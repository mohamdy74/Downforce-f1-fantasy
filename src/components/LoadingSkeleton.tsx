import { cn } from "@/lib/utils";

/**
 * Single shimmer block — the shared primitive every skeleton in the app is
 * composed from. Uses the design-system .skeleton-shimmer class (pulsing
 * gradient, light/dark aware, and disabled under prefers-reduced-motion
 * via the global rule in styles.css).
 */
export function Skeleton({ className }: { className?: string }) {
  return <div aria-hidden="true" className={cn("skeleton-shimmer rounded", className)} />;
}

interface LoadingSkeletonProps {
  className?: string;
  rows?: number;
  showHeader?: boolean;
}

/**
 * Generic loading skeleton for tables/lists
 * Shows shimmer effect with configurable rows
 */
export function LoadingSkeleton({ className, rows = 5, showHeader = false }: LoadingSkeletonProps) {
  return (
    <div
      role="status"
      aria-busy="true"
      aria-label="Loading content"
      className={cn("space-y-2", className)}
    >
      {showHeader && (
        <div className="flex items-center justify-between gap-4 px-3 py-2.5">
          <div className="skeleton-shimmer h-5 w-32 rounded" />
          <div className="skeleton-shimmer h-5 w-20 rounded" />
        </div>
      )}
      {Array.from({ length: rows }).map((_, idx) => (
        <div key={idx} className="flex items-center gap-3 rounded-md px-3 py-2.5">
          <div className="skeleton-shimmer h-7 w-7 rounded-full" />
          <div className="min-w-0 flex-1 space-y-1.5">
            <div className="skeleton-shimmer h-4 w-3/4 rounded" />
            <div className="skeleton-shimmer h-3 w-1/2 rounded" />
          </div>
          <div className="skeleton-shimmer h-4 w-12 rounded" />
        </div>
      ))}
    </div>
  );
}

/**
 * Skeleton for tower-row lists (weekend classifications, standings, debrief
 * rows). Mirrors the real tower-row geometry — position block, two text
 * lines, right-hand value — so swapping in real rows causes no layout shift.
 */
export function TowerRowsSkeleton({ rows = 6, className }: { rows?: number; className?: string }) {
  return (
    <div
      role="status"
      aria-busy="true"
      aria-label="Loading classification"
      className={cn("space-y-1.5", className)}
    >
      {Array.from({ length: rows }).map((_, idx) => (
        <div key={idx} className="tower-row flex items-center gap-3 rounded-md px-3 py-2">
          <Skeleton className="h-5 w-8 shrink-0" />
          <div className="min-w-0 flex-1 space-y-1.5">
            <Skeleton className="h-4 w-28" />
            <Skeleton className="h-3 w-20" />
          </div>
          <Skeleton className="h-4 w-14 shrink-0" />
        </div>
      ))}
    </div>
  );
}

/**
 * Card-style loading skeleton for panels
 */
export function CardLoadingSkeleton({
  className,
  lines = 3,
}: {
  className?: string;
  lines?: number;
}) {
  return (
    <div
      role="status"
      aria-busy="true"
      aria-label="Loading"
      className={cn("carbon-panel rounded-xl border border-border p-6", className)}
    >
      <div className="space-y-3">
        {Array.from({ length: lines }).map((_, idx) => (
          <div
            key={idx}
            className={cn("skeleton-shimmer rounded", idx === 0 ? "h-6 w-1/2" : "h-4 w-full")}
          />
        ))}
      </div>
    </div>
  );
}

/**
 * Stats card loading skeleton
 */
export function StatsLoadingSkeleton({
  count = 4,
  className,
}: {
  count?: number;
  className?: string;
}) {
  return (
    <div
      role="status"
      aria-busy="true"
      aria-label="Loading statistics"
      className={cn("grid gap-2 sm:grid-cols-2 lg:grid-cols-4", className)}
    >
      {Array.from({ length: count }).map((_, idx) => (
        <div key={idx} className="carbon-panel rounded-lg border border-border p-4 text-center">
          <div className="skeleton-shimmer mx-auto h-4 w-20 rounded" />
          <div className="skeleton-shimmer mx-auto mt-2 h-6 w-16 rounded" />
        </div>
      ))}
    </div>
  );
}
