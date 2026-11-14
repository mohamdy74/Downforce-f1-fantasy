/** Top-10 completion guard shared by the PickStatus card and F1 scoring sync. */
export function isCompleteTop10(top10: unknown): boolean {
  return Array.isArray(top10) && top10.filter((x) => Boolean(x && x !== "__none__")).length === 10;
}
