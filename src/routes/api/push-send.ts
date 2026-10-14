import { checkAndSendRaceReminders } from "@/lib/push.functions";
export default async () => {
  try {
    const r = await checkAndSendRaceReminders({ data: {} });
    return new Response(JSON.stringify({ ok: true, ...r }), { headers: { "Content-Type": "application/json" } });
  } catch (e) {
    return new Response(JSON.stringify({ ok": false, error: (e as Error).message }), { status: 500 });
  }
};
