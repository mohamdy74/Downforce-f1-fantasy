import { Link, useLocation } from "@tanstack/react-router";

import { LogoHorizontal } from "@/components/Logo";

const FOOTER_LINKS = [
  { to: "/predict", label: "Predict" },
  { to: "/weekend", label: "Weekend" },
  { to: "/leaderboard", label: "Standings" },
  { to: "/rules", label: "Rules" },
] as const;

/** Site-wide footer with the "unofficial / non-profit" disclaimer. */
export function SiteFooter() {
  // The disclaimer footer is shown on the Paddock tab (home) only.
  const { pathname } = useLocation();
  

  return (
    <footer className="mt-12 border-t border-border bg-background/70">
      <div className="kerb-strip" />
      <div className="mx-auto max-w-5xl px-4 pb-8 pt-8">
        <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-4">
          <Link to="/" aria-label="DOWNFORCE home" className="flex min-w-0 items-center opacity-90">
            <LogoHorizontal className="h-9 w-auto max-w-full" />
          </Link>
          <nav aria-label="Footer" className="flex flex-wrap gap-x-5 gap-y-2">
            {FOOTER_LINKS.map((l) => (
              <Link
                key={l.to}
                to={l.to}
                className="font-mono text-[11px] font-semibold uppercase tracking-widest text-muted-foreground transition-colors hover:text-foreground"
              >
                {l.label}
              </Link>
            ))}
          </nav>
        </div>

        <div className="mt-6 rounded-lg border border-border/70 bg-card/40 p-4">
          <p className="font-mono text-[10px] font-bold uppercase tracking-[0.25em] text-gold">
            Unofficial fan project · Non-profit
          </p>
          <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
            DOWNFORCE is an independent, non-profit prediction game made by fans, for fans. It is
            not affiliated with, authorised, endorsed or sponsored by Formula 1, Formula One Group,
            the FIA, or any racing team, driver, sponsor or championship organiser. All names,
            trademarks and logos mentioned belong to their respective owners and are used only to
            identify the sport and its participants.
          </p>
        </div>

        <div className="mt-5 flex flex-wrap items-center justify-between gap-2 font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
          <span>© {new Date().getFullYear()} DOWNFORCE · Fantasy Racing League</span>
          <span>Timing data courtesy of Jolpica and OpenF1</span>
        </div>
      </div>
    </footer>
  );
}