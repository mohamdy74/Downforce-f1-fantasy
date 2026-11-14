import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// Regression tests import the REAL production modules (the characterization
// copies in characterization.test.mjs pin the intended contract; these fail in
// CI if src/ itself regresses).

import {
  POSITION_POINTS,
  NO_SUBMISSION_PENALTY,
  positionPoints,
  scorePrediction,
} from "../src/lib/scoring.ts";
import { isCompleteTop10 } from "../src/lib/push-keys.ts";
import { buildCalendarIcs } from "../src/lib/telegram.ts";

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

test("calendar feed: race and sprint events carry 90-minute and 30-minute alerts", () => {
  const calendar = buildCalendarIcs({
    races: [
      {
        id: "race-1",
        round: 1,
        name: "Australian Grand Prix",
        circuit: "Albert Park",
        locality: "Melbourne",
        country: "Australia",
        race_at: "2026-03-08T04:00:00.000Z",
        qualifying_at: null,
        has_sprint: true,
        sprint_at: "2026-03-07T04:00:00.000Z",
      },
    ],
    season: 2026,
    appUrl: "https://downforce.lovable.app",
    now: new Date("2026-01-01T00:00:00.000Z"),
  });

  assert.equal((calendar.match(/TRIGGER:-PT90M/g) ?? []).length, 2);
  assert.equal((calendar.match(/TRIGGER:-PT30M/g) ?? []).length, 2);
  assert.ok(!calendar.includes("TRIGGER:-PT1H"));
});

test("calendar feed: race events use race titles, venue, and session duration", () => {
  const calendar = buildCalendarIcs({
    races: [
      {
        id: "race-1",
        round: 1,
        name: "Australian Grand Prix",
        circuit: null,
        locality: null,
        country: null,
        race_at: "2026-03-08T04:00:00.000Z",
        qualifying_at: null,
        has_sprint: false,
        sprint_at: null,
      },
    ],
    season: 2026,
    appUrl: "https://downforce.lovable.app",
    now: new Date("2026-01-01T00:00:00.000Z"),
  });

  assert.ok(calendar.includes("DTSTART:20260308T040000Z"));
  assert.ok(calendar.includes("DTEND:20260308T060000Z"));
  assert.ok(calendar.includes("SUMMARY:🏁 FORMULA 1 Australian Grand Prix 2026 - Grand Prix"));
  assert.ok(calendar.includes("LOCATION:Australia"));
  assert.ok(calendar.includes("DOWNFORCE picks lock at session start."));
});

// ---- pwa: manifest, service worker and root preloads (regression) ----
// Rebuilt on main from Mohamed's local b75ea35 (Oct 31): the manifest once
// declared favicon.png (64x64) as 192x192 and apple-touch-icon.png (180x180)
// as 512x512, sw v1 precached nonexistent /assets/fonts/* paths with an
// all-or-nothing addAll() (one 404 aborted the install and silently broke
// PWA install), and __root.tsx once hardcoded font
// preload hrefs under /assets/fonts/* that never matched Vite's output.
// Comments are stripped before assertions so explanatory notes about the
// old paths are not mistaken for markup.

function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

function repoFile(rel) {
  return readFileSync(new URL(rel, import.meta.url), "utf8");
}

test("pwa manifest: every icon entry declares the size its filename promises", () => {
  const manifest = JSON.parse(repoFile("../public/manifest.webmanifest"));
  const icons = manifest.icons;

  assert.equal(icons.length, 3);
  for (const icon of icons) {
    const basename = icon.src.replace(/^\/icon-/, "").replace(".png", "");
    const declared = /(\d{2,4})/.exec(basename);
    assert.ok(declared, `unparseable icon src: ${icon.src}`);
    assert.equal(icon.sizes, `${declared[1]}x${declared[1]}`);
    assert.equal(icon.type, "image/png");
  }
  assert.deepEqual(
    icons.map((i) => i.purpose),
    ["any", "any", "maskable"],
  );
  // The old bug: favicon.png masquerading as 192x192, apple-touch-icon as 512x512.
  assert.ok(!icons.some((i) => i.src.includes("favicon")));
  assert.ok(!icons.some((i) => i.src.includes("apple-touch")));
});

test("pwa sw: versioned cache, real precache targets, no phantom font paths", () => {
  const sw = stripComments(repoFile("../public/sw.js"));

  assert.match(sw, /const CACHE_NAME = "dfr:v\d+";/);
  assert.ok(sw.includes('"/"'));
  assert.ok(sw.includes('"/manifest.webmanifest"'));
  assert.ok(sw.includes('"/favicon.svg"'));
  // The v1 incident: hardcoded /assets/fonts/* never existed, every URL 404'd.
  assert.ok(!sw.includes("/assets/fonts/"));
  // Fonts are deliberately NOT precached; the browser fetches install icons
  // in its own context, which never consults this worker's cache.
  assert.ok(!sw.includes("woff"));
  assert.ok(!sw.includes("icon-192"));
});

test("pwa sw: install caches per-URL, never an all-or-nothing addAll()", () => {
  const sw = stripComments(repoFile("../public/sw.js"));

  assert.ok(!sw.includes("addAll"));
  assert.match(
    sw,
    /PRECACHE_ASSETS\.map\(\(url\) => cache\.add\(url\)\.catch\(\(\) => undefined\)\)/,
  );
});

test("pwa root: font preloads go through hashed ?url imports, not hardcoded paths", () => {
  const root = stripComments(repoFile("../src/routes/__root.tsx"));

  assert.match(root, /archivo-roman-var\.woff2\?url/);
  assert.match(root, /barlow-400\.woff2\?url/);
  assert.match(root, /rel: "preload"/);
  // __root.tsx once hardcoded /assets/fonts/<name>.woff2 preload hrefs.
  assert.ok(!root.includes('"/assets/fonts/'));
});
