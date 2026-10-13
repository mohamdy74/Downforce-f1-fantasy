import { useEffect, useState } from "react";
import type { Session, User } from "@supabase/supabase-js";

import { supabase } from "@/integrations/supabase/client";

let _s: Session | null = null; let _r = false; export function useAuth() {
  const [session, setSession] = useState<Session | null>(_s);
  const [loading, setLoading] = useState(!_r);

  useEffect(() => {
    const { data: sub } = supabase.auth.onAuthStateChange((_event, next) => {
      _s = next; _r = true; setSession(next);
      setLoading(false);
    });

    supabase.auth.getSession().then(({ data }) => {
      _s = data.session; _r = true; setSession(data.session);
      setLoading(false);
    });

    return () => sub.subscription.unsubscribe();
  }, []);

  const user: User | null = session?.user ?? null;
  return { session, user, loading, signOut: () => supabase.auth.signOut() };
}
