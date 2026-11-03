import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";

type LegalKind = "privacy" | "terms";

export function LegalDialog({
  kind,
  onOpenChange,
}: {
  kind: LegalKind | null;
  onOpenChange: (kind: LegalKind | null) => void;
}) {
  return (
    <Dialog open={kind !== null} onOpenChange={(o) => onOpenChange(o ? kind : null)}>
      <DialogContent
        aria-describedby={undefined}
        className="carbon-panel relative max-h-[82vh] max-w-lg overflow-y-auto rounded-xl border-border shadow-2xl sm:rounded-xl"
      >
        {kind === "privacy" ? (
          <div className="space-y-3 text-xs leading-relaxed text-muted-foreground">
            <p className="font-mono text-[10px] font-bold uppercase tracking-widest text-gold">
              Legal &amp; Privacy
            </p>
            <DialogTitle className="text-2xl text-foreground">Privacy Policy</DialogTitle>
            <p>
              <strong>1. Data We Collect:</strong> When you sign in with Google OAuth, we store only
              your account identifier, email address (for authentication), display name, and profile
              avatar to display your position on the league leaderboard.
            </p>
            <p>
              <strong>2. Push Notifications:</strong> If you opt in to race lock alerts, your
              browser&apos;s encrypted Web Push endpoint is stored solely to send automated 2h and
              30m race deadline reminders.
            </p>
            <p>
              <strong>3. No Third-Party Selling or Tracking:</strong> DOWNFORCE is a private,
              non-profit fan project. We never sell, rent, or share your personal data with
              advertisers or third parties.
            </p>
            <p>
              <strong>4. Account &amp; Data Deletion:</strong> You can permanently delete your
              account, predictions, and scores at any time using the <em>Account Settings</em>{" "}
              button in the top navigation bar.
            </p>
          </div>
        ) : (
          <div className="space-y-3 text-xs leading-relaxed text-muted-foreground">
            <p className="font-mono text-[10px] font-bold uppercase tracking-widest text-gold">
              League Regulations
            </p>
            <DialogTitle className="text-2xl text-foreground">Terms of Use</DialogTitle>
            <p>
              <strong>1. Non-Profit Fan Game:</strong> DOWNFORCE is a free-to-play, non-commercial
              fantasy prediction league created for entertainment among friends. No real money,
              gambling, or wagering is involved.
            </p>
            <p>
              <strong>2. Deadlines &amp; Fair Play:</strong> Pole position picks lock automatically
              at the start of Qualifying, and Race Top 10 / Fastest Lap / DNF picks lock at the
              official Race start time. Registered players who fail to submit a complete Top 10
              receive a −25 point penalty for that round.
            </p>
            <p>
              <strong>3. FIA Stewards Decisions:</strong> League Stewards may adjust lock times in
              the event of real-world session delays (such as red flags or weather) or waive
              penalties in documented technical emergencies.
            </p>
            <p>
              <strong>4. Intellectual Property Disclaimer:</strong> This project is unofficial and
              is not associated in any way with the Formula 1 companies, the FIA, or any F1 team.
            </p>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
