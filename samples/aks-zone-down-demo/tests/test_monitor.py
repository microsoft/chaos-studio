"""Focused stdlib tests for the AKS zone-down demo monitor."""
from __future__ import annotations

import contextlib
import io
import pathlib
import sys
import threading
import unittest
from unittest import mock

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))

import monitor  # noqa: E402


def _pod(name, node_name, ready, phase="Running"):
    return {
        "metadata": {"name": name},
        "spec": {"nodeName": node_name},
        "status": {
            "phase": phase,
            "conditions": [{"type": "Ready", "status": "True" if ready else "False"}],
        },
    }


def _node(name, zone, ready_status="True"):
    return {
        "metadata": {"name": name, "labels": {monitor.ZONE_LABEL: zone}},
        "status": {"conditions": [{"type": "Ready", "status": ready_status}]},
    }


def _config(*extra):
    return monitor.Config(
        monitor.parse_args(
            [
                "--storefront-url",
                "http://example.com",
                "--target-zone",
                "z1",
                *extra,
            ]
        )
    )


def _snapshot(http_ok=True, node_state="Ready", zones=("z1",), ts=1.0):
    return {
        "ts": ts,
        "http_ok": http_ok,
        "http_detail": "HTTP 200",
        "node_state": node_state,
        "zones": frozenset(zones),
        "pods": [],
        "replica_count": 0,
    }


class ParsingTest(unittest.TestCase):
    def test_pod_readiness_cases(self):
        cases = [
            ("ready", _pod("p1", "n1", True), True),
            ("not ready", _pod("p1", "n1", False), False),
            ("missing conditions", {"status": {}}, False),
            ("missing status", {}, False),
        ]
        for name, pod, expected in cases:
            with self.subTest(name=name):
                self.assertEqual(monitor.get_pod_ready(pod), expected)

    def test_node_readiness_cases(self):
        cases = [
            ("True", "Ready"),
            ("False", "NotReady"),
            ("Unknown", "Unknown"),
        ]
        for status, expected in cases:
            with self.subTest(status=status):
                self.assertEqual(monitor.get_node_ready_state(_node("n1", "z1", status)), expected)
        self.assertEqual(monitor.get_node_ready_state({"status": {}}), "Unknown")

    def test_node_map_pod_parsing_and_ready_zone_coverage(self):
        nodes = {"items": [_node("n1", "z1"), _node("n2", "z2"), _node("n3", "z3")]}
        node_map = monitor.build_node_zone_map(nodes)
        pods = monitor.parse_frontend_pods(
            {
                "items": [
                    _pod("front-a", "n1", True),
                    _pod("front-b", "n2", False, phase="Pending"),
                    _pod("front-c", "missing", True),
                ]
            },
            node_map,
        )

        self.assertEqual(node_map, {"n1": "z1", "n2": "z2", "n3": "z3"})
        self.assertEqual(monitor.discover_zones(nodes), ["z1", "z2", "z3"])
        self.assertEqual(
            pods,
            [
                {"name": "front-a", "node": "n1", "zone": "z1", "ready": True, "phase": "Running"},
                {"name": "front-b", "node": "n2", "zone": "z2", "ready": False, "phase": "Pending"},
                {"name": "front-c", "node": "missing", "zone": None, "ready": True, "phase": "Running"},
            ],
        )
        self.assertEqual(monitor.zones_with_ready_replica(pods), {"z1"})


class StorefrontHttpTest(unittest.TestCase):
    def test_cache_busting_url_preserves_existing_query(self):
        cases = [
            ("http://example.com", "http://example.com?_cb=1500"),
            ("http://example.com?a=1", "http://example.com?a=1&_cb=1500"),
        ]
        for base_url, expected in cases:
            with self.subTest(base_url=base_url):
                self.assertEqual(monitor.cache_busting_url(base_url, 1.5), expected)

    def test_check_storefront_sends_cache_busted_no_cache_request(self):
        response = mock.MagicMock()
        response.__enter__.return_value.status = 200
        with (
            mock.patch.object(monitor.time, "time", return_value=1.5),
            mock.patch.object(monitor.urllib.request, "urlopen", return_value=response) as urlopen,
        ):
            self.assertEqual(monitor.check_storefront("http://example.com", 3), (True, "HTTP 200"))

        request = urlopen.call_args.args[0]
        self.assertEqual(request.full_url, "http://example.com?_cb=1500")
        self.assertEqual(request.get_header("Cache-control"), "no-cache")
        self.assertEqual(request.get_header("Pragma"), "no-cache")


class TransitionTest(unittest.TestCase):
    def test_initial_and_unchanged_snapshots(self):
        snap = _snapshot()
        self.assertIn("monitoring started", monitor.classify_transition(None, snap))
        self.assertIsNone(monitor.classify_transition(snap, dict(snap)))

    def test_individual_transition_classification(self):
        cases = [
            (_snapshot(), _snapshot(http_ok=False), "UNREACHABLE"),
            (_snapshot(http_ok=False), _snapshot(), "reachable again"),
            (_snapshot(), _snapshot(node_state="NotReady"), "Ready -> NotReady"),
            (_snapshot(), _snapshot(zones=("z1", "z2")), "zone coverage"),
        ]
        for previous, current, expected in cases:
            with self.subTest(expected=expected):
                self.assertIn(expected, monitor.classify_transition(previous, current))

    def test_http_transition_precedes_node_transition_in_combined_event(self):
        message = monitor.classify_transition(
            _snapshot(),
            _snapshot(http_ok=False, node_state="NotReady", zones=()),
        )
        self.assertLess(message.index("UNREACHABLE"), message.index("Ready -> NotReady"))
        self.assertIn("zone coverage", message)


class VerifyZoneCoverageTest(unittest.TestCase):
    @staticmethod
    def _covered_cluster(args, timeout=10.0):
        if args[:2] == ["get", "nodes"]:
            return {"items": [_node("n1", "z1"), _node("n2", "z2")]}
        return {"items": [_pod("front-a", "n1", True), _pod("front-b", "n2", True)]}

    def test_passes_when_every_discovered_zone_is_covered(self):
        with mock.patch.object(monitor, "kubectl_json", side_effect=self._covered_cluster) as kubectl:
            self.assertTrue(monitor.verify_zone_coverage("app=store-front", "default", 1, poll_seconds=0))
        self.assertEqual(kubectl.call_count, 2)

    def test_times_out_when_a_discovered_zone_is_missing(self):
        def missing_zone(args, timeout=10.0):
            if args[:2] == ["get", "nodes"]:
                return {"items": [_node("n1", "z1"), _node("n2", "z2")]}
            return {"items": [_pod("front-a", "n1", True)]}

        with (
            mock.patch.object(monitor, "kubectl_json", side_effect=missing_zone),
            contextlib.redirect_stderr(io.StringIO()) as stderr,
        ):
            self.assertFalse(monitor.verify_zone_coverage("app=store-front", "default", 0, poll_seconds=0))
        self.assertIn("zone(s) z2", stderr.getvalue())

    def test_transient_initial_discovery_failure_retries_then_passes(self):
        responses = [
            RuntimeError("temporary API failure"),
            {"items": [_node("n1", "z1"), _node("n2", "z2")]},
            {"items": [_pod("front-a", "n1", True), _pod("front-b", "n2", True)]},
        ]
        with (
            mock.patch.object(monitor, "kubectl_json", side_effect=responses),
            contextlib.redirect_stderr(io.StringIO()) as stderr,
        ):
            self.assertTrue(monitor.verify_zone_coverage("app=store-front", "default", 1, poll_seconds=0))
        self.assertIn("transient error, retrying", stderr.getvalue())

    def test_persistent_failure_returns_nonzero_from_verify_mode(self):
        with (
            mock.patch.object(monitor, "kubectl_json", side_effect=RuntimeError("API unavailable")),
            contextlib.redirect_stderr(io.StringIO()) as stderr,
        ):
            self.assertEqual(monitor.main(["--mode", "verify", "--timeout", "0"]), 1)
        self.assertIn("FAIL after", stderr.getvalue())


class PollingTest(unittest.TestCase):
    def test_poll_uses_one_all_nodes_sample_for_target_and_pod_zones(self):
        calls = []

        def fake_kubectl(args, timeout=10.0):
            calls.append(args)
            if args[:2] == ["get", "nodes"]:
                return {"items": [_node("n1", "z1", "False"), _node("n2", "z2")]}
            return {"items": [_pod("front-a", "n1", True)]}

        with (
            mock.patch.object(monitor, "check_storefront", return_value=(True, "HTTP 200")),
            mock.patch.object(monitor, "kubectl_json", side_effect=fake_kubectl),
        ):
            sample = monitor.poll_once(_config())

        self.assertEqual(calls, [["get", "nodes"], ["get", "pods", "-l", "app=store-front", "-n", "default"]])
        self.assertEqual(sample["node_state"], "NotReady")
        self.assertEqual(sample["zones"], frozenset({"z1"}))

    def test_current_error_is_visible_and_success_clears_it(self):
        state = monitor.MonitorState(_config())
        state.record_error("kubectl error: API unavailable")
        self.assertEqual(state.snapshot_json()["error"], "kubectl error: API unavailable")

        state.record(_snapshot())
        self.assertIsNone(state.snapshot_json()["error"])

    def test_poll_loop_recovers_and_clears_current_error(self):
        state = monitor.MonitorState(_config("--interval", "0"))
        stop_event = threading.Event()
        results = [RuntimeError("stale kubeconfig"), _snapshot()]

        def recovering_poll(_config):
            result = results.pop(0)
            if isinstance(result, Exception):
                raise result
            stop_event.set()
            return result

        with (
            mock.patch.object(monitor, "poll_once", side_effect=recovering_poll),
            contextlib.redirect_stderr(io.StringIO()) as stderr,
        ):
            monitor.poll_loop(state, stop_event)

        self.assertIsNone(state.snapshot_json()["error"])
        self.assertIn("poll error", stderr.getvalue())


class DashboardTest(unittest.TestCase):
    def test_rendered_page_wires_current_error_banner(self):
        page = monitor.render_page(_config())
        self.assertIn('id="banner"', page)
        self.assertIn("data.error", page)
        self.assertNotIn("data.errors", page)


if __name__ == "__main__":
    unittest.main()
