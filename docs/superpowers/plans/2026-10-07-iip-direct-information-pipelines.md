# Direct Information Pipelines (Internet_Info_Plug) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the mini-mac `Internet_Info_Plug` daemon a generic `series` adapter, twelve new information sources (ten feeds, two numeric series) and an alert channel that works on Linux, without touching the ai1 baseline config, `executor/`, or anything market-specific.

**Architecture:** A new `iip/adapters/series.py` reads one number per source (a JSON path or a one-capture-group regex) and reports one `RawItem` per new reading, treating any failed extraction as DEGRADED, never as "no change". A new file `config/sources.minimac.yaml` carries every shared source verbatim plus the twelve new ones and is selected on mini-mac only, via `iip run --config`. `build_notifier` replaces the hard-wired macOS notifier with the channels a host can actually deliver: log, Redis stream, the macOS banner only on darwin, and Slack when a webhook is configured.

**Tech Stack:** Python >= 3.12, httpx (already a dependency), pydantic v2, pytest with pytest-asyncio in auto mode, `httpx.MockTransport` for fakes. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-10-07-trade-profile-relevance-gate-design.md`, section 11, in the executor_module repo. Executors read the spec and this plan together. The operator approved this work on 2026-10-07 as an explicit exception to executor_module's "do not modify `Internet_Info_Plug`" rule.

**Repo for every command below unless stated:** `/Users/eamonmcnamee/Downloads/Internet_Info_Plug`, branch `feat/direct-information-pipelines` created from `main` at `9b8dcb6`.

**How this plan was built:** every code block below was written and run in a scratch copy of the repo, applied in the order given to a fresh copy of the real files, and the full suite run after each task. The test counts quoted are measured, not estimated. Source behaviour (response shapes, cadences, reachability) was measured from mini-mac itself on 2026-10-08, because reachability is per IP.

## Global Constraints

Copied from the spec and the repo's own standing rules. Every task's requirements include this section.

- No market ticker, threshold, strike or market keyword in `iip/`. (HANDOFF.md section 7, "Market ignorance". This plan extends the same rule to source config files and enforces it with tests.)
- Nothing under `Internet_Info_Plug/executor/` changes. `git diff --stat main -- executor/` must print nothing.
- ai1's `config/sources.yaml` is unchanged. `git diff --stat main -- config/sources.yaml` must print nothing.
- Each new source has an explicit `rate_limit`. (An absent block means UNLIMITED in this codebase.)
- A failed extraction is DEGRADED, never "no change".
- Run the plug suite as plain `.venv/bin/pytest`. NOT `-q`: `addopts` already contains it and a second one hides the summary line.
- Never `pip install` into `executor/.venv`. The new code needs no new dependency; `tests/test_packaging.py` rejects undeclared imports.
- Never `git clean` (any flags), `reset --hard`, `rebase`, `commit --amend`, `push --force` or `branch -D`. To undo, `git revert` or `git checkout -- <explicit path>`.
- Never `launchctl` anything on the Mac. Never run the daemon at `--log-level DEBUG` (Telethon logs auth material there). Never touch `data/iip.db` read-write.
- Never cause an authenticated request to any `*.kalshi.*` host, and never set a `^KALSHI` environment variable. (Task 1 also makes the registry refuse a `series` source pointed at such a host.)
- A shell hook in this environment can reject a Bash command that merely mentions `os.environ` (it pattern-matches env dumps). If one does, make that edit with the editor tool instead of a shell heredoc; do not work around the hook.

## Spec corrections found while planning

These differ from what the spec's section 11 table or the planning brief assumed. Each was verified against the live source or the code on 2026-10-08.

1. **PortWatch's `date` is an ISO string, not epoch milliseconds.** The live response is `{"date": "2026-10-04", "portname": "Strait of Hormuz", "n_total": 4}`. The adapter supports `iso`, `epoch_ms` and `mdy_short`; PortWatch uses `iso`.
2. **The normalizer drops publish times older than two days** (`DEFAULT_MAX_PUBLISH_SKEW_S` = 172,800 s in `iip/normalize.py`). PortWatch's newest point is about four days old, so its `source_publish_ts` will be `None` on the emitted `Item`. The adapter still sets it internally (health uses it to detect an older point than one already reported) and the data date is spelled out in the headline, snippet and `raw`. This is the honest outcome and is not changed.
3. **`ukmto_advisories` is NOT added.** UKMTO's incident list is rendered client-side. On both `/` and `/recent-incidents` the likely watch regions exist but contain zero server-rendered characters, so the existing `primary` adapter would baseline an empty string and then never fire, which is a silent source, the exact failure this daemon exists to prevent. No JSON endpoint was found (`/api/incidents` and two variants return 404). Needs a separate investigation; deferred.
4. **`nhc_atlantic` is NOT added.** The NHC feed is a snapshot of currently active storms: entries disappear when a storm ends, and iip's feed-rollback check (`HealthMonitor._rollback`) would then mark the source DEAD "feed rolled back" falsely. It also carries static "Local Statement" entries dated in the years 1015 to 1114. It needs a snapshot-aware adapter; deferred. The result is ten feeds, not eleven feeds plus one page watcher.
5. **The Hill answers HTTP 301 before its feed.** `FeedAdapter` already follows redirects, so no config change is needed; a bare `curl` without `-L` reads it as "zero entries" (it nearly mis-measured the cadence).
6. **Deployment hazard (an operator decision, Task 6 step 1):** the live `executor-module` on mini-mac currently runs with real-money trading armed (`KALSHI_DRY_RUN` unset) and reads the same Redis stream this daemon writes. New tier-1 sources (Federal Reserve, White House, EIA) can reach its decision pipeline, and the first poll of each feed releases a back-catalogue of stale items. On 2026-09-01 exactly this made 19 stale YouGov items look like news to the pipeline. The plan therefore does not restart the daemon until the operator has halted or dry-run-ed the executor.
7. The test counts in HANDOFF.md are stale. The suite today is 1169 tests, not 889 or 842.

## Review Focus

The five inputs most likely to bite that the spec does not spell out, most likely first. Each is pinned by a test in the task that owns the code.

1. **A page that shows the same figure twice, or two different figures.** The AAA page has other prices on it. Identical repeats are one answer; two different matches are an ambiguity error, never "take the first". (Task 1 `TestRegexExtraction`; Task 2 `TestExtractors`.)
2. **A data point dated earlier than one already reported.** Not news and not silence: the adapter emits nothing and health reads the pair as a rolled-back source (DEAD). (Task 2 `test_an_older_date_than_one_already_reported_...`.)
3. **A `200` whose body is an error object or an HTML error page.** ArcGIS answers a bad query with HTTP 200 and `{"error": ...}`. That must read DEGRADED, then DEAD after three, and must never emit zero or repeat the last value. Pinned against a recorded copy of the real error body. (Task 2 `TestExtractionFailureIsNotQuiet`; Task 3 `test_an_http_200_error_object_is_degraded_not_quiet`.)
4. **A very large feed body with weak cache validators.** The White House feed is about 570 KB per fetch; three of the new feeds send no ETag or Last-Modified at all. The byte cap must accept the large one, and the large one must not be polled fast. (Task 4 `test_a_feed_a_few_hundred_kilobytes_long_is_accepted_under_the_byte_cap`, `test_the_large_feed_is_polled_slowly`.)
5. **Items with identical titles, and the same reading after a restart.** Feed identity is the entry id then the link, never the title; a series reading's identity is a function of source, data date and value, never of the process, so permanent dedup drops a restart's repeat. (Task 4 `test_entries_sharing_a_title_...`; Task 2 `test_the_same_reading_after_a_restart_has_the_same_identity`.)

## File Structure

| File | Responsibility | Task |
|---|---|---|
| `iip/extract.py` (new) | Pure helpers: validate an extractor spec, pull one value out of a body, parse a number and a date. Shared by config validation and the adapter. | 1 |
| `iip/registry.py` (modify) | Declare the `series` adapter and its config fields; refuse an incomplete or unsafe series source at load time. | 1 |
| `iip/adapters/series.py` (new) | Poll one numeric series; one `RawItem` per new reading; failed extraction is an error. | 2 |
| `iip/__main__.py` (modify) | Build a `SeriesAdapter` for `series` sources (Task 2); build notifiers with `build_notifier` (Task 5). | 2, 5 |
| `config/sources.minimac.yaml` (new) | Every shared source verbatim, plus two series sources (Task 3) and ten feeds (Task 4). Selected on mini-mac only. | 3, 4 |
| `iip/alerts.py` (modify) | `SlackNotifier` and `build_notifier`; the macOS banner only where it can exist. | 5 |
| `tests/test_extract.py`, `tests/test_series_adapter.py`, `tests/test_minimac_sources.py`, `tests/test_alert_sinks.py` (new); `tests/test_registry.py`, `tests/adapter_cases.py` (modify) | Tests for the above, including recorded real responses under `tests/fixtures/series/` and `tests/fixtures/feeds_minimac/`. | 1-5 |
| `CLAUDE.md`, `HANDOFF.md` (modify) | The operator-approved boundary wording. Requires operator approval before merge. | 7 |
| `executor_module/deploy/mini-mac/iip.service` | NOT edited by this plan. The exact diff is given in Task 6 for the operator to apply in that repo. | 6 |

Deliberately NOT touched: `executor/`, `config/sources.yaml`, `config/schedule.yaml`, `iip/adapters/feed.py`, `iip/adapters/primary.py`, `iip/health.py`, `iip/normalize.py`.

---

### Task 1: Value extraction and `series` config validation

**Files:**
- Create: `iip/extract.py`
- Create: `tests/test_extract.py`
- Modify: `iip/registry.py`
- Modify: `tests/test_registry.py` (append a class)

**Interfaces:**
- Produces (later tasks rely on these exact names):
  - `iip.extract.ExtractError(ValueError)`
  - `iip.extract.check_spec(spec: str) -> None` (raises `ExtractError`)
  - `iip.extract.extract(spec: str, text: str) -> str` (raises `ExtractError` if absent, ambiguous, or not a scalar)
  - `iip.extract.parse_number(text: str) -> float`
  - `iip.extract.parse_date(text: str, fmt: str) -> datetime` (UTC; `fmt` is `"iso"`, `"epoch_ms"` or `"mdy_short"`)
  - `SourceConfig` gains `params: dict[str, str]`, `extract: str | None`, `date_extract: str | None`, `date_format: Literal["iso","epoch_ms","mdy_short"] = "iso"`, `label: str | None`, `unit: str = ""`, `emit_on: Literal["new_point","change_ge"] = "new_point"`, `change_ge: float | None`, `page_url: str | None`
  - `KNOWN_ADAPTERS` includes `"series"`; `SourceConfig.adapter` accepts `"series"`
- Consumes: nothing from earlier tasks.

- [ ] **Step 1: Branch, baseline, and record the executor suite**

```bash
cd /Users/eamonmcnamee/Downloads/Internet_Info_Plug
git status --short                   # expected: no output (clean tree)
git branch --show-current            # expected: main
git log --oneline -1                 # expected: 9b8dcb6 feat(sources): watch poll publications ...
git checkout -b feat/direct-information-pipelines
.venv/bin/pytest 2>&1 | tail -2      # expected: 1169 passed
executor/.venv/bin/python -m pytest executor/tests 2>&1 | tail -2
```

Write down the executor suite's pass count from the last command (the guards must be exactly as green at the end as now).

- [ ] **Step 2: Write the failing extraction tests**

Create `tests/test_extract.py`:

```python
"""Value extraction for the series adapter. Pure functions, no network."""

from datetime import datetime, timezone

import pytest

from iip.extract import ExtractError, check_spec, extract, parse_date, parse_number


class TestCheckSpec:
    @pytest.mark.parametrize(
        "spec",
        [
            "json:value",
            "json:features.0.attributes.n_total",
            r"regex:Average \$([0-9.]+)",
        ],
    )
    def test_accepts_well_formed_specs(self, spec):
        check_spec(spec)

    @pytest.mark.parametrize(
        "spec, why",
        [
            ("value", "no scheme"),
            ("xpath:/a/b", "unknown scheme"),
            ("json:", "empty path"),
            ("json:a..b", "empty segment"),
            ("regex:(", "does not compile"),
            ("regex:no capture group", "zero groups"),
            ("regex:(a)(b)", "two groups"),
        ],
    )
    def test_rejects_malformed_specs(self, spec, why):
        with pytest.raises(ExtractError):
            check_spec(spec)


class TestRegexExtraction:
    SPEC = r"regex:National Average \$([0-9]+\.[0-9]+)"

    def test_returns_the_single_capture(self):
        assert extract(self.SPEC, "<p>National Average $4.3667 <i></i></p>") == "4.3667"

    def test_the_same_number_twice_is_one_answer(self):
        """A page that shows its headline figure in a banner and again in the body is
        not ambiguous: both say the same thing."""
        text = "National Average $4.3667 ... National Average $4.3667"
        assert extract(self.SPEC, text) == "4.3667"

    def test_two_different_numbers_is_an_error_not_a_guess(self):
        """Picking the first of two different figures would report one of them as THE
        value on a page we have stopped understanding."""
        text = "National Average $4.3667 ... National Average $9.9999"
        with pytest.raises(ExtractError, match="ambiguous"):
            extract(self.SPEC, text)

    def test_no_match_is_an_error(self):
        with pytest.raises(ExtractError, match="matched nothing"):
            extract(self.SPEC, "<html>redesigned page</html>")


class TestJsonExtraction:
    BODY = '{"features":[{"attributes":{"n_total":4,"date":"2026-10-04"}}]}'

    def test_follows_keys_and_list_indexes(self):
        assert extract("json:features.0.attributes.n_total", self.BODY) == "4"
        assert extract("json:features.0.attributes.date", self.BODY) == "2026-10-04"

    def test_an_error_object_served_with_http_200_is_an_error(self):
        """ArcGIS answers a bad query with HTTP 200 and {"error": {...}}. That must not
        read as a quiet source."""
        body = '{"error":{"code":400,"message":"Cannot perform query."}}'
        with pytest.raises(ExtractError, match="not found"):
            extract("json:features.0.attributes.n_total", body)

    def test_an_empty_feature_list_is_an_error(self):
        with pytest.raises(ExtractError, match="not a valid index"):
            extract("json:features.0.attributes.n_total", '{"features":[]}')

    def test_html_where_json_was_expected_is_an_error(self):
        with pytest.raises(ExtractError, match="not JSON"):
            extract("json:a", "<html>Service Unavailable</html>")

    @pytest.mark.parametrize("body", ['{"a":null}', '{"a":{"b":1}}', '{"a":[1]}', '{"a":true}'])
    def test_a_non_scalar_end_is_an_error(self, body):
        with pytest.raises(ExtractError, match="scalar"):
            extract("json:a", body)


class TestParseNumber:
    def test_plain_and_comma_numbers(self):
        assert parse_number("4.3667") == 4.3667
        assert parse_number(" 1,234.5 ") == 1234.5
        assert parse_number("0") == 0.0

    @pytest.mark.parametrize("text", ["", "abc", "nan", "inf", "-inf", "4.3.6"])
    def test_rejects_non_numbers(self, text):
        with pytest.raises(ExtractError):
            parse_number(text)


class TestParseDate:
    def test_iso_date_is_midnight_utc(self):
        assert parse_date("2026-10-04", "iso") == datetime(2026, 10, 4, tzinfo=timezone.utc)

    def test_iso_datetime_with_offset_is_converted_to_utc(self):
        assert parse_date("2026-10-04T02:00:00+02:00", "iso") == datetime(
            2026, 10, 4, 0, 0, tzinfo=timezone.utc
        )

    def test_epoch_milliseconds(self):
        assert parse_date("1759536000000", "epoch_ms") == datetime(
            2025, 10, 4, tzinfo=timezone.utc
        )

    def test_month_day_two_digit_year(self):
        assert parse_date("10/7/26", "mdy_short") == datetime(2026, 10, 7, tzinfo=timezone.utc)

    @pytest.mark.parametrize("fmt, text", [("iso", "yesterday"), ("epoch_ms", "soon"), ("mdy_short", "2026-10-07")])
    def test_rejects_unparseable_dates(self, fmt, text):
        with pytest.raises(ExtractError):
            parse_date(text, fmt)
```

- [ ] **Step 3: Run it and watch it fail**

Run: `.venv/bin/pytest tests/test_extract.py`
Expected: a collection error, `ModuleNotFoundError: No module named 'iip.extract'`.

- [ ] **Step 4: Write `iip/extract.py`**

```python
"""Pull ONE value out of a response body. Shared by config validation and SeriesAdapter.

A spec is `json:<dotted.path>` or `regex:<pattern with exactly one capture group>`.

The governing rule is the project's own: a source that has stopped saying what we think
it says must not look like a source that is quiet. So every function here either returns
the value the spec names or raises `ExtractError` -- never an empty string, a zero, or a
"best guess" among several candidates.
"""

from __future__ import annotations

import json
import math
import re
from datetime import datetime, timezone
from typing import Any


class ExtractError(ValueError):
    """The spec is malformed, or the body does not contain what the spec names."""


def _split(spec: str) -> tuple[str, str]:
    for kind in ("json", "regex"):
        prefix = f"{kind}:"
        if spec.startswith(prefix):
            return kind, spec[len(prefix):]
    raise ExtractError(f"extractor must start with 'json:' or 'regex:', got {spec!r}")


def check_spec(spec: str) -> None:
    """Config-time syntax check. Never looks at a body."""
    kind, expr = _split(spec)
    if kind == "regex":
        try:
            compiled = re.compile(expr)
        except re.error as exc:
            raise ExtractError(f"invalid regex {expr!r}: {exc}") from exc
        if compiled.groups != 1:
            raise ExtractError(
                f"a regex extractor needs exactly one capture group, got "
                f"{compiled.groups}: {expr!r}"
            )
        return
    if not expr or any(part == "" for part in expr.split(".")):
        raise ExtractError(f"empty segment in json path {expr!r}")


def extract(spec: str, text: str) -> str:
    """The one value `spec` names in `text`, as a string.

    A regex that matches several DIFFERENT values is an error rather than "take the
    first": on a page we have stopped understanding, the first match is as likely to be
    a sidebar as the figure, and reporting it would be a confident wrong number. The
    same value repeated is fine -- a page may show its headline figure twice.
    """
    kind, expr = _split(spec)
    if kind == "regex":
        matches = re.findall(expr, text)
        if not matches:
            raise ExtractError(f"regex matched nothing: {expr!r}")
        distinct = sorted(set(matches))
        if len(distinct) > 1:
            raise ExtractError(
                f"regex is ambiguous, {len(distinct)} distinct matches "
                f"{distinct[:4]!r}: {expr!r}"
            )
        return distinct[0]

    try:
        node: Any = json.loads(text)
    except ValueError as exc:
        raise ExtractError(f"body is not JSON: {exc}") from exc
    for part in expr.split("."):
        if isinstance(node, list):
            try:
                node = node[int(part)]
            except (ValueError, IndexError):
                raise ExtractError(
                    f"json path segment {part!r} is not a valid index of a list of "
                    f"{len(node)}"
                ) from None
        elif isinstance(node, dict):
            if part not in node:
                raise ExtractError(
                    f"json path segment {part!r} not found (keys: {sorted(node)[:6]})"
                )
            node = node[part]
        else:
            raise ExtractError(f"json path segment {part!r} descends into a scalar")
    if node is None or isinstance(node, (dict, list, bool)):
        raise ExtractError(
            f"json path {expr!r} did not end at a scalar value, got {type(node).__name__}"
        )
    return str(node)


def parse_number(text: str) -> float:
    cleaned = text.strip().replace(",", "")
    try:
        value = float(cleaned)
    except ValueError:
        raise ExtractError(f"not a number: {text!r}") from None
    if not math.isfinite(value):
        raise ExtractError(f"not a finite number: {text!r}")
    return value


def parse_date(text: str, fmt: str) -> datetime:
    """A UTC datetime. Date-only inputs are midnight UTC."""
    raw = text.strip()
    try:
        if fmt == "iso":
            parsed = datetime.fromisoformat(raw)
        elif fmt == "epoch_ms":
            parsed = datetime.fromtimestamp(int(float(raw)) / 1000, tz=timezone.utc)
        elif fmt == "mdy_short":
            parsed = datetime.strptime(raw, "%m/%d/%y")
        else:
            raise ExtractError(f"unknown date format {fmt!r}")
    except ExtractError:
        raise
    except (ValueError, OverflowError, OSError):
        raise ExtractError(f"not a {fmt} date: {text!r}") from None
    if parsed.tzinfo is None:
        return parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc)
```

- [ ] **Step 5: Run the extraction tests**

Run: `.venv/bin/pytest tests/test_extract.py`
Expected: `36 passed`.

- [ ] **Step 6: Write the failing registry tests**

Append this to the END of `tests/test_registry.py` (leave everything above it as is):

```python


SERIES = """
sources:
  - id: widget_count
    adapter: series
    url: https://data.example.org/latest
    trust_tier: 1
    extract: "json:value"
    date_extract: "json:date"
    label: Widget count
    unit: widgets
"""


def series_yaml(**changes):
    """The SERIES source with keys replaced; a value of None removes the key."""
    entry = yaml.safe_load(SERIES)["sources"][0]
    for key, value in changes.items():
        if value is None:
            entry.pop(key, None)
        else:
            entry[key] = value
    return yaml.safe_dump({"sources": [entry]})


class TestSeriesSources:
    def load(self, tmp_path, text):
        registry = Registry(write(tmp_path, text))
        registry.load()
        return registry.by_id["widget_count"]

    def test_a_valid_series_source_parses_with_documented_defaults(self, tmp_path):
        config = self.load(tmp_path, SERIES)
        assert config.adapter == "series"
        assert config.emit_on == "new_point"
        assert config.date_format == "iso"
        assert config.params == {}
        assert config.page_url is None

    def test_series_is_a_known_adapter(self):
        from iip.registry import KNOWN_ADAPTERS

        assert "series" in KNOWN_ADAPTERS

    @pytest.mark.parametrize(
        "changes, message",
        [
            ({"url": None}, "require a url"),
            ({"extract": None}, "require an extract"),
            ({"label": None}, "require a label"),
            ({"extract": "value"}, "must start with"),
            ({"extract": r"regex:(a)(b)"}, "exactly one capture group"),
            ({"date_extract": "xpath:/a"}, "must start with"),
            ({"date_extract": None}, "needs a date_extract"),
            ({"emit_on": "change_ge"}, "requires change_ge"),
            ({"change_ge": 0.5}, "only meaningful"),
            ({"url": "https://api.elections.kalshi.com/trade-api/v2/markets"}, "kalshi"),
            ({"page_url": "https://trading.kalshi.com/"}, "kalshi"),
        ],
    )
    def test_invalid_series_configs_are_refused_loudly(self, tmp_path, changes, message):
        with pytest.raises(ConfigError, match=message):
            Registry(write(tmp_path, series_yaml(**changes))).load()

    def test_change_ge_mode_without_a_date_extractor_is_allowed(self, tmp_path):
        config = self.load(
            tmp_path, series_yaml(emit_on="change_ge", change_ge=0.01, date_extract=None)
        )
        assert config.change_ge == 0.01

    def test_a_misspelled_series_key_is_still_rejected(self, tmp_path):
        """extra="forbid" is what stops `extrakt:` becoming a source that quietly
        extracts nothing."""
        with pytest.raises(ConfigError):
            Registry(write(tmp_path, series_yaml(extrakt="json:value"))).load()
```

Run: `.venv/bin/pytest tests/test_registry.py`
Expected: 14 of the 15 new tests FAIL (`unknown adapter 'series'`). The misspelled-key test already passes, because an unknown adapter is also a `ConfigError`; it becomes meaningful once the adapter is known.

- [ ] **Step 7: Apply the registry change**

Save this as the patch and apply it (it reproduces exactly the tested edit):

```bash
git apply <<'PATCH'
--- a/iip/registry.py
+++ b/iip/registry.py
@@ -6,14 +6,17 @@
 from datetime import datetime
 from pathlib import Path
 from typing import Literal
+from urllib.parse import urlsplit
 
 import yaml
 from pydantic import BaseModel, ConfigDict, Field, ValidationError
 
+from iip.extract import ExtractError, check_spec
+
 log = logging.getLogger(__name__)
 
 # Extended as adapters land in later phases.
-KNOWN_ADAPTERS = ("feed", "bluesky", "telegram", "primary", "reddit")
+KNOWN_ADAPTERS = ("feed", "bluesky", "telegram", "primary", "reddit", "series")
 
 
 class ConfigError(Exception):
@@ -70,7 +73,9 @@
     # pipeline. Omitting it from this Literal made the daemon crash on startup the
     # instant a schedule entry was enabled, and no test caught it because schedule.yaml
     # ships empty and that loop body never ran.
-    adapter: Literal["feed", "bluesky", "telegram", "primary", "scheduled", "reddit"]
+    adapter: Literal[
+        "feed", "bluesky", "telegram", "primary", "scheduled", "reddit", "series"
+    ]
     url: str = ""
     trust_tier: int = Field(ge=1, le=5)
     tier: Literal["hot", "warm", "cold"] = "warm"
@@ -120,6 +125,26 @@
     # interval regardless of what `rate_limit`/`poll_interval_s` ask for, because
     # this host answers abuse with a block; see iip/adapters/reddit.py.
     subreddits: list[str] = Field(default_factory=list)
+    # SERIES adapters only: one number that changes over time (a price, a count), polled
+    # from an endpoint or page. Nothing here may name a market or a level at which anyone
+    # would trade -- see iip/adapters/series.py. Required keys are checked in
+    # `_validate_series`, not by defaults: a default extractor would be a guess about a
+    # page nobody has looked at.
+    #
+    # `extract` / `date_extract`: `json:<dotted.path>` or `regex:<one capture group>`.
+    params: dict[str, str] = Field(default_factory=dict)
+    extract: str | None = Field(default=None, min_length=1)
+    date_extract: str | None = Field(default=None, min_length=1)
+    date_format: Literal["iso", "epoch_ms", "mdy_short"] = "iso"
+    # What the number is, in words, for the headline and snippet ("AAA national average").
+    label: str | None = Field(default=None, min_length=1)
+    unit: str = ""
+    # `new_point`: emit when the data point (its date, or its value) differs from the last
+    # one reported. `change_ge`: emit when the value has moved by at least `change_ge`.
+    emit_on: Literal["new_point", "change_ge"] = "new_point"
+    change_ge: float | None = Field(default=None, gt=0)
+    # The human-facing page for the item's `url`, when `url` is an API query.
+    page_url: str | None = Field(default=None, min_length=1)
     # Should a body be fetched from the OUTBOUND ARTICLE named in the entry's content,
     # rather than from the entry's own link? Off by default and per source: the generic
     # feed adapter serves seven sources and for a normal news feed the entry link IS the
@@ -156,6 +181,38 @@
     ban_block_s: float = Field(default=900.0, gt=0)
 
 
+def _validate_series(config: SourceConfig) -> None:
+    """Everything a series source must state, refused rather than defaulted."""
+    where = f"source {config.id!r}"
+    if not config.url:
+        raise ConfigError(f"{where}: series adapters require a url")
+    if not config.extract:
+        raise ConfigError(f"{where}: series adapters require an extract")
+    if not config.label:
+        raise ConfigError(f"{where}: series adapters require a label")
+    for field in (config.url, config.page_url):
+        host = (urlsplit(field).hostname or "").lower() if field else ""
+        if "kalshi" in host:
+            # The standing credential rule, enforced where it cannot be forgotten: no
+            # source in this daemon may point at a Kalshi host.
+            raise ConfigError(f"{where}: a source may never point at a kalshi host")
+    try:
+        check_spec(config.extract)
+        if config.date_extract:
+            check_spec(config.date_extract)
+    except ExtractError as exc:
+        raise ConfigError(f"{where}: {exc}") from exc
+    if config.emit_on == "change_ge" and config.change_ge is None:
+        raise ConfigError(f"{where}: emit_on change_ge requires change_ge")
+    if config.emit_on != "change_ge" and config.change_ge is not None:
+        raise ConfigError(f"{where}: change_ge is only meaningful with emit_on: change_ge")
+    if config.emit_on == "new_point" and not config.date_extract:
+        raise ConfigError(
+            f"{where}: emit_on new_point needs a date_extract -- without a data date there"
+            " is no way to tell a new point from the same one"
+        )
+
+
 class Registry:
     def __init__(self, path: Path) -> None:
         self._path = Path(path)
@@ -271,6 +328,8 @@
                         f"source {config.id!r}: primary adapters require a"
                         " region_selector (the page region to watch)"
                     )
+            if config.adapter == "series":
+                _validate_series(config)
             if config.id in seen:
                 raise ConfigError(f"duplicate source id {config.id!r}")
             seen.add(config.id)
PATCH
```

- [ ] **Step 8: Run the registry and extraction tests, then the whole suite**

```bash
.venv/bin/pytest tests/test_registry.py tests/test_extract.py   # expected: 92 passed
.venv/bin/pytest 2>&1 | tail -2                                  # expected: 1220 passed
```

- [ ] **Step 9: Commit**

```bash
git add iip/extract.py iip/registry.py tests/test_extract.py tests/test_registry.py
git commit -m "feat(registry): declare the series adapter and validate its config

Add iip/extract.py (one value out of a JSON or regex body; ambiguity and absence are
errors, never guesses) and the series source fields. An incomplete series source, a bad
extractor, or one pointed at a kalshi host is refused at load time."
```

---

### Task 2: `SeriesAdapter`

**Files:**
- Create: `iip/adapters/series.py`
- Create: `tests/test_series_adapter.py`
- Modify: `iip/__main__.py` (the `build_adapter` function only)
- Modify: `tests/adapter_cases.py` (the shared contract suite)

**Interfaces:**
- Consumes (Task 1): `ExtractError`, `extract`, `parse_number`, `parse_date`; the `SourceConfig` series fields.
- Produces: `iip.adapters.series.SeriesAdapter(config, *, clock, client, sleep=asyncio.sleep, max_bytes=2 MiB, timeout_s=10.0)` implementing the existing `Adapter` protocol (`source_id`, `poll_once`, `run`, `health`, `aclose`) plus `limiter`, `blocked`, `blocked_for`, `newest_seen_publish_ts`, `last_poll_newest_publish_ts`, `cooldown_until_monotonic`, `ban_until_monotonic`, `consecutive_forbidden`. Emitted items carry `dedup_identity == f"{source_id}|{data_date}|{value}"`, `provenance_gaps == (SYNTHETIC_HEADLINE, NO_ARTICLE_URL)`, `observed_live=False` for the first reading and `True` after.

- [ ] **Step 1: Write the failing adapter tests**

Create `tests/test_series_adapter.py`:

```python
"""SeriesAdapter: one number that changes over time, reported one reading at a time.

The properties that carry this component:

* **A reading is reported once.** An unchanged value is silence, a new data point is one
  item, and the same point seen again after a restart collapses in permanent dedup.
* **A failed extraction is an ERROR, never "no change".** A 200 whose body no longer
  contains the number (an error JSON, a redesigned page) must read as a broken source.
  Emitting zero, or re-emitting the last value, would make it look fine.
* **It knows nothing about markets.** A level at which somebody would trade does not
  appear here; what a reading means is somebody else's problem.
"""

from __future__ import annotations

import asyncio
import json
import pathlib
import re
from datetime import datetime, timezone

import httpx
import pytest

from iip.adapters.series import SeriesAdapter
from iip.health import HealthMonitor
from iip.registry import SourceConfig
from iip.schema import NO_ARTICLE_URL, SYNTHETIC_HEADLINE, HealthState

URL = "https://data.example.org/latest"


def make_config(**overrides) -> SourceConfig:
    defaults = dict(
        id="test_series",
        adapter="series",
        url=URL,
        trust_tier=1,
        poll_interval_s=60,
        extract="json:value",
        date_extract="json:date",
        date_format="iso",
        label="Widget count",
        unit="widgets",
        emit_on="new_point",
    )
    return SourceConfig(**{**defaults, **overrides})


class Recorder:
    """Injected sleep: records the delay and yields instead of waiting."""

    def __init__(self):
        self.delays = []

    async def __call__(self, seconds):
        self.delays.append(seconds)
        await asyncio.sleep(0)


class FakeServer:
    """A mutable fake endpoint. Tests change `body`/`status` between polls."""

    def __init__(self, body="", status=200, headers=None):
        self.body = body
        self.status = status
        self.headers = headers or {}
        self.requests: list[httpx.Request] = []

    def __call__(self, request: httpx.Request) -> httpx.Response:
        self.requests.append(request)
        return httpx.Response(self.status, text=self.body, headers=self.headers)


def reading(value, date="2026-10-04") -> str:
    return json.dumps({"value": value, "date": date})


def make_adapter(clock, server, **overrides) -> SeriesAdapter:
    return SeriesAdapter(
        make_config(**overrides),
        clock=clock,
        client=httpx.AsyncClient(transport=httpx.MockTransport(server)),
        sleep=Recorder(),
    )


class TestEmission:
    async def test_the_first_poll_reports_the_baseline_reading_as_not_live(self, clock):
        adapter = make_adapter(clock, FakeServer(reading(4)))
        [item] = await adapter.poll_once()
        assert item.headline == "Widget count: 4 widgets (2026-10-04)"
        assert "First reading" in item.snippet
        assert item.source_publish_ts == datetime(2026, 10, 4, tzinfo=timezone.utc)
        assert item.url == URL
        assert item.observed_live is False
        assert item.dedup_identity == "test_series|2026-10-04|4"
        assert SYNTHETIC_HEADLINE in item.provenance_gaps
        assert NO_ARTICLE_URL in item.provenance_gaps

    async def test_an_unchanged_reading_is_not_reported_again(self, clock):
        adapter = make_adapter(clock, FakeServer(reading(4)))
        assert len(await adapter.poll_once()) == 1
        assert await adapter.poll_once() == []
        assert await adapter.poll_once() == []

    async def test_a_new_data_point_is_one_item_with_previous_value_and_change(self, clock):
        server = FakeServer(reading(4, "2026-10-04"))
        adapter = make_adapter(clock, server)
        await adapter.poll_once()
        server.body = reading(7, "2026-10-05")
        [item] = await adapter.poll_once()
        assert item.headline == "Widget count: 7 widgets (2026-10-05)"
        assert "previous reading 4 widgets as of 2026-10-04" in item.snippet
        assert "change +3 widgets" in item.snippet
        assert item.observed_live is True
        assert await adapter.poll_once() == []

    async def test_a_decrease_reports_a_negative_change(self, clock):
        server = FakeServer(reading(7, "2026-10-04"))
        adapter = make_adapter(clock, server)
        await adapter.poll_once()
        server.body = reading(4.5, "2026-10-05")
        [item] = await adapter.poll_once()
        assert "change -2.5 widgets" in item.snippet

    async def test_a_revised_value_for_the_same_date_is_a_new_reading(self, clock):
        server = FakeServer(reading(4, "2026-10-04"))
        adapter = make_adapter(clock, server)
        [first] = await adapter.poll_once()
        server.body = reading(5, "2026-10-04")
        [revised] = await adapter.poll_once()
        assert revised.dedup_identity != first.dedup_identity

    async def test_the_same_reading_after_a_restart_has_the_same_identity(self, clock):
        """Permanent dedup is what stops a restart re-announcing today's number. That only
        works if the identity is a function of the reading, not of the process."""
        [before] = await make_adapter(clock, FakeServer(reading(4))).poll_once()
        [after] = await make_adapter(clock, FakeServer(reading(4))).poll_once()
        assert before.dedup_identity == after.dedup_identity

    async def test_an_older_date_than_one_already_reported_emits_nothing_and_reads_as_rolled_back(
        self, clock
    ):
        server = FakeServer(reading(7, "2026-10-05"))
        adapter = make_adapter(clock, server)
        await adapter.poll_once()
        server.body = reading(3, "2026-10-03")
        assert await adapter.poll_once() == []
        health = await adapter.health()
        # The mechanism worked; what it returned is older than what we already reported.
        # HealthMonitor._rollback turns exactly this pair into DEAD "feed rolled back".
        assert health.mechanism_ok is True
        assert health.newest_seen_publish_ts == datetime(2026, 10, 5, tzinfo=timezone.utc)
        assert health.last_poll_newest_publish_ts == datetime(2026, 10, 3, tzinfo=timezone.utc)
        state, detail = HealthMonitor(None, clock).evaluate(make_config(), health)
        assert state is HealthState.DEAD
        assert "rolled back" in detail


class TestChangeMode:
    def config(self, **overrides):
        return dict(emit_on="change_ge", change_ge=0.01, **overrides)

    async def test_only_moves_of_at_least_the_delta_are_reported(self, clock):
        server = FakeServer(reading(4.00))
        adapter = make_adapter(clock, server, **self.config())
        assert len(await adapter.poll_once()) == 1  # baseline
        server.body = reading(4.005)  # wiggle below the delta
        assert await adapter.poll_once() == []
        server.body = reading(4.02)  # measured from the last REPORTED value
        [item] = await adapter.poll_once()
        assert "change +0.02" in item.snippet

    async def test_without_a_date_extractor_the_fetch_day_is_the_data_day_and_no_publish_time_is_claimed(
        self, clock
    ):
        server = FakeServer('{"value": 4.1}')
        adapter = make_adapter(clock, server, **self.config(date_extract=None))
        [item] = await adapter.poll_once()
        assert item.headline == "Widget count: 4.1 widgets (2026-07-28)"
        assert item.source_publish_ts is None


class TestExtractionFailureIsNotQuiet:
    async def test_a_200_whose_body_lacks_the_number_is_degraded_and_emits_nothing(self, clock):
        error_body = '{"error":{"code":400,"message":"Cannot perform query."}}'
        adapter = make_adapter(clock, FakeServer(error_body))
        assert await adapter.poll_once() == []
        health = await adapter.health()
        assert health.mechanism_ok is False
        assert health.consecutive_errors == 1
        assert health.last_error.startswith("extraction failed")
        state, _ = HealthMonitor(None, clock).evaluate(make_config(), health)
        assert state is HealthState.DEGRADED

    async def test_three_failures_in_a_row_is_dead(self, clock):
        adapter = make_adapter(clock, FakeServer("<html>Service Unavailable</html>"))
        for _ in range(3):
            await adapter.poll_once()
        health = await adapter.health()
        state, _ = HealthMonitor(None, clock).evaluate(make_config(), health)
        assert state is HealthState.DEAD

    async def test_a_failure_after_a_good_reading_never_reuses_or_zeroes_the_value(self, clock):
        server = FakeServer(reading(4))
        adapter = make_adapter(clock, server)
        await adapter.poll_once()
        server.body = "<html>redesigned</html>"
        assert await adapter.poll_once() == []
        server.body = reading(4)  # the source recovers with the SAME reading
        assert await adapter.poll_once() == []  # still not news
        health = await adapter.health()
        assert health.mechanism_ok is True
        assert health.consecutive_errors == 0

    async def test_a_value_that_is_not_a_number_is_a_failure(self, clock):
        adapter = make_adapter(clock, FakeServer(reading("n/a")))
        assert await adapter.poll_once() == []
        assert (await adapter.health()).mechanism_ok is False

    async def test_an_unparseable_date_is_a_failure(self, clock):
        adapter = make_adapter(clock, FakeServer(reading(4, "last Tuesday")))
        assert await adapter.poll_once() == []
        assert (await adapter.health()).mechanism_ok is False


class TestTransport:
    async def test_http_500_is_a_failure(self, clock):
        adapter = make_adapter(clock, FakeServer("boom", status=500))
        assert await adapter.poll_once() == []
        health = await adapter.health()
        assert health.mechanism_ok is False
        assert health.last_error == "HTTP 500"

    async def test_a_timeout_is_a_failure_not_a_crash(self, clock):
        def handler(request):
            raise httpx.ConnectTimeout("timed out", request=request)

        adapter = SeriesAdapter(
            make_config(),
            clock=clock,
            client=httpx.AsyncClient(transport=httpx.MockTransport(handler)),
            sleep=Recorder(),
        )
        assert await adapter.poll_once() == []
        assert (await adapter.health()).last_error.startswith("transport error")

    async def test_repeated_403s_stop_the_polling(self, clock):
        server = FakeServer("denied", status=403)
        adapter = make_adapter(clock, server, ban_after_forbidden=2)
        await adapter.poll_once()
        await adapter.poll_once()
        health = await adapter.health()
        assert health.blocked is True
        assert health.consecutive_forbidden == 2
        requests_before = len(server.requests)
        assert await adapter.poll_once() == []
        assert len(server.requests) == requests_before  # stopped means stopped

    async def test_429_starts_a_cooldown(self, clock):
        server = FakeServer("slow down", status=429, headers={"Retry-After": "120"})
        adapter = make_adapter(clock, server)
        await adapter.poll_once()
        assert adapter.cooldown_until_monotonic == clock.monotonic() + 120
        requests_before = len(server.requests)
        await adapter.poll_once()
        assert len(server.requests) == requests_before

    async def test_an_oversize_body_is_refused(self, clock):
        adapter = SeriesAdapter(
            make_config(),
            clock=clock,
            client=httpx.AsyncClient(transport=httpx.MockTransport(FakeServer("x" * 5000))),
            sleep=Recorder(),
            max_bytes=1000,
        )
        assert await adapter.poll_once() == []
        assert "too large" in (await adapter.health()).last_error

    async def test_the_request_carries_params_and_no_credentials(self, clock):
        server = FakeServer(reading(4))
        adapter = make_adapter(clock, server, params={"where": "x=1", "f": "json"})
        await adapter.poll_once()
        [request] = server.requests
        assert request.url.params["where"] == "x=1"
        assert request.url.params["f"] == "json"
        assert "authorization" not in {k.lower() for k in request.headers}
        assert "cookie" not in {k.lower() for k in request.headers}


class TestExtractors:
    async def test_a_regex_over_html_with_the_figure_shown_twice_is_fine(self, clock):
        html = "<b>Average $4.3667</b> ... <i>Average $4.3667</i> Price as of 10/7/26"
        adapter = make_adapter(
            clock,
            FakeServer(html),
            extract=r"regex:Average \$([0-9.]+)",
            date_extract=r"regex:Price as of ([0-9/]+)",
            date_format="mdy_short",
        )
        [item] = await adapter.poll_once()
        assert item.headline == "Widget count: 4.3667 widgets (2026-10-07)"

    async def test_a_regex_over_html_showing_two_different_figures_is_a_failure(self, clock):
        html = "Average $4.3667 ... Average $9.9999 Price as of 10/7/26"
        adapter = make_adapter(
            clock,
            FakeServer(html),
            extract=r"regex:Average \$([0-9.]+)",
            date_extract=r"regex:Price as of ([0-9/]+)",
            date_format="mdy_short",
        )
        assert await adapter.poll_once() == []
        assert "ambiguous" in (await adapter.health()).last_error

    async def test_a_json_path_through_a_list(self, clock):
        body = '{"features":[{"attributes":{"n":9,"d":"2026-10-01"}}]}'
        adapter = make_adapter(
            clock,
            FakeServer(body),
            extract="json:features.0.attributes.n",
            date_extract="json:features.0.attributes.d",
        )
        [item] = await adapter.poll_once()
        assert item.headline == "Widget count: 9 widgets (2026-10-01)"


class TestSurroundings:
    async def test_run_yields_a_new_reading_then_sleeps_the_poll_interval(self, clock):
        sleeps = Recorder()
        adapter = SeriesAdapter(
            make_config(poll_interval_s=42),
            clock=clock,
            client=httpx.AsyncClient(transport=httpx.MockTransport(FakeServer(reading(4)))),
            sleep=sleeps,
        )
        stream = adapter.run()
        item = await stream.__anext__()
        assert item.headline.startswith("Widget count")
        task = asyncio.create_task(stream.__anext__())
        await asyncio.sleep(0.01)
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task
        assert sleeps.delays and sleeps.delays[0] == 42

    async def test_build_adapter_constructs_a_series_adapter(self):
        from iip.__main__ import build_adapter
        from iip.clock import SystemClock

        adapter = build_adapter(make_config(), SystemClock())
        try:
            assert isinstance(adapter, SeriesAdapter)
        finally:
            await adapter.aclose()

    def test_the_adapter_and_extraction_code_know_nothing_about_markets(self):
        """Market ignorance is a rule of this repo: no ticker, venue or trading level may
        enter iip/. Checked on the source text so it fails the day someone types one."""
        root = pathlib.Path(__file__).resolve().parent.parent / "iip"
        banned = re.compile(r"\bKX[A-Z]{2,}|kalshi|\bstrike\b|\bthreshold\b|\bbet\b", re.I)
        for name in ("adapters/series.py", "extract.py"):
            text = (root / name).read_text()
            # registry.py legitimately NAMES kalshi to refuse it; these two must not.
            assert not banned.search(text), f"{name} mentions a market term"
```

Run: `.venv/bin/pytest tests/test_series_adapter.py`
Expected: collection error, `ModuleNotFoundError: No module named 'iip.adapters.series'`.

- [ ] **Step 2: Write `iip/adapters/series.py`**

```python
"""SeriesAdapter: poll one number that changes over time and report each new reading.

Some of what matters is not a headline at all. A national average price, a daily count of
ships through a strait: each is a number published on a schedule by someone with no feed,
and the only way to know it moved is to read it again. This adapter reads one such number
per source and reports a reading when it is new.

Three properties define it.

**A reading is reported once.** An unchanged value is silence. A new data point is one
item. The same point seen again after a restart gets the same `dedup_identity` -- a
function of the source, the data date and the value, never of this process -- so permanent
dedup drops it instead of announcing today's number a second time.

**A failed extraction is an ERROR, never "no change".** If the response is a 200 but no
longer contains the number -- an error object served with a success status, a redesigned
page, a field renamed -- the adapter reports DEGRADED (and DEAD after repeated failures)
and emits nothing. It never emits zero, and it never repeats the previous value. A source
that has stopped saying what we think it says must not be indistinguishable from one that
is quiet; that is the rule this whole daemon is organised around.

**It knows nothing about markets.** Config says where the number is and what to call it.
What a reading means for anything anyone trades is not this module's business, which is
also why this file contains no level, ticker or venue.

The data DATE, when the source states one, is the item's `source_publish_ts` and is also
what the health monitor uses to notice a source handing back an older point than one
already reported. (The normalizer drops publish times it cannot believe, such as a point
several days old; the date then survives only in the headline and snippet, which is the
honest outcome for a series that publishes with a lag.)
"""

from __future__ import annotations

import asyncio
import logging
from datetime import datetime, timezone
from typing import AsyncIterator, Awaitable, Callable

import httpx

from iip.clock import Clock
from iip.extract import ExtractError, extract, parse_date, parse_number
from iip.ratelimit import RateLimiter
from iip.registry import SourceConfig
from iip.schema import NO_ARTICLE_URL, SYNTHETIC_HEADLINE, AdapterHealth, RawItem

log = logging.getLogger(__name__)

DEFAULT_MAX_BYTES = 2 * 1024 * 1024
DEFAULT_TIMEOUT_S = 10.0
DEFAULT_USER_AGENT = "iip/0.1 (+internet-info-plug)"
BODY_PREVIEW_CHARS = 120


class _ResponseTooLarge(Exception):
    """Raised from inside the streaming block so leaving it stops the download."""


def _fmt(value: float) -> str:
    """4.3667 -> "4.3667", 4.0 -> "4", 0.0 -> "0". Never scientific notation."""
    text = f"{value:.6f}".rstrip("0").rstrip(".")
    return text or "0"


class SeriesAdapter:
    """Reads one numeric series. One adapter per source, like FeedAdapter."""

    def __init__(
        self,
        config: SourceConfig,
        *,
        clock: Clock,
        client: httpx.AsyncClient,
        sleep: Callable[[float], Awaitable[None]] = asyncio.sleep,
        max_bytes: int = DEFAULT_MAX_BYTES,
        timeout_s: float = DEFAULT_TIMEOUT_S,
    ) -> None:
        if not config.extract or not config.label:
            raise ValueError(f"{config.id}: series adapters require extract and label")
        self.source_id = config.id
        self._config = config
        self._clock = clock
        self._client = client
        self._sleep = sleep
        self._max_bytes = max_bytes
        self._timeout_s = timeout_s

        # Opt-in per source, exactly as FeedAdapter: no rate_limit block means no
        # limiter, never a limiter with a rate of zero.
        self.limiter: RateLimiter | None = (
            RateLimiter(config.rate_limit.rate_per_s, config.rate_limit.burst, clock)
            if config.rate_limit is not None
            else None
        )

        # The last reading we REPORTED. Never updated by a failed or suppressed poll.
        self._last_value: float | None = None
        self._last_date: datetime | None = None
        self._reported_any = False

        self.newest_seen_publish_ts: datetime | None = None
        self.last_poll_newest_publish_ts: datetime | None = None
        self.cooldown_until_monotonic: float = 0.0
        self.ban_until_monotonic: float = 0.0
        self.consecutive_forbidden: int = 0

        self._consecutive_errors = 0
        self._last_error: str | None = None
        self._last_poll_ok_at: datetime | None = None
        self._last_item_at: datetime | None = None
        self._mechanism_ok = False
        self._closed = False

    # --- Adapter protocol ----------------------------------------------

    @property
    def blocked(self) -> bool:
        return self.blocked_for > 0.0

    @property
    def blocked_for(self) -> float:
        remaining = self.ban_until_monotonic - self._clock.monotonic()
        if self.limiter is not None:
            remaining = max(remaining, self.limiter.blocked_for)
        return max(0.0, remaining)

    async def poll_once(self) -> list[RawItem]:
        if self.blocked:
            return []
        if self._clock.monotonic() < self.cooldown_until_monotonic:
            return []

        if self.limiter is not None:
            wait = self.limiter.take()
            if wait > 0:
                await self._sleep(wait)

        try:
            status, retry_after, text = await self._fetch()
        except _ResponseTooLarge as exc:
            return self._fail(f"response too large: {exc}")
        except (httpx.HTTPError, httpx.InvalidURL, OSError) as exc:
            return self._fail(f"transport error: {exc!r}")

        if status == 429:
            self._start_cooldown(retry_after)
            return self._fail("429 rate limited")
        if status == 403:
            self.consecutive_forbidden += 1
            if self.consecutive_forbidden >= self._config.ban_after_forbidden:
                self._enter_ban()
            return self._fail("403 forbidden")
        if status >= 400:
            return self._fail(f"HTTP {status}")

        try:
            value = parse_number(extract(self._config.extract, text))
            point_date = self._read_date(text)
        except ExtractError as exc:
            # Includes the start of the body: when an endpoint starts answering with an
            # error page under a 200, that is the one line that says so.
            preview = text[:BODY_PREVIEW_CHARS].replace("\n", " ")
            return self._fail(f"extraction failed: {exc}; body starts {preview!r}")

        return self._consider(value, point_date)

    async def run(self) -> AsyncIterator[RawItem]:
        while True:
            for item in await self.poll_once():
                yield item
            await self._sleep(self._config.poll_interval_s)

    async def health(self) -> AdapterHealth:
        return AdapterHealth(
            source_id=self.source_id,
            mechanism_ok=self._mechanism_ok,
            last_poll_ok_at=self._last_poll_ok_at,
            last_item_at=self._last_item_at,
            consecutive_errors=self._consecutive_errors,
            consecutive_forbidden=self.consecutive_forbidden,
            last_error=self._last_error,
            newest_seen_publish_ts=self.newest_seen_publish_ts,
            last_poll_newest_publish_ts=self.last_poll_newest_publish_ts,
            blocked=self.blocked,
            blocked_for=self.blocked_for,
        )

    async def aclose(self) -> None:
        if self._closed:
            return
        self._closed = True
        await self._client.aclose()

    # --- internals -----------------------------------------------------

    def _read_date(self, text: str) -> datetime:
        if self._config.date_extract:
            return parse_date(
                extract(self._config.date_extract, text), self._config.date_format
            )
        now = self._clock.now()
        return datetime(now.year, now.month, now.day, tzinfo=timezone.utc)

    def _consider(self, value: float, point_date: datetime) -> list[RawItem]:
        self._succeed()
        has_date = bool(self._config.date_extract)
        if has_date:
            self.last_poll_newest_publish_ts = point_date

        if self._reported_any:
            if has_date and self._last_date is not None and point_date < self._last_date:
                # Older than a point already reported: a stale or rolled-back copy. Not
                # news, and not silence either -- health compares the two dates above
                # and calls it what it is.
                log.warning(
                    "%s: served a point dated %s, older than the %s already reported",
                    self.source_id, point_date.date(), self._last_date.date(),
                )
                return []
            if not self._is_new(value, point_date):
                return []

        previous_value, previous_date = self._last_value, self._last_date
        first = not self._reported_any
        self._last_value, self._last_date, self._reported_any = value, point_date, True
        if has_date and (
            self.newest_seen_publish_ts is None or point_date > self.newest_seen_publish_ts
        ):
            self.newest_seen_publish_ts = point_date
        self._last_item_at = self._clock.now()
        return [
            self._to_item(
                value, point_date, previous_value, previous_date, observed_live=not first
            )
        ]

    def _is_new(self, value: float, point_date: datetime) -> bool:
        assert self._last_value is not None
        if self._config.emit_on == "change_ge":
            return abs(value - self._last_value) >= (self._config.change_ge or 0.0)
        return (point_date, value) != (self._last_date, self._last_value)

    def _to_item(
        self,
        value: float,
        point_date: datetime,
        previous_value: float | None,
        previous_date: datetime | None,
        *,
        observed_live: bool,
    ) -> RawItem:
        config = self._config
        shown = _fmt(value)
        unit = f" {config.unit}" if config.unit else ""
        day = point_date.date().isoformat()
        if previous_value is None or previous_date is None:
            snippet = (
                f"{config.label} reads {shown}{unit} as of {day}. First reading recorded "
                "by this source; there is no earlier value to compare it with."
            )
        else:
            change = value - previous_value
            sign = "+" if change >= 0 else "-"
            snippet = (
                f"{config.label} reads {shown}{unit} as of {day}; previous reading "
                f"{_fmt(previous_value)}{unit} as of {previous_date.date().isoformat()}; "
                f"change {sign}{_fmt(abs(change))}{unit}."
            )
        return RawItem(
            source_id=self.source_id,
            # Synthetic, and says so in provenance_gaps as well: nobody wrote this
            # sentence, and `Item.headline` may not be blank.
            headline=f"{config.label}: {shown}{unit} ({day})",
            snippet=snippet,
            # The human-facing page. `url` identifies the thing watched, not this reading,
            # so identity is supplied explicitly (and NO_ARTICLE_URL is declared).
            url=config.page_url or config.url,
            # Only claimed when the source states a date; inferring one from the fetch
            # time would manufacture a publish timestamp.
            source_publish_ts=point_date if config.date_extract else None,
            raw={
                "label": config.label,
                "value": value,
                "unit": config.unit,
                "data_date": day,
                "previous_value": previous_value,
            },
            observed_live=observed_live,
            dedup_identity=f"{self.source_id}|{day}|{shown}",
            provenance_gaps=(SYNTHETIC_HEADLINE, NO_ARTICLE_URL),
        )

    async def _fetch(self) -> tuple[int, str | None, str]:
        """(status, Retry-After, body text). Streamed so the byte cap is real."""
        headers = {"User-Agent": self._config.user_agent or DEFAULT_USER_AGENT}
        async with self._client.stream(
            "GET",
            self._config.url,
            params=self._config.params or None,
            headers=headers,
            timeout=self._timeout_s,
            follow_redirects=True,
        ) as response:
            if response.status_code >= 400:
                return response.status_code, response.headers.get("Retry-After"), ""
            chunks: list[bytes] = []
            total = 0
            async for chunk in response.aiter_bytes():
                total += len(chunk)
                if total > self._max_bytes:
                    raise _ResponseTooLarge(
                        f"aborted the download after {total} bytes, over the "
                        f"{self._max_bytes}-byte cap"
                    )
                chunks.append(chunk)
            encoding = response.encoding or "utf-8"
            status = response.status_code
        return status, None, b"".join(chunks).decode(encoding, "replace")

    def _enter_ban(self) -> None:
        seconds = self._config.ban_block_s
        until = self._clock.monotonic() + seconds
        self.ban_until_monotonic = max(self.ban_until_monotonic, until)
        if self.limiter is not None:
            self.limiter.block(seconds)
        log.critical(
            "%s: %d consecutive 403s -- STOPPING polling for %.0fs. A human must "
            "disable, throttle or re-key this source; it resumes when the block expires.",
            self.source_id, self.consecutive_forbidden, seconds,
        )

    def _start_cooldown(self, retry_after: str | None) -> None:
        seconds = 60.0
        if retry_after:
            try:
                seconds = float(retry_after)
            except ValueError:
                log.warning("%s sent unparseable Retry-After %r", self.source_id, retry_after)
        self.cooldown_until_monotonic = self._clock.monotonic() + seconds
        log.warning("%s rate limited; cooling down %.0fs", self.source_id, seconds)

    def _succeed(self) -> None:
        self._mechanism_ok = True
        self._consecutive_errors = 0
        self._last_error = None
        self._last_poll_ok_at = self._clock.now()
        self.consecutive_forbidden = 0

    def _fail(self, reason: str) -> list[RawItem]:
        self._mechanism_ok = False
        self._consecutive_errors += 1
        self._last_error = reason
        log.warning("%s poll failed: %s", self.source_id, reason)
        return []
```

- [ ] **Step 3: Teach `build_adapter` about `series`**

```bash
git apply <<'PATCH'
--- a/iip/__main__.py
+++ b/iip/__main__.py
@@ -249,6 +249,12 @@
         from iip.adapters.reddit import RedditAdapter
 
         return RedditAdapter(
+            config, clock=clock, client=httpx.AsyncClient(http2=False)
+        )
+    if config.adapter == "series":
+        from iip.adapters.series import SeriesAdapter
+
+        return SeriesAdapter(
             config, clock=clock, client=httpx.AsyncClient(http2=False)
         )
     raise ConfigError(f"no adapter implementation for {config.adapter!r}")
PATCH
```

- [ ] **Step 4: Add the adapter to the shared contract suite**

Every adapter must pass `tests/test_contract.py`. Add it to the registry of cases:

```bash
git apply <<'PATCH'
--- a/tests/adapter_cases.py
+++ b/tests/adapter_cases.py
@@ -110,8 +110,33 @@
     return _PreloadedPush()
 
 
+def make_series_adapter():
+    """SeriesAdapter over an in-process transport: one reading on the first poll."""
+    from iip.adapters.series import SeriesAdapter
+
+    def handler(request: httpx.Request) -> httpx.Response:
+        return httpx.Response(200, json={"value": 4, "date": "2026-07-27"})
+
+    return SeriesAdapter(
+        SourceConfig(
+            id="contract_series",
+            adapter="series",
+            url="https://data.example.org/latest",
+            trust_tier=1,
+            poll_interval_s=0.01,
+            extract="json:value",
+            date_extract="json:date",
+            label="Widget count",
+            unit="widgets",
+        ),
+        clock=FakeClock(datetime(2026, 7, 28, 12, 0, tzinfo=timezone.utc)),
+        client=httpx.AsyncClient(transport=httpx.MockTransport(handler)),
+    )
+
+
 ADAPTER_CASES: list[AdapterCase] = [
     AdapterCase(name="fake", make=FakeAdapter, expected_min_items=2),
     AdapterCase(name="feed", make=make_feed_adapter, expected_min_items=2),
     AdapterCase(name="push", make=make_push_adapter, expected_min_items=2),
+    AdapterCase(name="series", make=make_series_adapter, expected_min_items=1),
 ]
PATCH
```

- [ ] **Step 5: Run the adapter and contract tests**

Run: `.venv/bin/pytest tests/test_series_adapter.py tests/test_contract.py`
Expected: `51 passed`.

- [ ] **Step 6: Mutation check (the suite being green proves the tests, not the code)**

Each mutation breaks one guarantee at the call site. Each must turn the suite red. Run before committing, from the repo root:

```bash
cp iip/adapters/series.py /tmp/series_orig.py
python3 - <<'PYEOF'
import re
import subprocess

path = "iip/adapters/series.py"
orig = open("/tmp/series_orig.py").read()
mutations = {
    "extraction failure swallowed as quiet": (
        '            return self._fail(f"extraction failed: {exc}; body starts {preview!r}")',
        "            return []",
    ),
    "rollback guard removed": (
        "            if has_date and self._last_date is not None and point_date < self._last_date:",
        "            if False:",
    ),
    "identity depends on the process clock": (
        'dedup_identity=f"{self.source_id}|{day}|{shown}"',
        'dedup_identity=f"{self.source_id}|{day}|{shown}|{self._clock.now().isoformat()}"',
    ),
    "unchanged value re-emitted": (
        "            if not self._is_new(value, point_date):\n                return []",
        "            pass",
    ),
}
for name, (old, new) in mutations.items():
    assert orig.count(old) == 1, (name, orig.count(old))
    open(path, "w").write(orig.replace(old, new))
    out = subprocess.run(
        [".venv/bin/python", "-m", "pytest", "tests/test_series_adapter.py", "-p", "no:cacheprovider"],
        capture_output=True, text=True,
    ).stdout
    print(f"MUTATION {name!r}: " + re.sub(r"\x1b\[[0-9;]*m", "", out.strip().splitlines()[-1]))
open(path, "w").write(orig)
PYEOF
cmp /tmp/series_orig.py iip/adapters/series.py && echo "restored: identical"
```

Expected: four `MUTATION ...` lines each reporting at least one `failed` (the validated run showed 3, 1, 1 and 5), then `restored: identical`. If any mutation line reports `0 failed`, a guard is untested: stop and add the missing test before continuing.

- [ ] **Step 7: Run the whole suite**

Run: `.venv/bin/pytest 2>&1 | tail -2`
Expected: `1252 passed`.

- [ ] **Step 8: Commit**

```bash
git add iip/adapters/series.py iip/__main__.py tests/test_series_adapter.py tests/adapter_cases.py
git commit -m "feat(adapters): series adapter -- report each new reading of one published number

One RawItem per new data point; an unchanged value is silence; the same reading after a
restart has the same identity. A 200 that no longer contains the number is DEGRADED and
emits nothing, never zero and never the previous value."
```

---

### Task 3: The mini-mac source file and the two series sources

**Files:**
- Create: `config/sources.minimac.yaml`
- Create: `tests/test_minimac_sources.py`
- Create: `tests/fixtures/series/aaa_home.html`, `tests/fixtures/series/portwatch_hormuz_latest.json`, `tests/fixtures/series/portwatch_error_200.json` (recorded real responses)

**Interfaces:**
- Consumes (Tasks 1-2): the `series` config fields; `SeriesAdapter`.
- Produces: `config/sources.minimac.yaml` containing all 14 shared sources verbatim plus `aaa_national_average` and `imf_portwatch_hormuz`; the test module's constants `NEW_SERIES`, `EXPECTED_NEW`, helpers `load()`, `series_adapter()`, `fixture()` which Task 4 extends.

- [ ] **Step 1: Record real responses from mini-mac (not from this Mac)**

Reachability is per IP, and mini-mac is where this runs. `ssh -n` matters in any loop (plain `ssh` swallows the loop's stdin).

```bash
mkdir -p tests/fixtures/series

# AAA: keep only the block that carries the figure and its date, so the fixture is small
# and readable. A fixture that cannot be read cannot be reviewed.
ssh mini-mac 'curl -s -L -m 25 -A "iip/0.1 (+internet-info-plug)" https://gasprices.aaa.com/' | python3 -c '
import sys
t = sys.stdin.read()
i = t.index("Today’s AAA National Average")
start = t.rfind("<div class=\"mobi-average-price", 0, i)
end = t.index("</div>", i) + len("</div>")
sys.stdout.write("<html><body>\n" + t[start:end] + "\n</body></html>\n")
' > tests/fixtures/series/aaa_home.html

# PortWatch, the success shape.
ssh mini-mac 'bash -s' <<'REMOTE' > tests/fixtures/series/portwatch_hormuz_latest.json
curl -s -m 30 -A 'iip/0.1 (+internet-info-plug)' -G \
  'https://services9.arcgis.com/weJ1QsnbMYJlCHdG/arcgis/rest/services/Daily_Chokepoints_Data/FeatureServer/0/query' \
  --data-urlencode "where=portname='Strait of Hormuz'" \
  --data-urlencode 'outFields=date,portname,n_total' \
  --data-urlencode 'orderByFields=date DESC' \
  --data-urlencode 'resultRecordCount=1' \
  --data-urlencode 'returnGeometry=false' \
  --data-urlencode 'f=json'
REMOTE

# PortWatch, the failure shape: a bad query is answered HTTP 200 with an error object.
ssh mini-mac 'bash -s' <<'REMOTE' > tests/fixtures/series/portwatch_error_200.json
curl -s -m 30 -A 'iip/0.1 (+internet-info-plug)' -G \
  'https://services9.arcgis.com/weJ1QsnbMYJlCHdG/arcgis/rest/services/Daily_Chokepoints_Data/FeatureServer/0/query' \
  --data-urlencode "where=nonsense=1" \
  --data-urlencode 'outFields=date,portname,n_total' \
  --data-urlencode 'f=json'
REMOTE

cat tests/fixtures/series/aaa_home.html
python3 -c "
import json
ok = json.load(open('tests/fixtures/series/portwatch_hormuz_latest.json'))
print(ok['features'])
assert ok['features'][0]['attributes']['n_total'] is not None
bad = json.load(open('tests/fixtures/series/portwatch_error_200.json'))
assert 'error' in bad and 'features' not in bad
print('fixtures look right:', bad['error']['message'])
"
```

Expected: the AAA block shows `Today’s AAA National Average $x.xxxx` and `Price as of m/d/yy`; the PortWatch success file holds one feature with an ISO `date` string; the error file holds an `error` object and no `features`.

- [ ] **Step 2: Write the failing tests (the series half of the file)**

Create `tests/test_minimac_sources.py` (Task 4 extends it):

```python
"""The mini-mac source set: everything the shared config carries, plus direct sources.

`config/sources.yaml` is what the ai1 baseline run uses and it must not change.
`config/sources.minimac.yaml` is that file verbatim plus the sources added for the
trade profiles that run beside the mini-mac daemon. These tests pin the relationship
between the two, and parse every new source against a RECORDED copy of its real
response, because a source nobody has ever parsed is a source that is quiet by accident.
"""

from __future__ import annotations

import asyncio
import re
from pathlib import Path

import httpx
import yaml

from iip.adapters.series import SeriesAdapter
from iip.registry import Registry, SourceConfig

ROOT = Path(__file__).resolve().parent.parent
BASE = ROOT / "config" / "sources.yaml"
MINIMAC = ROOT / "config" / "sources.minimac.yaml"
SERIES_FIXTURES = Path(__file__).parent / "fixtures" / "series"

NEW_SERIES = {"aaa_national_average", "imf_portwatch_hormuz"}

EXPECTED_NEW = set(NEW_SERIES)

MARKET_TERMS = re.compile(r"\bKX[A-Z]{2,}|kalshi|\bstrike\b|\bthreshold\b|\bbet\b", re.I)


def load(path: Path) -> dict[str, SourceConfig]:
    registry = Registry(path)
    registry.load()
    return registry.by_id


async def no_sleep(_seconds: float) -> None:
    await asyncio.sleep(0)


def series_adapter(source_id, clock, body, status=200, seen=None) -> SeriesAdapter:
    def handler(request: httpx.Request) -> httpx.Response:
        if seen is not None:
            seen.append(request)
        return httpx.Response(status, text=body)

    return SeriesAdapter(
        load(MINIMAC)[source_id],
        clock=clock,
        client=httpx.AsyncClient(transport=httpx.MockTransport(handler)),
        sleep=no_sleep,
    )


def fixture(name: str) -> str:
    return (SERIES_FIXTURES / name).read_text()


class TestTheFileItself:
    def test_it_parses(self):
        assert len(load(MINIMAC)) > len(load(BASE))

    def test_the_shared_sources_are_carried_over_verbatim(self):
        """Textually, so a quiet edit to a shared source cannot hide in this file."""
        assert BASE.read_text() in MINIMAC.read_text()

    def test_every_shared_source_parses_to_the_same_config(self):
        base, minimac = load(BASE), load(MINIMAC)
        for source_id, config in base.items():
            assert minimac[source_id] == config, source_id

    def test_the_new_sources_are_exactly_the_expected_set(self):
        assert set(load(MINIMAC)) - set(load(BASE)) == EXPECTED_NEW

    def test_no_key_in_the_file_is_silently_swallowed(self):
        document = yaml.safe_load(MINIMAC.read_text())
        used: set[str] = set()
        for entry in document["sources"]:
            used |= set(entry)
        assert not used - set(SourceConfig.model_fields)

    def test_every_new_source_states_its_politeness_and_its_expectation(self):
        """An absent rate_limit means UNLIMITED, and an absent expected_gap_s means silence
        is not being watched. Neither may be true of a source nobody has watched yet."""
        minimac = load(MINIMAC)
        for source_id in EXPECTED_NEW:
            config = minimac[source_id]
            assert config.rate_limit is not None, source_id
            assert config.expected_gap_s is not None, source_id

    def test_the_new_sources_name_no_market_ticker_level_or_venue(self):
        document = yaml.safe_load(MINIMAC.read_text())
        for entry in document["sources"]:
            if entry["id"] in EXPECTED_NEW:
                assert not MARKET_TERMS.search(yaml.safe_dump(entry)), entry["id"]


class TestAaaNationalAverage:
    async def test_the_recorded_page_yields_one_reading(self, clock):
        adapter = series_adapter("aaa_national_average", clock, fixture("aaa_home.html"))
        [item] = await adapter.poll_once()
        assert re.fullmatch(
            r"AAA national average regular gas price: \d\.\d{1,4} USD per gallon "
            r"\(20\d\d-\d\d-\d\d\)",
            item.headline,
        ), item.headline
        assert item.url == "https://gasprices.aaa.com/"

    async def test_a_page_without_the_figure_is_degraded_not_quiet(self, clock):
        adapter = series_adapter(
            "aaa_national_average", clock, "<html><body>A redesigned page</body></html>"
        )
        assert await adapter.poll_once() == []
        health = await adapter.health()
        assert health.mechanism_ok is False
        assert health.last_error.startswith("extraction failed")


class TestPortWatchHormuz:
    async def test_the_recorded_response_yields_one_reading(self, clock):
        adapter = series_adapter(
            "imf_portwatch_hormuz", clock, fixture("portwatch_hormuz_latest.json")
        )
        [item] = await adapter.poll_once()
        assert re.fullmatch(
            r"IMF PortWatch daily transit calls, Strait of Hormuz: \d+ calls "
            r"\(20\d\d-\d\d-\d\d\)",
            item.headline,
        ), item.headline

    async def test_an_http_200_error_object_is_degraded_not_quiet(self, clock):
        """Recorded from the live service: a bad query is answered 200 with an error body."""
        adapter = series_adapter(
            "imf_portwatch_hormuz", clock, fixture("portwatch_error_200.json")
        )
        assert await adapter.poll_once() == []
        health = await adapter.health()
        assert health.mechanism_ok is False
        assert health.last_error.startswith("extraction failed")

    async def test_the_request_carries_the_configured_query(self, clock):
        seen: list[httpx.Request] = []
        adapter = series_adapter(
            "imf_portwatch_hormuz",
            clock,
            fixture("portwatch_hormuz_latest.json"),
            seen=seen,
        )
        await adapter.poll_once()
        params = seen[0].url.params
        assert params["where"] == "portname='Strait of Hormuz'"
        assert params["orderByFields"] == "date DESC"
        assert params["resultRecordCount"] == "1"
        assert params["f"] == "json"
```

Run: `.venv/bin/pytest tests/test_minimac_sources.py`
Expected: every test FAILS (`ConfigError: sources file not found: .../config/sources.minimac.yaml`).

- [ ] **Step 3: Create `config/sources.minimac.yaml`**

The file is: a header, then `config/sources.yaml` copied verbatim (a test pins that textually), then the two series sources. Write the two new parts, then assemble:

```bash
cat > /tmp/iip-minimac-header.yaml <<'EOF'
# Source set for the MINI-MAC instance of iip.
#
# Selected with `iip run --config config/sources.minimac.yaml`
# (executor_module/deploy/mini-mac/iip.service). The ai1 baseline run keeps using
# config/sources.yaml, which this file never edits: its 28-day observation must not be
# perturbed by sources added for a different purpose.
#
# Contents: every source in config/sources.yaml, copied VERBATIM and first (a test pins
# that), then the direct information sources added for the trade profiles that run beside
# this daemon. Nothing below names a market, a level, or a venue -- see HANDOFF.md section 7
# ("Market ignorance"). What a reading means is decided downstream, not here.
#
# `series` sources report ONE NUMBER each (see iip/adapters/series.py). A page or API that
# stops containing the number is reported DEGRADED, never as "no change".
EOF

cat > /tmp/iip-minimac-series.yaml <<'EOF'

  # ---------------------------------------------------------------------------------
  # Direct information sources -- added for the mini-mac instance only.
  # ---------------------------------------------------------------------------------

  # The AAA national average for regular gasoline, read from the public landing page.
  # Verified from mini-mac 2026-10-08: the page carries
  #   "Today's AAA National Average $4.3667" and, in the same block, "Price as of 10/7/26".
  # Both are captured by regexes anchored on their own labels, so a second price elsewhere
  # on the page (state averages, yesterday's figure) cannot be mistaken for the headline
  # one; and if two DIFFERENT values ever match, the adapter calls it ambiguous and fails
  # rather than picking one. The apostrophe is matched with `.` because the page uses a
  # typographic one.
  #
  # emit_on change_ge 0.0005: the figure is published to four decimals and moves daily, so
  # any real move is reported and rounding noise is not. trust_tier 1: AAA is the
  # publisher of its own number.
  #
  # expected_gap_s: GUESS from a single day of observation -- the figure changes roughly
  # daily. 2d x 3.0 -> alert after 6d of silence. Replace from observed gaps after the
  # first calibration pass (deployment runbook), not from this comment.
  - id: aaa_national_average
    adapter: series
    url: https://gasprices.aaa.com/
    page_url: https://gasprices.aaa.com/
    extract: 'regex:Today.s AAA National Average\s*\$([0-9]+\.[0-9]+)'
    date_extract: 'regex:Price as of ([0-9]{1,2}/[0-9]{1,2}/[0-9]{2})'
    date_format: mdy_short
    label: AAA national average regular gas price
    unit: USD per gallon
    emit_on: change_ge
    change_ge: 0.0005
    tier: cold
    poll_interval_s: 1800
    trust_tier: 1
    market_tags: [energy, consumer_prices]
    rate_limit:
      rate_per_s: 0.02
      burst: 1
    expected_gap_s: 172800

  # Daily transit calls for one maritime chokepoint, from the IMF PortWatch public ArcGIS
  # service. Verified from mini-mac 2026-10-08: the query below returns one feature,
  #   {"attributes": {"date": "2026-10-04", "portname": "Strait of Hormuz", "n_total": 4}}
  # -- `date` is an ISO date STRING (not epoch milliseconds), and the newest point was four
  # days old, so this is a settlement-tracking series, not a breaking-news one. An
  # out-of-range query is answered with HTTP 200 and {"error": {...}}, which has no
  # `features` and therefore fails extraction (DEGRADED) as intended.
  #
  # The normalizer drops publish times older than two days, so the data date will live in
  # the headline and snippet rather than in `source_publish_ts` once emitted. That is the
  # honest outcome for a lagging series and is why the date is spelled out in both.
  #
  # expected_gap_s: GUESS -- one new point per day, observed lag of 4 days. 3d x 3.0 ->
  # alert after 9d. Replace from observed gaps after calibration.
  - id: imf_portwatch_hormuz
    adapter: series
    url: https://services9.arcgis.com/weJ1QsnbMYJlCHdG/arcgis/rest/services/Daily_Chokepoints_Data/FeatureServer/0/query
    params:
      where: "portname='Strait of Hormuz'"
      outFields: "date,portname,n_total"
      orderByFields: "date DESC"
      resultRecordCount: "1"
      returnGeometry: "false"
      f: "json"
    page_url: https://portwatch.imf.org/
    extract: "json:features.0.attributes.n_total"
    date_extract: "json:features.0.attributes.date"
    date_format: iso
    label: IMF PortWatch daily transit calls, Strait of Hormuz
    unit: calls
    emit_on: new_point
    tier: cold
    poll_interval_s: 3600
    trust_tier: 1
    market_tags: [shipping, chokepoints]
    rate_limit:
      rate_per_s: 0.01
      burst: 1
    expected_gap_s: 259200
EOF

{ cat /tmp/iip-minimac-header.yaml; echo; cat config/sources.yaml /tmp/iip-minimac-series.yaml; } > config/sources.minimac.yaml
git diff --stat main -- config/sources.yaml   # expected: no output (the shared file is untouched)
```

- [ ] **Step 4: Run the tests**

Run: `.venv/bin/pytest tests/test_minimac_sources.py`
Expected: `12 passed`.

- [ ] **Step 5: Run the whole suite**

Run: `.venv/bin/pytest 2>&1 | tail -2`
Expected: `1264 passed`.

- [ ] **Step 6: Commit**

```bash
git add config/sources.minimac.yaml tests/test_minimac_sources.py tests/fixtures/series
git commit -m "feat(sources): mini-mac source file with two series sources

config/sources.minimac.yaml = every shared source verbatim + aaa_national_average and
imf_portwatch_hormuz. The ai1 baseline keeps config/sources.yaml. Parsed against recorded
real responses, including the HTTP-200 error body the PortWatch service really sends."
```

---

### Task 4: Ten feed sources

**Files:**
- Modify: `config/sources.minimac.yaml` (append)
- Modify: `tests/test_minimac_sources.py` (extend)
- Create: `tests/fixtures/feeds_minimac/<source_id>.xml` x10 (recorded, trimmed to three items each)

**Interfaces:**
- Consumes (Task 3): the module's `load`, `no_sleep`, `EXPECTED_NEW`, `MINIMAC`, `BASE`; `FeedAdapter` (existing).
- Produces: ten sources: `federal_reserve_monetary`, `federal_reserve_press`, `federal_reserve_speeches`, `whitehouse_presidential_actions`, `eia_today_in_energy`, `oilprice_main`, `rigzone_latest`, `npr_news`, `politico_politics`, `thehill_news`.

**How `expected_gap_s` was chosen (and how to recalibrate).** Each value is the LONGEST gap between entries in that feed's own window on 2026-10-08, rounded up; iip multiplies it by `anomaly_k` (3.0) to get the silence threshold, so that factor is the slack. A test pins "never below the measured maximum" (a silence threshold shorter than a gap the source demonstrably has would alert on a healthy source). They are human estimates: once a source's health bucket matures (about 28 days) iip uses the measured p95 instead and these only matter as a bootstrap. Task 6 step 9 is the recalibration procedure.

- [ ] **Step 1: Record the ten feeds from mini-mac, trimmed to three items**

```bash
mkdir -p tests/fixtures/feeds_minimac

cat > /tmp/trim_feed.py <<'EOF'
```python
import re, sys
raw = sys.stdin.buffer.read().decode("utf-8", "replace")
items = list(re.finditer(r"<item[ >].*?</item>", raw, re.S))
if not items:
    sys.exit("no <item> elements found -- not RSS 2.0, refusing to write a fixture")
sys.stdout.write(raw[: items[0].start()] + "\n".join(m.group(0) for m in items[:3]) + raw[items[-1].end():])
```
EOF

while IFS='|' read -r id url; do
  ssh -n -o ConnectTimeout=10 mini-mac "curl -s -L -m 30 -A 'iip/0.1 (+internet-info-plug)' '$url'" \
    | python3 /tmp/trim_feed.py > tests/fixtures/feeds_minimac/$id.xml \
    && echo "ok   $id $(wc -c < tests/fixtures/feeds_minimac/$id.xml) bytes" || echo "FAIL $id"
done <<'LIST'
federal_reserve_monetary|https://www.federalreserve.gov/feeds/press_monetary.xml
federal_reserve_press|https://www.federalreserve.gov/feeds/press_all.xml
federal_reserve_speeches|https://www.federalreserve.gov/feeds/speeches_and_testimony.xml
whitehouse_presidential_actions|https://www.whitehouse.gov/presidential-actions/feed/
eia_today_in_energy|https://www.eia.gov/rss/todayinenergy.xml
oilprice_main|https://oilprice.com/rss/main
rigzone_latest|https://www.rigzone.com/news/rss/rigzone_latest.aspx
npr_news|https://feeds.npr.org/1001/rss.xml
politico_politics|https://rss.politico.com/politics-news.xml
thehill_news|https://thehill.com/feed/
LIST
ls tests/fixtures/feeds_minimac | wc -l    # expected: 10
```

Expected: ten `ok` lines, no `FAIL`. (`-L` is required: The Hill answers 301.) The White House and Politico fixtures are tens of KB because each item carries full text; that is acceptable.

- [ ] **Step 2: Extend the tests and watch them fail**

```bash
git apply <<'PATCH'
--- a/tests/test_minimac_sources.py
+++ b/tests/test_minimac_sources.py
@@ -16,6 +16,7 @@
 import httpx
 import yaml
 
+from iip.adapters.feed import FeedAdapter
 from iip.adapters.series import SeriesAdapter
 from iip.registry import Registry, SourceConfig
 
@@ -23,10 +24,28 @@
 BASE = ROOT / "config" / "sources.yaml"
 MINIMAC = ROOT / "config" / "sources.minimac.yaml"
 SERIES_FIXTURES = Path(__file__).parent / "fixtures" / "series"
+FEED_FIXTURES = Path(__file__).parent / "fixtures" / "feeds_minimac"
 
 NEW_SERIES = {"aaa_national_average", "imf_portwatch_hormuz"}
 
-EXPECTED_NEW = set(NEW_SERIES)
+# Source id -> the longest gap between entries, in seconds, MEASURED from the live feed on
+# 2026-10-08 from mini-mac. `expected_gap_s` may never be set below this: a silence
+# threshold shorter than a gap the source demonstrably has is an alert that fires on a
+# healthy source, which trains an operator to ignore it.
+MEASURED_MAX_GAP_S = {
+    "federal_reserve_monetary": 1_900_800,
+    "federal_reserve_press": 691_200,
+    "federal_reserve_speeches": 1_299_600,
+    "whitehouse_presidential_actions": 596_689,
+    "eia_today_in_energy": 432_000,
+    "oilprice_main": 18_511,
+    "rigzone_latest": 43_337,
+    "npr_news": 26_908,
+    "politico_politics": 111_016,
+    "thehill_news": 23_862,
+}
+NEW_FEEDS = set(MEASURED_MAX_GAP_S)
+EXPECTED_NEW = NEW_SERIES | NEW_FEEDS
 
 MARKET_TERMS = re.compile(r"\bKX[A-Z]{2,}|kalshi|\bstrike\b|\bthreshold\b|\bbet\b", re.I)
 
@@ -156,3 +175,80 @@
         assert params["resultRecordCount"] == "1"
         assert params["f"] == "json"
 
+
+RSS_ENTRY = (
+    "<item><title>{title}</title><link>https://news.example.org/{n}</link>"
+    "<guid>{guid}</guid><pubDate>Wed, 07 Oct 2026 10:{n:02d}:00 GMT</pubDate>"
+    "<description>{body}</description></item>"
+)
+
+
+def rss(entries: str) -> str:
+    return (
+        '<?xml version="1.0"?><rss version="2.0"><channel><title>t</title>'
+        f"<link>https://news.example.org/</link><description>d</description>{entries}"
+        "</channel></rss>"
+    )
+
+
+def feed_adapter(source_id, clock, body) -> FeedAdapter:
+    return FeedAdapter(
+        load(MINIMAC)[source_id],
+        clock=clock,
+        client=httpx.AsyncClient(
+            transport=httpx.MockTransport(lambda request: httpx.Response(200, text=body))
+        ),
+        sleep=no_sleep,
+    )
+
+
+class TestNewFeeds:
+    def test_every_new_feed_is_a_cold_tier_feed_source(self):
+        minimac = load(MINIMAC)
+        for source_id in NEW_FEEDS:
+            assert minimac[source_id].adapter == "feed", source_id
+            assert minimac[source_id].tier == "cold", source_id
+
+    def test_expected_gap_is_never_below_the_longest_gap_actually_measured(self):
+        minimac = load(MINIMAC)
+        for source_id, measured in MEASURED_MAX_GAP_S.items():
+            assert minimac[source_id].expected_gap_s >= measured, source_id
+
+    def test_the_large_feed_is_polled_slowly(self):
+        """~570 KB per body. If its validators ever stopped working, a short interval
+        would turn that into tens of megabytes an hour from one host."""
+        assert load(MINIMAC)["whitehouse_presidential_actions"].poll_interval_s >= 600
+
+    async def test_every_recorded_feed_parses_into_items(self, clock):
+        for source_id in sorted(NEW_FEEDS):
+            body = (FEED_FIXTURES / f"{source_id}.xml").read_text()
+            adapter = feed_adapter(source_id, clock, body)
+            items = await adapter.poll_once()
+            health = await adapter.health()
+            assert health.mechanism_ok, f"{source_id}: {health.last_error}"
+            assert items, f"{source_id}: recorded feed produced no items"
+            assert all(item.headline.strip() for item in items), source_id
+            assert all(item.source_id == source_id for item in items), source_id
+
+    async def test_a_feed_a_few_hundred_kilobytes_long_is_accepted_under_the_byte_cap(
+        self, clock
+    ):
+        padding = "x" * 18_000
+        entries = "".join(
+            RSS_ENTRY.format(title=f"Entry {n}", n=n % 60, guid=f"g{n}", body=padding)
+            for n in range(30)
+        )
+        body = rss(entries)
+        assert len(body) > 500_000
+        items = await feed_adapter("whitehouse_presidential_actions", clock, body).poll_once()
+        assert len(items) == 30
+
+    async def test_entries_sharing_a_title_are_distinct_items_when_their_ids_differ(self, clock):
+        """Titles repeat on real feeds ("Presidential Actions", daily briefings). Identity
+        is the entry id, then the link, never the title."""
+        entries = "".join(
+            RSS_ENTRY.format(title="Daily briefing", n=n, guid=f"briefing-{n}", body="b")
+            for n in range(3)
+        )
+        items = await feed_adapter("politico_politics", clock, rss(entries)).poll_once()
+        assert len(items) == 3
PATCH
.venv/bin/pytest tests/test_minimac_sources.py
```

Expected: FAIL: the new sources are not in the config yet (`test_the_new_sources_are_exactly_the_expected_set`, `KeyError` in the feed tests).

- [ ] **Step 3: Append the ten feeds to the config**

```bash
cat > /tmp/iip-minimac-feeds.yaml <<'EOF'

  # ---------------------------------------------------------------------------------
  # Feeds added for the mini-mac instance. All `cold` tier, all with an explicit
  # rate_limit (one request per 50s at most -- far below every poll interval here, so the
  # limiter only ever bites after a ban or a cooldown). Every number below was MEASURED
  # on 2026-10-08 from mini-mac itself (source reachability is per IP) from the feed's own
  # entry dates. expected_gap_s is the LONGEST gap seen in that window, rounded up -- the
  # x3.0 anomaly multiplier is then the slack. A matured, measured p95 replaces all of
  # these after a few weeks; until then they are human estimates and /health says so.
  # ---------------------------------------------------------------------------------

  # Federal Reserve press releases about monetary policy (FOMC statements, minutes).
  # 15 entries / 176d, median gap 15d, max 22d. ETag + Last-Modified honoured.
  - id: federal_reserve_monetary
    adapter: feed
    url: https://www.federalreserve.gov/feeds/press_monetary.xml
    tier: cold
    poll_interval_s: 300
    trust_tier: 1
    market_tags: [monetary_policy, us_data]
    rate_limit:
      rate_per_s: 0.02
      burst: 1
    expected_gap_s: 1900800

  # All Federal Reserve press releases. 20 entries / 43d, median 1.9d, max 8d.
  - id: federal_reserve_press
    adapter: feed
    url: https://www.federalreserve.gov/feeds/press_all.xml
    tier: cold
    poll_interval_s: 300
    trust_tier: 1
    market_tags: [monetary_policy, us_data]
    rate_limit:
      rate_per_s: 0.02
      burst: 1
    expected_gap_s: 691200

  # Federal Reserve speeches and testimony. 15 entries / 35d, median 0.9d, max 15d.
  - id: federal_reserve_speeches
    adapter: feed
    url: https://www.federalreserve.gov/feeds/speeches_and_testimony.xml
    tier: cold
    poll_interval_s: 600
    trust_tier: 1
    market_tags: [monetary_policy]
    rate_limit:
      rate_per_s: 0.02
      burst: 1
    expected_gap_s: 1299600

  # The White House "Presidential Actions" feed: executive orders, proclamations,
  # memoranda. 30 entries / 33d, median 5.6h, max 6.9d. ETag + Last-Modified honoured, but
  # the body is ~570 KB because every entry carries its full text -- if the validators ever
  # stop working that is ~80 MB/day at this interval, which is why it polls every 10
  # minutes and not every 30 seconds like the other .gov feeds.
  - id: whitehouse_presidential_actions
    adapter: feed
    url: https://www.whitehouse.gov/presidential-actions/feed/
    tier: cold
    poll_interval_s: 600
    trust_tier: 1
    market_tags: [us_politics, executive_actions]
    rate_limit:
      rate_per_s: 0.02
      burst: 1
    expected_gap_s: 600000

  # EIA "Today in Energy". 14 entries / 36d, median 3d, max 5d. ETag + Last-Modified.
  - id: eia_today_in_energy
    adapter: feed
    url: https://www.eia.gov/rss/todayinenergy.xml
    tier: cold
    poll_interval_s: 900
    trust_tier: 1
    market_tags: [energy, us_data]
    rate_limit:
      rate_per_s: 0.02
      burst: 1
    expected_gap_s: 432000

  # Oilprice.com. 15 entries / 0.6d, median 55m, max 5.1h. NO validators (no ETag, no
  # Last-Modified): every poll downloads the whole ~16 KB body, which is why the interval
  # is 10 minutes. trust_tier 3: an outlet, not the publisher of the underlying facts.
  - id: oilprice_main
    adapter: feed
    url: https://oilprice.com/rss/main
    tier: cold
    poll_interval_s: 600
    trust_tier: 3
    market_tags: [energy, commodities]
    rate_limit:
      rate_per_s: 0.02
      burst: 1
    expected_gap_s: 21600

  # Rigzone latest headlines. 20 entries / 2d, median 69m, max 12.04h (43,337s). No
  # validators; ~9 KB.
  - id: rigzone_latest
    adapter: feed
    url: https://www.rigzone.com/news/rss/rigzone_latest.aspx
    tier: cold
    poll_interval_s: 600
    trust_tier: 3
    market_tags: [energy, commodities]
    rate_limit:
      rate_per_s: 0.02
      burst: 1
    expected_gap_s: 43400

  # NPR news. 10 entries / 0.6d, median 47m, max 7.5h. No validators; ~15 KB.
  - id: npr_news
    adapter: feed
    url: https://feeds.npr.org/1001/rss.xml
    tier: cold
    poll_interval_s: 300
    trust_tier: 3
    market_tags: [us_politics, general_news]
    rate_limit:
      rate_per_s: 0.02
      burst: 1
    expected_gap_s: 28800

  # Politico politics. 30 entries / 11d, median 6.3h, max 31h. Last-Modified only; ~280 KB.
  - id: politico_politics
    adapter: feed
    url: https://rss.politico.com/politics-news.xml
    tier: cold
    poll_interval_s: 300
    trust_tier: 3
    market_tags: [us_politics]
    rate_limit:
      rate_per_s: 0.02
      burst: 1
    expected_gap_s: 115200

  # The Hill. 100 entries / 1.2d, median 7.7m, max 6.6h. ETag + Last-Modified. The URL
  # answers HTTP 301 before the feed; the adapter follows redirects (a bare `curl` without
  # -L reads that as "zero entries", which is how this was nearly mis-measured).
  - id: thehill_news
    adapter: feed
    url: https://thehill.com/feed/
    tier: cold
    poll_interval_s: 600
    trust_tier: 3
    market_tags: [us_politics]
    rate_limit:
      rate_per_s: 0.02
      burst: 1
    expected_gap_s: 28800
EOF

cat /tmp/iip-minimac-feeds.yaml >> config/sources.minimac.yaml
```

- [ ] **Step 4: Run the tests**

Run: `.venv/bin/pytest tests/test_minimac_sources.py`
Expected: `18 passed`. (If `test_expected_gap_is_never_below_the_longest_gap_actually_measured` fails after a re-measurement, raise that source's `expected_gap_s` to at least the measured value; never lower the test's number to fit.)

- [ ] **Step 5: Run the whole suite and the protected-path check**

```bash
.venv/bin/pytest 2>&1 | tail -2                         # expected: 1270 passed
git diff --stat main -- executor/ config/sources.yaml   # expected: no output
```

- [ ] **Step 6: Commit**

```bash
git add config/sources.minimac.yaml tests/test_minimac_sources.py tests/fixtures/feeds_minimac
git commit -m "feat(sources): ten feeds for the mini-mac instance

Federal Reserve (3), White House presidential actions, EIA, and five news outlets.
expected_gap_s is each feed's measured maximum gap; every source has an explicit
rate_limit. NHC and UKMTO are deliberately not added (see the plan)."
```

---

### Task 5: Alert channels that work on Linux

**Files:**
- Create: `tests/test_alert_sinks.py`
- Modify: `iip/alerts.py`
- Modify: `iip/__main__.py` (the notifier import and its construction in `run`)

**Interfaces:**
- Produces:
  - `iip.alerts.SlackNotifier(webhook_url: str, client: httpx.AsyncClient | None = None, timeout_s: float = 5.0)` with `async notify(title, message, level) -> None`; never raises; never logs the URL.
  - `iip.alerts.build_notifier(redis, clock, *, env: Mapping[str, str] | None = None, platform: str | None = None) -> CompositeNotifier`: LogNotifier and RedisStreamNotifier always; MacNotifier only when `platform == "darwin"`; SlackNotifier only when `SLACK_WEBHOOK_URL` is non-blank.
- Unchanged: `MacNotifier`, `CompositeNotifier`, `HealthAlerter` and their existing tests (`MacNotifier` still works on any host when constructed directly; only the composition changed).

- [ ] **Step 1: Write the failing tests**

Create `tests/test_alert_sinks.py`:

```python
"""Which alert channels exist on which host, and the Slack one in particular.

mini-mac is Linux: `osascript` does not exist there, so the macOS banner failed about
2,400 times in the first month and every source failure on that box paged nobody. The
properties that matter are (1) a channel that cannot work on this host is not built at
all, (2) a channel that CAN work is built when its configuration is present, and (3) a
broken channel never takes down the thing reporting the trouble, and never leaks the
credential it was configured with.
"""

from __future__ import annotations

import asyncio
import json
import logging

import fakeredis.aioredis
import httpx
import pytest

from iip.alerts import SlackNotifier, build_notifier

SECRET_URL = "https://hooks.slack.test/services/T000/B000/SECRETTOKEN"


def kinds(notifier) -> list[str]:
    return [type(n).__name__ for n in notifier._notifiers]


@pytest.fixture
def redis():
    return fakeredis.aioredis.FakeRedis(decode_responses=True)


class TestBuildNotifier:
    def test_linux_gets_no_macos_banner(self, redis, clock):
        notifier = build_notifier(redis, clock, env={}, platform="linux")
        assert kinds(notifier) == ["LogNotifier", "RedisStreamNotifier"]

    def test_macos_keeps_its_banner(self, redis, clock):
        notifier = build_notifier(redis, clock, env={}, platform="darwin")
        assert kinds(notifier) == ["LogNotifier", "RedisStreamNotifier", "MacNotifier"]

    def test_slack_is_added_exactly_when_a_webhook_is_configured(self, redis, clock):
        with_hook = build_notifier(
            redis, clock, env={"SLACK_WEBHOOK_URL": SECRET_URL}, platform="linux"
        )
        assert kinds(with_hook)[-1] == "SlackNotifier"
        for blank in ("", "   "):
            without = build_notifier(
                redis, clock, env={"SLACK_WEBHOOK_URL": blank}, platform="linux"
            )
            assert "SlackNotifier" not in kinds(without)

    def test_the_webhook_never_appears_in_a_repr(self):
        assert "SECRETTOKEN" not in repr(SlackNotifier(SECRET_URL))


class TestSlackNotifier:
    def make(self, handler, **kwargs):
        return SlackNotifier(
            SECRET_URL,
            client=httpx.AsyncClient(transport=httpx.MockTransport(handler)),
            **kwargs,
        )

    async def test_posts_one_json_message_naming_the_source_and_level(self):
        seen: list[httpx.Request] = []

        def handler(request):
            seen.append(request)
            return httpx.Response(200, text="ok")

        await self.make(handler).notify("aaa_national_average", "HEALTHY -> DEAD: boom", "error")
        [request] = seen
        assert str(request.url) == SECRET_URL
        text = json.loads(request.content)["text"]
        assert "aaa_national_average" in text
        assert "HEALTHY -> DEAD: boom" in text
        assert "ERROR" in text

    async def test_a_long_message_is_truncated(self):
        seen = []

        def handler(request):
            seen.append(json.loads(request.content)["text"])
            return httpx.Response(200)

        await self.make(handler).notify("s", "x" * 10_000, "warning")
        assert len(seen[0]) <= 3000

    async def test_an_error_status_is_logged_without_the_url_and_does_not_raise(self, caplog):
        notifier = self.make(lambda request: httpx.Response(500, text="no"))
        with caplog.at_level(logging.ERROR):
            await notifier.notify("s", "m", "error")
        assert "HTTP 500" in caplog.text
        assert "SECRETTOKEN" not in caplog.text

    async def test_a_transport_error_does_not_raise_and_does_not_leak_the_url(self, caplog):
        def handler(request):
            raise httpx.ConnectError(f"cannot connect to {request.url}", request=request)

        with caplog.at_level(logging.ERROR):
            await self.make(handler).notify("s", "m", "error")
        assert "ConnectError" in caplog.text
        assert "SECRETTOKEN" not in caplog.text

    async def test_a_hung_endpoint_is_abandoned_at_the_timeout(self, caplog):
        async def handler(request):
            await asyncio.sleep(30)
            return httpx.Response(200)

        notifier = self.make(handler, timeout_s=0.05)
        with caplog.at_level(logging.ERROR):
            await asyncio.wait_for(notifier.notify("s", "m", "error"), timeout=2)
        assert "timed out" in caplog.text
        assert "SECRETTOKEN" not in caplog.text
```

Run: `.venv/bin/pytest tests/test_alert_sinks.py`
Expected: collection error, `ImportError: cannot import name 'SlackNotifier' from 'iip.alerts'`.

- [ ] **Step 2: Add `SlackNotifier` and `build_notifier`**

```bash
git apply <<'PATCH'
--- a/iip/alerts.py
+++ b/iip/alerts.py
@@ -1,5 +1,7 @@
-"""Alert fan-out. Spec 7.1: every health transition logs, streams, and pops a
-macOS notification -- the right channel for a single operator at the machine.
+"""Alert fan-out. Spec 7.1: every health transition logs and streams, and pops a macOS
+notification where one can exist -- the right channel for a single operator at the
+machine. On a host with no desktop (the Linux mini-mac) the channel is a Slack incoming
+webhook, when one is configured.
 
 A broken notifier must never take down the poller. Every path swallows.
 """
@@ -9,9 +11,13 @@
 import asyncio
 import contextlib
 import logging
+import os
+import sys
 from datetime import datetime
-from typing import Awaitable, Callable, Protocol
+from typing import Awaitable, Callable, Mapping, Protocol
 
+import httpx
+
 from iip.clock import Clock
 from iip.emit import STREAM_ALERTS
 from iip.schema import HealthState
@@ -132,8 +138,59 @@
     @staticmethod
     def _escape(text: str) -> str:
         return text.replace("\\", "\\\\").replace('"', '\\"')
+
+
+SLACK_TIMEOUT_S = 5.0
+SLACK_MAX_CHARS = 3000
+
+
+class SlackNotifier:
+    """Posts to a Slack incoming webhook. Never raises; never waits longer than the timeout.
+
+    The webhook URL is a bearer credential: anyone holding it can post to the channel. So
+    it is never logged, never in a repr, and the error paths below log only the exception
+    TYPE or the HTTP status -- an httpx exception message can embed the URL it was
+    connecting to.
+
+    Bounded with `asyncio.wait_for` as well as an httpx timeout, because httpx's timeout
+    is per phase (connect, read, write, pool) and four phases of 5s is not 5s. This is
+    awaited from the health and gap paths, so an unbounded wait stalls the machinery that
+    exists to report trouble.
+    """
+
+    def __init__(
+        self,
+        webhook_url: str,
+        client: httpx.AsyncClient | None = None,
+        timeout_s: float = SLACK_TIMEOUT_S,
+    ) -> None:
+        self._url = webhook_url
+        self._client = client
+        self._timeout_s = timeout_s
+
+    def __repr__(self) -> str:
+        return "SlackNotifier(<webhook redacted>)"
+
+    async def notify(self, title: str, message: str, level: str) -> None:
+        text = f"[iip {level.upper()}] {title}: {message}"[:SLACK_MAX_CHARS]
+        try:
+            response = await asyncio.wait_for(self._post(text), timeout=self._timeout_s)
+            if response.status_code >= 400:
+                log.error("slack alert delivery failed: HTTP %s", response.status_code)
+        except asyncio.TimeoutError:
+            log.error("slack alert delivery timed out after %.0fs", self._timeout_s)
+        except Exception as exc:
+            log.error("slack alert delivery failed: %s", type(exc).__name__)
 
+    async def _post(self, text: str) -> httpx.Response:
+        if self._client is not None:
+            return await self._client.post(
+                self._url, json={"text": text}, timeout=self._timeout_s
+            )
+        async with httpx.AsyncClient() as client:
+            return await client.post(self._url, json={"text": text}, timeout=self._timeout_s)
 
+
 class CompositeNotifier:
     def __init__(self, notifiers: list[Notifier]) -> None:
         self._notifiers = notifiers
@@ -146,6 +203,37 @@
                 log.error("notifier %r failed", notifier, exc_info=True)
 
 
+def build_notifier(
+    redis,
+    clock: Clock,
+    *,
+    env: Mapping[str, str] | None = None,
+    platform: str | None = None,
+) -> CompositeNotifier:
+    """The alert channels that can work on THIS host.
+
+    `MacNotifier` is only built on macOS: `osascript` does not exist elsewhere, and a
+    channel that fails on every alert is worse than none -- it logged ~2,400 errors on
+    mini-mac while telling nobody anything. Slack is added exactly when a webhook is
+    configured. `env` and `platform` are parameters so this is testable without touching
+    the real process environment.
+    """
+    env = os.environ if env is None else env
+    platform = sys.platform if platform is None else platform
+    notifiers: list[Notifier] = [LogNotifier(), RedisStreamNotifier(redis, clock)]
+    if platform == "darwin":
+        notifiers.append(MacNotifier())
+    webhook = (env.get("SLACK_WEBHOOK_URL") or "").strip()
+    if webhook:
+        notifiers.append(SlackNotifier(webhook))
+    else:
+        log.info(
+            "SLACK_WEBHOOK_URL is not set: alerts go to the log and the %s stream only",
+            STREAM_ALERTS,
+        )
+    return CompositeNotifier(notifiers)
+
+
 class HealthAlerter:
     """Persists state on every change; alerts only once trouble has PERSISTED.
 
PATCH
```

- [ ] **Step 3: Use `build_notifier` in the daemon**

```bash
git apply <<'PATCH'
--- a/iip/__main__.py
+++ b/iip/__main__.py
@@ -19,13 +19,7 @@
 from iip.adapters.feed import FeedAdapter
 from iip.adapters.scheduled import ScheduledAdapter
 from iip.amend import AmendmentSweeper, schedule_checks
-from iip.alerts import (
-    CompositeNotifier,
-    HealthAlerter,
-    LogNotifier,
-    MacNotifier,
-    RedisStreamNotifier,
-)
+from iip.alerts import HealthAlerter, build_notifier
 from iip.clock import Clock, SystemClock
 from iip.dedup import Deduper
 from iip.emit import Emitter, STREAM_ITEMS
@@ -314,9 +308,7 @@
         store=store,
     )
 
-    notifier = CompositeNotifier(
-        [LogNotifier(), RedisStreamNotifier(redis, clock), MacNotifier()]
-    )
+    notifier = build_notifier(redis, clock)
     monitor = HealthMonitor(store, clock)
     alerter = HealthAlerter(store, clock, notifier)
 
PATCH
```

- [ ] **Step 4: Run the alert, supervisor and main tests**

Run: `.venv/bin/pytest tests/test_alert_sinks.py tests/test_alerts.py tests/test_supervisor.py tests/test_main.py`
Expected: `100 passed`. (`tests/test_supervisor.py` reads `iip/__main__.py` as text, so this also proves the edit did not disturb what it guards.)

- [ ] **Step 5: Mutation check**

```bash
cp iip/alerts.py /tmp/alerts_orig.py
python3 - <<'PYEOF'
import re
import subprocess

path = "iip/alerts.py"
orig = open("/tmp/alerts_orig.py").read()
mutations = {
    "mac banner built on every platform": (
        '    if platform == "darwin":\n        notifiers.append(MacNotifier())',
        "    notifiers.append(MacNotifier())",
    ),
    "error path logs the exception text (can embed the URL)": (
        'log.error("slack alert delivery failed: %s", type(exc).__name__)',
        'log.error("slack alert delivery failed: %s", exc)',
    ),
    "no overall timeout bound": (
        "response = await asyncio.wait_for(self._post(text), timeout=self._timeout_s)",
        "response = await self._post(text)",
    ),
    "slack added even without a webhook": (
        "    if webhook:\n        notifiers.append(SlackNotifier(webhook))",
        "    if True:\n        notifiers.append(SlackNotifier(webhook))",
    ),
}
for name, (old, new) in mutations.items():
    assert orig.count(old) == 1, (name, orig.count(old))
    open(path, "w").write(orig.replace(old, new))
    out = subprocess.run(
        [".venv/bin/python", "-m", "pytest", "tests/test_alert_sinks.py", "-p", "no:cacheprovider", "--timeout=20"],
        capture_output=True, text=True,
    ).stdout
    print(f"MUTATION {name!r}: " + re.sub(r"\x1b\[[0-9;]*m", "", out.strip().splitlines()[-1]))
open(path, "w").write(orig)
PYEOF
cmp /tmp/alerts_orig.py iip/alerts.py && echo "restored: identical"
```

Expected: four `MUTATION ...` lines each reporting at least one `failed`, then `restored: identical`. A `0 failed` line means an untested guard: add the test first.

- [ ] **Step 6: Run the whole suite and the protected-path check**

```bash
.venv/bin/pytest 2>&1 | tail -2                         # expected: 1279 passed
executor/.venv/bin/python -m pytest executor/tests 2>&1 | tail -2   # expected: same count as recorded in Task 1 step 1
git diff --stat main -- executor/ config/sources.yaml   # expected: no output
git diff main --name-only                                # expected: exactly the files listed in File Structure (minus CLAUDE.md/HANDOFF.md until Task 7)
```

- [ ] **Step 7: Commit**

```bash
git add iip/alerts.py iip/__main__.py tests/test_alert_sinks.py
git commit -m "feat(alerts): build alert channels per host; add a Slack webhook channel

The macOS banner failed ~2,400 times on Linux mini-mac and told nobody anything. Build it
only on darwin; add Slack when SLACK_WEBHOOK_URL is set (5s bound, never raises, the URL
is never logged). Source failures on mini-mac now reach a human."
```

---

### Task 6: Deploy to mini-mac and calibrate

This task changes a running system that shares a Redis stream with a real-money process. It is a runbook, not a code change. Do the steps in order. Nothing in it edits `executor_module`; the unit-file change is given as a diff for the operator to apply there.

**Interfaces:**
- Consumes: the branch `feat/direct-information-pipelines` after Tasks 1-5; mini-mac's clone at `/home/emac/Internet_Info_Plug` (HEAD `9b8dcb6`, remote `/tmp/iip-main.bundle`).
- Produces: a mini-mac `iip` running `config/sources.minimac.yaml` with 26 sources, and calibrated `expected_gap_s` values committed back to the branch.

- [ ] **Step 1: OPERATOR GATE. Do not continue until the operator has chosen.**

mini-mac's `executor-module` is running with `KALSHI_DRY_RUN` unset: it places real orders. It consumes the same Redis stream. On first poll each new feed releases a back-catalogue of stale items (the Fed, the White House and EIA are tier 1, so they reach the `reported` rung), and keyphrases such as "Trump executive order" can match them. The executor has no staleness gate (the 2026-09-01 YouGov backlog is the precedent). The operator must choose ONE:

- **A. Halt trading** (the kill switch; independent of dry-run):
  ```bash
  ssh mini-mac 'grep -q "^EXECUTOR_TRADING_HALTED=" ~/executor_module/.env || echo "EXECUTOR_TRADING_HALTED=true" >> ~/executor_module/.env; systemctl --user restart executor-module'
  ```
- **B. Switch the executor to dry-run:**
  ```bash
  ssh mini-mac 'grep -q "^KALSHI_DRY_RUN=" ~/executor_module/.env || echo "KALSHI_DRY_RUN=true" >> ~/executor_module/.env; systemctl --user restart executor-module'
  ```
- **C. Accept the risk in writing.** Record the decision and its reason in the session before proceeding.

Either A or B stays in force until step 8 says the backlog has drained. Lifting it is the operator's call, not part of this plan.

- [ ] **Step 2: Final local checks**

```bash
cd /Users/eamonmcnamee/Downloads/Internet_Info_Plug
git status --short                                       # expected: clean
.venv/bin/pytest 2>&1 | tail -2                          # expected: 1279 passed
git diff --stat main -- executor/ config/sources.yaml    # expected: no output
grep -rniE 'KX[A-Z]{2,}|kalshi|\bstrike\b|\bthreshold\b' iip/adapters/series.py iip/extract.py   # expected: no output
```

- [ ] **Step 3: Transfer the branch by git bundle (the pattern used for executor_module)**

```bash
cd /Users/eamonmcnamee/Downloads/Internet_Info_Plug
git bundle create /tmp/iip-direct.bundle 9b8dcb6..feat/direct-information-pipelines
scp /tmp/iip-direct.bundle mini-mac:/tmp/iip-direct.bundle
ssh mini-mac 'cd ~/Internet_Info_Plug && git status --short && git branch --show-current && git fetch /tmp/iip-direct.bundle feat/direct-information-pipelines:feat/direct-information-pipelines && git merge --ff-only feat/direct-information-pipelines && git log --oneline -1'
```

Expected: `git status --short` prints nothing (its `.env` and `data/` are git-ignored); the merge fast-forwards; the last line is the newest commit of the branch. Do not restart anything yet; the running daemon keeps using the code it loaded.

- [ ] **Step 4: Put Slack alerts and the new config selection in place on mini-mac**

Reuse the executor's webhook (the operator may prefer a separate channel; if so, put a different `SLACK_WEBHOOK_URL=` line in `~/Internet_Info_Plug/.env` instead). The value is never printed:

```bash
ssh mini-mac 'grep -q "^SLACK_WEBHOOK_URL=" ~/Internet_Info_Plug/.env || grep "^SLACK_WEBHOOK_URL=" ~/executor_module/.env >> ~/Internet_Info_Plug/.env; chmod 600 ~/Internet_Info_Plug/.env; grep -c "^SLACK_WEBHOOK_URL=" ~/Internet_Info_Plug/.env'
```

Expected: `1`. Now the unit. The repo copy lives in executor_module; this plan does not edit it. The operator applies this diff there (`deploy/mini-mac/iip.service`):

```diff
--- a/deploy/mini-mac/iip.service
+++ b/deploy/mini-mac/iip.service
@@ -37,7 +37,11 @@
 # --log-level INFO, stated explicitly rather than left to the default, matching
 # ai1's own unit: DEBUG is FORBIDDEN here, Telethon logs authentication material
 # at that level.
-ExecStart=%h/Internet_Info_Plug/.venv/bin/python -m iip run --log-level INFO --redis-url ${REDIS_URL}
+#
+# --config selects the mini-mac source set: every source in config/sources.yaml,
+# verbatim, plus the direct information sources added for the trade profiles that run
+# beside this daemon. ai1 keeps the default config/sources.yaml untouched.
+ExecStart=%h/Internet_Info_Plug/.venv/bin/python -m iip run --config config/sources.minimac.yaml --log-level INFO --redis-url ${REDIS_URL}
 
 # A verified backup before every start, including every automatic restart -- same
 # rationale as ai1's own unit: cheap, and the archive is never more than one crash
```

and makes the same edit to the INSTALLED unit (idempotent; fails loudly if the line is not as expected):

```bash
ssh mini-mac 'python3 - <<EOF
from pathlib import Path
p = Path.home() / ".config/systemd/user/iip.service"
s = p.read_text()
old = "-m iip run --log-level INFO --redis-url"
new = "-m iip run --config config/sources.minimac.yaml --log-level INFO --redis-url"
assert s.count(old) == 1, "unit is not in the expected state; do not guess"
p.write_text(s.replace(old, new))
print("installed unit updated")
EOF
systemctl --user daemon-reload && systemctl --user cat iip | grep ExecStart='
```

Expected: `installed unit updated`, then an `ExecStart=` line containing `--config config/sources.minimac.yaml`.

- [ ] **Step 5: Pre-flight. Poll every new source once, before the restart**

`verify-sources` hits each configured source once and prints `OK`/`FAIL` per source (the daemon is not involved):

```bash
ssh mini-mac 'cd ~/Internet_Info_Plug && .venv/bin/python -m iip verify-sources --config config/sources.minimac.yaml 2>&1 | grep -E "^(OK|FAIL) +(aaa_national_average|imf_portwatch_hormuz|federal_reserve_|whitehouse_|eia_|oilprice_|rigzone_|npr_|politico_|thehill_)|sources OK"'
```

Expected: twelve lines starting `OK`, one per new source (the two series sources report `1 items`), then `N/26 sources OK`. `N` may be below 26 because of failures that exist today (for example `reddit_geopolitics` is blocked with a 403); what matters is that none of the TWELVE NEW lines is `FAIL`. If one is, stop and fix it before restarting.

- [ ] **Step 6: Prove a broken extractor is reported, not swallowed**

A throwaway config with one series source whose regex cannot match; it never touches the live config:

```bash
ssh mini-mac 'cat > /tmp/iip-broken.yaml' <<'EOF'
sources:
  - id: broken_extractor_check
    adapter: series
    url: https://gasprices.aaa.com/
    extract: 'regex:This label does not exist on the page\s*\$([0-9]+\.[0-9]+)'
    label: Deliberately broken extractor
    unit: USD
    emit_on: change_ge
    change_ge: 0.01
    trust_tier: 1
EOF
ssh mini-mac 'cd ~/Internet_Info_Plug && .venv/bin/python -m iip verify-sources --config /tmp/iip-broken.yaml 2>&1 | grep -v -E "WARNING|INFO"; rm -f /tmp/iip-broken.yaml'
```

Expected:

```
FAIL broken_extractor_check             extraction failed: regex matched nothing: '...'; body starts '<!DOCTYPE html> ...'

0/1 sources OK
```

(Validated against the live endpoint. The process exit status is 1; do not pipe if you want to read it.) The in-daemon path from this to the `DEGRADED` then `DEAD` health states is pinned offline by `TestExtractionFailureIsNotQuiet` in Task 2.

- [ ] **Step 7: Restart the daemon and confirm it is running the new set**

```bash
ssh mini-mac 'systemctl --user restart iip && sleep 20 && systemctl --user is-active iip && journalctl --user -u iip --since "-2 min" --no-pager | grep -E "iip running with|Traceback|CRASH LOOP"'
```

Expected: `active`, then `iip running with 26 sources`, no `Traceback`, no `CRASH LOOP`.

- [ ] **Step 8: Verify every new source polls, reports healthy, and emits; then check the backlog has drained**

```bash
# polling: every new host appears in the journal (httpx logs each request at INFO)
ssh mini-mac 'bash -s' <<'REMOTE'
for u in https://gasprices.aaa.com/ https://services9.arcgis.com/ \
         https://www.federalreserve.gov/feeds/press_monetary.xml \
         https://www.federalreserve.gov/feeds/press_all.xml \
         https://www.federalreserve.gov/feeds/speeches_and_testimony.xml \
         https://www.whitehouse.gov/presidential-actions/feed/ \
         https://www.eia.gov/rss/todayinenergy.xml https://oilprice.com/rss/main \
         https://www.rigzone.com/news/rss/rigzone_latest.aspx https://feeds.npr.org/1001/rss.xml \
         https://rss.politico.com/politics-news.xml https://thehill.com/feed/; do
  printf '%-72s %s\n' "$u" "$(journalctl --user -u iip --since '-15 min' --no-pager | grep -c "GET $u")"
done
REMOTE
```

Expected: every count is at least 1.

```bash
# health: state per new source from the daemon's own /health
ssh mini-mac 'python3 -' <<'PYEOF'
```python
import json
import urllib.request

NEW = {
    "aaa_national_average", "imf_portwatch_hormuz", "federal_reserve_monetary",
    "federal_reserve_press", "federal_reserve_speeches", "whitehouse_presidential_actions",
    "eia_today_in_energy", "oilprice_main", "rigzone_latest", "npr_news",
    "politico_politics", "thehill_news",
}

with urllib.request.urlopen("http://127.0.0.1:8787/health", timeout=10) as response:
    sources = json.load(response)["sources"]

for source_id in sorted(NEW):
    source = sources.get(source_id)
    if source is None:
        print("MISSING  ", source_id)
        continue
    print(
        f'{source["state"]:9} mechanism_ok={source["mechanism_ok"]} '
        f'errors={source["consecutive_errors"]} {source_id}  {str(source["detail"])[:80]}'
    )
```
PYEOF
```

Expected: twelve lines. `healthy` is the goal; `unknown` right after a restart resolves within a minute or two. Any `degraded`/`dead` line means that source's poll or extraction is failing: read its `detail`, which names the cause.

```bash
# emission: items per new source in the archive (read-only; never open it with Store)
ssh mini-mac 'cd ~/Internet_Info_Plug && .venv/bin/python -' <<'PYEOF'
```python
import sqlite3

NEW = [
    "aaa_national_average", "imf_portwatch_hormuz", "federal_reserve_monetary",
    "federal_reserve_press", "federal_reserve_speeches", "whitehouse_presidential_actions",
    "eia_today_in_energy", "oilprice_main", "rigzone_latest", "npr_news",
    "politico_politics", "thehill_news",
]

# Read-only on purpose: Store() migrates the archive on open, and this file has no copy.
connection = sqlite3.connect("file:data/iip.db?mode=ro", uri=True)
for source_id in sorted(NEW):
    count, quarantined, last_seen = connection.execute(
        "SELECT COUNT(*), COALESCE(SUM(quarantined), 0), MAX(first_seen_ts)"
        " FROM items WHERE source_id = ?",
        (source_id,),
    ).fetchone()
    print(f"{source_id:34} items={count:4} quarantined={quarantined:4} last_seen={last_seen}")
```
PYEOF
```

Expected: the two series sources have `items=1` (their baseline reading). Feeds show their first-poll items, and a large first poll may show a high `quarantined` count: that is iip's burst breaker withholding an old back-catalogue, which is the behaviour you want.

**Backlog-drained condition (when the step 1 gate may be lifted):** all twelve sources have polled at least twice, and `ssh mini-mac 'journalctl --user -u executor-module --since "-10 min" --no-pager | grep -c "KEYPHRASE-MATCH"'` has printed `0` for ten consecutive minutes. Report this to the operator; do not lift the gate yourself.

- [ ] **Step 9: Slack channel check, then the 3-day calibration**

A real alert proves the channel end to end. From the repo on mini-mac, with the venv (this posts one clearly labelled message and prints nothing sensitive):

```bash
ssh mini-mac 'cd ~/Internet_Info_Plug && .venv/bin/python -' <<'PYEOF'
import asyncio
from dotenv import load_dotenv
import os
from iip.alerts import SlackNotifier

load_dotenv()
url = os.getenv("SLACK_WEBHOOK_URL", "").strip()
assert url, "SLACK_WEBHOOK_URL is not set in ~/Internet_Info_Plug/.env"
asyncio.run(SlackNotifier(url).notify("iip deployment check", "[TEST] mini-mac iip alert channel works. No action needed.", "info"))
print("sent (confirm it arrived in the channel; a failure is logged, never raised)")
PYEOF
```

Expected: `sent ...`, and the message in the channel. If it did not arrive, read the `slack alert delivery failed:` line in the output (it names a status or error TYPE, never the URL).

Calibration. Wait at least 72 hours after step 7. Then, with `SINCE` set to the restart time plus one hour (an ISO timestamp with `+00:00`, e.g. `2026-10-10T21:00:00+00:00`), which keeps the first-poll backlog out of the measurement:

```bash
ssh mini-mac 'cd ~/Internet_Info_Plug && .venv/bin/python - 2026-10-10T21:00:00+00:00' <<'PYEOF'
```python
"""Observed gaps per new source against the configured expected_gap_s. Read-only.

usage (from ~/Internet_Info_Plug, with the venv python):
    python calibrate_gaps.py 2026-10-09T20:00:00+00:00
The argument is when to start counting: the deployment time plus an hour, so the
first-poll back-catalogue does not read as a burst of zero gaps.
"""
import sqlite3
import sys
from datetime import datetime
from pathlib import Path

from iip.registry import Registry

NEW = [
    "aaa_national_average", "imf_portwatch_hormuz", "federal_reserve_monetary",
    "federal_reserve_press", "federal_reserve_speeches", "whitehouse_presidential_actions",
    "eia_today_in_energy", "oilprice_main", "rigzone_latest", "npr_news",
    "politico_politics", "thehill_news",
]

since = sys.argv[1]
registry = Registry(Path("config/sources.minimac.yaml"))
registry.load()
connection = sqlite3.connect("file:data/iip.db?mode=ro", uri=True)

print(f"{'source':34} {'items':>5} {'median_s':>9} {'max_s':>9} {'expected_s':>10}  verdict")
for source_id in sorted(NEW):
    rows = connection.execute(
        "SELECT first_seen_ts FROM items WHERE source_id = ? AND quarantined = 0"
        " AND first_seen_ts >= ? ORDER BY first_seen_ts",
        (source_id, since),
    ).fetchall()
    stamps = [datetime.fromisoformat(row[0]) for row in rows]
    gaps = sorted((b - a).total_seconds() for a, b in zip(stamps, stamps[1:]))
    expected = registry.by_id[source_id].expected_gap_s
    if len(gaps) < 3:
        verdict = "TOO FEW SAMPLES: keep the current value and look again later"
        median = longest = float("nan")
    else:
        median, longest = gaps[len(gaps) // 2], gaps[-1]
        verdict = (
            f"RAISE expected_gap_s to at least {int(longest) + 1}"
            if longest > expected
            else "ok"
        )
    print(
        f"{source_id:34} {len(stamps):>5} {median:>9.0f} {longest:>9.0f} "
        f"{expected:>10.0f}  {verdict}"
    )
```
PYEOF
```

Read each row's verdict:

- `RAISE expected_gap_s to at least N`: the source went quieter than its configured expectation without being broken. Raise it to `N` (rounded up) in `config/sources.minimac.yaml`, and add the same number to `MEASURED_MAX_GAP_S` in `tests/test_minimac_sources.py`. Never lower a number to silence an alert.
- `TOO FEW SAMPLES`: leave it. The slow ones (the Fed, the series sources) legitimately need weeks; look again later.
- `ok`: leave it.

Also check `ssh mini-mac 'journalctl --user -u iip --since "-72 hours" --no-pager | grep -E "ALERT \[(aaa_national_average|imf_portwatch_hormuz|federal_reserve|whitehouse|eia_|oilprice|rigzone|npr_|politico|thehill)"'`. A `SUSPECT` line on a source that was in fact working is the signature of a too-tight `expected_gap_s`; a `DEGRADED`/`DEAD` line on a series source is a real extraction failure to investigate (compare the live page or response with the recorded fixture). Commit any calibration changes to the branch, re-run the suite, and repeat the bundle transfer and restart for them.

- [ ] **Step 10: Rollback (if anything above goes wrong)**

The code can stay; only the selection of the config and the restart need reverting:

```bash
ssh mini-mac 'python3 - <<EOF
from pathlib import Path
p = Path.home() / ".config/systemd/user/iip.service"
s = p.read_text()
p.write_text(s.replace("-m iip run --config config/sources.minimac.yaml --log-level INFO", "-m iip run --log-level INFO"))
EOF
systemctl --user daemon-reload && systemctl --user restart iip && systemctl --user is-active iip'
```

Expected: `active`; the daemon is back on `config/sources.yaml` exactly as before. Items already archived from the new sources are harmless and stay.

- [ ] **Step 11: Record the outcome**

No commit unless step 9 changed the calibration. Report to the operator: the pre-flight and health output, the Slack check, the backlog-drained evidence, which executor option (A/B/C) was chosen and whether the gate is still in force.

---

### Task 7: Boundary wording in this repo's docs (REQUIRES OPERATOR APPROVAL)

This task rewrites the standing rules that govern this repo. **Do not apply or merge it until the operator has read the exact wording below and said yes.** It describes an exception the operator already approved in principle; the wording is theirs to approve.

**Files:**
- Modify: `CLAUDE.md` (the "Market ignorance" bullet)
- Modify: `HANDOFF.md` (section 7, "Market ignorance")

**Interfaces:** none.

- [ ] **Step 1: Show the operator the exact wording and wait**

Present these two diffs and stop. They are validated to apply cleanly to the current files.

`CLAUDE.md`:

```diff
--- a/CLAUDE.md
+++ b/CLAUDE.md
@@ -26,7 +26,12 @@
   read, copy or write the bytes of any `kalshi_key.pem`; never write a string beginning
   `-----BEGIN`; never set a `^KALSHI` environment variable.
 - **Market ignorance:** no keyword or rule encoding a specific market's resolution
-  condition may enter `iip/`. Rules live in `executor/rules.d/`.
+  condition may enter `iip/` or any source's config -- no market ticker, no trading
+  level, no venue. Rules live in `executor/rules.d/`. *Exception, operator-approved
+  2026-10-07:* generic source work is allowed and expected -- feeds, page watchers, and
+  `series` sources that read one published number -- including a mini-mac-only source
+  set (`config/sources.minimac.yaml`). A source says WHAT a number or document is, never
+  what anyone should do about it. The `executor/` guards above are unaffected.
 - **`data/iip.db` is git-ignored, holds 103 real archived items, and has no copy
   anywhere.** Never `git clean` (any flags). `Store.__init__` migrates on open, so never
   point anything read-write at it — copy it first, or read it `?mode=ro`.
```

`HANDOFF.md`:

```diff
--- a/HANDOFF.md
+++ b/HANDOFF.md
@@ -787,6 +787,16 @@
 **No keyword or rule that encodes a specific market's resolution condition may enter
 `iip/`.** The daemon reports what sources said; it does not know what any market resolves
 on. Rules live in `executor/rules.d/`.
+
+**Source work is not market knowledge, and is allowed** (operator-approved exception,
+2026-10-07). New generic sources -- a feed, a page watcher, or a `series` source that reads
+one published number -- may be added, including to a deployment-specific file such as
+`config/sources.minimac.yaml` (the mini-mac instance; the ai1 baseline keeps
+`config/sources.yaml` untouched). What stays forbidden is anything that names a market
+ticker, a level someone would trade at, or a venue, in `iip/` OR in any source's config:
+`tests/test_series_adapter.py` and `tests/test_minimac_sources.py` scan for exactly that.
+The `executor/` guards in the section above are not part of this exception and do not
+change.
 
 ### Process
 
```

What stays true after them, and should be said to the operator in one sentence: the market-ignorance rule is unchanged for markets, tickers, levels and venues (and now covers source configs explicitly); the exception covers only generic source work; the `executor/` safety guards and the credential rules are not part of it.

- [ ] **Step 2: Apply once approved**

```bash
git apply <<'PATCH'
--- a/CLAUDE.md
+++ b/CLAUDE.md
@@ -26,7 +26,12 @@
   read, copy or write the bytes of any `kalshi_key.pem`; never write a string beginning
   `-----BEGIN`; never set a `^KALSHI` environment variable.
 - **Market ignorance:** no keyword or rule encoding a specific market's resolution
-  condition may enter `iip/`. Rules live in `executor/rules.d/`.
+  condition may enter `iip/` or any source's config -- no market ticker, no trading
+  level, no venue. Rules live in `executor/rules.d/`. *Exception, operator-approved
+  2026-10-07:* generic source work is allowed and expected -- feeds, page watchers, and
+  `series` sources that read one published number -- including a mini-mac-only source
+  set (`config/sources.minimac.yaml`). A source says WHAT a number or document is, never
+  what anyone should do about it. The `executor/` guards above are unaffected.
 - **`data/iip.db` is git-ignored, holds 103 real archived items, and has no copy
   anywhere.** Never `git clean` (any flags). `Store.__init__` migrates on open, so never
   point anything read-write at it — copy it first, or read it `?mode=ro`.
PATCH
git apply <<'PATCH'
--- a/HANDOFF.md
+++ b/HANDOFF.md
@@ -787,6 +787,16 @@
 **No keyword or rule that encodes a specific market's resolution condition may enter
 `iip/`.** The daemon reports what sources said; it does not know what any market resolves
 on. Rules live in `executor/rules.d/`.
+
+**Source work is not market knowledge, and is allowed** (operator-approved exception,
+2026-10-07). New generic sources -- a feed, a page watcher, or a `series` source that reads
+one published number -- may be added, including to a deployment-specific file such as
+`config/sources.minimac.yaml` (the mini-mac instance; the ai1 baseline keeps
+`config/sources.yaml` untouched). What stays forbidden is anything that names a market
+ticker, a level someone would trade at, or a venue, in `iip/` OR in any source's config:
+`tests/test_series_adapter.py` and `tests/test_minimac_sources.py` scan for exactly that.
+The `executor/` guards in the section above are not part of this exception and do not
+change.
 
 ### Process
 
PATCH
git diff --stat
```

Expected: two files changed, documentation only.

- [ ] **Step 3: Whole-branch verification, then commit**

```bash
.venv/bin/pytest 2>&1 | tail -2                         # expected: 1279 passed
git diff --stat main -- executor/ config/sources.yaml   # expected: no output
git add CLAUDE.md HANDOFF.md
git commit -m "docs: state the operator-approved source-work exception to market ignorance

Generic source work (feeds, page watchers, series readers, deployment-specific source
files) is allowed; market tickers, trading levels and venues stay forbidden in iip/ and
in any source config. The executor/ guards and credential rules are unchanged."
```

- [ ] **Step 4: Tell the executor_module side**

executor_module's `CLAUDE.md` still says "Do not modify anything under `Internet_Info_Plug`". That is its own repo's text and is outside this plan. Tell the operator it needs a matching one-line exception (new generic sources only; never `executor/`), and that `deploy/mini-mac/iip.service` there needs the diff from Task 6 step 4.

---

## Self-review

**Spec coverage (section 11):**
- Boundary and operator exception: Global Constraints, Task 7. Market-ignorance rule enforced by tests (Task 2 scan of the adapter/extractor source, Task 3 scan of the new config entries) and by the registry refusing a kalshi host (Task 1).
- Sources table: all rows are covered except `nhc_atlantic` and `ukmto_advisories`, which were investigated and deliberately excluded with evidence (Spec corrections 3 and 4); `aaa_national_average` and `imf_portwatch_hormuz` (Task 3) and ten feeds (Task 4).
- `series` adapter (config fields, one item per new point, DEGRADED on failed extraction, templated synthetic headline, snippet with value/unit/date/previous/delta, no market knowledge): Tasks 1-2.
- Deployment (mini-mac only via `--config`, ai1 untouched, rate_limit explicit, tolerant expected_gap in the cold tier, calibration, bundle transfer, restart): Tasks 3, 4, 6.
- Testing section (adapter unit tests with a fake client, config-load tests, recorded fixtures, plug and executor suites unchanged, `git diff` shows nothing under `executor/`): Tasks 1-5 and the protected-path checks in Tasks 4, 5, 6, 7.
- Risks section (scraping fragility, alerts going nowhere on Linux, volume, politeness): the fragility is addressed by DEGRADED-on-failure; the alert channel by Task 5; politeness by per-source rate limits and slow polls.
- Executor-side `directSources` routing is explicitly NOT part of this plan (it lives in executor_module's plan).

**Placeholder scan:** none. Every code block is a file or diff that was run. The only values left to the executor are measured at execution time (fixtures, the calibration verdicts) and are produced by commands given in full.

**Type and name consistency:** `check_spec`, `extract`, `parse_number`, `parse_date`, `ExtractError` (Task 1) are the names Task 2's adapter imports; `SeriesAdapter`'s constructor matches its use in Tasks 2, 3 and the contract case; `build_notifier` and `SlackNotifier` (Task 5) match their use in `__main__`; the twelve source ids are identical across Tasks 3, 4, 6 and the helper scripts.

**Review Focus:** all five lines are pinned by named tests; the first three were verified red under mutation (Task 2 step 6).

**Verified counts (plug suite, real-repo baseline 1169):** after Task 1 = 1220; Task 2 = 1252; Task 3 = 1264; Task 4 = 1270; Task 5 = 1279 (110 new tests). Task 7 adds none.
