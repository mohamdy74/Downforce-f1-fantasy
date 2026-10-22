import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useLocation } from "@tanstack/react-router";
import { Bell, CheckCircle2, ShieldAlert, Sparkles, Trash2, Trophy, UserCog, X } from "lucide-react";
import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { useAuth } from "@/hooks/useAuth";
import { supabase } from "@/integrations/supabase/client";
import { VAPID_PUBLIC_KEY as PUBLIC_VAPID, urlBase64ToUint8Array } from "@/lib/push-keys";
import { deleteMyAccount, savePushSubscription, updateMyProfile } from "@/lib/stewards.functions";

export function AccountAndOnboarding() {
  const { user, signOut } = useAuth();
  const { pathname } = useLocation();
  const queryClient = useQueryClient();

  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<"onboarding" | "account">("account");
  const [step, setStep] = useState<1 | 2 | 3>(1);
  const [nameInput, setNameInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const { data: profile } = useQuery({
    queryKey: ["my-profile", user?.id],
    enabled: !!user?.id,
    staleTime: 5 * 60_000,
    queryFn: async () => {
      const { data } = await supabase
        .from("profiles")
        .select("id, display_name, created_at")
        .eq("id", user!.id)
        .maybeSingle();
      return data;
    },
  });

  useEffect(() => {
    if (profile?.display_name) {
      setNameInput(profile.display_name);
    }
  }, [profile?.display_name]);

  // Auto-close modal immediately whenever the user switches to another tab/route
  useEffect(() => {
    setOpen(false);
    setConfirmDelete(false);
  }, [pathname]);

  // Close modal when pressing Escape key on keyboard
  useEffect(() => {
    if (!open) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        markOnboarded();
        setOpen(false);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open, user?.id]);

  // Show 3-step onboarding automatically once for brand-new players
  useEffect(() => {
    if (!user?.id || !profile) return;
    try {
      const key = `dfr:onboarded:${user.id}`;
      if (window.localStorage.getItem(key)) return;
      const ageMs = Date.now() - new Date(profile.created_at).getTime();
      if (ageMs < 24 * 3600_000) {
        setMode("onboarding");
        setStep(1);
        setOpen(true);
      } else {
        window.localStorage.setItem(key, "1");
      }
    } catch {}
  }, [user?.id, profile]);

  if (!user) return null;

  function markOnboarded() {
    try {
      window.localStorage.setItem(`dfr:onboarded:${user!.id}`, "1");
    } catch {}
  }

  function closeModal() {
    markOnboarded();
    setOpen(false);
    setConfirmDelete(false);
  }

  async function handleSaveName(nextStepAfter = false) {
    if (!nameInput.trim()) {
      toast.error("Please enter a display name.");
      return;
    }
    setBusy(true);
    try {
      await updateMyProfile({ data: { displayName: nameInput.trim() } });
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["my-profile", user!.id] }),
        queryClient.invalidateQueries({ queryKey: ["profile-name", user!.id] }),
        queryClient.invalidateQueries({ queryKey: ["leaderboard"] }),
      ]);
      toast.success("Display name saved!");
      if (nextStepAfter) setStep(2);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to update name");
    } finally {
      setBusy(false);
    }
  }

  async function handleEnableAlerts() {
    setBusy(true);
    try {
      if (!("Notification" in window) || !("serviceWorker" in navigator)) {
        toast.error("Push alerts are not supported on this browser.");
        setStep(3);
        return;
      }
      const perm = await Notification.requestPermission();
      if (perm === "granted") {
        await navigator.serviceWorker.register("/sw.js");
        const readyReg = await navigator.serviceWorker.ready;
        let sub = await readyReg.pushManager.getSubscription();
        if (!sub) {
          sub = await readyReg.pushManager.subscribe({
            userVisibleOnly: true,
            applicationServerKey: urlBase64ToUint8Array(PUBLIC_VAPID),
          });
        }
        const json = sub.toJSON();
        if (json.endpoint && json.keys?.["p256dh"] && json.keys?.["auth"]) {
          await savePushSubscription({
            data: {
              endpoint: json.endpoint,
              p256dh: json.keys["p256dh"],
              auth: json.keys["auth"],
            },
          });
        }
        readyReg
          .showNotification("🏎️ DOWNFORCE Alerts Active!", {
            body: "You will be notified 2h & 30m before Qualifying and Race lock.",
            icon: "/favicon.png",
          })
          .catch(() => {});
        toast.success("Race alerts enabled!");
      }
      setStep(3);
    } catch {
      setStep(3);
    } finally {
      setBusy(false);
    }
  }

  async function handleDeleteAccount() {
    setBusy(true);
    try {
      await deleteMyAccount();
      toast.success("Your account and data have been permanently deleted.");
      setOpen(false);
      await signOut();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not delete account");
    } finally {
      setBusy(false);
    }
  }

  const modalContent =
    open && typeof document !== "undefined"
      ? createPortal(
          <div
            className="fixed inset-0 z-[100] flex items-center justify-center bg-black/80 p-4 backdrop-blur-sm"
            onClick={closeModal}
          >
            <div
              className="carbon-panel relative max-h-[88vh] w-full max-w-md overflow-y-auto rounded-2xl border border-border bg-card p-5 shadow-2xl"
              onClick={(e) => e.stopPropagation()}
            >
              {/* Top Header Row with Clear ESC Close Button */}
              <div className="mb-4 flex items-center justify-between gap-2 border-b border-border/60 pb-3">
                <div>
                  {mode === "onboarding" ? (
                    <div className="flex items-center gap-1.5 font-mono text-[11px] font-bold uppercase tracking-widest text-gold">
                      <Sparkles className="h-3.5 w-3.5" />
                      Welcome · Step {step} of 3
                    </div>
                  ) : (
                    <p className="font-mono text-[10px] font-bold uppercase tracking-widest text-gold">
                      Driver Profile &amp; Account
                    </p>
                  )}
                  <h2 className="mt-0.5 text-xl sm:text-2xl">
                    {mode === "onboarding"
                      ? step === 1
                        ? "Choose Your Driver Name"
                        : step === 2
                          ? "Never Take a −25 Penalty"
                          : "How Scoring Works"
                      : "Account Settings"}
                  </h2>
                </div>

                <button
                  type="button"
                  onClick={closeModal}
                  className="inline-flex shrink-0 items-center gap-1.5 rounded-lg border border-border bg-secondary/70 px-2.5 py-1.5 font-mono text-xs font-bold uppercase tracking-wider text-foreground transition-colors hover:border-primary hover:bg-primary/20"
                  aria-label="Close modal"
                >
                  <span>ESC</span>
                  <X className="h-3.5 w-3.5" />
                </button>
              </div>

              {mode === "onboarding" ? (
                <div className="space-y-4">
                  {step === 1 && (
                    <div className="space-y-3">
                      <p className="text-xs text-muted-foreground">
                        This is the name shown on the League Standings, Head-to-Head, and Share Cards.
                      </p>
                      <input
                        type="text"
                        value={nameInput}
                        onChange={(e) => setNameInput(e.target.value)}
                        placeholder="Your league display name"
                        className="h-11 w-full rounded-lg border border-input bg-background px-3 font-display text-sm font-bold uppercase"
                      />
                      <div className="flex gap-2 pt-1">
                        <Button className="flex-1" disabled={busy} onClick={() => handleSaveName(true)}>
                          Save &amp; Continue →
                        </Button>
                        <Button variant="ghost" onClick={() => setStep(2)}>
                          Skip
                        </Button>
                      </div>
                    </div>
                  )}

                  {step === 2 && (
                    <div className="space-y-3">
                      <p className="text-xs text-muted-foreground">
                        Enable instant phone notifications so we alert you <strong>2 hours</strong> and{" "}
                        <strong>30 minutes</strong> before Qualifying and Race lock if you haven&apos;t submitted yet.
                      </p>
                      <div className="flex gap-2 pt-2">
                        <Button className="flex-1 gap-2" disabled={busy} onClick={handleEnableAlerts}>
                          <Bell className="h-4 w-4 text-gold" />
                          Enable Race Alerts 🔔
                        </Button>
                        <Button variant="ghost" onClick={() => setStep(3)}>
                          Later
                        </Button>
                      </div>
                    </div>
                  )}

                  {step === 3 && (
                    <div className="space-y-3">
                      <div className="space-y-2 rounded-xl border border-border/70 bg-secondary/20 p-3 text-xs">
                        <div className="flex items-center justify-between">
                          <span>Exact Top 10 Position</span>
                          <strong className="font-mono text-success">+3 pts each</strong>
                        </div>
                        <div className="flex items-center justify-between">
                          <span>1 / 2 Positions Off</span>
                          <strong className="font-mono text-gold">+2 / +1 pt</strong>
                        </div>
                        <div className="flex items-center justify-between">
                          <span>Pole · Fastest Lap · DNF Bonus</span>
                          <strong className="font-mono text-primary">+3 · +3 · +1 pt</strong>
                        </div>
                        <div className="flex items-center justify-between">
                          <span>Missed Race Submission</span>
                          <strong className="font-mono text-destructive">−25 pts penalty</strong>
                        </div>
                      </div>
                      <Button className="w-full gap-2" onClick={closeModal}>
                        <CheckCircle2 className="h-4 w-4" />
                        Enter the Paddock 🏁
                      </Button>
                    </div>
                  )}
                </div>
              ) : (
                <div className="space-y-4">
                  <p className="font-mono text-xs text-muted-foreground">{user.email}</p>

                  <div className="space-y-1.5">
                    <label className="block font-mono text-[10px] font-bold uppercase tracking-widest text-muted-foreground">
                      League Display Name
                    </label>
                    <div className="flex gap-2">
                      <input
                        type="text"
                        value={nameInput}
                        onChange={(e) => setNameInput(e.target.value)}
                        className="h-10 min-w-0 flex-1 rounded-md border border-input bg-background px-3 text-sm font-bold"
                      />
                      <Button size="sm" className="h-10" disabled={busy} onClick={() => handleSaveName(false)}>
                        Save
                      </Button>
                    </div>
                  </div>

                  <div className="border-t border-border/60 pt-3">
                    <Button
                      size="sm"
                      variant="secondary"
                      className="w-full gap-1.5"
                      onClick={() => {
                        setMode("onboarding");
                        setStep(1);
                      }}
                    >
                      <Trophy className="h-3.5 w-3.5 text-gold" />
                      View Quick Onboarding Guide
                    </Button>
                  </div>

                  <div className="rounded-xl border border-destructive/30 bg-destructive/5 p-3">
                    <div className="flex items-center justify-between gap-2">
                      <div>
                        <p className="font-mono text-[11px] font-bold uppercase text-destructive">
                          Danger Zone
                        </p>
                        <p className="text-[11px] text-muted-foreground">
                          Permanently delete your account, predictions, and league scores.
                        </p>
                      </div>
                      {!confirmDelete ? (
                        <Button
                          size="sm"
                          variant="destructive"
                          className="shrink-0 gap-1"
                          onClick={() => setConfirmDelete(true)}
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                          Delete Account
                        </Button>
                      ) : (
                        <div className="flex shrink-0 gap-1.5">
                          <Button
                            size="sm"
                            variant="destructive"
                            disabled={busy}
                            onClick={handleDeleteAccount}
                          >
                            <ShieldAlert className="mr-1 h-3.5 w-3.5" />
                            Confirm
                          </Button>
                          <Button size="sm" variant="ghost" onClick={() => setConfirmDelete(false)}>
                            Cancel
                          </Button>
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              )}
            </div>
          </div>,
          document.body,
        )
      : null;

  return (
    <>
      <Button
        variant="ghost"
        size="icon"
        aria-label="Account settings"
        title="Driver Profile & Settings"
        onClick={() => {
          setMode("account");
          setConfirmDelete(false);
          setOpen((prev) => !prev);
        }}
        className="h-8 w-8 shrink-0 sm:h-9 sm:w-9"
      >
        <UserCog className="h-4 w-4" />
      </Button>
      {modalContent}
    </>
  );
}
