if (typeof window !== "undefined") {
  throw new Error(
    "Security violation: webpush-native is a Server-Only module and must never be imported in browser code.",
  );
}

function cleanEnvKey(val: string | undefined): string {
  return (val ?? "").trim().replace(/^["']+|["']+$/g, "").trim();
}

export function getServerVapidKeys(): { publicKey: string; privateKey: string } {
  const env = (typeof process !== "undefined" && process?.env ? process.env : {}) as Record<
    string,
    string | undefined
  >;
  const publicKey = cleanEnvKey(
    env["VAPID_PUBLIC_KEY"] ||
      env["VITE_VAPID_PUBLIC_KEY"] ||
      env["PUBLIC_VAPID_KEY"],
  );
  const privateKey = cleanEnvKey(
    env["VAPID_PRIVATE_KEY"] ||
      env["PRIVATE_VAPID_KEY"],
  );
  if (publicKey && !env["VITE_VAPID_PUBLIC_KEY"]) {
    env["VITE_VAPID_PUBLIC_KEY"] = publicKey;
  }
  if (publicKey && !env["VAPID_PUBLIC_KEY"]) {
    env["VAPID_PUBLIC_KEY"] = publicKey;
  }
  return { publicKey, privateKey };
}

function b64urlDecode(str: string): Uint8Array {
  const cleaned = cleanEnvKey(str);
  const pad = "=".repeat((4 - (cleaned.length % 4)) % 4);
  const b64 = (cleaned + pad).replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function b64urlEncode(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]!);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function concatBytes(...arrays: Uint8Array[]): Uint8Array {
  const total = arrays.reduce((acc, a) => acc + a.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const a of arrays) {
    out.set(a, offset);
    offset += a.length;
  }
  return out;
}

async function hmacSha256(keyBytes: Uint8Array, dataBytes: Uint8Array): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    "raw",
    keyBytes as BufferSource,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, dataBytes as BufferSource));
}

async function hkdfExtractAndExpand(
  salt: Uint8Array,
  ikm: Uint8Array,
  info: Uint8Array,
  length: number,
): Promise<Uint8Array> {
  const prk = await hmacSha256(salt, ikm);
  const infoPlusOne = concatBytes(info, new Uint8Array([1]));
  const okm = await hmacSha256(prk, infoPlusOne);
  return okm.slice(0, length);
}

async function createVapidAuthHeader(
  endpoint: string,
  subject: string,
  vapidPublicKey: string,
  vapidPrivateKey: string,
): Promise<string> {
  const origin = new URL(endpoint).origin;
  const pubBytes = b64urlDecode(vapidPublicKey);
  if (pubBytes.length !== 65 || pubBytes[0] !== 0x04) {
    throw new Error("Invalid VAPID_PUBLIC_KEY format (must be 65-byte uncompressed P-256 public key)");
  }
  const x = b64urlEncode(pubBytes.slice(1, 33));
  const y = b64urlEncode(pubBytes.slice(33, 65));
  const jwk: JsonWebKey = {
    kty: "EC",
    crv: "P-256",
    x,
    y,
    d: cleanEnvKey(vapidPrivateKey),
    ext: true,
  };
  let ecKey: CryptoKey;
  try {
    ecKey = await crypto.subtle.importKey(
      "jwk",
      jwk,
      { name: "ECDSA", namedCurve: "P-256" },
      false,
      ["sign"],
    );
  } catch {
    throw new Error(
      "VAPID_PRIVATE_KEY does not match VAPID_PUBLIC_KEY! Make sure both came from the same generated keypair.",
    );
  }
  const enc = new TextEncoder();
  const header = b64urlEncode(enc.encode(JSON.stringify({ typ: "JWT", alg: "ES256" })));
  const payload = b64urlEncode(
    enc.encode(
      JSON.stringify({
        aud: origin,
        exp: Math.floor(Date.now() / 1000) + 12 * 3600,
        sub: subject,
      }),
    ),
  );
  const unsigned = `${header}.${payload}`;
  const sig = new Uint8Array(
    await crypto.subtle.sign(
      { name: "ECDSA", hash: "SHA-256" },
      ecKey,
      enc.encode(unsigned) as BufferSource,
    ),
  );
  return `vapid t=${unsigned}.${b64urlEncode(sig)}, k=${cleanEnvKey(vapidPublicKey)}`;
}

async function encryptWebPushAes128Gcm(
  p256dh: string,
  auth: string,
  payloadStr: string,
): Promise<Uint8Array> {
  const enc = new TextEncoder();
  const uaPublicBytes = b64urlDecode(p256dh);
  const authBytes = b64urlDecode(auth);

  const uaPublicKey = await crypto.subtle.importKey(
    "raw",
    uaPublicBytes as BufferSource,
    { name: "ECDH", namedCurve: "P-256" },
    false,
    [],
  );
  const asKeyPair = await crypto.subtle.generateKey(
    { name: "ECDH", namedCurve: "P-256" },
    true,
    ["deriveBits"],
  );
  const asPublicBytes = new Uint8Array(await crypto.subtle.exportKey("raw", asKeyPair.publicKey));
  const sharedSecret = new Uint8Array(
    await crypto.subtle.deriveBits(
      { name: "ECDH", public: uaPublicKey },
      asKeyPair.privateKey,
      256,
    ),
  );

  const keyInfo = concatBytes(enc.encode("WebPush: info\0"), uaPublicBytes, asPublicBytes);
  const ikm = await hkdfExtractAndExpand(authBytes, sharedSecret, keyInfo, 32);

  const salt = crypto.getRandomValues(new Uint8Array(16));
  const cekInfo = enc.encode("Content-Encoding: aes128gcm\0");
  const nonceInfo = enc.encode("Content-Encoding: nonce\0");

  const cekBytes = await hkdfExtractAndExpand(salt, ikm, cekInfo, 16);
  const nonceBytes = await hkdfExtractAndExpand(salt, ikm, nonceInfo, 12);

  const aesKey = await crypto.subtle.importKey(
    "raw",
    cekBytes as BufferSource,
    { name: "AES-GCM" },
    false,
    ["encrypt"],
  );
  const paddedPlaintext = concatBytes(enc.encode(payloadStr), new Uint8Array([2]));
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: "AES-GCM", iv: nonceBytes as BufferSource },
      aesKey,
      paddedPlaintext as BufferSource,
    ),
  );

  const rsBytes = new Uint8Array([0x00, 0x00, 0x10, 0x00]);
  const idlenBytes = new Uint8Array([65]);
  return concatBytes(salt, rsBytes, idlenBytes, asPublicBytes, ciphertext);
}

export async function sendNativeWebPush(
  sub: { endpoint: string; p256dh: string; auth: string },
  payloadObj: { title: string; body: string; tag?: string; url?: string },
): Promise<{ ok: boolean; status: number; error?: string }> {
  const { publicKey: pub, privateKey: priv } = getServerVapidKeys();
  if (!pub || !priv) {
    const missing = [
      !pub ? "VAPID_PUBLIC_KEY" : "",
      !priv ? "VAPID_PRIVATE_KEY" : "",
    ]
      .filter(Boolean)
      .join(" & ");
    const msg = `Missing ${missing} on server (click Publish -> Update in Lovable after adding Secrets)`;
    console.error(`[WebPush] ${msg}`);
    return { ok: false, status: 0, error: msg };
  }
  const payloadStr = JSON.stringify(payloadObj);

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 8000);
  try {
    const [authHeader, encryptedBody] = await Promise.all([
      createVapidAuthHeader(sub.endpoint, "mailto:admin@downforce.app", pub, priv),
      encryptWebPushAes128Gcm(sub.p256dh, sub.auth, payloadStr),
    ]);

    const res = await fetch(sub.endpoint, {
      method: "POST",
      headers: {
        Authorization: authHeader,
        "Content-Encoding": "aes128gcm",
        "Content-Type": "application/octet-stream",
        TTL: "86400",
        Urgency: "high",
      },
      body: encryptedBody as BodyInit,
      signal: ctrl.signal,
    });
    const ok = res.ok || res.status === 201;
    if (!ok) {
      const errText = await res.text().catch(() => "");
      console.error(`[WebPush] Push endpoint returned HTTP ${res.status}: ${errText}`);
      return {
        ok: false,
        status: res.status,
        error:
          res.status === 401 || res.status === 403
            ? `HTTP ${res.status} (Old VAPID subscription removed â€” tap Test My Phone once more to re-subscribe)`
            : `Push service HTTP ${res.status}`,
      };
    }
    return { ok: true, status: res.status };
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    console.error("[WebPush] Failed to send push notification:", errMsg);
    return { ok: false, status: 0, error: errMsg };
  } finally {
    clearTimeout(timer);
  }
}
