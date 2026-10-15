import datetime, json, os, tempfile, unittest


def jload(p):
    with open(p) as f:
        return json.load(f)


def jdump(d, p):
    with open(p, "w") as f:
        json.dump(d, f)
from unittest import mock
import refresh

T0 = datetime.datetime(2026, 10, 13, 12, 0, 0, tzinfo=datetime.timezone.utc).timestamp()


def iso(offset_hours):
    return datetime.datetime.fromtimestamp(T0 + offset_hours * 3600, datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def event(ticker, opened_h, close_hs, strike=None):
    return {"event_ticker": ticker, "strike_date": strike,
            "markets": [{"open_time": iso(opened_h), "close_time": iso(c)} for c in close_hs]}


class PickAndStale(unittest.TestCase):
    def test_pick_event_soonest_future_close(self):
        a = event("A", -48, [-5, 30])      # next close in 30h (the -5 is past)
        b = event("B", -10, [6, 72])       # next close in 6h  <- soonest
        c = event("C", -10, [-3])          # nothing in the future
        self.assertEqual(refresh.pick_event([a, b, c], T0)["event_ticker"], "B")

    def test_pick_event_fallbacks(self):
        self.assertIsNone(refresh.pick_event([], T0))
        no_close = [{"event_ticker": "Z", "strike_date": "2026-12-01", "markets": []}, {"event_ticker": "Y", "strike_date": None, "markets": []}]
        self.assertEqual(refresh.pick_event(no_close, T0)["event_ticker"], "Y")  # null strike_date sorts first

    def test_stale_rule(self):
        p = {"generatedAt": iso(-24)}
        self.assertTrue(refresh.is_stale(p, event("E", -2, [5])))                 # event opened after the profile
        self.assertFalse(refresh.is_stale(p, event("E", -30, [5])))               # event is older than the profile
        self.assertFalse(refresh.is_stale(p, event("E", -24 + 0.01, [5])))        # inside the 60 s grace
        self.assertFalse(refresh.is_stale({"generatedAt": None}, event("E", -2, [5])))
        self.assertFalse(refresh.is_stale(p, {"event_ticker": "E", "markets": []}))

    def test_build_cmd(self):
        cmd = refresh.build_cmd({"name": "kxwti", "seriesTicker": "KXWTI", "directSources": ["eia_today_in_energy", "x"]})
        self.assertEqual(cmd, ["/usr/bin/npm", "run", "build-trade", "--", "--series", "KXWTI", "--direct", "eia_today_in_energy,x",
                               "--reuse-keyphrases", "trades/kxwti/keyphrases.json"])
        self.assertNotIn("--direct", refresh.build_cmd({"name": "kxgdp", "seriesTicker": "KXGDP", "directSources": []}))

    def test_active_trades_parses_only_paper_units(self):
        out = ("executor-module@kxwti.service loaded active running a\n  executor-module@kxfed.service loaded active running b\n")
        with mock.patch("subprocess.run", return_value=mock.Mock(stdout=out)):
            self.assertEqual(refresh.active_trades(), ["kxfed", "kxwti"])


class Orchestration(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.repo = os.path.join(self.tmp.name, "repo")
        self.out = os.path.join(self.tmp.name, "out")
        self.runs, self.restarts, self.logs = [], [], []
        for t, gen in (("kxwti", iso(-72)), ("kxgdp", iso(-72))):
            os.makedirs(f"{self.repo}/trades/{t}")
            with open(f"{self.repo}/trades/{t}/profile.json", "w") as f:
                json.dump({"name": t, "seriesTicker": t.upper(), "directSources": ["eia"] if t == "kxwti" else [], "generatedAt": gen, "title": "old"}, f)
            with open(f"{self.repo}/trades/{t}/keyphrases.json", "w") as f:
                f.write('["a"]')
        self.event_by_series = {"KXWTI": event("KXWTI-NEW", -10, [8]), "KXGDP": event("KXGDP-OLD", -500, [900])}

    def tearDown(self):
        self.tmp.cleanup()

    def deps(self, run=None, restart=None, trades=("kxgdp", "kxwti")):
        def default_run(cmd, env, cwd):
            self.runs.append((cmd, env, cwd))
            series = cmd[cmd.index("--series") + 1].lower()
            p = f"{self.repo}/trades/{series}/profile.json"
            data = jload(p); data["generatedAt"] = iso(0); data["title"] = "new"
            jdump(data, p)
            return 0, "ok"
        return refresh.Deps(repo=self.repo, out=self.out, trades=lambda: list(trades),
                            events=lambda s: [self.event_by_series[s]], run=run or default_run,
                            restart=restart or (lambda t: self.restarts.append(t) or True), now=lambda: T0,
                            sleep=lambda s: None, env=lambda: {"ANTHROPIC_API_KEY": "sk-test-secret"},
                            log=lambda m: self.logs.append(m))

    def test_rebuilds_only_the_stale_profile_restarts_only_that_unit_and_keeps_a_backup(self):
        res = refresh.refresh(self.deps())
        self.assertEqual((res["stale"], res["rebuilt"], res["failed"], res["errors"]), (["kxwti"], ["kxwti"], [], []))
        self.assertEqual(len(self.runs), 1)
        cmd, env, cwd = self.runs[0]
        self.assertIn("--reuse-keyphrases", cmd)
        self.assertEqual((env["ANTHROPIC_API_KEY"], cwd), ("sk-test-secret", self.repo))
        self.assertEqual(self.restarts, ["kxwti"])
        backups = os.listdir(f"{self.out}/backups")
        self.assertEqual(len(backups), 1)
        self.assertTrue(backups[0].startswith("kxwti-"))
        old = jload(f"{self.out}/backups/{backups[0]}/profile.json")
        self.assertEqual(old["title"], "old")
        self.assertFalse(any("sk-test-secret" in m for m in self.logs))      # the key is never logged

    def test_failed_build_is_retried_then_reported_and_the_unit_is_not_restarted(self):
        calls = []
        def failing(cmd, env, cwd):
            calls.append(1)
            return 1, "bank section SETTLEMENT-SENSITIVE FACTS: has 2 item(s), needs at least 3"
        res = refresh.refresh(self.deps(run=failing))
        self.assertEqual((res["rebuilt"], res["failed"]), ([], ["kxwti"]))
        self.assertEqual(len(calls), refresh.BUILD_RETRIES)
        self.assertEqual(self.restarts, [])
        self.assertEqual(jload(f"{self.repo}/trades/kxwti/profile.json")["title"], "old")

    def test_a_retry_can_succeed(self):
        n = {"i": 0}
        def flaky(cmd, env, cwd):
            n["i"] += 1
            if n["i"] < 2:
                return 1, "validation failed"
            p = f"{self.repo}/trades/kxwti/profile.json"
            data = jload(p); data["generatedAt"] = iso(0); jdump(data, p)
            return 0, "ok"
        res = refresh.refresh(self.deps(run=flaky))
        self.assertEqual((res["rebuilt"], res["failed"]), (["kxwti"], []))
        self.assertEqual(n["i"], 2)

    def test_rc_zero_without_a_new_profile_counts_as_failure(self):
        res = refresh.refresh(self.deps(run=lambda cmd, env, cwd: (0, "ok but wrote nothing")))
        self.assertEqual(res["failed"], ["kxwti"])
        self.assertEqual(self.restarts, [])

    def test_failed_restart_is_reported(self):
        res = refresh.refresh(self.deps(restart=lambda t: False))
        self.assertEqual((res["rebuilt"], res["failed"]), ([], ["kxwti"]))

    def test_dry_run_changes_nothing(self):
        res = refresh.refresh(self.deps(), dry=True)
        self.assertEqual((res["stale"], res["rebuilt"]), (["kxwti"], []))
        self.assertEqual((self.runs, self.restarts), ([], []))
        self.assertFalse(os.path.exists(self.out))

    def test_only_filter_and_no_restart_flag(self):
        res = refresh.refresh(self.deps(), only={"kxgdp"})
        self.assertEqual((res["checked"], res["stale"]), (1, []))
        res = refresh.refresh(self.deps(), only={"kxwti"}, restart=False)
        self.assertEqual((res["rebuilt"], self.restarts), (["kxwti"], []))

    def test_a_kalshi_failure_for_one_trade_does_not_stop_the_others(self):
        def events(series):
            if series == "KXGDP":
                raise RuntimeError("HTTP 500")
            return [self.event_by_series[series]]
        d = self.deps()
        d.events = events
        res = refresh.refresh(d)
        self.assertEqual(res["rebuilt"], ["kxwti"])
        self.assertEqual(len(res["errors"]), 1)
        self.assertIn("kxgdp", res["errors"][0])

    def test_an_unreadable_profile_is_an_error_not_a_crash(self):
        os.remove(f"{self.repo}/trades/kxgdp/profile.json")
        res = refresh.refresh(self.deps())
        self.assertEqual(res["rebuilt"], ["kxwti"])
        self.assertIn("kxgdp", res["errors"][0])


def ladder_event(ticker, strikes, opened_h=-30, close_h=8):
    return {"event_ticker": ticker, "strike_date": None,
            "markets": [{"open_time": iso(opened_h), "close_time": iso(close_h), "floor_strike": s, "cap_strike": None} for s in strikes]}


GAS = [round(4.16 + 0.02 * i, 2) for i in range(21)]  # 4.16 .. 4.56


class StrikeStaleness(unittest.TestCase):
    profile = {"generatedAt": iso(-24), "marketStructure": "threshold", "decideContext": "Estimate the effect on the AAA price."}

    def test_strike_range_uses_the_median_step(self):
        r = refresh.strike_range(ladder_event("E", GAS))
        self.assertEqual((r["min"], r["max"]), (4.16, 4.56))
        self.assertAlmostEqual(r["step"], 0.02)
        self.assertIsNone(refresh.strike_range(ladder_event("E", [4.2])))
        self.assertIsNone(refresh.strike_range({"event_ticker": "E", "markets": []}))

    def test_quoted_strikes_make_a_ladder_profile_stale(self):
        for text in ("The market resolves Yes if above the strike; strikes range from 22 to 75.",
                     "With strikes spaced $0.02 apart around $4.46-$4.56.", "Strike 4.5 matters."):
            p = {**self.profile, "decideContext": text}
            self.assertEqual(refresh.stale_reason(p, {}, ladder_event("E", GAS)), "decideContext quotes strike values", text)

    def test_strike_free_context_and_other_structures_are_left_alone(self):
        ok = {**self.profile, "decideContext": "Resolves Yes if the weekly sum is above the strike; the ladder is supplied with each decision."}
        self.assertIsNone(refresh.stale_reason(ok, {}, ladder_event("E", GAS)))
        binary = {**self.profile, "marketStructure": "binary", "decideContext": "strikes 1 to 5"}
        self.assertIsNone(refresh.stale_reason(binary, {}, ladder_event("E", GAS)))

    def test_drift_beyond_two_steps_is_stale_and_within_it_is_not(self):
        meta = {"strikeRange": {"min": 4.46, "max": 4.56}}
        self.assertIn("drifted", refresh.stale_reason(self.profile, meta, ladder_event("E", GAS)))   # min moved 0.30
        near = {"strikeRange": {"min": 4.14, "max": 4.58}}                                           # within 2 steps (0.04)
        self.assertIsNone(refresh.stale_reason(self.profile, near, ladder_event("E", GAS)))
        self.assertIsNone(refresh.stale_reason(self.profile, {}, ladder_event("E", GAS)))           # legacy: no recorded range

    def test_event_rollover_still_wins(self):
        self.assertEqual(refresh.stale_reason(self.profile, {}, ladder_event("E", GAS, opened_h=-2)), "event rolled over")

    def test_read_meta_tolerates_missing_and_bad_files(self):
        with tempfile.TemporaryDirectory() as repo:
            os.makedirs(f"{repo}/trades/t")
            self.assertEqual(refresh.read_meta(repo, "t"), {})
            with open(f"{repo}/trades/t/bank.meta.json", "w") as f:
                f.write("{not json")
            self.assertEqual(refresh.read_meta(repo, "t"), {})
            jdump({"strikeRange": {"min": 1, "max": 2}}, f"{repo}/trades/t/bank.meta.json")
            self.assertEqual(refresh.read_meta(repo, "t")["strikeRange"]["max"], 2)


class StrikeOrchestration(unittest.TestCase):
    def test_a_quoting_profile_is_rebuilt_even_when_its_event_has_not_rolled_over(self):
        with tempfile.TemporaryDirectory() as tmp:
            repo, out = f"{tmp}/repo", f"{tmp}/out"
            os.makedirs(f"{repo}/trades/kxaaagasw")
            jdump({"name": "kxaaagasw", "seriesTicker": "KXAAAGASW", "directSources": [], "generatedAt": iso(-1), "marketStructure": "threshold",
                   "decideContext": "Strikes spaced $0.02 around $4.46-$4.56."}, f"{repo}/trades/kxaaagasw/profile.json")
            jdump(["a"], f"{repo}/trades/kxaaagasw/keyphrases.json")
            restarts, logs = [], []

            def run(cmd, env, cwd):
                p = f"{repo}/trades/kxaaagasw/profile.json"
                data = jload(p); data["generatedAt"] = iso(0); data["decideContext"] = "Resolves Yes above the strike."; jdump(data, p)
                return 0, "ok"
            d = refresh.Deps(repo=repo, out=out, trades=lambda: ["kxaaagasw"], events=lambda s: [ladder_event("KXAAAGASW-26OCT19", GAS)],
                             run=run, restart=lambda t: restarts.append(t) or True, now=lambda: T0, sleep=lambda s: None, env=lambda: {}, log=logs.append)
            res = refresh.refresh(d)
            self.assertEqual((res["stale"], res["rebuilt"], res["failed"]), (["kxaaagasw"], ["kxaaagasw"], []))
            self.assertEqual(res["reasons"], {"kxaaagasw": "decideContext quotes strike values"})
            self.assertEqual(restarts, ["kxaaagasw"])
            self.assertTrue(any("quotes strike values" in m for m in logs))
            # Rebuilt text is strike-free, so the next pass leaves it alone (no rebuild loop).
            res2 = refresh.refresh(d)
            self.assertEqual(res2["stale"], [])


if __name__ == "__main__":
    unittest.main()
