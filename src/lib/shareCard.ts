import { LOGO } from "@/lib/logoPaths";
import { teamLabel } from "@/lib/teams";

export const CARD_W = 1080;
export const CARD_H = 1350; // 4:5 portrait, fits Instagram / WhatsApp status

export type CardDriver = {
  code: string | null;
  name: string | null;
  team: string | null;
  number?: number | null | undefined;
} | null;

export type CardData = {
  raceName: string;
  round: number;
  playerName: string;
  top10: CardDriver[];
  pole: CardDriver;
  fastestLap: CardDriver;
  dnf: CardDriver;
  host: string;
  lockedAt?: string | null | undefined;
};

export type PoleCardData = {
  raceName: string;
  round: number;
  playerName: string;
  driver: CardDriver;
  circuit?: string | null | undefined;
  savedAtLabel: string | null;
  host: string;
};

const TEAM_HEX: Record<string, string> = {
  Ferrari: "#E3121E",
  McLaren: "#FF8918",
  Mercedes: "#36D2BA",
  "Red Bull": "#325AC2",
  "Aston Martin": "#007C59",
  Alpine: "#0099E0",
  Williams: "#2A80E2",
  Haas: "#FCFCFC",
  "Racing Bulls": "#5E78D9",
  Audi: "#F50537",
  Cadillac: "#D4AF37",
};

const C = {
  bg: "#08090E",
  panel: "#11131C",
  row: "#121520",
  podium: "#131622",
  line: "rgba(255,255,255,0.10)",
  text: "#FFFFFF",
  muted: "#9CA3AF",
  red: "#E10600",
  orange: "#FF6A1F",
  gold: "#FFD230",
  purple: "#A855F7",
  silver: "#C9CCD3",
  bronze: "#CD7F32",
};

const DISPLAY = (size: number, italic = true) =>
  `${italic ? "italic " : ""}900 ${size}px Archivo, "Arial Black", system-ui, sans-serif`;
const SANS = (size: number, weight = 600) => `${weight} ${size}px Barlow, system-ui, sans-serif`;
const MONO = (size: number, weight = 800) =>
  `${weight} ${size}px "Barlow Semi Condensed", ui-monospace, Menlo, monospace`;

function teamHex(team: string | null | undefined) {
  return TEAM_HEX[teamLabel(team)] ?? "#6B6B73";
}

type Ctx = CanvasRenderingContext2D;

function spaced(ctx: Ctx, px: number) {
  if ("letterSpacing" in ctx) (ctx as unknown as { letterSpacing: string }).letterSpacing = `${px}px`;
}

function fit(ctx: Ctx, text: string, maxW: number, make: (size: number) => string, start: number, min = 18) {
  let size = start;
  ctx.font = make(size);
  while (size > min && ctx.measureText(text).width > maxW) {
    size -= 2;
    ctx.font = make(size);
  }
}

function roundRect(ctx: Ctx, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function drawLogo(ctx: Ctx, x: number, y: number, height: number) {
  const k = height / LOGO.box.h;
  ctx.save();
  ctx.translate(x, y);
  ctx.scale(k, k);
  ctx.translate(-LOGO.box.x, -LOGO.box.y);
  ctx.fillStyle = C.text;
  ctx.fill(new Path2D(LOGO.d), "evenodd");
  ctx.fillStyle = C.orange;
  ctx.fill(new Path2D(LOGO.c1));
  ctx.fillStyle = C.red;
  ctx.fill(new Path2D(LOGO.c2));
  ctx.save();
  ctx.translate(LOGO.textX, 0);
  ctx.fillStyle = C.text;
  ctx.fill(new Path2D(LOGO.word));
  ctx.translate(0, LOGO.subY);
  ctx.fillStyle = "rgba(255,255,255,0.72)";
  ctx.fill(new Path2D(LOGO.sub));
  ctx.restore();
  ctx.restore();
}

function drawCarbonBg(ctx: Ctx, accentHex: string) {
  ctx.fillStyle = C.bg;
  ctx.fillRect(0, 0, CARD_W, CARD_H);

  // Subtle diagonal carbon weave lines (NO red/white kerb strip at the top!)
  ctx.strokeStyle = "rgba(255,255,255,0.018)";
  ctx.lineWidth = 2;
  for (let i = -CARD_H; i < CARD_W + CARD_H; i += 28) {
    ctx.beginPath();
    ctx.moveTo(i, 0);
    ctx.lineTo(i - CARD_H, CARD_H);
    ctx.stroke();
  }

  // Top-right & bottom-left ambient glow
  const g1 = ctx.createRadialGradient(CARD_W * 0.85, 120, 10, CARD_W * 0.85, 120, 720);
  g1.addColorStop(0, accentHex + "44");
  g1.addColorStop(1, "rgba(0,0,0,0)");
  ctx.fillStyle = g1;
  ctx.fillRect(0, 0, CARD_W, CARD_H);

  const g2 = ctx.createRadialGradient(CARD_W * 0.15, CARD_H - 180, 10, CARD_W * 0.15, CARD_H - 180, 620);
  g2.addColorStop(0, "rgba(225,6,0,0.18)");
  g2.addColorStop(1, "rgba(0,0,0,0)");
  ctx.fillStyle = g2;
  ctx.fillRect(0, 0, CARD_W, CARD_H);
}

function drawHeader(ctx: Ctx, roundNum: number, raceName: string, subtitle: string) {
  const L = 56;
  const R = CARD_W - 56;

  // Official DOWNFORCE Logo on top-left
  drawLogo(ctx, L, 44, 58);

  // 5 Start Lights Pill on top-right
  ctx.fillStyle = "#12141E";
  roundRect(ctx, R - 230, 44, 230, 50, 25);
  ctx.fill();
  ctx.strokeStyle = "rgba(255,255,255,0.12)";
  ctx.lineWidth = 2;
  ctx.stroke();
  for (let i = 0; i < 5; i++) {
    ctx.fillStyle = C.red;
    ctx.beginPath();
    ctx.arc(R - 194 + i * 38, 69, 10, 0, Math.PI * 2);
    ctx.fill();
  }

  // Round & Championship line
  ctx.textAlign = "left";
  ctx.fillStyle = C.gold;
  ctx.font = MONO(22, 800);
  spaced(ctx, 2);
  ctx.fillText(`ROUND ${String(roundNum).padStart(2, "0")} · 2026 FIA WORLD CHAMPIONSHIP`, L, 152);
  spaced(ctx, 0);

  // Race Title
  ctx.fillStyle = C.text;
  const race = raceName.toUpperCase();
  fit(ctx, race, R - L, (s) => DISPLAY(s), 58, 34);
  ctx.fillText(race, L, 214);

  // Circuit / Subtitle line
  ctx.fillStyle = C.muted;
  fit(ctx, subtitle.toUpperCase(), R - L, (s) => MONO(s, 700), 22, 16);
  ctx.fillText(subtitle.toUpperCase(), L, 250);
}

function drawFooter(ctx: Ctx, playerName: string, lockedAtLabel: string | null, host: string) {
  const L = 56;
  const R = CARD_W - 56;

  ctx.fillStyle = "#121521";
  roundRect(ctx, L, CARD_H - 150, R - L, 76, 12);
  ctx.fill();
  ctx.strokeStyle = "rgba(255,255,255,0.10)";
  ctx.lineWidth = 2;
  ctx.stroke();

  ctx.fillStyle = C.red;
  ctx.fillRect(L, CARD_H - 150, 10, 76);

  ctx.textAlign = "left";
  ctx.fillStyle = C.muted;
  ctx.font = MONO(18, 700);
  ctx.fillText("LOCKED IN BY", L + 28, CARD_H - 118);

  ctx.fillStyle = C.text;
  fit(ctx, playerName.toUpperCase(), (R - L) * 0.52, (s) => DISPLAY(s), 32, 20);
  ctx.fillText(playerName.toUpperCase(), L + 28, CARD_H - 86);

  ctx.textAlign = "right";
  ctx.fillStyle = C.gold;
  ctx.font = MONO(20, 700);
  ctx.fillText(`🔒 ${lockedAtLabel || "LOCKED IN"}`, R - 24, CARD_H - 114);
  ctx.fillStyle = C.muted;
  ctx.font = MONO(16, 700);
  ctx.fillText("CAIRO OFFICIAL TIME", R - 24, CARD_H - 88);

  // Bottom bar
  ctx.textAlign = "left";
  ctx.fillStyle = C.muted;
  ctx.font = MONO(20, 700);
  ctx.fillText(host.toUpperCase(), L, CARD_H - 34);

  ctx.fillStyle = C.red;
  ctx.textAlign = "right";
  ctx.fillText("CALL THE GRID · BEAT YOUR RIVALS", R, CARD_H - 34);
  ctx.textAlign = "left";
}

/** "SAT 3 OCT · 14:32" in Cairo time */
export function formatCairo(iso: string | null | undefined, seconds = false): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Africa/Cairo",
    weekday: "short",
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    ...(seconds ? { second: "2-digit" as const } : {}),
    hourCycle: "h23",
  }).formatToParts(d);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  const time = `${get("hour")}:${get("minute")}${seconds ? ":" + get("second") : ""}`;
  return `${get("weekday")} ${get("day")} ${get("month")} · ${time}`.toUpperCase();
}

// ============================================================================
// 1. FULL RACE PREDICTIONS CARD (Exact Left Card from Screenshot, No Top Kerb)
// ============================================================================
export function drawPickCard(ctx: Ctx, d: CardData) {
  const L = 56;
  const R = CARD_W - 56;

  drawCarbonBg(ctx, C.gold);
  drawHeader(ctx, d.round, d.raceName, "OFFICIAL PODIUM & STARTING GRID PICKS");

  // Top Podium Trio (P2 Silver Left | P1 Gold Center Tall | P3 Bronze Right)
  const pOrder = [
    { pos: 2, drv: d.top10[1], color: C.silver, x: L, y: 310, w: 300, h: 210 },
    { pos: 1, drv: d.top10[0], color: C.gold, x: L + 316, y: 278, w: 336, h: 242 },
    { pos: 3, drv: d.top10[2], color: C.bronze, x: L + 668, y: 324, w: 300, h: 196 },
  ];

  pOrder.forEach((p) => {
    const tHex = teamHex(p.drv?.team);
    ctx.fillStyle = C.podium;
    roundRect(ctx, p.x, p.y, p.w, p.h, 14);
    ctx.fill();
    ctx.strokeStyle = p.color;
    ctx.lineWidth = 3;
    ctx.stroke();

    ctx.fillStyle = p.color;
    roundRect(ctx, p.x + 18, p.y + 16, 70, 36, 8);
    ctx.fill();
    ctx.fillStyle = "#090A0F";
    ctx.font = MONO(22, 900);
    ctx.textAlign = "center";
    ctx.fillText(`P${p.pos}`, p.x + 53, p.y + 41);

    if (p.drv?.number != null) {
      ctx.textAlign = "right";
      ctx.fillStyle = tHex;
      ctx.font = DISPLAY(32);
      ctx.fillText(`#${p.drv.number}`, p.x + p.w - 18, p.y + 44);
    }

    ctx.textAlign = "center";
    ctx.fillStyle = C.text;
    ctx.font = DISPLAY(64);
    ctx.fillText(p.drv?.code ?? "—", p.x + p.w / 2, p.y + 125);

    ctx.fillStyle = C.muted;
    fit(ctx, p.drv?.name ?? "", p.w - 28, (s) => SANS(s, 700), 20, 14);
    ctx.fillText(p.drv?.name ?? "", p.x + p.w / 2, p.y + 165);
  });

  // P4 to P10 Compact 2-Column Grid
  const gy = 542;
  const colW = (R - L - 20) / 2;
  d.top10.slice(3, 10).forEach((drv, idx) => {
    const pos = idx + 4;
    const col = idx % 2;
    const row = Math.floor(idx / 2);
    const x = L + col * (colW + 20);
    const y = gy + row * 82;
    const tHex = teamHex(drv?.team);

    ctx.fillStyle = C.row;
    roundRect(ctx, x, y, colW, 70, 10);
    ctx.fill();
    ctx.fillStyle = tHex;
    ctx.fillRect(x, y + 8, 8, 54);

    ctx.fillStyle = C.muted;
    ctx.font = MONO(24, 800);
    ctx.textAlign = "left";
    ctx.fillText(`P${pos}`, x + 22, y + 44);

    ctx.fillStyle = C.text;
    ctx.font = DISPLAY(32);
    ctx.fillText(drv?.code ?? "—", x + 84, y + 46);

    ctx.fillStyle = C.muted;
    fit(ctx, drv?.name ?? "", colW - 265, (s) => SANS(s, 600), 20, 14);
    ctx.fillText(drv?.name ?? "", x + 185, y + 44);

    if (drv?.number != null) {
      ctx.textAlign = "right";
      ctx.fillStyle = tHex;
      ctx.font = DISPLAY(26);
      ctx.fillText(`#${drv.number}`, x + colW - 18, y + 45);
    }
  });

  // Bonus Trio at y = 885
  const by = 885;
  const bh = 278;
  const cardW = (R - L - 32) / 3;
  const bonuses = [
    { label: "POLE PICK", pts: "+3 PTS", drv: d.pole, accent: C.gold },
    { label: "FASTEST LAP", pts: "+3 PTS", drv: d.fastestLap, accent: C.purple },
    { label: "DNF PICK", pts: "+1 PT", drv: d.dnf, accent: C.red },
  ];

  bonuses.forEach((b, idx) => {
    const bx = L + idx * (cardW + 16);
    const tHex = teamHex(b.drv?.team);

    ctx.fillStyle = C.row;
    roundRect(ctx, bx, by, cardW, bh, 16);
    ctx.fill();
    ctx.strokeStyle = b.accent;
    ctx.lineWidth = 2.5;
    ctx.stroke();

    ctx.fillStyle = b.accent;
    ctx.font = MONO(20, 800);
    ctx.textAlign = "left";
    ctx.fillText(`${b.label} (${b.pts})`, bx + 20, by + 44);

    ctx.fillStyle = C.text;
    ctx.font = DISPLAY(76);
    ctx.fillText(b.drv?.code ?? "—", bx + 20, by + 145);

    ctx.fillStyle = C.muted;
    fit(ctx, b.drv?.name ?? "Not selected", cardW - 40, (s) => SANS(s, 700), 22, 15);
    ctx.fillText(b.drv?.name ?? "Not selected", bx + 20, by + 195);

    ctx.fillStyle = tHex;
    const teamLine = b.drv
      ? `${teamLabel(b.drv.team).toUpperCase()}${b.drv.number != null ? ` · #${b.drv.number}` : ""}`
      : "—";
    fit(ctx, teamLine, cardW - 40, (s) => DISPLAY(s), 30, 18);
    ctx.fillText(teamLine, bx + 20, by + 245);
  });

  const lock = formatCairo(d.lockedAt, false);
  drawFooter(ctx, d.playerName, lock, d.host);
}

// ============================================================================
// 2. POLE POSITION SHARE CARD (Exact Right Card from Screenshot, No Top Kerb)
// ============================================================================
export function drawPoleCard(ctx: Ctx, d: PoleCardData) {
  const L = 56;
  const R = CARD_W - 56;
  const MID = CARD_W / 2;
  const tHex = teamHex(d.driver?.team);

  drawCarbonBg(ctx, C.gold);
  drawHeader(
    ctx,
    d.round,
    d.raceName,
    d.circuit || "OFFICIAL POLE POSITION PREDICTION",
  );

  const py = 285;
  const ph = 875;
  ctx.fillStyle = C.panel;
  roundRect(ctx, L, py, R - L, ph, 22);
  ctx.fill();
  ctx.strokeStyle = C.gold;
  ctx.lineWidth = 3;
  ctx.stroke();

  // Giant Diagonal Racing Slash in Team Color
  ctx.save();
  ctx.beginPath();
  roundRect(ctx, L, py, R - L, ph, 22);
  ctx.clip();
  ctx.fillStyle = tHex + "26";
  ctx.beginPath();
  ctx.moveTo(L + 420, py);
  ctx.lineTo(R, py);
  ctx.lineTo(R - 260, py + ph);
  ctx.lineTo(L + 160, py + ph);
  ctx.closePath();
  ctx.fill();
  ctx.restore();

  // Hexagonal Chronograph Shield in Center
  ctx.save();
  ctx.translate(MID, py + 370);
  ctx.beginPath();
  for (let i = 0; i < 6; i++) {
    const ang = (i * Math.PI) / 3 - Math.PI / 6;
    const rx = Math.cos(ang) * 230;
    const ry = Math.sin(ang) * 230;
    if (i === 0) ctx.moveTo(rx, ry);
    else ctx.lineTo(rx, ry);
  }
  ctx.closePath();
  ctx.fillStyle = "#090B10";
  ctx.fill();
  ctx.lineWidth = 8;
  ctx.strokeStyle = C.gold;
  ctx.stroke();

  ctx.fillStyle = C.gold;
  ctx.font = MONO(22, 800);
  ctx.textAlign = "center";
  ctx.fillText("👑 POLE POSITION KING", 0, -110);

  ctx.fillStyle = C.text;
  ctx.font = DISPLAY(145);
  ctx.fillText(d.driver?.code ?? "—", 0, 25);

  ctx.fillStyle = tHex;
  ctx.font = DISPLAY(58);
  ctx.fillText(d.driver?.number != null ? `CAR #${d.driver.number}` : "POLE P1", 0, 105);
  ctx.restore();

  // Bottom Driver Name & Team Bar inside Arena
  ctx.textAlign = "center";
  ctx.fillStyle = C.text;
  const dn = (d.driver?.name ?? "No pole pick").toUpperCase();
  fit(ctx, dn, R - L - 80, (s) => DISPLAY(s), 62, 32);
  ctx.fillText(dn, MID, py + 715);

  ctx.fillStyle = tHex;
  const sub = `${teamLabel(d.driver?.team).toUpperCase()} · +3 BONUS POINTS`;
  fit(ctx, sub, R - L - 80, (s) => MONO(s, 800), 32, 20);
  ctx.fillText(sub, MID, py + 768);

  drawFooter(ctx, d.playerName, d.savedAtLabel, d.host);
}

async function paint(draw: (ctx: Ctx) => void): Promise<Blob | null> {
  try {
    await Promise.all(
      [
        "italic 900 40px Archivo",
        "800 40px Archivo",
        "600 28px Barlow",
        '800 28px "Barlow Semi Condensed"',
      ].map((f) => document.fonts.load(f).catch(() => null)),
    );
  } catch {
    /* draw with fallback fonts */
  }
  const canvas = document.createElement("canvas");
  canvas.width = CARD_W;
  canvas.height = CARD_H;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  draw(ctx);
  return new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
}

export function renderPickCard(data: CardData): Promise<Blob | null> {
  return paint((ctx) => drawPickCard(ctx, data));
}

export function renderPoleCard(data: PoleCardData): Promise<Blob | null> {
  return paint((ctx) => drawPoleCard(ctx, data));
}
