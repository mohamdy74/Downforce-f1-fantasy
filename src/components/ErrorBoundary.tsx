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

  render() {
    const { error } = this.state;
    if (error) {
      return (
        <div className="flex min-h-[60vh] items-center justify-center p-4">
          <div className="carbon-panel max-w-md rounded-lg p-6 text-center">
            <h2 className="text-xl font-bold text-destructive">Something went wrong</h2>
            <p className="mt-2 text-sm text-muted-foreground">{error.message}</p>
            <Button onClick={() => this.setState({ error: null })} className="mt-4">
              Try again
            </Button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}
