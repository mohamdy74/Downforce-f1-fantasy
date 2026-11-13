/**
 * Top-10 completion guard shared by the PickStatus card and F1 scoring sync.
 * Formerly the home of Web Push VAPID helpers; web push has been retired in
 * favour of Telegram reminders, so only this guard remains.
 */
export function isCompleteTop10(top10: unknown): boolean {
  return Array.isArray(top10) && top10.filter((x) => Boolean(x && x !== "__none__")).length === 10;
}
