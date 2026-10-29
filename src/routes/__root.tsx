import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  Outlet,
  Link,
  createRootRouteWithContext,
  useRouter,
  HeadContent,
  Scripts,
  type ErrorComponentProps,
} from "@tanstack/react-router";
import { useEffect, type ReactNode } from "react";

import appCss from "../styles.css?url";
import { reportLovableError } from "../lib/lovable-error-reporting";
import { BackgroundSync } from "@/components/BackgroundSync";
import { InstallPrompt } from "@/components/InstallPrompt";
import { OfflineIndicator } from "@/components/OfflineIndicator";
import { PullToRefresh } from "@/components/PullToRefresh";
import { SiteFooter } from "@/components/SiteFooter";
import { SiteHeader, BottomNav } from "@/components/SiteHeader";
import { Toaster } from "@/components/ui/sonner";
import { ErrorBoundary } from "@/components/ErrorBoundary";

function NotFoundComponent() {
  return (
    <div className="flex min-h-[75vh] flex-col items-center justify-center px-4 py-16 text-center">
      <div className="carbon-panel max-w-md rounded-2xl border border-border p-8 shadow-2xl">
        <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-full bg-gold/15 text-gold border border-gold/40">
          <span className="font-mono text-2xl font-black">404</span>
        </div>
        <p className="mt-4 font-mono text-xs font-bold uppercase tracking-[0.25em] text-primary">
          Yellow Flag · Car Off Track
        </p>
        <h1 className="mt-1 text-3xl sm:text-4xl">Gravel Trap!</h1>
        <p className="mt-3 text-sm leading-relaxed text-muted-foreground">
          You went off the racing line. The corner you are looking for does not exist or has been
          moved.
        </p>
        <div className="mt-6 flex justify-center gap-3">
          <Link
            to="/"
            className="inline-flex h-10 items-center justify-center rounded-md bg-primary px-5 font-mono text-xs font-bold uppercase tracking-wider text-primary-foreground transition-colors hover:bg-primary/90"
          >
            Rejoin the Paddock 🏁
          </Link>
          <Link
            to="/predict"
            className="inline-flex h-10 items-center justify-center rounded-md border border-border bg-secondary px-5 font-mono text-xs font-bold uppercase tracking-wider text-foreground transition-colors hover:bg-secondary/70"
          >
            Make Picks
          </Link>
        </div>
      </div>
    </div>
  );
}

function ErrorComponent({ error, reset }: ErrorComponentProps) {
  console.error(error);
  const router = useRouter();
  useEffect(() => {
    reportLovableError(error, { boundary: "tanstack_root_error_component" });
  }, [error]);

  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4">
      <div className="max-w-md text-center">
        <h1 className="text-xl font-semibold tracking-tight text-foreground">
          This page didn't load
        </h1>
        <p className="mt-2 text-sm text-muted-foreground">
          Something went wrong on our end. You can try refreshing or head back home.
        </p>
        <div className="mt-6 flex flex-wrap justify-center gap-2">
          <button
            onClick={() => {
              router.invalidate();
              reset();
            }}
            className="inline-flex items-center justify-center rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
          >
            Try again
          </button>
          <a
            href="/"
            className="inline-flex items-center justify-center rounded-md border border-input bg-background px-4 py-2 text-sm font-medium text-foreground transition-colors hover:bg-accent"
          >
            Go home
          </a>
        </div>
      </div>
    </div>
  );
}

export const Route = createRootRouteWithContext<{ queryClient: QueryClient }>()({
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      { name: "viewport", content: "width=device-width, initial-scale=1, viewport-fit=cover" },
      { title: "DOWNFORCE — Fantasy Racing League" },
      {
        name: "description",
        content:
          "Predict the top 10, pole, fastest lap and DNF of every Grand Prix. Score points and win the league.",
      },
      { property: "og:title", content: "DOWNFORCE — Fantasy Racing League" },
      {
        property: "og:description",
        content: "Call the grid. Beat your rivals. Take the top step.",
      },
      { property: "og:type", content: "website" },
      { property: "og:site_name", content: "DOWNFORCE" },
      { name: "twitter:card", content: "summary_large_image" },
      { name: "twitter:title", content: "DOWNFORCE — Fantasy Racing League" },
      {
        name: "twitter:description",
        content:
          "Predict the top 10, pole, fastest lap and DNF of every Grand Prix. Score points and win the league.",
      },
      { name: "theme-color", content: "#0E0E12" },
      { name: "apple-mobile-web-app-capable", content: "yes" },
      { name: "apple-mobile-web-app-status-bar-style", content: "black-translucent" },
      { name: "apple-mobile-web-app-title", content: "DOWNFORCE" },
    ],
    links: [
      {
        rel: "stylesheet",
        href: appCss,
      },
      { rel: "icon", href: "/favicon.svg", type: "image/svg+xml" },
      { rel: "icon", href: "/favicon.png", type: "image/png" },
      { rel: "manifest", href: "/manifest.webmanifest" },
      { rel: "apple-touch-icon", href: "/apple-touch-icon.png" },
      {
        rel: "preload",
        href: "/assets/fonts/archivo-roman-var.woff2",
        as: "font",
        type: "font/woff2",
        crossorigin: "anonymous",
      },
      {
        rel: "preload",
        href: "/assets/fonts/barlow-400.woff2",
        as: "font",
        type: "font/woff2",
        crossorigin: "anonymous",
      },
      {
        rel: "preload",
        href: "/assets/fonts/barlow-600.woff2",
        as: "font",
        type: "font/woff2",
        crossorigin: "anonymous",
      },
      {
        rel: "preload",
        href: "/assets/fonts/barlow-700.woff2",
        as: "font",
        type: "font/woff2",
        crossorigin: "anonymous",
      },
      {
        rel: "preload",
        href: "/assets/fonts/cairo-badge-var.woff2",
        as: "font",
        type: "font/woff2",
        crossorigin: "anonymous",
      },
    ],
  }),
  shellComponent: RootShell,
  component: RootComponent,
  notFoundComponent: NotFoundComponent,
  errorComponent: ErrorComponent,
});

function RootShell({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <head>
        <HeadContent />
      </head>
      <body>
        {children}
        <Scripts />
      </body>
    </html>
  );
}

function RootComponent() {
  const { queryClient } = Route.useRouteContext();

  useEffect(() => {
    if ("serviceWorker" in navigator) {
      navigator.serviceWorker.register("/sw.js").catch((error) => {
        console.error("[__root.tsx] Service Worker registration failed:", error);
      });
    }
  }, []);

  return (
    <QueryClientProvider client={queryClient}>
      <BackgroundSync />
      <InstallPrompt />
      <PullToRefresh />
      <OfflineIndicator />
      <div className="relative z-10 flex min-h-svh flex-col">
        <SiteHeader />
        <div className="flex-1">
          <ErrorBoundary>
            <Outlet />
          </ErrorBoundary>
        </div>
        <SiteFooter />
      </div>
      <BottomNav />
      <Toaster />
    </QueryClientProvider>
  );
}
