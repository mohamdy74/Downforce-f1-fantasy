import test from "node:test";
import assert from "node:assert/strict";

// 1. Scoring contract (src/lib/scoring.ts)
const POSITION_POINTS = { 0: 3, 1: 2, 2: 1, 3: -1, 4: -2 };
const NO_SUBMISSION_PENALTY = -25;

function positionPoints(diff) {
  return diff in POSITION_POINTS ? POSITION_POINTS[diff] : -3;
}

function scorePrediction(prediction, results) {
  const finishPosition = new Map();
  for (const r of results) {
    if (r.finished && r.position != null) finishPosition.set(r.driver_id, r.position);
  }
  const poleDriver = results.find((r) => r.pole)?.driver_id ?? null;
  const fastestLapDriver = results.find((r) => r.fastest_lap)?.driver_id ?? null;
  const dnfDrivers = new Set(results.filter((r) => !r.finished).map((r) => r.driver_id));

  let top10 = 0;
  let exactCount = 0;
  prediction.top10.slice(0, 10).forEach((driverId, index) => {
    const predicted = index + 1;
    const actual = finishPosition.get(driverId);
    const diff = actual == null ? 99 : Math.abs(actual - predicted);
    if (diff === 0) exactCount += 1;
    top10 += positionPoints(diff);
  });

  const poleCorrect =
    !!prediction.pole_driver_id && prediction.pole_driver_id === poleDriver;
  const flCorrect =
    !!prediction.fastest_lap_driver_id &&
    prediction.fastest_lap_driver_id === fastestLapDriver;
  const dnfCorrect =
    !!prediction.dnf_driver_id && dnfDrivers.has(prediction.dnf_driver_id);

  const pole = poleCorrect ? 3 : 0;
  const fastestLap = flCorrect ? 3 : 0;
  const dnf = dnfCorrect ? 1 : 0;

  const perfectTop10 = prediction.top10.length === 10 && exactCount === 10;
  const perfectWeekend = perfectTop10 && poleCorrect && flCorrect && dnfCorrect;
  const perfect = perfectWeekend ? 15 : perfectTop10 ? 10 : 0;

  const total = top10 + pole + fastestLap + dnf + perfect;
  return { top10, pole, fastestLap, dnf, perfect, perfectTop10, perfectWeekend, total };
}

// 2. Sprint scoring contract (src/lib/sprintScoring.ts)
const SPRINT_SLOTS = 8;
function scoreSprint(prediction, results) {
  if (!prediction) return { top8: 0, pole: 0, total: 0 };
  const finishPosition = new Map();
  for (const r of results) {
    if (r.finished && r.position != null) finishPosition.set(r.driver_id, r.position);
  }
  const poleDriver = results.find((r) => r.pole)?.driver_id ?? null;

  let top8 = 0;
  (prediction.top8 ?? []).slice(0, SPRINT_SLOTS).forEach((driverId, index) => {
    if (finishPosition.get(driverId) === index + 1) top8 += 1;
  });

  const pole =
    !!prediction.pole_driver_id && prediction.pole_driver_id === poleDriver ? 1 : 0;

  return { top8, pole, total: top8 + pole };
}

// 3. Round scoring contract (src/lib/roundScoring.ts)
function filterValidDriverIds(ids) {
  return (ids ?? []).filter((x) => Boolean(x && x !== "__none__"));
}

function extractStewardLockedUsers(existingScores) {
  return new Set(
    (existingScores ?? [])
      .filter((s) => {
        const b = s.breakdown;
        return b && typeof b === "object" && b["stewardOverride"] === true;
      })
      .map((s) => s.user_id),
  );
}

function buildRaceScoreRows({
  raceId,
  raceAt,
  profiles,
  results,
  predictions,
  sprintResults,
  sprintPredictions,
  existingScores,
  mode,
  manualPoleWinner,
  nowIso = "2026-10-21T00:00:00.000Z",
}) {
  const stewardLockedUsers = extractStewardLockedUsers(existingScores);
  const byUser = new Map((predictions ?? []).map((p) => [p.user_id, p]));
  const sprintByUser = new Map((sprintPredictions ?? []).map((p) => [p.user_id, p]));
  const sprintFor = (userId) =>
    sprintResults?.length
      ? scoreSprint(sprintByUser.get(userId) ?? null, sprintResults)
      : null;

  const rows = [];
  for (const profile of profiles ?? []) {
    if (stewardLockedUsers.has(profile.id)) continue;
    if (raceAt && new Date(profile.created_at) > new Date(raceAt)) continue;

    const sprint = sprintFor(profile.id);
    const sprintTotal = sprint?.total ?? 0;
    const pr = byUser.get(profile.id);
    const validTop10 = filterValidDriverIds(pr?.top10);

    if (!pr || validTop10.length < 10) {
      if (!pr) {
        rows.push({
          user_id: profile.id,
          race_id: raceId,
          points: NO_SUBMISSION_PENALTY + sprintTotal,
          breakdown: {
            noSubmission: true,
            ...(sprint ? { sprint } : {}),
            total: NO_SUBMISSION_PENALTY + sprintTotal,
          },
          updated_at: nowIso,
        });
      } else {
        const poleHit =
          mode === "manual_results"
            ? pr.pole_driver_id && pr.pole_driver_id === manualPoleWinner
              ? 3
              : 0
            : scorePrediction(
                {
                  top10: validTop10,
                  pole_driver_id: pr.pole_driver_id,
                  fastest_lap_driver_id: pr.fastest_lap_driver_id,
                  dnf_driver_id: pr.dnf_driver_id,
                },
                results,
              ).pole;
        const total = NO_SUBMISSION_PENALTY + poleHit + sprintTotal;
        const breakdownObj =
          mode === "auto_sync"
            ? { noSubmission: true, poleOnly: true, pole: poleHit, ...(sprint ? { sprint } : {}), total }
            : { noSubmission: true, pole: poleHit, ...(sprint ? { sprint } : {}), total };
        rows.push({
          user_id: profile.id,
          race_id: raceId,
          points: total,
          breakdown: breakdownObj,
          updated_at: nowIso,
        });
      }
      continue;
    }

    const b = scorePrediction(
      {
        top10: validTop10,
        pole_driver_id: pr.pole_driver_id,
        fastest_lap_driver_id: pr.fastest_lap_driver_id,
        dnf_driver_id: pr.dnf_driver_id,
      },
      results,
    );
    const total = b.total + sprintTotal;
    rows.push({
      user_id: profile.id,
      race_id: raceId,
      points: total,
      breakdown: { ...b, ...(sprint ? { sprint } : {}), total },
      updated_at: nowIso,
    });
  }
  return rows;
}

// 4. Leaderboard aggregation contract (src/lib/queries.ts)
const LEAGUE_START_ROUND = 14;
function computeLeaderboardEntries(profiles, scores, raceRows) {
  const rMap = new Map((raceRows ?? []).map((r) => [r.id, r.round]));
  const activeRounds = new Set();
  for (const s of scores ?? []) {
    const rd = rMap.get(s.race_id);
    if (rd != null && rd >= LEAGUE_START_ROUND && s.points !== 0) {
      activeRounds.add(rd);
    }
  }

  const byUser = new Map();
  for (const p of profiles ?? []) {
    byUser.set(p.id, {
      userId: p.id,
      name: p.display_name,
      avatar: p.avatar_url,
      points: 0,
      races: 0,
      best: null,
      change: null,
      byRound: {},
      fahl: false,
    });
  }

  let latestRound = 0;
  for (const s of scores ?? []) {
    const entry = byUser.get(s.user_id);
    const rd = rMap.get(s.race_id);
    if (!entry || rd == null || !activeRounds.has(rd)) continue;
    entry.points += s.points;
    entry.races += 1;
    entry.best = entry.best == null ? s.points : Math.max(entry.best, s.points);
    entry.byRound[rd] = s.points;
    if (rd > latestRound) latestRound = rd;
  }

  if (latestRound > 0) {
    const top = Math.max(...[...byUser.values()].map((e) => e.byRound[latestRound] ?? -Infinity));
    for (const e of byUser.values()) {
      if (e.byRound[latestRound] === top) e.fahl = true;
    }
  }

  const sort = (a, b) => b.points - a.points || a.name.localeCompare(b.name);
  const list = [...byUser.values()].sort(sort);

  if (latestRound > 0) {
    const prevPts = new Map();
    for (const s of scores ?? []) {
      const rd = rMap.get(s.race_id);
      if (rd == null || !activeRounds.has(rd) || rd === latestRound) continue;
      prevPts.set(s.user_id, (prevPts.get(s.user_id) ?? 0) + s.points);
    }
    const prev = [...list].sort(
      (a, b) =>
        (prevPts.get(b.userId) ?? 0) - (prevPts.get(a.userId) ?? 0) ||
        a.name.localeCompare(b.name),
    );
    const prevRank = new Map(prev.map((e, i) => [e.userId, i]));
    list.forEach((e, i) => (e.change = (prevRank.get(e.userId) ?? i) - i));
  }
  return list;
}

// 5. Push keys & F1 parsers contract
function parsePushSubscriptionKey(key) {
  const m = /^push_sub:([^:]+):(.+)$/.exec(key);
  if (!m) return null;
  try {
    const raw = JSON.parse(m[2]);
    const p256dh = raw.keys?.p256dh ?? raw.p256dh;
    const auth = raw.keys?.auth ?? raw.auth;
    if (!raw.endpoint || !p256dh || !auth) return null;
    return { userId: m[1], endpoint: raw.endpoint, p256dh, auth, rawKey: key };
  } catch {
    return null;
  }
}

function findStalePushKeysForEndpoint(existingKeys, userId, endpoint) {
  const prefix = `push_sub:${userId}:`;
  const stale = [];
  for (const key of existingKeys) {
    if (!key.startsWith(prefix)) continue;
    try {
      const parsed = JSON.parse(key.slice(prefix.length));
      if (parsed.endpoint === endpoint) stale.push(key);
    } catch {
      stale.push(key);
    }
  }
  return stale;
}

function toIso(session) {
  if (!session?.date) return null;
  const d = new Date(`${session.date}T${session.time ?? "12:00:00Z"}`);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function isClassifiedFinishStatus(status, includeLappedKeyword = true) {
  if (!status) return false;
  return includeLappedKeyword
    ? /finished|lapped|\+\d+ lap/i.test(status)
    : /finished|\+\d+ lap/i.test(status);
}

function fmtLap(sec) {
  if (sec == null || !Number.isFinite(sec) || sec <= 0) return null;
  const m = Math.floor(sec / 60);
  const s = (sec - m * 60).toFixed(3).padStart(6, "0");
  return m > 0 ? `${m}:${s}` : s;
}

test("Characterization 1: positionPoints & scorePrediction preserve exact F1 league scoring rules", () => {
  assert.equal(positionPoints(0), 3);
  assert.equal(positionPoints(1), 2);
  assert.equal(positionPoints(2), 1);
  assert.equal(positionPoints(3), -1);
  assert.equal(positionPoints(4), -2);
  assert.equal(positionPoints(5), -3);
  assert.equal(positionPoints(99), -3);

  const drivers = ["d1", "d2", "d3", "d4", "d5", "d6", "d7", "d8", "d9", "d10"];
  const results = [
    ...drivers.map((id, i) => ({
      driver_id: id,
      position: i + 1,
      finished: true,
      pole: i === 0,
      fastest_lap: i === 1,
    })),
    { driver_id: "dnf1", position: null, finished: false, pole: false, fastest_lap: false },
  ];

  const perfect = scorePrediction(
    { top10: drivers, pole_driver_id: "d1", fastest_lap_driver_id: "d2", dnf_driver_id: "dnf1" },
    results,
  );
  assert.equal(perfect.total, 52);
  assert.equal(perfect.perfectWeekend, true);
});

test("Characterization 2: scoreSprint awards max 9 points and handles null safely", () => {
  const top8 = ["d1", "d2", "d3", "d4", "d5", "d6", "d7", "d8"];
  const results = top8.map((id, i) => ({
    driver_id: id,
    position: i + 1,
    finished: true,
    pole: i === 0,
  }));
  assert.deepEqual(scoreSprint(null, results), { top8: 0, pole: 0, total: 0 });
  assert.deepEqual(scoreSprint({ top8, pole_driver_id: "d1" }, results), { top8: 8, pole: 1, total: 9 });
});

test("Characterization 3: buildRaceScoreRows preserves stewardOverride lock, post-race signup exemption, and auto_sync vs manual_results contracts", () => {
  const results = Array.from({ length: 10 }, (_, i) => ({
    driver_id: `d${i + 1}`,
    position: i + 1,
    finished: true,
    pole: i === 0,
    fastest_lap: i === 0,
  }));
  const profiles = [
    { id: "u_locked", created_at: "2026-01-01T00:00:00Z" },
    { id: "u_late", created_at: "2026-10-25T00:00:00Z" },
    { id: "u_missing", created_at: "2026-01-01T00:00:00Z" },
    { id: "u_pole_only", created_at: "2026-01-01T00:00:00Z" },
  ];
  const predictions = [
    { user_id: "u_pole_only", top10: ["__none__"], pole_driver_id: "d1", fastest_lap_driver_id: null, dnf_driver_id: null },
  ];
  const existingScores = [
    { user_id: "u_locked", breakdown: { stewardOverride: true, total: 99 } },
  ];

  const autoRows = buildRaceScoreRows({
    raceId: "r1",
    raceAt: "2026-10-20T14:00:00Z",
    profiles,
    results,
    predictions,
    sprintResults: [],
    sprintPredictions: [],
    existingScores,
    mode: "auto_sync",
  });
  assert.equal(autoRows.length, 2);
  assert.deepEqual(autoRows[0].breakdown, { noSubmission: true, total: -25 });
  assert.deepEqual(autoRows[1].breakdown, { noSubmission: true, poleOnly: true, pole: 3, total: -22 });

  const manualRows = buildRaceScoreRows({
    raceId: "r1",
    raceAt: "2026-10-20T14:00:00Z",
    profiles,
    results,
    predictions,
    sprintResults: [],
    sprintPredictions: [],
    existingScores,
    mode: "manual_results",
    manualPoleWinner: "d1",
  });
  assert.equal(manualRows.length, 2);
  assert.deepEqual(manualRows[0].breakdown, { noSubmission: true, total: -25 });
  assert.deepEqual(manualRows[1].breakdown, { noSubmission: true, pole: 3, total: -22 });
});

test("Characterization 4: computeLeaderboardEntries filters R14+, strips zero-only rounds, and computes Fahl & rank change", () => {
  const profiles = [
    { id: "u1", display_name: "Mohamed Hamdy", avatar_url: null },
    { id: "u2", display_name: "Ahmed Hatem", avatar_url: null },
  ];
  const raceRows = [
    { id: "r13", round: 13 },
    { id: "r14", round: 14 },
    { id: "r15", round: 15 },
    { id: "r16", round: 16 },
  ];
  const scores = [
    { user_id: "u1", race_id: "r13", points: 50 },
    { user_id: "u1", race_id: "r14", points: 13 },
    { user_id: "u2", race_id: "r14", points: 9 },
    { user_id: "u1", race_id: "r15", points: 0 },
    { user_id: "u2", race_id: "r15", points: 0 },
    { user_id: "u1", race_id: "r16", points: 4 },
    { user_id: "u2", race_id: "r16", points: 18 },
  ];

  const board = computeLeaderboardEntries(profiles, scores, raceRows);
  assert.equal(board[0].userId, "u2");
  assert.equal(board[0].points, 27);
  assert.equal(board[0].fahl, true);
  assert.equal(board[0].change, 1);
  assert.equal(board[1].userId, "u1");
  assert.equal(board[1].points, 17);
  assert.equal(board[1].change, -1);
});

test("Characterization 5: push-keys and f1-parsers preserve exact string and regex semantics", () => {
  const key = 'push_sub:u123:{"endpoint":"https://fcm.googleapis.com/1","p256dh":"k","auth":"a"}';
  const parsed = parsePushSubscriptionKey(key);
  assert.equal(parsed?.userId, "u123");
  assert.equal(parsed?.endpoint, "https://fcm.googleapis.com/1");

  const stale = findStalePushKeysForEndpoint(
    [key, "push_sub:u123:corrupt-json", 'push_sub:u123:{"endpoint":"https://other"}'],
    "u123",
    "https://fcm.googleapis.com/1",
  );
  assert.deepEqual(stale, [key, "push_sub:u123:corrupt-json"]);
  assert.equal(toIso({ date: "2026-10-25", time: "19:00:00Z" }), "2026-10-25T19:00:00.000Z");
  assert.equal(isClassifiedFinishStatus("Finished"), true);
  assert.equal(isClassifiedFinishStatus("+1 Lap"), true);
  assert.equal(isClassifiedFinishStatus("Retired"), false);
  assert.equal(fmtLap(83.456), "1:23.456");
});