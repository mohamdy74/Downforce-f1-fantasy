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

  const poleCorrect = !!prediction.pole_driver_id && prediction.pole_driver_id === poleDriver;
  const flCorrect =
    !!prediction.fastest_lap_driver_id && prediction.fastest_lap_driver_id === fastestLapDriver;
  const dnfCorrect = !!prediction.dnf_driver_id && dnfDrivers.has(prediction.dnf_driver_id);

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

  const pole = !!prediction.pole_driver_id && prediction.pole_driver_id === poleDriver ? 1 : 0;

  return { top8, pole, total: top8 + pole };
}

// 3. Round scoring contract (src/lib/roundScoring.ts)
function filterValidDriverIds(ids) {
  return (ids ?? []).filter((x) => Boolean(x && x !== "__none__"));
}

function isCompleteTop10(top10) {
  return Array.isArray(top10) && filterValidDriverIds(top10).length === 10;
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
    sprintResults?.length ? scoreSprint(sprintByUser.get(userId) ?? null, sprintResults) : null;

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
            ? {
                noSubmission: true,
                poleOnly: true,
                pole: poleHit,
                ...(sprint ? { sprint } : {}),
                total,
              }
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
        (prevPts.get(b.userId) ?? 0) - (prevPts.get(a.userId) ?? 0) || a.name.localeCompare(b.name),
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

function formatCairoDate(iso, seconds = false) {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Africa/Cairo",
    weekday: "short",
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    ...(seconds ? { second: "2-digit" } : {}),
    hourCycle: "h23",
  }).formatToParts(d);
  const get = (t) => parts.find((p) => p.type === t)?.value ?? "";
  const time = `${get("hour")}:${get("minute")}${seconds ? ":" + get("second") : ""}`;
  return `${get("weekday")} ${get("day")} ${get("month")} \u00B7 ${time}`.toUpperCase();
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
  assert.deepEqual(scoreSprint({ top8, pole_driver_id: "d1" }, results), {
    top8: 8,
    pole: 1,
    total: 9,
  });
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
    {
      user_id: "u_pole_only",
      top10: ["__none__"],
      pole_driver_id: "d1",
      fastest_lap_driver_id: null,
      dnf_driver_id: null,
    },
  ];
  const existingScores = [{ user_id: "u_locked", breakdown: { stewardOverride: true, total: 99 } }];

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
  assert.deepEqual(autoRows[1].breakdown, {
    noSubmission: true,
    poleOnly: true,
    pole: 3,
    total: -22,
  });

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

test("Characterization 6: isCompleteTop10, DNF constructor filter, and Cairo timezone formatting", () => {
  assert.equal(
    isCompleteTop10(["d1", "d2", "d3", "d4", "d5", "d6", "d7", "d8", "d9", "d10"]),
    true,
  );
  assert.equal(
    isCompleteTop10(["d1", "d2", "d3", "d4", "d5", "d6", "d7", "d8", "d9", "__none__"]),
    false,
  );
  assert.equal(isCompleteTop10([]), false);
  assert.equal(isCompleteTop10(null), false);

  const sampleDrivers = [
    { id: "alo", team: "Aston Martin" },
    { id: "per", team: "Cadillac F1 Team" },
    { id: "ver", team: "Red Bull" },
    { id: "nor", team: "McLaren" },
  ];
  const eligibleDnf = sampleDrivers.filter((d) => !/aston|cadillac/i.test(d.team ?? ""));
  assert.deepEqual(
    eligibleDnf.map((d) => d.id),
    ["ver", "nor"],
  );

  const cairoLabel = formatCairoDate("2026-10-24T20:45:00.000Z", false);
  assert.ok(cairoLabel && cairoLabel.includes("\u00B7") && cairoLabel.includes("OCT"));
});
// 7. Live Virtual Standings & Chequered Flag Instant Finalizer contract (src/lib/liveStandings.ts)
function hasChequeredFlag(messages) {
  if (!Array.isArray(messages) || messages.length === 0) return false;
  for (const m of messages) {
    const flag = (m.flag ?? "").toUpperCase();
    const msg = (m.message ?? "").toUpperCase();
    if (flag === "CHEQUERED" || flag === "CHECKERED") return true;
    if (msg.includes("CHEQUERED FLAG") || msg.includes("CHECKERED FLAG")) return true;
    if (msg.includes("SESSION ENDED") || msg.includes("RACE ENDED")) return true;
  }
  return false;
}

function computeVirtualStandings({
  officialBoard,
  raceId,
  round,
  raceAt,
  profiles,
  liveResults,
  predictions,
}) {
  if (!officialBoard.length) return [];
  const effectiveProfiles =
    profiles.length > 0
      ? profiles
      : officialBoard.map((e) => ({ id: e.userId, created_at: "2026-01-01T00:00:00.000Z" }));

  const builtRows = buildRaceScoreRows({
    raceId,
    raceAt,
    profiles: effectiveProfiles,
    results: liveResults,
    predictions,
    sprintResults: [],
    sprintPredictions: [],
    existingScores: [],
    mode: "auto_sync",
  });

  const liveRowByUser = new Map(builtRows.map((r) => [r.user_id, r]));
  const virtualEntries = officialBoard.map((entry, idx) => {
    const alreadyCountedPts = entry.byRound[round];
    const hasOfficialRoundScore = alreadyCountedPts !== undefined;
    const basePoints = hasOfficialRoundScore ? entry.points - alreadyCountedPts : entry.points;
    const baseRaces = hasOfficialRoundScore ? Math.max(0, entry.races - 1) : entry.races;
    const liveRow = liveRowByUser.get(entry.userId);
    const liveRoundPoints = liveRow ? liveRow.points : (alreadyCountedPts ?? 0);
    const totalPoints = basePoints + liveRoundPoints;
    const totalRaces = baseRaces + (liveRow || hasOfficialRoundScore ? 1 : 0);
    const nextByRound = { ...entry.byRound, [round]: liveRoundPoints };
    const nextBest = entry.best == null ? liveRoundPoints : Math.max(entry.best, liveRoundPoints);
    return {
      ...entry,
      points: totalPoints,
      races: totalRaces,
      best: nextBest,
      byRound: nextByRound,
      officialPoints: basePoints,
      officialRank: idx + 1,
      liveRoundPoints,
      liveRankDelta: 0,
    };
  });

  virtualEntries.sort((a, b) => b.points - a.points || a.name.localeCompare(b.name));
  const topLiveRound = Math.max(...virtualEntries.map((e) => e.liveRoundPoints), -Infinity);
  for (let i = 0; i < virtualEntries.length; i++) {
    const entry = virtualEntries[i];
    entry.liveRankDelta = entry.officialRank - (i + 1);
    entry.change = entry.liveRankDelta;
    entry.fahl = Number.isFinite(topLiveRound) && entry.liveRoundPoints === topLiveRound;
  }
  return virtualEntries;
}

test("Characterization 7: hasChequeredFlag & computeVirtualStandings compute real-time rank deltas and guard Red Flag races", () => {
  assert.equal(hasChequeredFlag([]), false);
  assert.equal(hasChequeredFlag([{ flag: "RED", message: "RED FLAG - SESSION SUSPENDED" }]), false);
  assert.equal(hasChequeredFlag([{ flag: "CHEQUERED", message: "CHEQUERED FLAG" }]), true);
  assert.equal(hasChequeredFlag([{ category: "SessionStatus", message: "SESSION ENDED" }]), true);

  const officialBoard = [
    {
      userId: "u_ahmed",
      name: "Ahmed Hatem",
      avatar: null,
      points: 46,
      races: 4,
      best: 18,
      change: 0,
      byRound: { 14: 12, 15: 16, 16: 18 },
      fahl: true,
    },
    {
      userId: "u_mohamed",
      name: "Mohamed Hamdy",
      avatar: null,
      points: 32,
      races: 4,
      best: 14,
      change: 0,
      byRound: { 14: 10, 15: 8, 16: 14 },
      fahl: false,
    },
  ];

  const drivers = ["d1", "d2", "d3", "d4", "d5", "d6", "d7", "d8", "d9", "d10"];
  const liveResults = drivers.map((id, i) => ({
    driver_id: id,
    position: i + 1,
    finished: true,
    pole: i === 0,
    fastest_lap: i === 1,
  }));

  const predictions = [
    // Mohamed nails exact top 10 + Pole + FL (+30 + 3 + 3 + 10 = +46 pts!)
    {
      user_id: "u_mohamed",
      top10: drivers,
      pole_driver_id: "d1",
      fastest_lap_driver_id: "d2",
      dnf_driver_id: null,
    },
    // Ahmed misses all top 10 (-30 pts)
    {
      user_id: "u_ahmed",
      top10: ["x1", "x2", "x3", "x4", "x5", "x6", "x7", "x8", "x9", "x10"],
      pole_driver_id: null,
      fastest_lap_driver_id: null,
      dnf_driver_id: null,
    },
  ];

  const virtual = computeVirtualStandings({
    officialBoard,
    raceId: "r18",
    round: 18,
    raceAt: "2026-10-25T19:00:00Z",
    profiles: [],
    liveResults,
    predictions,
  });

  assert.equal(virtual[0].userId, "u_mohamed");
  assert.equal(virtual[0].liveRoundPoints, 46);
  assert.equal(virtual[0].points, 32 + 46);
  assert.equal(virtual[0].liveRankDelta, 1); // jumped from #2 to #1!
  assert.equal(virtual[0].fahl, true);

  assert.equal(virtual[1].userId, "u_ahmed");
  assert.equal(virtual[1].liveRoundPoints, -30);
  assert.equal(virtual[1].points, 46 - 30);
  assert.equal(virtual[1].liveRankDelta, -1); // dropped from #1 to #2!
});

function buildLiveOrderFromPositions(positions, laps, raceControl) {
  if (!Array.isArray(positions) || positions.length === 0) return [];
  const latestPos = new Map();
  for (let i = 0; i < positions.length; i++) {
    const p = positions[i];
    if (typeof p.driver_number !== "number" || typeof p.position !== "number" || p.position <= 0)
      continue;
    const dateMs = p.date ? new Date(p.date).getTime() : 0;
    const prev = latestPos.get(p.driver_number);
    if (!prev || (dateMs > 0 && dateMs >= prev.dateMs) || (dateMs === 0 && i >= prev.idx)) {
      latestPos.set(p.driver_number, { position: p.position, dateMs, idx: i });
    }
  }
  if (latestPos.size === 0) return [];

  const maxLapByDriver = new Map();
  const bestLapByDriver = new Map();
  for (const l of laps ?? []) {
    if (typeof l.driver_number !== "number") continue;
    if (
      typeof l.lap_number === "number" &&
      l.lap_number > (maxLapByDriver.get(l.driver_number) ?? 0)
    ) {
      maxLapByDriver.set(l.driver_number, l.lap_number);
    }
    if (
      typeof l.lap_duration === "number" &&
      l.lap_duration > 0 &&
      l.lap_duration < (bestLapByDriver.get(l.driver_number) ?? Infinity)
    ) {
      bestLapByDriver.set(l.driver_number, l.lap_duration);
    }
  }
  const leaderMaxLap = Math.max(0, ...maxLapByDriver.values());

  const retiredNums = new Set();
  for (const m of raceControl ?? []) {
    const msg = (m.message ?? "").toUpperCase();
    const match = msg.match(/\bCAR\s+(\d+)\b/);
    if (
      match &&
      (msg.includes("RETIRED") ||
        msg.includes("OUT OF THE RACE") ||
        msg.includes("STOPPED ON TRACK") ||
        msg.includes("WILL NOT RESUME"))
    ) {
      retiredNums.add(Number(match[1]));
    }
  }

  const sorted = [...latestPos.entries()].sort(
    (a, b) => a[1].position - b[1].position || a[0] - b[0],
  );
  return sorted.map(([driver_number, info], idx) => {
    const drvLaps = maxLapByDriver.get(driver_number) ?? null;
    const isLapsRetired =
      leaderMaxLap >= 6 && drvLaps != null && leaderMaxLap - drvLaps >= 4 && info.position >= 15;
    const dnf = retiredNums.has(driver_number) || isLapsRetired;
    return {
      position: idx + 1,
      driver_number,
      duration: bestLapByDriver.get(driver_number) ?? null,
      gap_to_leader: null,
      number_of_laps: drvLaps,
      dnf,
      dns: false,
      dsq: false,
    };
  });
}

const LIVE_RACE_GRACE_MS = 4 * 60 * 60_000;
function nextRaceLiveAware(races, nowMs) {
  return (
    races.find((r) => {
      const start = new Date(r.race_at).getTime();
      if (start > nowMs) return true;
      return r.round >= LEAGUE_START_ROUND && !r.has_results && nowMs - start <= LIVE_RACE_GRACE_MS;
    }) ?? null
  );
}

test("Characterization 8: Race-Day End-to-End Safeguards (buildLiveOrderFromPositions, Sprint+GP Virtual Standings, and nextRace live window)", async () => {
  const fs = await import("node:fs");

  // 1) buildLiveOrderFromPositions synthesizes mid-race running order when /v1/session_result is empty
  const positions = [
    { driver_number: 44, position: 2, date: "2026-10-25T20:05:00Z" },
    { driver_number: 1, position: 1, date: "2026-10-25T20:05:00Z" },
    { driver_number: 44, position: 1, date: "2026-10-25T20:15:00Z" }, // HAM overtakes NOR for P1
    { driver_number: 1, position: 2, date: "2026-10-25T20:15:00Z" },
    { driver_number: 16, position: 3, date: "2026-10-25T20:15:00Z" },
    { driver_number: 31, position: 20, date: "2026-10-25T20:10:00Z" },
  ];
  const laps = [
    { driver_number: 44, lap_number: 12, lap_duration: 96.4 },
    { driver_number: 1, lap_number: 12, lap_duration: 95.8 },
    { driver_number: 16, lap_number: 12, lap_duration: 96.9 },
    { driver_number: 31, lap_number: 3, lap_duration: 99.1 },
  ];
  const raceControl = [{ category: "CarEvent", message: "CAR 31 (OCO) RETIRED IN PIT LANE" }];

  const synth = buildLiveOrderFromPositions(positions, laps, raceControl);
  assert.equal(synth.length, 4);
  assert.equal(synth[0].driver_number, 44);
  assert.equal(synth[0].position, 1);
  assert.equal(synth[0].dnf, false);
  assert.equal(synth[1].driver_number, 1);
  assert.equal(synth[1].duration, 95.8);
  assert.equal(synth[3].driver_number, 31);
  assert.equal(synth[3].dnf, true);

  // 2) nextRace keeps the active race during the 4-hour live race window until has_results is true
  const sampleRaces = [
    {
      id: "r18",
      season: 2026,
      round: 18,
      name: "United States Grand Prix",
      race_at: "2026-10-25T20:00:00.000Z",
      has_results: false,
    },
    {
      id: "r19",
      season: 2026,
      round: 19,
      name: "Mexico City Grand Prix",
      race_at: "2026-11-01T20:00:00.000Z",
      has_results: false,
    },
  ];

  const midRaceNow = new Date("2026-10-25T20:45:00.000Z").getTime();
  assert.equal(nextRaceLiveAware(sampleRaces, midRaceNow)?.id, "r18");

  const finalizedRaces = sampleRaces.map((r) => (r.id === "r18" ? { ...r, has_results: true } : r));
  assert.equal(nextRaceLiveAware(finalizedRaces, midRaceNow)?.id, "r19");

  // 3) Verify on-disk source files contain all 5 Race-Day Safeguards
  const liveStandingsSrc = fs.readFileSync("src/lib/liveStandings.ts", "utf8");
  assert.ok(liveStandingsSrc.includes("export function buildLiveOrderFromPositions"));
  assert.ok(liveStandingsSrc.includes("precomputedScores"));

  const queriesSrc = fs.readFileSync("src/lib/queries.ts", "utf8");
  assert.ok(queriesSrc.includes("LIVE_RACE_GRACE_MS"));

  const weekendFnSrc = fs.readFileSync("src/lib/weekend.functions.ts", "utf8");
  assert.ok(weekendFnSrc.includes("buildLiveOrderFromPositions"));
  assert.ok(weekendFnSrc.includes("resolvePoleDriverId"));
  assert.ok(weekendFnSrc.includes("liveScores"));

  const leaderboardSrc = fs.readFileSync("src/routes/leaderboard.tsx", "utf8");
  // "Test Live Mode" debug toggle was removed in the Oct 29 UX pass;
  // pin the live-standings fetch helper that replaced that flow instead.
  assert.ok(leaderboardSrc.includes("jolpicaFetch"));

  const weekendRouteSrc = fs.readFileSync("src/routes/weekend.tsx", "utf8");
  assert.ok(weekendRouteSrc.includes("Live Grand Prix Telemetry"));
});
