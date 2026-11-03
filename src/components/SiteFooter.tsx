import { Link, useLocation } from "@tanstack/react-router";
import { ShieldCheck, FileText } from "lucide-react";
import { useState } from "react";

import { LegalDialog } from "@/components/LegalModal";
import { LogoHorizontal } from "@/components/Logo";

const FOOTER_LINKS = [
  { to: "/predict", label: "Predict" },
  { to: "/weekend", label: "Weekend" },
  { to: "/leaderboard", label: "Standings" },
  { to: "/rules", label: "Rules" },
] as const;

export function SiteFooter() {
  const { pathname } = useLocation();
  const [legalModal, setLegalModal] = useState<"privacy" | "terms" | null>(null);

  if (pathname !== "/") return null;

  return (
    <footer className="mt-12 border-t border-border bg-background/80">
      <div className="kerb-strip" />
      <div className="mx-auto max-w-5xl px-4 pb-8 pt-8">
        <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-4">
          <Link to="/" aria-label="DOWNFORCE home" className="flex min-w-0 items-center opacity-95">
            <LogoHorizontal className="h-9 w-auto max-w-full" />
          </Link>

          <nav aria-label="Footer" className="flex flex-wrap items-center gap-x-4 gap-y-2">
            {FOOTER_LINKS.map((l) => (
              <Link
                key={l.to}
                to={l.to}
                className="font-mono text-[11px] font-semibold uppercase tracking-widest text-muted-foreground transition-colors hover:text-foreground"
              >
                {l.label}
              </Link>
            ))}

            {/* Distinctive highlighted legal pills */}
            <div className="flex items-center gap-2 pl-1">
              <button
                type="button"
                onClick={() => setLegalModal("privacy")}
                className="inline-flex items-center gap-1 rounded-full border border-gold/50 bg-gold/15 px-3 py-1 font-mono text-[11px] font-bold uppercase tracking-wider text-gold shadow-sm transition hover:border-gold hover:bg-gold/25"
              >
                <ShieldCheck className="h-3 w-3" />
                Privacy Policy
              </button>
              <button
                type="button"
                onClick={() => setLegalModal("terms")}
                className="inline-flex items-center gap-1 rounded-full border border-primary/50 bg-primary/15 px-3 py-1 font-mono text-[11px] font-bold uppercase tracking-wider text-primary shadow-sm transition hover:border-primary hover:bg-primary/25"
              >
                <FileText className="h-3 w-3" />
                Terms of Use
              </button>
            </div>
          </nav>
        </div>

        <div className="mt-6 rounded-lg border border-border/70 bg-card/40 p-4">
          <p className="font-mono text-[11px] font-bold uppercase tracking-[0.25em] text-gold">
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

        {/* Distinctive styled copyright & timing credit bar */}
        <div className="mt-5 flex flex-wrap items-center justify-between gap-2.5 rounded-lg border border-border/60 bg-secondary/30 px-3.5 py-2.5 font-mono text-[11px] uppercase tracking-wider">
          <span className="font-bold text-foreground">
            © {new Date().getFullYear()}{" "}
            <strong className="font-black text-primary">DOWNFORCE</strong> ·{" "}
            <span className="font-black text-gold">Fantasy Racing League</span>
          </span>
          <span className="text-muted-foreground">
            Official Timing Data: <strong className="text-foreground">Jolpica &amp; OpenF1</strong>
          </span>
        </div>
      </div>

      <LegalDialog kind={legalModal} onOpenChange={setLegalModal} />
    </footer>
  );
}
