import { useEffect, useState } from "react";

/**
 * Hook to detect online/offline status
 * Returns current status and last change timestamp
 */
export function useOffline() {
  const [isOffline, setIsOffline] = useState(!navigator.onLine);
  const [lastChanged, setLastChanged] = useState(Date.now());

  useEffect(() => {
    const handleOnline = () => {
      setIsOffline(false);
      setLastChanged(Date.now());
    };
    const handleOffline = () => {
      setIsOffline(true);
      setLastChanged(Date.now());
    };

    window.addEventListener("online", handleOnline);
    window.addEventListener("offline", handleOffline);

    return () => {
      window.removeEventListener("online", handleOnline);
      window.removeEventListener("offline", handleOffline);
    };
  }, []);

  return { isOffline, lastChanged };
}
