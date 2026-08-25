"""Unit tests for monitor.py's deterministic state-parsing logic.

Stdlib-only (unittest), no kubectl/network required -- these exercise the
pure functions with fixture JSON shaped like real `kubectl ... -o json`
output. Run with:

    python3 -m unittest discover -s tests -v

from the samples/aks-zone-down-demo/ directory, or as part of a repo-wide
`python3 -m unittest discover` if a future CI job adopts one.
"""
from __future__ import annotations

import pathlib
import py_compile
import sys
import unittest

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


class MonitorModuleSyntaxTest(unittest.TestCase):
    def test_compiles(self):
        monitor_path = pathlib.Path(monitor.__file__)
        py_compile.compile(str(monitor_path), doraise=True)


class PodReadyTest(unittest.TestCase):
    def test_ready_true(self):
        self.assertTrue(monitor.get_pod_ready(_pod("p1", "n1", True)))

    def test_ready_false(self):
        self.assertFalse(monitor.get_pod_ready(_pod("p1", "n1", False)))

    def test_missing_conditions(self):
        self.assertFalse(monitor.get_pod_ready({"status": {}}))

    def test_missing_status(self):
        self.assertFalse(monitor.get_pod_ready({}))


class NodeReadyStateTest(unittest.TestCase):
    def test_ready(self):
        self.assertEqual(monitor.get_node_ready_state(_node("n1", "z1", "True")), "Ready")

    def test_not_ready(self):
        self.assertEqual(monitor.get_node_ready_state(_node("n1", "z1", "False")), "NotReady")

    def test_unknown_status(self):
        self.assertEqual(monitor.get_node_ready_state(_node("n1", "z1", "Unknown")), "Unknown")

    def test_no_conditions_is_unknown(self):
        self.assertEqual(monitor.get_node_ready_state({"status": {}}), "Unknown")


class BuildNodeZoneMapTest(unittest.TestCase):
    def test_maps_names_to_zones(self):
        nodes_obj = {
            "items": [
                _node("n1", "eastus2-1"),
                _node("n2", "eastus2-2"),
                _node("n3", "eastus2-3"),
            ]
        }
        self.assertEqual(
            monitor.build_node_zone_map(nodes_obj),
            {"n1": "eastus2-1", "n2": "eastus2-2", "n3": "eastus2-3"},
        )

    def test_empty_items(self):
        self.assertEqual(monitor.build_node_zone_map({"items": []}), {})

    def test_missing_items_key(self):
        self.assertEqual(monitor.build_node_zone_map({}), {})


class ParseFrontendPodsTest(unittest.TestCase):
    def test_parses_zone_and_ready(self):
        node_zone_map = {"n1": "eastus2-1", "n2": "eastus2-2"}
        pods_obj = {
            "items": [
                _pod("store-front-a", "n1", True),
                _pod("store-front-b", "n2", False, phase="Pending"),
            ]
        }
        result = monitor.parse_frontend_pods(pods_obj, node_zone_map)
        self.assertEqual(
            result,
            [
                {"name": "store-front-a", "node": "n1", "zone": "eastus2-1", "ready": True, "phase": "Running"},
                {"name": "store-front-b", "node": "n2", "zone": "eastus2-2", "ready": False, "phase": "Pending"},
            ],
        )

    def test_unknown_node_gives_none_zone(self):
        result = monitor.parse_frontend_pods({"items": [_pod("p1", "unmapped-node", True)]}, {})
        self.assertIsNone(result[0]["zone"])


class ZonesWithReadyReplicaTest(unittest.TestCase):
    def test_only_ready_zones_count(self):
        pods = [
            {"zone": "z1", "ready": True},
            {"zone": "z2", "ready": False},
            {"zone": "z3", "ready": True},
        ]
        self.assertEqual(monitor.zones_with_ready_replica(pods), {"z1", "z3"})

    def test_no_zone_is_excluded(self):
        pods = [{"zone": None, "ready": True}]
        self.assertEqual(monitor.zones_with_ready_replica(pods), set())


class CacheBustingUrlTest(unittest.TestCase):
    def test_appends_with_question_mark_when_no_query(self):
        url = monitor.cache_busting_url("http://example.com", 1.5)
        self.assertEqual(url, "http://example.com?_cb=1500")

    def test_appends_with_ampersand_when_query_present(self):
        url = monitor.cache_busting_url("http://example.com?a=1", 2.0)
        self.assertEqual(url, "http://example.com?a=1&_cb=2000")


class ClassifyTransitionTest(unittest.TestCase):
    def _snap(self, http_ok, node_state, zones):
        return {"http_ok": http_ok, "node_state": node_state, "zones": frozenset(zones)}

    def test_initial_snapshot_produces_message(self):
        msg = monitor.classify_transition(None, self._snap(True, "Ready", {"z1", "z2"}))
        self.assertIn("monitoring started", msg)
        self.assertIn("reachable", msg)

    def test_no_change_returns_none(self):
        snap = self._snap(True, "Ready", {"z1"})
        self.assertIsNone(monitor.classify_transition(snap, dict(snap)))

    def test_http_flip_to_unreachable(self):
        prev = self._snap(True, "Ready", {"z1"})
        curr = self._snap(False, "Ready", {"z1"})
        msg = monitor.classify_transition(prev, curr)
        self.assertIn("UNREACHABLE", msg)

    def test_http_flip_to_reachable(self):
        prev = self._snap(False, "Ready", {"z1"})
        curr = self._snap(True, "Ready", {"z1"})
        msg = monitor.classify_transition(prev, curr)
        self.assertIn("reachable again", msg)

    def test_node_state_change(self):
        prev = self._snap(True, "Ready", {"z1"})
        curr = self._snap(True, "NotReady", {"z1"})
        msg = monitor.classify_transition(prev, curr)
        self.assertIn("Ready -> NotReady", msg)

    def test_zone_coverage_change(self):
        prev = self._snap(True, "Ready", {"z1"})
        curr = self._snap(True, "Ready", {"z1", "z2"})
        msg = monitor.classify_transition(prev, curr)
        self.assertIn("zone coverage", msg)

    def test_multiple_changes_are_combined(self):
        prev = self._snap(True, "Ready", {"z1", "z2"})
        curr = self._snap(False, "NotReady", {"z2"})
        msg = monitor.classify_transition(prev, curr)
        self.assertIn("UNREACHABLE", msg)
        self.assertIn("Ready -> NotReady", msg)
        self.assertIn("zone coverage", msg)


class VerifyZoneCoverageTest(unittest.TestCase):
    """verify_zone_coverage() calls kubectl_json(); patch it to test the
    polling/timeout logic deterministically without a real cluster."""

    def test_passes_immediately_when_all_zones_covered(self):
        calls = {"n": 0}

        def fake_kubectl_json(args, timeout=10.0):
            calls["n"] += 1
            if args[:2] == ["get", "nodes"]:
                return {"items": [_node("n1", "z1"), _node("n2", "z2")]}
            return {
                "items": [
                    _pod("store-front-a", "n1", True),
                    _pod("store-front-b", "n2", True),
                ]
            }

        original = monitor.kubectl_json
        monitor.kubectl_json = fake_kubectl_json
        try:
            ok = monitor.verify_zone_coverage("app=store-front", "default", ["z1", "z2"], timeout_seconds=5)
        finally:
            monitor.kubectl_json = original
        self.assertTrue(ok)
        self.assertEqual(calls["n"], 2)

    def test_fails_after_timeout_when_zone_missing(self):
        def fake_kubectl_json(args, timeout=10.0):
            if args[:2] == ["get", "nodes"]:
                return {"items": [_node("n1", "z1"), _node("n2", "z2")]}
            return {"items": [_pod("store-front-a", "n1", True)]}  # z2 never ready

        original = monitor.kubectl_json
        monitor.kubectl_json = fake_kubectl_json
        try:
            ok = monitor.verify_zone_coverage(
                "app=store-front", "default", ["z1", "z2"], timeout_seconds=0.2, poll_seconds=0.05
            )
        finally:
            monitor.kubectl_json = original
        self.assertFalse(ok)


if __name__ == "__main__":
    unittest.main()
