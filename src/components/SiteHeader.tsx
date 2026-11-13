import { Link } from "@tanstack/react-router";
import {
  CalendarDays,
  ChevronDown,
  Grid3x3,
  Home,
  LogOut,
  Moon,
  Shield,
  Sun,
  Swords,
  Trophy,
} from "lucide-react";
import { useState } from "react";

import { AccountAndOnboarding } from "@/components/AccountAndOnboarding";
import { LogoHorizontal, LogoMark } from "@/components/Logo";
import { UpdatesFeed } from "@/components/UpdatesFeed";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { useAuth } from "@/hooks/useAuth";
import { useIsSteward } from "@/hooks/useIsSteward";
import { useTheme } from "@/hooks/useTheme";

const links = [
  { to: "/", label: "Paddock", icon: Home },
  { to: "/predict", label: "Predict", icon: Grid3x3 },
  { to: "/leaderboard", label: "Standings", icon: Trophy },
  { to: "/h2h", label: "1v1", icon: Swords },
  { to: "/weekend", label: "Weekend", icon: CalendarDays },
  { to: "/rules", label: "Rules", icon: null },
] as const;

const DESKTOP_LINK =
  "hidden rounded-sm px-2 py-1.5 font-mono text-xs font-semibold uppercase tracking-widest text-muted-foreground transition-colors hover:text-foreground hover:underline hover:decoration-border hover:underline-offset-[5px] lg:inline [&.active]:text-primary [&.active]:underline [&.active]:decoration-gold [&.active]:decoration-2 [&.active]:underline-offset-[5px]";

export const HelmetLogo = LogoMark;

export function SiteHeader() {
  const { user, signOut } = useAuth();
  const { theme, setTheme } = useTheme();
  const isSteward = useIsSteward();
  const [confirmExitOpen, setConfirmExitOpen] = useState(false);
  const [signingOut, setSigningOut] = useState(false);
  const [exploreOpen, setExploreOpen] = useState(false);

  const toggleTheme = () => {
    setTheme(theme === "dark" ? "light" : "dark");
  };

  async function handleConfirmExit() {
    setSigningOut(true);
    try {
      await signOut();
      setConfirmExitOpen(false);
    } finally {
      setSigningOut(false);
    }
  }

  const exitConfirmModal = (
    <Dialog
      open={confirmExitOpen}
      onOpenChange={(o) => {
        if (!signingOut) setConfirmExitOpen(o);
      }}
    >
      <DialogContent
        aria-describedby={undefined}
        className="carbon-panel relative max-w-sm overflow-hidden rounded-xl shadow-[0_24px_60px_rgba(0,0,0,0.85)] sm:rounded-xl"
      >
        <div className="pointer-events-none absolute -right-10 -top-10 h-28 w-28 rounded-full bg-primary/15 blur-2xl" />

        <div className="relative flex items-start justify-between gap-3">
          <div className="flex items-center gap-2.5">
            <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-primary/40 bg-primary/15 text-primary shadow-[0_0_16px_rgba(225,6,0,0.25)]">
              <LogOut className="h-5 w-5" />
            </span>
            <div>
              <p className="font-mono text-[11px] font-bold uppercase tracking-widest text-gold">
                Confirm Action
              </p>
              <DialogTitle className="mt-0.5 text-lg font-black uppercase tracking-wide text-foreground">
                Exit the League?
              </DialogTitle>
            </div>
          </div>
        </div>

        <p className="relative mt-3.5 text-xs leading-relaxed text-muted-foreground sm:text-sm">
          Are you sure you want to exit the league? You&apos;ll be signed out on this device, and
          you can sign back in anytime with your Google account.
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
      </DialogContent>
    </Dialog>
  );

  return (
    <header className="sticky top-0 z-40 w-full overflow-x-clip border-b border-border bg-background/95 pt-[env(safe-area-inset-top)] md:bg-background/90 md:backdrop-blur">
      <div className="mx-auto flex max-w-5xl items-center justify-between gap-1.5 px-3 py-2 sm:gap-2 sm:px-4">
        <Link to="/" className="flex min-w-0 shrink items-center" aria-label="DOWNFORCE home">
          <LogoHorizontal className="h-7 w-auto max-w-[140px] sm:h-10 sm:max-w-none" />
        </Link>

        <nav className="ml-auto flex shrink-0 items-center gap-0.5 sm:gap-1">
          <div
            className="relative hidden md:inline-flex lg:hidden"
            onKeyDown={(e) => {
              if (e.key === "Escape") setExploreOpen(false);
            }}
          >
            <button
              type="button"
              aria-haspopup="true"
              aria-expanded={exploreOpen}
              onClick={() => setExploreOpen((o) => !o)}
              className="hit-slop flex items-center gap-1.5 rounded-sm px-2 py-1.5 font-mono text-xs font-semibold uppercase tracking-widest text-muted-foreground transition-colors hover:text-foreground"
            >
              Explore
              <ChevronDown className="h-3.5 w-3.5" />
            </button>
            {exploreOpen && (
              <>
                <button
                  aria-hidden
                  tabIndex={-1}
                  className="fixed inset-0 z-40 cursor-default"
                  onClick={() => setExploreOpen(false)}
                />
                <div className="carbon-panel absolute right-0 top-full z-50 mt-2 w-44 rounded-xl p-1.5">
                  {links.map((l) => (
                    <Link
                      key={l.to}
                      to={l.to}
                      activeOptions={{ exact: l.to === "/" }}
                      onClick={() => setExploreOpen(false)}
                      className="block rounded-md px-3 py-2 font-mono text-xs font-semibold uppercase tracking-wider text-muted-foreground transition-colors hover:bg-secondary/60 hover:text-foreground [&.active]:text-primary"
                    >
                      {l.label}
                    </Link>
                  ))}
                  {isSteward && (
                    <Link
                      to="/stewards"
                      onClick={() => setExploreOpen(false)}
                      className="block rounded-md px-3 py-2 font-mono text-xs font-semibold uppercase tracking-wider text-gold transition-colors hover:bg-secondary/60"
                    >
                      Stewards
                    </Link>
                  )}
                </div>
              </>
            )}
          </div>
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
          {isSteward && (
            <Link to="/stewards" className={DESKTOP_LINK} style={{ color: "var(--gold)" }}>
              Stewards
            </Link>
          )}
          {isSteward && (
            <Button
              variant="ghost"
              size="icon"
              asChild
              className="hit-slop h-8 w-8 shrink-0 text-gold md:hidden"
              aria-label="Stewards"
            >
              <Link to="/stewards">
                <Shield className="h-4 w-4" />
              </Link>
            </Button>
          )}
          <Link
            to="/rules"
            className="hit-slop rounded-sm px-1.5 py-1 font-mono text-[11px] font-semibold uppercase tracking-wider text-muted-foreground transition-colors md:hidden lg:inline lg:px-2 lg:py-1.5 lg:text-xs lg:tracking-widest lg:hover:text-foreground lg:hover:underline lg:hover:decoration-border lg:hover:underline-offset-[5px] [&.active]:text-primary lg:[&.active]:underline lg:[&.active]:decoration-gold lg:[&.active]:decoration-2 lg:[&.active]:underline-offset-[5px]"
          >
            Rules
          </Link>
          <UpdatesFeed />
          <Button
            variant="ghost"
            size="icon"
            aria-label="Toggle theme"
            onClick={toggleTheme}
            className="hit-slop h-8 w-8 shrink-0 sm:h-9 sm:w-9"
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
                className="hit-slop h-8 w-8 shrink-0 sm:h-9 sm:w-9"
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
      <div className="kerb-strip" />
    </header>
  );
}

export function BottomNav() {
  const count = links.filter((l) => l.icon).length;
  return (
    <>
      <div className="h-[calc(4rem+env(safe-area-inset-bottom))] md:hidden" />
      <nav
        className="fixed inset-x-0 bottom-0 z-50 grid border-t border-border bg-background/95 md:hidden"
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
                className="flex h-16 touch-manipulation select-none flex-col items-center justify-center gap-1 font-mono text-[11px] font-bold uppercase tracking-wider text-muted-foreground active:bg-secondary/60 [&.active]:text-primary"
              >
                <Icon className="h-5 w-5" />
                {l.label}
              </Link>
            );
          })}
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
