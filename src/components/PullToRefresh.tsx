import { useQueryClient } from "@tanstack/react-query";
import { useRouter } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { RefreshCw } from "lucide-react";

const PULL_THRESHOLD = 80;
const MAX_PULL = 120;

export function PullToRefresh() {
  const router = useRouter();
  const queryClient = useQueryClient();
  const [pullDistance, setPullDistance] = useState(0);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const startY = useRef(0);
  const isPulling = useRef(false);
  const pullRef = useRef(0);
  const refreshingRef = useRef(false);
  const lastRefreshTime = useRef(0);
  const rafRef = useRef(0);

  const MIN_REFRESH_INTERVAL = 5000;

  useEffect(() => {
    if (!("ontouchstart" in window)) return;

    const handleTouchStart = (e: TouchEvent) => {
      if (window.scrollY > 0 || refreshingRef.current) return;
      const target = e.target as HTMLElement | null;
      if (target?.closest("[role=\"dialog\"], [data-slot], .overflow-y-auto")) return;
      startY.current = e.touches[0]!.clientY;
      isPulling.current = true;
    };

    const handleTouchMove = (e: TouchEvent) => {
      if (!isPulling.current || refreshingRef.current) return;
      if (window.scrollY > 0) {
        isPulling.current = false;
        if (pullRef.current > 0) {
          pullRef.current = 0;
          setPullDistance(0);
        }
        return;
      }

      const currentY = e.touches[0]!.clientY;
      const distance = currentY - startY.current;

      if (distance <= 12) {
        if (pullRef.current > 0) {
          pullRef.current = 0;
          setPullDistance(0);
        }
        return;
      }

      const dampened = Math.min((distance - 12) * 0.5, MAX_PULL);
      pullRef.current = dampened;
      // Coalesce to at most one state update per animation frame so a fast
      // fling at the top of the page doesn't re-render on every touchmove.
      if (!rafRef.current) {
        rafRef.current = requestAnimationFrame(() => {
          rafRef.current = 0;
          setPullDistance(pullRef.current);
        });
      }

      if (distance > 20 && e.cancelable) {
        e.preventDefault();
      }
    };

    const handleTouchEnd = async () => {
      if (!isPulling.current) return;
      isPulling.current = false;

      const now = Date.now();
      if (now - lastRefreshTime.current < MIN_REFRESH_INTERVAL) {
        pullRef.current = 0;
        setPullDistance(0);
        return;
      }

      if (pullRef.current >= PULL_THRESHOLD && !refreshingRef.current) {
        refreshingRef.current = true;
        setIsRefreshing(true);
        pullRef.current = PULL_THRESHOLD;
        setPullDistance(PULL_THRESHOLD);
        lastRefreshTime.current = now;

        await router.invalidate();
        await queryClient.invalidateQueries({ queryKey: ["races"] });
        await queryClient.invalidateQueries({ queryKey: ["leaderboard"] });

        setTimeout(() => {
          refreshingRef.current = false;
          setIsRefreshing(false);
          pullRef.current = 0;
          setPullDistance(0);
        }, 400);
      } else if (pullRef.current > 0) {
        pullRef.current = 0;
        setPullDistance(0);
      }
    };

    document.addEventListener("touchstart", handleTouchStart, { passive: true });
    document.addEventListener("touchmove", handleTouchMove, { passive: true });
    document.addEventListener("touchend", handleTouchEnd, { passive: true });

    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      rafRef.current = 0;
      document.removeEventListener("touchstart", handleTouchStart, { capture: false });
      document.removeEventListener("touchmove", handleTouchMove, { capture: false });
      document.removeEventListener("touchend", handleTouchEnd, { capture: false });
    };
  }, [router]);

  if (pullDistance === 0) return null;

  const rotation = (pullDistance / PULL_THRESHOLD) * 360;
  const opacity = Math.min(pullDistance / PULL_THRESHOLD, 1);
  const scale = Math.min(pullDistance / PULL_THRESHOLD, 1);

  return (
    <div
      className="pointer-events-none fixed left-1/2 z-[100] flex -translate-x-1/2 items-center justify-center"
      style={{
        top: `${Math.min(pullDistance, PULL_THRESHOLD)}px`,
        opacity,
        transform: `translateX(-50%) scale(${scale})`,
        transition: isRefreshing ? "top 0.2s ease, opacity 0.2s ease" : "none",
      }}
    >
      <div className="flex h-12 w-12 items-center justify-center rounded-full bg-primary/90 shadow-lg backdrop-blur">
        <RefreshCw
          className="h-5 w-5 text-primary-foreground"
          style={{
            transform: `rotate(${rotation}deg)`,
            animation: isRefreshing ? "spin 1s linear infinite" : "none",
          }}
        />
      </div>
    </div>
  );
}
