import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { CalendarDays, Grid3x3, Home, LogOut, Moon, Sun, Swords, Trophy, Zap } from "lucide-react";

import { LogoHorizontal, LogoMark } from "@/components/Logo";
import { Button } from "@/components/ui/button";
import { useAuth } from "@/hooks/useAuth";
import { useTheme } from "@/hooks/useTheme";
import { racesQuery } from "@/lib/queries";
import { sprintWeekend } from "@/lib/sprint";

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

/** The Sprint tab exists only on sprint weekends. */
function useSprintWeek(): boolean {
  const { data: races } = useQuery(racesQuery);
  return !!races && !!sprintWeekend(races);
}

/** Kept so any other file that still imports HelmetLogo keeps working. */
export const HelmetLogo = LogoMark;

export function SiteHeader() {
  const { user, signOut } = useAuth();
  const { theme, setTheme } = useTheme();
  const sprintOn = useSprintWeek();

  const toggleTheme = () => {
    setTheme(theme === "dark" ? "light" : "dark");
  };

  return (
    <header className="sticky top-0 z-40 border-b border-border bg-background/90 backdrop-blur">
      <div className="mx-auto flex max-w-5xl items-center gap-3 px-4 py-2">
        <Link to="/" className="flex min-w-0 shrink items-center" aria-label="DOWNFORCE home">
          <LogoHorizontal className="h-8 w-auto max-w-full sm:h-10" />
        </Link>

        <nav className="ml-auto flex items-center gap-1">
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
          <Link to="/rules" className={DESKTOP_LINK}>
            Rules
          </Link>
          <Link
            to="/rules"
            className="rounded-sm px-2 py-1.5 font-mono text-xs font-semibold uppercase tracking-widest text-muted-foreground md:hidden [&.active]:text-primary"
          >
            Rules
          </Link>
          <Button
            variant="ghost"
            size="icon"
            aria-label="Toggle theme"
            onClick={toggleTheme}
            className="shrink-0"
          >
            {theme === "dark" ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
          </Button>
          {user ? (
            <Button variant="ghost" size="icon" aria-label="Sign out" onClick={() => signOut()}>
              <LogOut className="h-4 w-4" />
            </Button>
          ) : (
            <Button asChild size="sm" className="ml-1">
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
