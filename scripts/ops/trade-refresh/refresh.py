#!/usr/bin/env python3
"""Keeps the dated trade profiles fresh. Runs on mini-mac from a user timer (trade-refresh.timer, every 2 hours).

A trade profile (title, settlement text, decide context, bank) describes ONE Kalshi event, but many series roll to a new
event daily or weekly (WTI, AAA gas, Hormuz, Trump approval, executive orders...). A profile that still describes an expired
event makes the Sonnet prompts talk about the wrong date and strike. Rule: a profile is STALE when the series' current event
(the one the builder, and the live pipeline, use: the open event whose next market close is soonest) OPENED after the profile
was generated. Ladder (threshold/band) profiles are also stale when their decideContext still quotes strike values, or when
the live ladder's lowest/highest strike has drifted more than STRIKE_DRIFT_STEPS steps from the range the builder recorded in
bank.meta.json. For each stale profile of an ACTIVE paper unit this script:
  1. copies the trade directory to ~/trade-refresh/backups/<trade>-<timestamp>/,
  2. runs `npm run build-trade` for the same series, direct sources and the EXISTING keyphrases (so the trimmed keyphrase
     sets that validate-bank produced are kept; only the profile text and bank are regenerated),
  3. restarts that one unit so it loads the new profile.
A failed build leaves the old profile untouched (the builder guarantees it) and is retried up to BUILD_RETRIES times.
The LIVE unit (executor-module.service) is never touched. Rebuilt files appear as uncommitted changes under trades/ in
~/executor_module (the same as every earlier rebuild). Exit code is non-zero if any rebuild failed.

Usage: refresh.py [--dry] [--only kxwti,kxaaagasw] [--no-restart]
"""
import argparse, datetime, json, os, re, shutil, subprocess, sys, time, urllib.error, urllib.request

HOME = os.path.expanduser("~")
REPO = f"{HOME}/executor_module"
OUT = f"{HOME}/trade-refresh"
API = "https://api.elections.kalshi.com/trade-api/v2"
BUILD_RETRIES = 3
GRACE_SECONDS = 60


def parse_ts(s):
    if not s:
        return None
    try:
        return datetime.datetime.fromisoformat(s.replace("Z", "+00:00")).timestamp()
    except ValueError:
        return None


def pick_event(events, now_ts):
    """The builder's rule: the open event whose NEXT market close is soonest and still in the future; events without nested
    market close times fall back to strike_date order."""
    best = None
    for e in events:
        closes = [parse_ts(m.get("close_time")) for m in (e.get("markets") or [])]
        closes = [c for c in closes if c is not None and c > now_ts]
        if closes and (best is None or min(closes) < best[0]):
            best = (min(closes), e)
    if best is not None:
        return best[1]
    if not events:
        return None
    return sorted(events, key=lambda e: e.get("strike_date") or "")[0]


def event_opened(event):
    opens = [parse_ts(m.get("open_time")) for m in (event.get("markets") or [])]
    opens = [o for o in opens if o is not None]
    return min(opens) if opens else None


def is_stale(profile, event):
    opened, generated = event_opened(event), parse_ts(profile.get("generatedAt"))
    return opened is not None and generated is not None and opened > generated + GRACE_SECONDS


# A sentence that mentions "strike(s)" and a digit. Same pattern as the builder's check (src/profile/build.ts,
# quotedStrikeProblem): a profile whose decideContext still has one is stale, and one the builder accepts never has one.
QUOTED_STRIKES_RE = re.compile(r"[^.!?]*\bstrikes?\b[^.!?]*\d", re.IGNORECASE)
# Rebuild when the live ladder's lowest or highest strike has moved more than this many strike steps from the range
# recorded when the profile was built (bank.meta.json "strikeRange").
STRIKE_DRIFT_STEPS = 2
LADDER_STRUCTURES = ("threshold", "band")


def strike_values(event):
    out = []
    for m in event.get("markets") or []:
        for key in ("floor_strike", "cap_strike"):
            v = m.get(key)
            if isinstance(v, (int, float)) and not isinstance(v, bool):
                out.append(float(v))
    return sorted(set(out))


def strike_range(event):
    """{'min', 'max', 'step'} of the event's strikes (step = median gap), or None without at least two strikes."""
    vals = strike_values(event)
    if len(vals) < 2:
        return None
    gaps = sorted(b - a for a, b in zip(vals, vals[1:]))
    return {"min": vals[0], "max": vals[-1], "step": gaps[len(gaps) // 2]}


def quotes_strikes(profile):
    return bool(QUOTED_STRIKES_RE.search(profile.get("decideContext") or ""))


MONTH_RE = re.compile(r"\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\b", re.IGNORECASE)
# Legacy-profile month check runs only on profiles older than this, so a profile whose title legitimately names another
# month than the event title (the model's wording) is rebuilt at most once a day, never in a loop.
MONTH_CHECK_MIN_AGE_SECONDS = 24 * 3600


def months_in(text):
    return {m.group(1).lower() for m in MONTH_RE.finditer(text or "")}


def month_mismatch(profile, event, now_ts):
    """True when the profile TITLE names month(s) and the live event TITLE names month(s) and they share none: kxcpi's
    profile said September while the market (KXCPI-26OCT, 'CPI in October') settles on October. Only for profiles older
    than MONTH_CHECK_MIN_AGE_SECONDS; titles with no month name never trigger."""
    generated = parse_ts(profile.get("generatedAt"))
    if generated is None or now_ts - generated < MONTH_CHECK_MIN_AGE_SECONDS:
        return False
    mine, theirs = months_in(profile.get("title")), months_in(event.get("title"))
    return bool(mine) and bool(theirs) and not (mine & theirs)


def stale_reason(profile, meta, event, now_ts=None):
    """Why this profile needs a rebuild, or None. Event rollover, then a changed event (recorded) or a month mismatch
    (legacy profiles with no record), then (ladder trades only) quoted strikes and drift."""
    if is_stale(profile, event):
        return "event rolled over"
    recorded_event = (meta or {}).get("eventTicker")
    if recorded_event:
        if recorded_event != event.get("event_ticker"):
            return f"event changed from {recorded_event} to {event.get('event_ticker')}"
    elif month_mismatch(profile, event, time.time() if now_ts is None else now_ts):
        return f"profile title names a different month than the live event ('{event.get('title')}')"
    if profile.get("marketStructure") not in LADDER_STRUCTURES:
        return None
    if quotes_strikes(profile):
        return "decideContext quotes strike values"
    recorded, live = (meta or {}).get("strikeRange"), strike_range(event)
    if recorded and live and live["step"] > 0:
        limit = STRIKE_DRIFT_STEPS * live["step"]
        if abs(live["min"] - recorded["min"]) > limit or abs(live["max"] - recorded["max"]) > limit:
            return f"strike range drifted from {recorded['min']}-{recorded['max']} to {live['min']}-{live['max']}"
    return None


def build_cmd(profile):
    cmd = ["/usr/bin/npm", "run", "build-trade", "--", "--series", profile["seriesTicker"]]
    if profile.get("directSources"):
        cmd += ["--direct", ",".join(profile["directSources"])]
    cmd += ["--reuse-keyphrases", f"trades/{profile['name']}/keyphrases.json"]
    return cmd


def load_env(path):
    env = {}
    try:
        with open(path) as f:
            for line in f:
                line = line.strip()
                if not line or line.startswith("#") or "=" not in line:
                    continue
                k, v = line.split("=", 1)
                env[k.strip().removeprefix("export ").strip()] = v.strip().strip("'\"")
    except OSError:
        pass
    return env


def kalshi_events(series):
    url = f"{API}/events?series_ticker={series}&status=open&with_nested_markets=true"
    for attempt in range(4):
        try:
            with urllib.request.urlopen(urllib.request.Request(url, headers={"User-Agent": "trade-refresh"}), timeout=25) as r:
                return json.loads(r.read().decode())["events"]
        except urllib.error.HTTPError as e:
            if e.code == 429 and attempt < 3:
                time.sleep(3 * (attempt + 1))
                continue
            raise
    return []


def active_trades():
    out = subprocess.run(["systemctl", "--user", "list-units", "executor-module@*.service", "--state=active", "--no-legend", "--no-pager"],
                         capture_output=True, text=True, timeout=30).stdout
    return sorted(l.split()[0].replace("executor-module@", "").replace(".service", "") for l in out.splitlines() if l.strip())


def default_run(cmd, env, cwd):
    r = subprocess.run(cmd, cwd=cwd, env=env, capture_output=True, text=True, timeout=900)
    return r.returncode, (r.stdout + r.stderr)[-600:]


def default_restart(trade):
    r = subprocess.run(["systemctl", "--user", "restart", f"executor-module@{trade}.service"], capture_output=True, text=True, timeout=120)
    return r.returncode == 0


class Deps:
    def __init__(self, **kw):
        self.repo, self.out = REPO, OUT
        self.trades = active_trades
        self.events = kalshi_events
        self.run = default_run
        self.restart = default_restart
        self.now = time.time
        self.sleep = time.sleep
        self.env = lambda: load_env(f"{REPO}/.env")
        self.log = lambda m: print(f"{datetime.datetime.now().isoformat(timespec='seconds')} {m}", flush=True)
        self.__dict__.update(kw)


def read_profile(repo, trade):
    with open(f"{repo}/trades/{trade}/profile.json") as f:
        return json.load(f)


def read_meta(repo, trade):
    """bank.meta.json, where the builder records the strike range; {} when absent or unreadable (older profiles)."""
    try:
        with open(f"{repo}/trades/{trade}/bank.meta.json") as f:
            return json.load(f)
    except (OSError, ValueError):
        return {}


def refresh(d, dry=False, only=None, restart=True):
    """Returns {'stale': [...], 'rebuilt': [...], 'failed': [...], 'checked': n, 'errors': [...]}."""
    res = {"checked": 0, "stale": [], "rebuilt": [], "failed": [], "errors": []}
    for trade in d.trades():
        if only and trade not in only:
            continue
        try:
            profile = read_profile(d.repo, trade)
        except (OSError, ValueError) as e:
            res["errors"].append(f"{trade}: cannot read profile ({e})")
            continue
        res["checked"] += 1
        try:
            d.sleep(1.2)  # Kalshi's public API 429s when hit quickly
            event = pick_event(d.events(profile["seriesTicker"]), d.now())
        except Exception as e:
            res["errors"].append(f"{trade}: kalshi lookup failed ({e})")
            continue
        reason = None if event is None else stale_reason(profile, read_meta(d.repo, trade), event, d.now())
        if reason is None:
            continue
        res["stale"].append(trade)
        res.setdefault("reasons", {})[trade] = reason
        opened = event_opened(event)
        opened_s = datetime.datetime.fromtimestamp(opened, datetime.timezone.utc).isoformat(timespec="minutes") if opened is not None else "unknown"
        d.log(f"STALE {trade} ({reason}): profile generated {profile.get('generatedAt')}, current event {event['event_ticker']} opened {opened_s}")
        if dry:
            continue
        stamp = datetime.datetime.fromtimestamp(d.now(), datetime.timezone.utc).strftime("%Y%m%d-%H%M%S")
        backup = f"{d.out}/backups/{trade}-{stamp}"
        os.makedirs(os.path.dirname(backup), exist_ok=True)
        shutil.copytree(f"{d.repo}/trades/{trade}", backup)
        env = {**os.environ, **d.env()}
        ok = False
        for attempt in range(1, BUILD_RETRIES + 1):
            rc, tail = d.run(build_cmd(profile), env, d.repo)
            try:
                changed = read_profile(d.repo, trade).get("generatedAt") != profile.get("generatedAt")
            except (OSError, ValueError):
                changed = False
            if rc == 0 and changed:
                ok = True
                break
            d.log(f"  build attempt {attempt}/{BUILD_RETRIES} for {trade} failed (rc={rc}): {tail.strip().splitlines()[-1][:200] if tail.strip() else ''}")
            d.sleep(5)
        if not ok:
            res["failed"].append(trade)
            continue
        if restart and not d.restart(trade):
            res["failed"].append(trade)
            d.log(f"  rebuilt {trade} but the restart FAILED")
            continue
        res["rebuilt"].append(trade)
        d.log(f"  rebuilt {trade}" + (" and restarted its unit" if restart else " (no restart requested)"))
    return res


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry", action="store_true")
    ap.add_argument("--only", default="")
    ap.add_argument("--no-restart", action="store_true")
    a = ap.parse_args()
    d = Deps()
    os.makedirs(OUT, exist_ok=True)
    only = {x for x in a.only.split(",") if x} or None
    res = refresh(d, dry=a.dry, only=only, restart=not a.no_restart)
    d.log("summary " + json.dumps(res))
    with open(f"{OUT}/refresh.log", "a") as f:
        f.write(f"{datetime.datetime.now().isoformat(timespec='seconds')} {json.dumps(res)}\n")
    sys.exit(1 if res["failed"] or res["errors"] else 0)


if __name__ == "__main__":
    main()
