import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import type { Session, User } from "@supabase/supabase-js";

import { supabase } from "@/integrations/supabase/client";

type AuthSnapshot = {
  session: Session | null;
  loading: boolean;
};

function readCachedSession(): Session | null {
  if (typeof window === "undefined") return null;
  try {
    for (let i = 0; i < window.localStorage.length; i++) {
      const k = window.localStorage.key(i);
      if (k && k.startsWith("sb-") && k.endsWith("-auth-token")) {
        const raw = window.localStorage.getItem(k);
        if (!raw) continue;
        const parsed = JSON.parse(raw);
        const sess = parsed?.currentSession ?? parsed?.session ?? parsed;
        if (sess && typeof sess === "object" && sess.access_token && sess.user) {
          return sess as Session;
        }
      }
    }
  } catch {
    /* ignore storage errors */
  }
  return null;
}

const initialCached = readCachedSession();

let currentSnapshot: AuthSnapshot = {
  session: initialCached,
  loading: initialCached === null,
};

let initialized = false;
const listeners = new Set<(snap: AuthSnapshot) => void>();

function notify(next: AuthSnapshot) {
  currentSnapshot = next;
  for (const fn of listeners) fn(currentSnapshot);
}

function ensureAuthSubscription() {
  if (initialized || typeof window === "undefined") return;
  initialized = true;

  supabase.auth
    .getSession()
    .then(({ data }) => {
      notify({ session: data.session ?? null, loading: false });
    })
    .catch(() => {
      notify({ session: currentSnapshot.session, loading: false });
    });

  supabase.auth.onAuthStateChange((_event, nextSession) => {
    notify({ session: nextSession ?? null, loading: false });
  });
}

type AuthValue = {
  session: Session | null;
  user: User | null;
  loading: boolean;
  signOut: () => Promise<{ error: Error | null }>;
};

const AuthContext = createContext<AuthValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  ensureAuthSubscription();
  const [snap, setSnap] = useState<AuthSnapshot>(() => currentSnapshot);

  useEffect(() => {
    ensureAuthSubscription();
    setSnap(currentSnapshot);
    const listener = (next: AuthSnapshot) => setSnap(next);
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }, []);

  const value: AuthValue = {
    session: snap.session,
    user: snap.session?.user ?? null,
    loading: snap.loading,
    signOut: () => supabase.auth.signOut(),
  };

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthValue {
  const ctx = useContext(AuthContext);
  ensureAuthSubscription();
  const [snap, setSnap] = useState<AuthSnapshot>(() => currentSnapshot);

  useEffect(() => {
    if (ctx) return;
    ensureAuthSubscription();
    setSnap(currentSnapshot);
    const listener = (next: AuthSnapshot) => setSnap(next);
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }, [ctx]);

  if (ctx) return ctx;

  return {
    session: snap.session,
    user: snap.session?.user ?? null,
    loading: snap.loading,
    signOut: () => supabase.auth.signOut(),
  };
}
