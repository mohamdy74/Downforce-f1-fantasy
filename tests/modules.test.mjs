import test from "node:test";
import assert from "node:assert/strict";

// Regression tests import the REAL production modules (the characterization
// copies in characterization.test.mjs pin the intended contract; these fail in
// CI if src/ itself regresses).

import {
  POSITION_POINTS,
  NO_SUBMISSION_PENALTY,
  positionPoints,
  scorePrediction,
} from "../src/lib/scoring.ts";
import { cleanVapidKey, isCompleteTop10, parsePushSubscriptionKey } from "../src/lib/push-keys.ts";
import {
  buildReminderPayload,
  computeActiveReminders,
  REMINDER_WINDOWS,
} from "../src/lib/reminder-windows.ts";

function rows() {
  const results = [];
  for (let i = 1; i <= 10; i++) {
    results.push({
      driver_id: "d" + i,
      position: i,
      finished: true,
      fastest_lap: i === 2,
      pole: i === 1,
    });
  }
  results.push({
    driver_id: "d11",
    position: null,
    finished: false,
    fastest_lap: false,
    pole: false,
  });
  results.push({
    driver_id: "d12",
    position: null,
    finished: false,
    fastest_lap: false,
    pole: false,
  });
  return results;
}

test("scoring.ts: position points ladder and penalty constant", () => {
  assert.deepEqual(POSITION_POINTS, { 0: 3, 1: 2, 2: 1, 3: -1, 4: -2 });
  assert.equal(NO_SUBMISSION_PENALTY, -25);
  assert.equal(positionPoints(0), 3);
  assert.equal(positionPoints(1), 2);
  assert.equal(positionPoints(2), 1);
  assert.equal(positionPoints(3), -1);
  assert.equal(positionPoints(4), -2);
  assert.equal(positionPoints(5), -3);
  assert.equal(positionPoints(99), -3);
});

test("scoring.ts: perfect weekend scores 52", () => {
  const b = scorePrediction(
    {
      top10: ["d1", "d2", "d3", "d4", "d5", "d6", "d7", "d8", "d9", "d10"],
      pole_driver_id: "d1",
      fastest_lap_driver_id: "d2",
      dnf_driver_id: "d11",
    },
    rows(),
  );
  assert.deepEqual(b, {
    top10: 30,
    pole: 3,
    fastestLap: 3,
    dnf: 1,
    perfect: 15,
    perfectTop10: true,
    perfectWeekend: true,
    total: 52,
  });
});

test("scoring.ts: partial and missed picks pay by the ladder", () => {
  // off-by-one prediction pays 2
  const offByOne = scorePrediction(
    { top10: ["d2"], pole_driver_id: null, fastest_lap_driver_id: null, dnf_driver_id: null },
    rows(),
  );
  assert.equal(offByOne.top10, 2);
  assert.equal(offByOne.total, 2);

  // a DNF driver (no finish position) pays -3
  const missed = scorePrediction(
    { top10: ["d11"], pole_driver_id: null, fastest_lap_driver_id: null, dnf_driver_id: null },
    rows(),
  );
  assert.equal(missed.top10, -3);

  // wrong pole / fastest lap / dnf pay 0
  const wrongExtras = scorePrediction(
    {
      top10: ["d1"],
      pole_driver_id: "d9",
      fastest_lap_driver_id: "d9",
      dnf_driver_id: "d1",
    },
    rows(),
  );
  assert.equal(wrongExtras.pole, 0);
  assert.equal(wrongExtras.fastestLap, 0);
  assert.equal(wrongExtras.dnf, 0);
});

test("scoring.ts: only the first 10 slots score", () => {
  const top10 = Array(10).fill("d12"); // 10 wrong picks...
  top10.push("d1"); // ...an 11th exact pick that must NOT count
  const b = scorePrediction(
    { top10, pole_driver_id: null, fastest_lap_driver_id: null, dnf_driver_id: null },
    rows(),
  );
  assert.equal(b.top10, -30);
  assert.equal(b.perfectTop10, false);
});

test("push-keys.ts: isCompleteTop10 accepts exactly 10 real driver ids", () => {
  const ids = ["a", "b", "c", "d", "e", "f", "g", "h", "i", "j"];
  assert.equal(isCompleteTop10(ids), true);
  assert.equal(isCompleteTop10(ids.slice(0, 9)), false);
  assert.equal(isCompleteTop10([...ids.slice(0, 9), "__none__"]), false);
  assert.equal(isCompleteTop10([...ids, "k"]), false); // 11 slots
  assert.equal(isCompleteTop10(null), false);
  assert.equal(isCompleteTop10(undefined), false);
  assert.equal(isCompleteTop10("abc"), false);
});

test("push-keys.ts: cleanVapidKey strips quotes and whitespace", () => {
  assert.equal(cleanVapidKey(undefined), "");
  assert.equal(cleanVapidKey('  "abc"  '), "abc");
  assert.equal(cleanVapidKey("'x'"), "x");
  assert.equal(cleanVapidKey("plain"), "plain");
});

test("push-keys.ts: parsePushSubscriptionKey round-trip and rejects malformed", () => {
  const key = 'push_sub:u1:{"endpoint":"https://e.example","keys":{"p256dh":"p256","auth":"a"}}';
  const rec = parsePushSubscriptionKey(key);
  assert.ok(rec);
  assert.equal(rec.userId, "u1");
  assert.equal(rec.endpoint, "https://e.example");
  assert.equal(rec.p256dh, "p256");
  assert.equal(rec.auth, "a");

  assert.equal(parsePushSubscriptionKey("garbage"), null);
  assert.equal(
    parsePushSubscriptionKey('push_sub:u2:{"endpoint":"https://e.example"}'), // missing keys
    null,
  );
});

// ---- reminder-windows.ts: the pure reminder scheduling core ----

test("reminder-windows.ts: window bands are the consolidated 2h (45-135m) and 30m (5-44m)", () => {
  assert.equal(REMINDER_WINDOWS.length, 2);
  assert.deepEqual(
    REMINDER_WINDOWS.map((w) => [w.label, w.minMs, w.maxMs, w.text]),
    [
      ["2h", 45 * 60_000, 135 * 60_000, "in ~2 hours"],
      ["30m", 5 * 60_000, 44 * 60_000, "in less than 30 minutes"],
    ],
  );
});

test("reminder-windows.ts: computeActiveReminders picks exactly the open band", () => {
  const now = 1_700_000_000_000; // fixed clock
  const MIN = 60_000;
  const iso = (ms) => new Date(now + ms).toISOString();
  const race = {
    id: "r19",
    name: "Mexico City Grand Prix",
    qualifying_at: iso(90 * MIN), // pole in 90m -> 2h band only
    race_at: iso(25 * MIN), // race in 25m -> 30m band only
  };

  const plan = computeActiveReminders([race], now);
  assert.equal(plan.length, 2);
  assert.deepEqual(
    plan.map((e) => [e.type, e.window.label]),
    [
      ["pole", "2h"],
      ["race", "30m"],
    ],
  );

  // 180 minutes out: no band is open
  const none = computeActiveReminders(
    [{ ...race, qualifying_at: null, race_at: iso(180 * MIN) }],
    now,
  );
  assert.equal(none.length, 0);

  // exactly 2h before the race: the single race-2h entry
  const two = computeActiveReminders(
    [{ ...race, qualifying_at: null, race_at: iso(120 * MIN) }],
    now,
  );
  assert.equal(two.length, 1);
  assert.deepEqual([two[0].type, two[0].window.label], ["race", "2h"]);
});

test("reminder-windows.ts: buildReminderPayload keeps the exact tone, tags and url", () => {
  const now = 1_700_000_000_000;
  const iso = (ms) => new Date(now + ms).toISOString();
  const race = {
    id: "r19",
    name: "Mexico City Grand Prix",
    qualifying_at: null,
    race_at: iso(25 * 60_000),
  };

  const finalCall = buildReminderPayload(computeActiveReminders([race], now)[0]);
  assert.equal(finalCall.title, "\u{1F6A8} Mexico City Grand Prix \u2014 Final Call!");
  assert.ok(finalCall.body.includes("\u221225 penalty"));
  assert.equal(finalCall.tag, "downforce-r19-race-30m");
  assert.equal(finalCall.url, "/predict");

  const qRace = {
    id: "r19",
    name: "Mexico City Grand Prix",
    qualifying_at: iso(90 * 60_000),
    race_at: null,
  };
  const pole = buildReminderPayload(computeActiveReminders([qRace], now)[0]);
  assert.equal(pole.title, "\u23F0 Mexico City Grand Prix \u2014 Lock Alert!");
  assert.equal(pole.body, "Qualifying starts in ~2 hours! Lock in your Pole Position pick now.");
  assert.equal(pole.tag, "downforce-r19-pole-2h");
});
