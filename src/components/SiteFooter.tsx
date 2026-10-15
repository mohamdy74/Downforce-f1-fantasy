import { Link, useLocation } from "@tanstack/react-router";
import { X } from "lucide-react";
import { useState } from "react";

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
    <footer className="mt-12 border-t border-border bg-background/70">
      <div className="kerb-strip" />
      <div className="mx-auto max-w-5xl px-4 pb-8 pt-8">
        <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-4">
          <Link to="/" aria-label="DOWNFORCE home" className="flex min-w-0 items-center opacity-90">
            <LogoHorizontal className="h-9 w-auto max-w-full" />
          </Link>
          <nav aria-label="Footer" className="flex flex-wrap items-center gap-x-5 gap-y-2">
            {FOOTER_LINKS.map((l) => (
              <Link
                key={l.to}
                to={l.to}
                className="font-mono text-[11px] font-semibold uppercase tracking-widest text-muted-foreground transition-colors hover:text-foreground"
              >
                {l.label}
              </Link>
            ))}
            <button
              type="button"
              onClick={() => setLegalModal("privacy")}
              className="font-mono text-[11px] font-semibold uppercase tracking-widest text-muted-foreground transition-colors hover:text-foreground"
            >
              Privacy Policy
            </button>
            <button
              type="button"
              onClick={() => setLegalModal("terms")}
              className="font-mono text-[11px] font-semibold uppercase tracking-widest text-muted-foreground transition-colors hover:text-foreground"
            >
              Terms of Use
            </button>
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

      {legalModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 p-4 backdrop-blur-sm">
          <div className="carbon-panel relative max-h-[82vh] w-full max-w-lg overflow-y-auto rounded-2xl border border-border p-6 shadow-2xl">
            <button
              type="button"
              onClick={() => setLegalModal(null)}
              className="absolute right-4 top-4 rounded-full p-1 text-muted-foreground hover:bg-secondary hover:text-foreground"
              aria-label="Close"
            >
              <X className="h-4 w-4" />
            </button>

            {legalModal === "privacy" ? (
              <div className="space-y-3 text-xs leading-relaxed text-muted-foreground">
                <p className="font-mono text-[10px] font-bold uppercase tracking-widest text-gold">
                  Legal &amp; Privacy
                </p>
                <h2 className="text-2xl text-foreground">Privacy Policy</h2>
                <p>
                  <strong>1. Data We Collect:</strong> When you sign in with Google OAuth, we store
                  only your account identifier, email address (for authentication), display name, and
                  profile avatar to display your position on the league leaderboard.
                </p>
                <p>
                  <strong>2. Push Notifications:</strong> If you opt in to race lock alerts, your
                  browser&apos;s encrypted Web Push endpoint is stored solely to send automated 2h
                  and 30m race deadline reminders.
                </p>
                <p>
                  <strong>3. No Third-Party Selling or Tracking:</strong> DOWNFORCE is a private,
                  non-profit fan project. We never sell, rent, or share your personal data with
                  advertisers or third parties.
                </p>
                <p>
                  <strong>4. Account &amp; Data Deletion:</strong> You can permanently delete your
                  account, predictions, and scores at any time using the <em>Account Settings</em>{" "}
                  button in the top navigation bar.
                </p>
              </div>
            ) : (
              <div className="space-y-3 text-xs leading-relaxed text-muted-foreground">
                <p className="font-mono text-[10px] font-bold uppercase tracking-widest text-gold">
                  League Regulations
                </p>
                <h2 className="text-2xl text-foreground">Terms of Use</h2>
                <p>
                  <strong>1. Non-Profit Fan Game:</strong> DOWNFORCE is a free-to-play, non-commercial
                  fantasy prediction league created for entertainment among friends. No real money,
                  gambling, or wagering is involved.
                </p>
                <p>
                  <strong>2. Deadlines &amp; Fair Play:</strong> Pole position picks lock automatically
                  at the start of Qualifying, and Race Top 10 / Fastest Lap / DNF picks lock at the
                  official Race start time. Registered players who fail to submit a complete Top 10
                  receive a −25 point penalty for that round.
                </p>
                <p>
                  <strong>3. FIA Stewards Decisions:</strong> League Stewards may adjust lock times
                  in the event of real-world session delays (such as red flags or weather) or waive
                  penalties in documented technical emergencies.
                </p>
                <p>
                  <strong>4. Intellectual Property Disclaimer:</strong> This project is unofficial
                  and is not associated in any way with the Formula 1 companies, the FIA, or any F1
                  team.
                </p>
              </div>
            )}
          </div>
        </div>
      )}
    </footer>
  );
}
