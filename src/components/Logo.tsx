import type { CSSProperties } from "react";

/**
 * DOWNFORCE brand marks (pure SVG, transparent background).
 * LogoMark       -> the "D" with two downward chevrons (mobile, avatar, favicon-style uses)
 * LogoHorizontal -> mark + DOWNFORCE with the "Fantasy Racing League" subtitle underneath
 *
 * variant "auto" follows the site theme tokens; the others are fixed brand colours:
 *   white -> all white     black -> all near-black     light -> near-black + racing red/orange
 */
export type LogoVariant = "auto" | "white" | "black" | "light";

const PALETTE: Record<LogoVariant, { t: string; a: string; b: string; sub: number }> = {
  auto: { t: "var(--foreground)", a: "var(--primary)", b: "#FF6A1F", sub: 0.72 },
  white: { t: "#FFFFFF", a: "#FFFFFF", b: "#FFFFFF", sub: 0.78 },
  black: { t: "#0E0E12", a: "#0E0E12", b: "#0E0E12", sub: 0.72 },
  light: { t: "#0E0E12", a: "#E10600", b: "#FF6A1F", sub: 0.68 },
};

import { LOGO as D } from "@/lib/logoPaths";

type Props = { className?: string; variant?: LogoVariant; style?: CSSProperties };

function Mark({ t, a, b }: { t: string; a: string; b: string }) {
  return (
    <>
      <path d={D.d} fill={t} fillRule="evenodd" />
      <path d={D.c1} fill={b} />
      <path d={D.c2} fill={a} />
    </>
  );
}

/** Icon-only mark: a forward-leaning "D" with two downward speed chevrons. */
export function LogoMark({ className = "h-8 w-auto", variant = "auto", style }: Props) {
  const { t, a, b } = PALETTE[variant];
  return (
    <svg viewBox="-1.5 -1.5 102.0 91.0" className={className} style={style} role="img" aria-label="DOWNFORCE">
      <Mark t={t} a={a} b={b} />
    </svg>
  );
}

/** Full lockup: [D mark] DOWNFORCE / Fantasy Racing League */
export function LogoHorizontal({ className = "h-9 w-auto", variant = "auto", style }: Props) {
  const { t, a, b, sub } = PALETTE[variant];
  return (
    <svg
      viewBox="-1.5 -2.8 589.0 97.8"
      className={className}
      style={style}
      role="img"
      aria-label="DOWNFORCE — Fantasy Racing League"
    >
      <Mark t={t} a={a} b={b} />
      <g transform="translate(129.3 0)">
        <path d={D.word} fill={t} />
        <g transform="translate(0 68)">
          <path d={D.sub} fill={t} fillOpacity={sub} />
        </g>
      </g>
    </svg>
  );
}
