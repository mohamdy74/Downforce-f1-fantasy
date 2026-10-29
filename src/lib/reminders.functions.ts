// Thin re-export aliases: the canonical implementations live in
// prediction.functions.ts (hardened with requireSupabaseAuth and a verified
// context userId). The duplicated copies that used to live here lacked the
// auth middleware and trusted a client-supplied user id for audit rows.
export { assertDeadlineOpen, logPredAudit } from "@/lib/prediction.functions";
