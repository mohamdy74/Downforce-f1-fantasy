const DEFAULT_VAPID_PUBLIC =
  "BPsK6eJs07cjbH2JnZRJvMrZ_wTN4CfxgZqdZBXY-oQStSLyrd8NPq0xYVMsUqdbywWgvj5XJQboYn-E9TxPrSk";
const DEFAULT_VAPID_PRIVATE = "SowWFCNDsBlHZ3SW6l-nm3qjvEW-kG0DkVZTq8dIjJs";

function b64urlDecode(str: string): Uint8Array {
  const pad = "=".repeat((4 - (str.length % 4)) % 4);
  const b64 = (str + pad).replace(/-/g, "+").replace(/_/g, "/");
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
  const x = b64urlEncode(pubBytes.slice(1, 33));
  const y = b64urlEncode(pubBytes.slice(33, 65));
  const jwk: JsonWebKey = {
    kty: "EC",
    crv: "P-256",
    x,
    y,
    d: vapidPrivateKey,
    ext: true,
  };
  const ecKey = await crypto.subtle.importKey(
    "jwk",
    jwk,
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign"],
  );
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
  return `vapid t=${unsigned}.${b64urlEncode(sig)}, k=${vapidPublicKey}`;
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
): Promise<boolean> {
  const pub = process.env["VAPID_PUBLIC_KEY"] || DEFAULT_VAPID_PUBLIC;
  const priv = process.env["VAPID_PRIVATE_KEY"] || DEFAULT_VAPID_PRIVATE;
  const payloadStr = JSON.stringify(payloadObj);

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
  });

  return res.ok || res.status === 201;
}
