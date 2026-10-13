import { Component, type ReactNode } from "react";

import { Button } from "./ui/button";

interface ErrorBoundaryProps {
  children: ReactNode;
}

interface ErrorBoundaryState {
  error: Error | null;
}

export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error) {
    if (typeof window !== "undefined" && /No QueryClient set|dynamically imported module|Failed to fetch/i.test(error.message)) {
      const key = "dfr:hmr-reload";
      const last = Number(sessionStorage.getItem(key) ?? "0");
      if (Date.now() - last > 5000) {
        sessionStorage.setItem(key, String(Date.now()));
        window.location.reload();
      }
    }
  }

  render() {
    const { error } = this.state;
    if (error) {
      return (
        <div className="flex min-h-[60vh] items-center justify-center p-4">
          <div className="carbon-panel max-w-md rounded-lg p-6 text-center">
            <h2 className="text-xl font-bold text-destructive">Something went wrong</h2>
            <p className="mt-2 text-sm text-muted-foreground">{error.message}</p>
            <Button onClick={() => window.location.reload()} className="mt-4">
              Try again
            </Button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}
