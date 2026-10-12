import { ErrorBoundary as ReactErrorBoundary } from "react-error-boundary";
import { Button } from "./ui/button";

interface ErrorFallbackProps {
  error: Error;
  resetErrorBoundary: () => void;
}

function ErrorFallback({ error, resetErrorBoundary }: ErrorFallbackProps) {
  return (
    <div className="flex min-h-screen items-center justify-center p-4">
      <div className="carbon-panel max-w-md rounded-lg p-6 text-center">
        <h2 className="text-xl font-bold text-destructive">Something went wrong</h2>
        <p className="mt-2 text-sm text-muted-foreground">{error.message}</p>
        <Button onClick={resetErrorBoundary} className="mt-4">
          Try again
        </Button>
      </div>
    </div>
  );
}

interface ErrorBoundaryProps {
  children: React.ReactNode;
}

export function ErrorBoundary({ children }: ErrorBoundaryProps) {
  return (
    <ReactErrorBoundary FallbackComponent={ErrorFallback}>
      {children}
    </ReactErrorBoundary>
  );
}
