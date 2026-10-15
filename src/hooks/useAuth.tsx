import { useEffect, useState } from "react";
import type { Session, User } from "@supabase/supabase-js";

import { supabase } from "@/integrations/supabase/client";

type AuthSnapshot = {
  session: Session | null;
  loading: boolean;
};

let currentSnapshot: AuthSnapshot = {
  session: null,
  loading: true,
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
      notify({ session: null, loading: false });
    });

  supabase.auth.onAuthStateChange((_event, nextSession) => {
    notify({ session: nextSession ?? null, loading: false });
  });
}

export function useAuth() {
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

  const user: User | null = snap.session?.user ?? null;
  return {
    session: snap.session,
    user,
    loading: snap.loading,
    signOut: () => supabase.auth.signOut(),
  };
}
