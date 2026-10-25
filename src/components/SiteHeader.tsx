import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { CalendarDays, Grid3x3, Home, LogOut, Moon, Shield, Sun, Swords, Trophy, X, Zap } from "lucide-react";
import { useEffect, useState } from "react";
import { createPortal } from "react-dom";

import { AccountAndOnboarding } from "@/components/AccountAndOnboarding";
import { LogoHorizontal, LogoMark } from "@/components/Logo";
import { PushOptIn } from "@/components/PushOptIn";
import { Button } from "@/components/ui/button";
import { useAuth } from "@/hooks/useAuth";
import { useTheme } from "@/hooks/useTheme";
import { racesQuery } from "@/lib/queries";
import { sprintWeekend } from "@/lib/sprint";
import { STEWARD_EMAIL } from "@/lib/stewards.functions";

const links = [
  { to: "/", label: "Paddock", icon: Home },
  { to: "/predict", label: "Predict", icon: Grid3x3 },
  { to: "/leaderboard", label: "Standings", icon: Trophy },
  { to: "/h2h", label: "1v1", icon: Swords },
  { to: "/weekend", label: "Weekend", icon: CalendarDays },
  { to: "/rules", label: "Rules", icon: null },
] as const;

const DESKTOP_LINK =
  "hidden rounded-sm px-2 py-1.5 font-mono text-xs font-semibold uppercase tracking-widest text-muted-foreground transition-colors hover:text-foreground md:inline [&.active]:text-primary";

function useSprintWeek(): boolean {
  const { data: races } = useQuery(racesQuery);
  return !!races && !!sprintWeekend(races);
}

export const HelmetLogo = LogoMark;

export function SiteHeader() {
  const { user, signOut } = useAuth();
  const { theme, setTheme } = useTheme();
  const sprintOn = useSprintWeek();
  const isSteward = user?.email?.toLowerCase() === STEWARD_EMAIL;
  const [confirmExitOpen, setConfirmExitOpen] = useState(false);
  const [signingOut, setSigningOut] = useState(false);

  const toggleTheme = () => {
    setTheme(theme === "dark" ? "light" : "dark");
  };

  useEffect(() => {
    if (!confirmExitOpen) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setConfirmExitOpen(false);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [confirmExitOpen]);

  async function handleConfirmExit() {
    setSigningOut(true);
    try {
      await signOut();
      setConfirmExitOpen(false);
    } finally {
      setSigningOut(false);
    }
  }

  const exitConfirmModal =
    confirmExitOpen && typeof document !== "undefined"
      ? createPortal(
          <div
            className="fixed inset-0 z-[110] flex items-center justify-center bg-black/80 p-4 backdrop-blur-sm animate-in fade-in duration-150"
            onClick={() => !signingOut && setConfirmExitOpen(false)}
          >
            <div
              className="carbon-panel relative w-full max-w-sm overflow-hidden rounded-2xl border border-white/15 bg-card/95 p-5 shadow-[0_24px_60px_rgba(0,0,0,0.85)] backdrop-blur-xl"
              onClick={(e) => e.stopPropagation()}
              role="dialog"
              aria-modal="true"
              aria-labelledby="exit-league-title"
            >
              <div className="pointer-events-none absolute -right-10 -top-10 h-28 w-28 rounded-full bg-primary/15 blur-2xl" />

              <div className="relative flex items-start justify-between gap-3">
                <div className="flex items-center gap-2.5">
                  <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-primary/40 bg-primary/15 text-primary shadow-[0_0_16px_rgba(225,6,0,0.25)]">
                    <LogOut className="h-5 w-5" />
                  </span>
                  <div>
                    <p className="font-mono text-[10px] font-bold uppercase tracking-widest text-gold">
                      Confirm Action
                    </p>
                    <h2 id="exit-league-title" className="mt-0.5 text-lg font-black uppercase tracking-wide text-foreground">
                      Exit the League?
                    </h2>
                  </div>
                </div>

                <button
                  type="button"
                  disabled={signingOut}
                  onClick={() => setConfirmExitOpen(false)}
                  className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-border/70 bg-secondary/50 text-muted-foreground transition-colors hover:border-white/25 hover:text-foreground"
                  aria-label="Close dialog"
                >
                  <X className="h-4 w-4" />
                </button>
              </div>

              <p className="relative mt-3.5 text-xs leading-relaxed text-muted-foreground sm:text-sm">
                Are you sure you want to exit the league? You&apos;ll be signed out on this device, and you can sign back in anytime with your Google account.
              </p>

              <div className="relative mt-5 grid grid-cols-2 gap-2.5">
                <Button
                  type="button"
                  variant="secondary"
                  disabled={signingOut}
                  onClick={() => setConfirmExitOpen(false)}
                  className="h-10 rounded-xl border border-border/80 font-mono text-xs font-bold uppercase tracking-wider"
                >
                  No, Stay
                </Button>
                <Button
                  type="button"
                  variant="destructive"
                  disabled={signingOut}
                  onClick={handleConfirmExit}
                  className="h-10 gap-1.5 rounded-xl font-mono text-xs font-bold uppercase tracking-wider shadow-[0_0_20px_rgba(225,6,0,0.3)]"
                >
                  <LogOut className="h-3.5 w-3.5" />
                  {signingOut ? "Exiting…" : "Yes, Exit"}
                </Button>
              </div>
            </div>
          </div>,
          document.body,
        )
      : null;

  return (
    <header className="sticky top-0 z-40 w-full overflow-x-clip border-b border-border bg-background/90 pt-[env(safe-area-inset-top)] backdrop-blur">
      <div className="mx-auto flex max-w-5xl items-center justify-between gap-1.5 px-3 py-2 sm:gap-2 sm:px-4">
        <Link to="/" className="flex min-w-0 shrink items-center" aria-label="DOWNFORCE home">
          <LogoHorizontal className="h-7 w-auto max-w-[140px] sm:h-10 sm:max-w-none" />
        </Link>

        <nav className="ml-auto flex shrink-0 items-center gap-0.5 sm:gap-1">
          {links
            .filter((l) => l.to !== "/rules")
            .map((l) => (
              <Link
                key={l.to}
                to={l.to}
                activeOptions={{ exact: l.to === "/" }}
                className={DESKTOP_LINK}
              >
                {l.label}
              </Link>
            ))}
          {sprintOn && (
            <Link to="/sprint" className={DESKTOP_LINK}>
              Sprint
            </Link>
          )}
          {isSteward && (
            <Link to="/stewards" className={DESKTOP_LINK} style={{ color: "var(--gold)" }}>
              Stewards
            </Link>
          )}
          <Link to="/rules" className={DESKTOP_LINK}>
            Rules
          </Link>
          {isSteward && (
            <Button
              variant="ghost"
              size="icon"
              asChild
              className="h-8 w-8 shrink-0 text-gold md:hidden"
              aria-label="Stewards"
            >
              <Link to="/stewards">
                <Shield className="h-4 w-4" />
              </Link>
            </Button>
          )}
          <Link
            to="/rules"
            className="rounded-sm px-1.5 py-1 font-mono text-[11px] font-semibold uppercase tracking-wider text-muted-foreground md:hidden [&.active]:text-primary"
          >
            Rules
          </Link>
          <Button
            variant="ghost"
            size="icon"
            aria-label="Toggle theme"
            onClick={toggleTheme}
            className="h-8 w-8 shrink-0 sm:h-9 sm:w-9"
          >
            {theme === "dark" ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
          </Button>
          {user ? (
            <>
              <AccountAndOnboarding />
              <Button
                variant="ghost"
                size="icon"
                aria-label="Exit league"
                title="Exit league"
                onClick={() => setConfirmExitOpen(true)}
                className="h-8 w-8 shrink-0 sm:h-9 sm:w-9"
              >
                <LogOut className="h-4 w-4" />
              </Button>
              {exitConfirmModal}
            </>
          ) : (
            <Button asChild size="sm" className="ml-1 h-8 px-2.5 text-xs">
              <Link to="/auth">Sign in</Link>
            </Button>
          )}
        </nav>
      </div>
      <div className="hidden"><PushOptIn /></div>
      <div className="kerb-strip" />
    </header>
  );
}

export function BottomNav() {
  const sprintOn = useSprintWeek();
  const count = links.filter((l) => l.icon).length + (sprintOn ? 1 : 0);
  return (
    <>
      <div className="h-[calc(4rem+env(safe-area-inset-bottom))] md:hidden" />
      <nav
        className="fixed inset-x-0 bottom-0 z-50 grid border-t border-border bg-background/95 backdrop-blur md:hidden"
        style={{
          paddingBottom: "env(safe-area-inset-bottom)",
          gridTemplateColumns: `repeat(${count}, minmax(0, 1fr))`,
        }}
        aria-label="Main"
      >
        {links
          .filter((l) => l.icon)
          .map((l) => {
            const Icon = l.icon!;
            return (
              <Link
                key={l.to}
                to={l.to}
                activeOptions={{ exact: l.to === "/" }}
                className="flex h-16 touch-manipulation select-none flex-col items-center justify-center gap-1 font-mono text-[10px] font-bold uppercase tracking-wider text-muted-foreground active:bg-secondary/60 [&.active]:text-primary"
              >
                <Icon className="h-5 w-5" />
                {l.label}
              </Link>
            );
          })}
        {sprintOn && (
          <Link
            to="/sprint"
            className="flex h-16 touch-manipulation select-none flex-col items-center justify-center gap-1 font-mono text-[10px] font-bold uppercase tracking-wider text-muted-foreground active:bg-secondary/60 [&.active]:text-primary"
          >
            <Zap className="h-5 w-5" />
            Sprint
          </Link>
        )}
      </nav>
    </>
  );
}

export function FahlBadge() {
  return (
    <span
      dir="rtl"
      className="fahl-badge inline-flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-black not-italic leading-4"
      style={{ fontFamily: "Cairo, sans-serif" }}
    >
      👑 فحل الجولة
    </span>
  );
}
