#!/usr/bin/env python3
"""Live browser dashboard for the AKS zone-down demo.

Python standard library only -- no pip install, so it works unmodified in a
fresh Azure Cloud Shell or any machine with `python3` and `kubectl` on PATH.

Two modes:

  serve (default)  Poll the storefront and the cluster on an interval and
                    serve a self-refreshing HTML dashboard. This is the
                    primary presentation surface during a live run: it shows
                    customer-facing HTTP health next to Kubernetes node/pod
                    state so the audience can see that the storefront can
                    fail *before* the node shows NotReady -- HTTP failure is
                    the real customer signal, node status just explains why.

  verify            One-shot (with retry/timeout) check that every cluster
                    zone has at least one Ready store-front replica. Used by
                    verify-fix.sh to block Run 2 until the fix has actually
                    taken effect, including waiting out rolling-update
                    stragglers from the old single-replica revision.

Usage:
    python3 monitor.py --storefront-url http://<ip> --target-zone eastus2-1
    python3 monitor.py --mode verify --timeout 300

Config can also come from environment variables (STOREFRONT_URL,
TARGET_ZONE, MONITOR_INTERVAL_SECONDS, MONITOR_PORT, MONITOR_NAMESPACE,
MONITOR_LABEL_SELECTOR, MONITOR_HTTP_TIMEOUT_SECONDS) so it can be launched
without remembering flags mid-demo.
"""
from __future__ import annotations

import argparse
import html
import json
import os
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any, Optional

ZONE_LABEL = "topology.kubernetes.io/zone"

# Override the five-second demo cadence with MONITOR_INTERVAL_SECONDS or
# --interval when needed.
DEFAULT_INTERVAL_SECONDS = 5.0
DEFAULT_HTTP_TIMEOUT_SECONDS = 3.0
DEFAULT_PORT = 8787
DEFAULT_NAMESPACE = "default"
DEFAULT_LABEL_SELECTOR = "app=store-front"
DEFAULT_VERIFY_TIMEOUT_SECONDS = 300


# --------------------------------------------------------------------------
# Pure parsing/state functions -- no subprocess or network calls. These are
# what tests/test_monitor.py exercises directly with fixture JSON, so the
# demo's state logic is deterministic and verifiable without a live cluster.
# --------------------------------------------------------------------------


def get_pod_ready(pod: dict) -> bool:
    """Return True if a pod's status.conditions report Ready=True."""
    for cond in (pod.get("status", {}) or {}).get("conditions", []) or []:
        if cond.get("type") == "Ready":
            return cond.get("status") == "True"
    return False


def get_node_ready_state(node: dict) -> str:
    """Return "Ready", "NotReady", or "Unknown" for a node object."""
    for cond in (node.get("status", {}) or {}).get("conditions", []) or []:
        if cond.get("type") == "Ready":
            status = cond.get("status")
            if status == "True":
                return "Ready"
            if status == "False":
                return "NotReady"
            return "Unknown"
    return "Unknown"


def build_node_zone_map(nodes_list_obj: dict, zone_label: str = ZONE_LABEL) -> dict:
    """Map node name -> zone label value from `kubectl get nodes -o json`."""
    mapping: dict[str, Optional[str]] = {}
    for node in nodes_list_obj.get("items", []) or []:
        name = (node.get("metadata", {}) or {}).get("name")
        zone = (node.get("metadata", {}) or {}).get("labels", {}).get(zone_label)
        if name:
            mapping[name] = zone
    return mapping


def parse_frontend_pods(pods_list_obj: dict, node_zone_map: dict) -> list[dict]:
    """Turn `kubectl get pods -o json` into [{name, node, zone, ready, phase}]."""
    pods = []
    for pod in pods_list_obj.get("items", []) or []:
        name = (pod.get("metadata", {}) or {}).get("name")
        node_name = (pod.get("spec", {}) or {}).get("nodeName")
        zone = node_zone_map.get(node_name) if node_name else None
        pods.append(
            {
                "name": name,
                "node": node_name,
                "zone": zone,
                "ready": get_pod_ready(pod),
                "phase": (pod.get("status", {}) or {}).get("phase"),
            }
        )
    return pods


def zones_with_ready_replica(pods: list[dict]) -> set:
    """Zones that currently have at least one Ready store-front replica."""
    return {p["zone"] for p in pods if p.get("ready") and p.get("zone")}


def cache_busting_url(base_url: str, ts: float) -> str:
    """Append a timestamp query param so intermediate caches can't serve a
    stale response for the customer-facing HTTP check."""
    separator = "&" if "?" in base_url else "?"
    return f"{base_url}{separator}_cb={int(ts * 1000)}"


def classify_transition(prev: Optional[dict], curr: dict) -> Optional[str]:
    """Describe what changed between two state snapshots, or None if nothing
    did. Snapshots are dicts with http_ok (bool), node_state (str), and
    zones (a frozenset of zone names with a Ready replica)."""
    if prev is None:
        zones_desc = ", ".join(sorted(curr["zones"])) or "none"
        reachability = "reachable" if curr["http_ok"] else "UNREACHABLE"
        return (
            f"monitoring started: storefront {reachability}, "
            f"target node {curr['node_state']}, zones covered: {zones_desc}"
        )

    messages = []
    if prev["http_ok"] != curr["http_ok"]:
        messages.append(
            "storefront became UNREACHABLE"
            if not curr["http_ok"]
            else "storefront became reachable again"
        )
    if prev["node_state"] != curr["node_state"]:
        messages.append(f"target node {prev['node_state']} -> {curr['node_state']}")
    if prev["zones"] != curr["zones"]:
        prev_desc = ", ".join(sorted(prev["zones"])) or "none"
        curr_desc = ", ".join(sorted(curr["zones"])) or "none"
        messages.append(f"zone coverage {prev_desc} -> {curr_desc}")
    return "; ".join(messages) if messages else None


# --------------------------------------------------------------------------
# I/O: kubectl and HTTP calls.
# --------------------------------------------------------------------------


def kubectl_json(args: list[str], timeout: float = 10.0) -> dict:
    """Run kubectl with -o json and return the parsed object. Raises
    RuntimeError with kubectl's stderr on failure."""
    proc = subprocess.run(
        ["kubectl", *args, "-o", "json"],
        capture_output=True,
        text=True,
        timeout=timeout,
    )
    if proc.returncode != 0:
        raise RuntimeError(proc.stderr.strip() or f"kubectl {' '.join(args)} failed")
    return json.loads(proc.stdout)


def check_storefront(url: str, timeout: float) -> tuple[bool, str]:
    """GET the storefront with cache-busting/no-cache semantics. Returns
    (ok, detail) where detail is the HTTP status or an error message."""
    request = urllib.request.Request(
        cache_busting_url(url, time.time()),
        headers={"Cache-Control": "no-cache", "Pragma": "no-cache"},
    )
    try:
        with urllib.request.urlopen(request, timeout=timeout) as resp:
            status = resp.status
            return status == 200, f"HTTP {status}"
    except urllib.error.HTTPError as e:
        return False, f"HTTP {e.code}"
    except (urllib.error.URLError, TimeoutError, OSError) as e:
        return False, f"error: {e.reason if hasattr(e, 'reason') else e}"


def discover_zones(nodes_obj: dict, zone_label: str = ZONE_LABEL) -> list[str]:
    """Return the distinct zone labels in an all-nodes response."""
    zones = {
        (n.get("metadata", {}) or {}).get("labels", {}).get(zone_label)
        for n in nodes_obj.get("items", []) or []
    }
    return sorted(z for z in zones if z)


# --------------------------------------------------------------------------
# verify mode
# --------------------------------------------------------------------------


def verify_zone_coverage(
    label_selector: str,
    namespace: str,
    timeout_seconds: float,
    poll_seconds: float = 5.0,
) -> bool:
    """Block until every zone has >=1 Ready store-front replica, or fail
    after timeout_seconds. Re-reads pods/nodes each iteration so it naturally
    rides out rolling-update stragglers from the prior single-replica
    revision -- pods that are still Terminating just won't count as Ready."""
    deadline = time.monotonic() + timeout_seconds
    while True:
        stamp = time.strftime("%H:%M:%S")
        try:
            nodes_obj = kubectl_json(["get", "nodes"])
            zones = discover_zones(nodes_obj)
            if not zones:
                raise RuntimeError("could not discover any zones from node labels")
            node_zone_map = build_node_zone_map(nodes_obj)
            pods_obj = kubectl_json(["get", "pods", "-l", label_selector, "-n", namespace])
            pods = parse_frontend_pods(pods_obj, node_zone_map)
        except (RuntimeError, subprocess.SubprocessError, json.JSONDecodeError, OSError) as e:
            # A transient kubectl/API/JSON failure (e.g. a momentary API
            # server blip) must not abort the check -- retry until the
            # deadline, same as any other "not yet satisfied" iteration, and
            # only fail loudly once the timeout is actually exhausted.
            print(f"[{stamp}] transient error, retrying: {e}", file=sys.stderr)
            if time.monotonic() >= deadline:
                print(
                    f"FAIL after {timeout_seconds:.0f}s: kubectl/API kept failing: {e}",
                    file=sys.stderr,
                )
                return False
            time.sleep(poll_seconds)
            continue

        covered = zones_with_ready_replica(pods)
        missing = [z for z in zones if z not in covered]
        ready_total = sum(1 for p in pods if p["ready"])
        print(
            f"[{stamp}] ready replicas={ready_total} "
            f"zones covered={sorted(covered)} missing={missing}"
        )
        if not missing:
            print(f"PASS: every zone ({', '.join(zones)}) has a Ready store-front replica.")
            return True
        if time.monotonic() >= deadline:
            print(
                f"FAIL after {timeout_seconds:.0f}s: no Ready store-front replica in "
                f"zone(s) {', '.join(missing)}.",
                file=sys.stderr,
            )
            print(
                "Do not start Run 2 until this passes. Check that the topology spread "
                "constraint uses whenUnsatisfiable=DoNotSchedule and that each zone has "
                "spare node capacity for a replica.",
                file=sys.stderr,
            )
            return False
        time.sleep(poll_seconds)


# --------------------------------------------------------------------------
# serve mode: background poller + HTTP dashboard
# --------------------------------------------------------------------------


class MonitorState:
    def __init__(self, config: "Config"):
        self.config = config
        self.lock = threading.Lock()
        self.last_snapshot: Optional[dict] = None
        self.history: list[dict] = []
        self.samples = 0
        self.error: Optional[str] = None

    def record(self, curr: dict) -> None:
        with self.lock:
            message = classify_transition(self.last_snapshot, curr)
            if message:
                self.history.append({"ts": curr["ts"], "message": message})
            self.last_snapshot = curr
            self.samples += 1
            self.error = None

    def record_error(self, message: str) -> None:
        with self.lock:
            self.error = message

    def snapshot_json(self) -> dict:
        with self.lock:
            snap = dict(self.last_snapshot) if self.last_snapshot else None
            if snap is not None:
                snap["zones"] = sorted(snap["zones"])
                snap["pods"] = list(snap.get("pods", []))
            return {
                "config": {
                    "storefront_url": self.config.storefront_url,
                    "target_zone": self.config.target_zone,
                    "interval_seconds": self.config.interval,
                },
                "current": snap,
                "history": list(self.history),
                "samples": self.samples,
                "error": self.error,
            }


class Config:
    def __init__(self, args: argparse.Namespace):
        self.storefront_url = args.storefront_url
        self.target_zone = args.target_zone
        self.label_selector = args.label_selector
        self.namespace = args.namespace
        self.interval = args.interval
        self.http_timeout = args.http_timeout
        self.port = args.port


def poll_once(config: Config) -> dict:
    http_ok, http_detail = check_storefront(config.storefront_url, config.http_timeout)

    node_state = "Unknown"
    zones: set = set()
    pods: list[dict] = []
    try:
        nodes_obj = kubectl_json(["get", "nodes"])
        node_zone_map = build_node_zone_map(nodes_obj)
        target_states = [
            get_node_ready_state(node)
            for node in nodes_obj.get("items", []) or []
            if (node.get("metadata", {}) or {}).get("labels", {}).get(ZONE_LABEL) == config.target_zone
        ]
        if "Ready" in target_states:
            node_state = "Ready"
        elif "NotReady" in target_states:
            node_state = "NotReady"
        pods_obj = kubectl_json(["get", "pods", "-l", config.label_selector, "-n", config.namespace])
        pods = parse_frontend_pods(pods_obj, node_zone_map)
        zones = zones_with_ready_replica(pods)
    except (RuntimeError, subprocess.SubprocessError, json.JSONDecodeError, OSError) as e:
        raise RuntimeError(f"kubectl error: {e}") from e

    return {
        "ts": time.time(),
        "http_ok": http_ok,
        "http_detail": http_detail,
        "node_state": node_state,
        "zones": frozenset(zones),
        "pods": pods,
        "replica_count": sum(1 for p in pods if p["ready"]),
    }


def poll_loop(state: MonitorState, stop_event: threading.Event) -> None:
    while not stop_event.is_set():
        try:
            curr = poll_once(state.config)
            state.record(curr)
        except RuntimeError as e:
            # Surface it in the terminal immediately (e.g. a stale/missing
            # kubeconfig) and keep it in state so the dashboard shows a
            # visible banner instead of sitting on "checking..." forever.
            message = str(e)
            print(f"[monitor] poll error: {message}", file=sys.stderr)
            state.record_error(message)
        stop_event.wait(state.config.interval)


PAGE_TEMPLATE = """<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>AKS zone-down demo monitor</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
  body {{ font-family: -apple-system, Segoe UI, Roboto, sans-serif; margin: 0; padding: 1.5rem; background: #0b0f14; color: #e6edf3; }}
  h1 {{ font-size: 1.3rem; margin: 0 0 1rem; }}
  .sub {{ color: #8b949e; font-size: 0.85rem; margin-bottom: 1.25rem; }}
  .cards {{ display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 1rem; margin-bottom: 1.5rem; }}
  .card {{ border-radius: 10px; padding: 1rem 1.25rem; background: #161b22; border: 1px solid #30363d; }}
  .card .label {{ font-size: 0.8rem; color: #8b949e; text-transform: uppercase; letter-spacing: 0.04em; }}
  .card .value {{ font-size: 1.6rem; font-weight: 600; margin-top: 0.25rem; }}
  .ok {{ color: #3fb950; }}
  .bad {{ color: #f85149; }}
  .unknown {{ color: #d29922; }}
  table {{ width: 100%; border-collapse: collapse; font-size: 0.9rem; }}
  th, td {{ text-align: left; padding: 0.4rem 0.6rem; border-bottom: 1px solid #30363d; }}
  th {{ color: #8b949e; font-weight: 600; }}
  .history {{ max-height: 40vh; overflow-y: auto; }}
  .stale {{ outline: 3px solid #f85149; }}
  .banner {{ display: none; border-radius: 8px; padding: 0.75rem 1rem; margin-bottom: 1.25rem; background: #3b1d1d; border: 1px solid #f85149; color: #ffd7d5; font-size: 0.9rem; }}
  .banner.show {{ display: block; }}
</style>
</head>
<body>
  <h1>AKS zone-down demo &mdash; live monitor</h1>
  <div class="sub" id="sub">storefront: {storefront_url} &middot; target zone: {target_zone} &middot; polling every {interval}s</div>

  <div class="banner" id="banner"></div>

  <div class="cards">
    <div class="card"><div class="label">Storefront</div><div class="value unknown" id="http">checking&hellip;</div></div>
    <div class="card"><div class="label">Target zone node</div><div class="value unknown" id="node">checking&hellip;</div></div>
    <div class="card"><div class="label">Ready front-end replicas</div><div class="value unknown" id="replicas">&mdash;</div></div>
    <div class="card"><div class="label">Zones covered</div><div class="value unknown" id="zones">&mdash;</div></div>
  </div>

  <h2>Front-end pods</h2>
  <table id="pods"><thead><tr><th>Pod</th><th>Zone</th><th>Ready</th><th>Phase</th></tr></thead><tbody></tbody></table>

  <h2>Timeline</h2>
  <div class="history">
    <table id="history"><thead><tr><th>Time</th><th>Event</th></tr></thead><tbody></tbody></table>
  </div>

<script>
const intervalMs = {interval_ms};

function setCard(id, text, cls) {{
  const el = document.getElementById(id);
  el.textContent = text;
  el.className = 'value ' + cls;
}}

async function refresh() {{
  const body = document.body;
  try {{
    const res = await fetch('/api/state?_=' + Date.now(), {{ cache: 'no-store' }});
    const data = await res.json();
    body.classList.remove('stale');

    const banner = document.getElementById('banner');
    if (data.error) {{
      banner.textContent = 'Poller error (kubectl/kubeconfig likely stale or the API server is unreachable): ' +
        data.error;
      banner.classList.add('show');
    }} else {{
      banner.classList.remove('show');
    }}

    const cur = data.current;
    if (!cur) {{
      setCard('http', 'waiting for first sample', 'unknown');
      setCard('node', 'waiting', 'unknown');
      setCard('replicas', '-', 'unknown');
      setCard('zones', '-', 'unknown');
      return;
    }}
    setCard('http', cur.http_ok ? 'REACHABLE' : 'UNREACHABLE', cur.http_ok ? 'ok' : 'bad');
    setCard('node', cur.node_state, cur.node_state === 'Ready' ? 'ok' : (cur.node_state === 'NotReady' ? 'bad' : 'unknown'));
    setCard('replicas', String(cur.replica_count), 'ok');
    setCard('zones', cur.zones.length + ' (' + cur.zones.join(', ') + ')', 'ok');

    const podsBody = document.querySelector('#pods tbody');
    podsBody.innerHTML = '';
    for (const p of cur.pods) {{
      const tr = document.createElement('tr');
      tr.innerHTML = '<td>' + p.name + '</td><td>' + (p.zone || '?') + '</td><td>' +
        (p.ready ? 'Ready' : 'not ready') + '</td><td>' + p.phase + '</td>';
      podsBody.appendChild(tr);
    }}

    const histBody = document.querySelector('#history tbody');
    histBody.innerHTML = '';
    for (const h of data.history.slice().reverse()) {{
      const tr = document.createElement('tr');
      const t = new Date(h.ts * 1000).toLocaleTimeString();
      tr.innerHTML = '<td>' + t + '</td><td>' + h.message + '</td>';
      histBody.appendChild(tr);
    }}
  }} catch (e) {{
    body.classList.add('stale');
  }}
}}

refresh();
setInterval(refresh, intervalMs);
</script>
</body>
</html>
"""


def render_page(config: Config) -> str:
    return PAGE_TEMPLATE.format(
        storefront_url=html.escape(config.storefront_url),
        target_zone=html.escape(config.target_zone),
        interval=config.interval,
        interval_ms=int(config.interval * 1000),
    )


def make_handler(state: MonitorState) -> type:
    class Handler(BaseHTTPRequestHandler):
        def _send(self, status: int, content_type: str, body: bytes) -> None:
            self.send_response(status)
            self.send_header("Content-Type", content_type)
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(body)

        def do_GET(self) -> None:  # noqa: N802 - required BaseHTTPRequestHandler name
            if self.path.startswith("/api/state"):
                body = json.dumps(state.snapshot_json()).encode("utf-8")
                self._send(200, "application/json", body)
            elif self.path == "/" or self.path.startswith("/?"):
                body = render_page(state.config).encode("utf-8")
                self._send(200, "text/html; charset=utf-8", body)
            else:
                self._send(404, "text/plain", b"not found")

        def log_message(self, format: str, *args: Any) -> None:  # noqa: A002
            pass  # keep the console clean during a live demo

    return Handler


def serve(config: Config) -> None:
    state = MonitorState(config)
    stop_event = threading.Event()
    poller = threading.Thread(target=poll_loop, args=(state, stop_event), daemon=True)
    poller.start()

    handler = make_handler(state)
    server = ThreadingHTTPServer(("0.0.0.0", config.port), handler)
    print(f"Dashboard: http://localhost:{config.port}  (Ctrl+C to stop)")
    print(f"Polling {config.storefront_url} and zone {config.target_zone} every {config.interval}s")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        stop_event.set()
        server.shutdown()


# --------------------------------------------------------------------------
# CLI
# --------------------------------------------------------------------------


def parse_args(argv: Optional[list[str]] = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--mode", choices=["serve", "verify"], default="serve")
    parser.add_argument("--storefront-url", default=os.environ.get("STOREFRONT_URL"))
    parser.add_argument("--target-zone", default=os.environ.get("TARGET_ZONE"))
    parser.add_argument("--label-selector", default=os.environ.get("MONITOR_LABEL_SELECTOR", DEFAULT_LABEL_SELECTOR))
    parser.add_argument("--namespace", default=os.environ.get("MONITOR_NAMESPACE", DEFAULT_NAMESPACE))
    parser.add_argument(
        "--interval",
        type=float,
        default=float(os.environ.get("MONITOR_INTERVAL_SECONDS", DEFAULT_INTERVAL_SECONDS)),
    )
    parser.add_argument(
        "--http-timeout",
        type=float,
        default=float(os.environ.get("MONITOR_HTTP_TIMEOUT_SECONDS", DEFAULT_HTTP_TIMEOUT_SECONDS)),
    )
    parser.add_argument("--port", type=int, default=int(os.environ.get("MONITOR_PORT", DEFAULT_PORT)))
    parser.add_argument(
        "--timeout",
        type=float,
        default=float(os.environ.get("MONITOR_VERIFY_TIMEOUT_SECONDS", DEFAULT_VERIFY_TIMEOUT_SECONDS)),
        help="verify mode: seconds to wait for zone coverage before failing",
    )
    args = parser.parse_args(argv)
    if args.mode == "serve" and not args.storefront_url:
        parser.error("--storefront-url (or STOREFRONT_URL) is required for --mode serve")
    if args.mode == "serve" and not args.target_zone:
        parser.error("--target-zone (or TARGET_ZONE) is required for --mode serve")
    return args


def main(argv: Optional[list[str]] = None) -> int:
    args = parse_args(argv)
    if args.mode == "verify":
        ok = verify_zone_coverage(args.label_selector, args.namespace, args.timeout)
        return 0 if ok else 1

    serve(Config(args))
    return 0


if __name__ == "__main__":
    sys.exit(main())
