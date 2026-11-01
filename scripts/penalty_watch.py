#!/usr/bin/env python3
"""Penalty Watch: poll OpenF1 race control messages and alert Telegram.

Stdlib only. Secrets come from environment variables and are never printed.
"""
import hashlib
import json
import os
import re
import sys
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timedelta, timezone

API = "https://api.openf1.org"
STATE_PATH = os.environ.get("STATE_PATH", "state/seen.json")
KEYWORDS = re.compile(
    r"PENALT|INVESTIGAT|IMPED|GRID DROP|PLACE GRID|DISQUALIF|SUMMON|REPRIMAND", re.I
)

try:
    from zoneinfo import ZoneInfo

    LOCAL_TZ = ZoneInfo("Africa/Cairo")
    LOCAL_LABEL = "Cairo"
except Exception:
    LOCAL_TZ = timezone.utc
    LOCAL_LABEL = "UTC"


def log(msg):
    print(msg, flush=True)


def warn(msg):
    print(f"::warning::{msg}", flush=True)


def fail(msg):
    print(f"::error::{msg}", flush=True)
    sys.exit(1)


def env(name, default=""):
    return os.environ.get(name, default).strip()


def flag(name):
    return env(name).lower() in ("1", "true", "yes")


def http(method, url, data=None, headers=None, timeout=20):
    req = urllib.request.Request(url, data=data, method=method, headers=headers or {})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return resp.status, resp.read().decode("utf-8", "replace")
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode("utf-8", "replace")
    except Exception as e:  # never echo the URL: the Telegram one contains the token
        fail(f"network error: {type(e).__name__}")


def parse_date(s):
    if not s:
        return None
    try:
        d = datetime.fromisoformat(str(s).replace("Z", "+00:00"))
    except ValueError:
        return None
    if d.tzinfo is None:
        d = d.replace(tzinfo=timezone.utc)
    return d


def openf1_headers():
    headers = {"accept": "application/json"}
    user, pw = env("OPENF1_USERNAME"), env("OPENF1_PASSWORD")
    if user and pw:
        body = urllib.parse.urlencode({"username": user, "password": pw}).encode()
        status, text = http(
            "POST", f"{API}/token", body,
            {"Content-Type": "application/x-www-form-urlencoded"},
        )
        if status != 200:
            fail(f"OpenF1 token request failed: HTTP {status}")
        try:
            headers["Authorization"] = "Bearer " + json.loads(text)["access_token"]
        except (ValueError, KeyError):
            fail("OpenF1 token response had no access_token")
        log("OpenF1: authenticated requests")
    else:
        log("OpenF1: unauthenticated requests")
    return headers


def openf1_get(path, params, headers):
    url = f"{API}{path}?{urllib.parse.urlencode(params)}"
    status, text = http("GET", url, headers=headers)
    if status == 404:
        log(f"OpenF1 {path}: HTTP 404, treated as no rows: {text[:120]}")
        return []
    if status != 200:
        fail(f"OpenF1 {path}: HTTP {status}: {text[:160]}")
    try:
        data = json.loads(text)
    except ValueError:
        fail(f"OpenF1 {path}: response is not JSON")
    if not isinstance(data, list):
        fail(f"OpenF1 {path}: unexpected response: {text[:160]}")
    return data


def send_telegram(bot, chat, text):
    data = urllib.parse.urlencode(
        {"chat_id": chat, "text": text[:3800], "disable_web_page_preview": "true"}
    ).encode()
    status, body = http(
        "POST", f"https://api.telegram.org/bot{bot}/sendMessage", data,
        {"Content-Type": "application/x-www-form-urlencoded"},
    )
    if status != 200:
        fail(f"Telegram sendMessage failed: HTTP {status} {body[:200]}")


def ident(m):
    raw = f"{m.get('session_key')}|{m.get('date')}|{m.get('message')}"
    return hashlib.sha1(raw.encode()).hexdigest()[:16]


def load_state():
    try:
        with open(STATE_PATH) as f:
            data = json.load(f)
        return data if isinstance(data, dict) else {}
    except FileNotFoundError:
        return {}
    except (ValueError, OSError):
        warn("state file unreadable, starting empty")
        return {}


def save_state(seen):
    items = sorted(seen.items(), key=lambda kv: kv[1])[-1000:]
    os.makedirs(os.path.dirname(STATE_PATH) or ".", exist_ok=True)
    with open(STATE_PATH, "w") as f:
        json.dump(dict(items), f)


def main():
    bot, chat = env("TELEGRAM_BOT_TOKEN"), env("TELEGRAM_CHAT_ID")
    if not bot or not chat:
        fail("TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID secrets must be set")

    if flag("SEND_TEST"):
        send_telegram(bot, chat, "✅ Penalty Watch test: Telegram delivery works.")
        log("Test message sent.")
        return

    replay = flag("REPLAY")
    session_key = env("SESSION_KEY") or "latest"
    lookback = int(env("LOOKBACK_MIN") or 25)
    max_lines = int(env("MAX_LINES") or 8)
    now = datetime.now(timezone.utc)
    headers = openf1_headers()

    sessions = openf1_get("/v1/sessions", {"session_key": session_key}, headers)
    session = sessions[-1] if sessions else None
    session_name = "?"
    if session:
        session_name = session.get("session_name", "?")
        end = parse_date(session.get("date_end"))
        log(
            f"session: key={session.get('session_key')} name={session_name} "
            f"start={session.get('date_start')} end={session.get('date_end')}"
        )
        if not replay and end and now - end > timedelta(minutes=lookback):
            mins = int((now - end).total_seconds() // 60)
            log(f"Latest session ended {mins} min ago: idle, nothing to watch.")
            return
    else:
        warn("could not read session info; continuing anyway")

    msgs = openf1_get("/v1/race_control", {"session_key": session_key}, headers)
    matched = [m for m in msgs if KEYWORDS.search(str(m.get("message") or ""))]
    seen = {} if replay else load_state()
    fresh = []
    for m in matched:
        mid = ident(m)
        if mid in seen:
            continue
        d = parse_date(m.get("date"))
        if not replay and (d is None or now - d > timedelta(minutes=lookback)):
            continue
        fresh.append((d or now, mid, m))
    fresh.sort(key=lambda x: x[0])
    log(f"summary: fetched={len(msgs)} matched={len(matched)} new={len(fresh)} replay={replay}")
    if not msgs:
        warn("OpenF1 returned 0 race-control messages (no live data, or live access needs a paid account)")

    if not fresh:
        if not replay:
            save_state(seen)
        return

    shown = min(max_lines, 5) if replay else max_lines
    lines = []
    for d, _, m in fresh[:shown]:
        lap = m.get("lap_number")
        lap_txt = f" L{lap}" if lap else ""
        lines.append(f"{d.astimezone(LOCAL_TZ).strftime('%H:%M')}{lap_txt} · {m.get('message')}")
    extra = len(fresh) - len(lines)
    if extra > 0:
        lines.append(f"+{extra} more")
    title = f"🚨 Penalty Watch · {session_name}" + (" (replay)" if replay else "")
    send_telegram(bot, chat, f"{title} ({LOCAL_LABEL} time)\n\n" + "\n".join(lines))
    log(f"sent: {len(fresh)} message(s)")

    if not replay:
        for _, mid, m in fresh:
            seen[mid] = m.get("date") or ""
        save_state(seen)


if __name__ == "__main__":
    main()
