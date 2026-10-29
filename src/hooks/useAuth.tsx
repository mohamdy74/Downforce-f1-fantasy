import { useEffect, useState, useCallback } from "react";
import type { Session, User } from "@supabase/supabase-js";

import { supabase } from "@/integrations/supabase/client";

let _s: Session | null = null;
let _r = false;

if (typeof window !== "undefined") {
  try {
    const k = Object.keys(localStorage).find(
      (x) => x.startsWith("sb-") && x.endsWith("-auth-token"),
    );
    if (k) {
      const p = JSON.parse(localStorage.getItem(k) || "null");
      if (p?.user) {
        _s = p;
        _r = true;
      }
    }
  } catch (error) {
    console.error("[useAuth] Failed to read auth token from localStorage:", error);
  }
}

export function useAuth() {
  const [session, setSession] = useState<Session | null>(_s);
  const [loading, setLoading] = useState(!_r);

  useEffect(() => {
    const {
      data: { subscription: sub },
    } = supabase.auth.onAuthStateChange((_event, next) => {
      _s = next;
      _r = true;
      setSession(next);
      setLoading(false);
    });

    supabase.auth.getSession().then(({ data }) => {
      _s = data.session;
      _r = true;
      setSession(data.session);
      setLoading(false);
    });

    return () => {
      sub?.unsubscribe?.();
    };
  }, []);

  const signOut = useCallback(async () => {
    await supabase.auth.signOut();
    _s = null;
    _r = false;
  }, []);

  return { user: session?.user ?? null, session, loading, signOut };
}
