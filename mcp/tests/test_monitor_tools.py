"""Unit tests for the three Azure Monitor MCP tools.

Uses httpx.MockTransport — no network, no `az` shell-outs (token acquisition
is monkey-patched). Validates happy path, 429 retry, and 403 → structured
error envelope for each tool.
"""
from __future__ import annotations

import json
from typing import Callable
from urllib.parse import parse_qs, urlparse

import httpx
import pytest

from chaos_mcp import azure as az
from chaos_mcp import monitor


# ---------------------------------------------------------------------------
# Test plumbing
# ---------------------------------------------------------------------------


@pytest.fixture(autouse=True)
def _reset_test_transport():
    """Guarantee `azure._TEST_TRANSPORT` is cleared after every test.

    `_TEST_TRANSPORT` is module-level (process-global) state. Without this
    teardown, a test that errors before its own cleanup line would leave a
    stale MockTransport installed, silently poisoning every subsequent test
    in the session.
    """
    yield
    az._TEST_TRANSPORT = None


@pytest.fixture(autouse=True)
def _no_real_az(monkeypatch):
    """Block any real `az` call; record which token audience was requested."""
    captured: dict[str, list[str]] = {"resources": []}

    def fake_get_token(resource: str = az.ARM_ENDPOINT) -> str:
        captured["resources"].append(resource)
        return "fake-token-for-" + resource
    monkeypatch.setattr(az, "_get_token", fake_get_token)
    return captured


@pytest.fixture(autouse=True)
def _no_sleep(monkeypatch):
    """Make exponential-backoff retries instant for the test suite."""
    monkeypatch.setattr(az.time, "sleep", lambda *_a, **_kw: None)


def install_transport(monkeypatch, handler: Callable[[httpx.Request], httpx.Response]):
    transport = httpx.MockTransport(handler)
    monkeypatch.setattr(az, "_TEST_TRANSPORT", transport)
    return transport


# ---------------------------------------------------------------------------
# monitor_query_metrics
# ---------------------------------------------------------------------------


RESOURCE_ID = (
    "/subscriptions/00000000-0000-0000-0000-000000000001"
    "/resourceGroups/rg1/providers/Microsoft.Compute/virtualMachines/vm1"
)


def test_metrics_happy_path(monkeypatch, _no_real_az):
    seen: dict = {}

    def handler(req: httpx.Request) -> httpx.Response:
        seen["url"] = str(req.url)
        seen["method"] = req.method
        seen["auth"] = req.headers.get("Authorization")
        assert "/providers/Microsoft.Insights/metrics" in str(req.url)
        params = parse_qs(urlparse(str(req.url)).query)
        assert params["api-version"] == ["2024-02-01"]
        assert params["metricnames"] == ["Percentage CPU,Network In Total"]
        assert params["timespan"] == ["2026-05-29T10:00:00Z/2026-05-29T11:00:00Z"]
        assert params["aggregation"] == ["Average"]
        assert params["interval"] == ["PT1M"]
        return httpx.Response(200, json={"value": [{"name": {"value": "Percentage CPU"}}]})

    install_transport(monkeypatch, handler)
    result = monitor.monitor_query_metrics(
        resource_id=RESOURCE_ID,
        metric_names=["Percentage CPU", "Network In Total"],
        start_time="2026-05-29T10:00:00Z",
        end_time="2026-05-29T11:00:00Z",
    )
    assert result["ok"] is True
    assert result["result"]["value"][0]["name"]["value"] == "Percentage CPU"
    assert seen["method"] == "GET"
    assert seen["auth"] == f"Bearer fake-token-for-{az.ARM_ENDPOINT}"
    assert az.ARM_ENDPOINT in _no_real_az["resources"]
    assert az.LOG_ANALYTICS_ENDPOINT not in _no_real_az["resources"]


def test_metrics_429_then_success(monkeypatch):
    calls: list[int] = []

    def handler(req: httpx.Request) -> httpx.Response:
        calls.append(1)
        if len(calls) < 3:
            return httpx.Response(429, headers={"Retry-After": "0"}, json={"error": "throttled"})
        return httpx.Response(200, json={"value": []})

    install_transport(monkeypatch, handler)
    result = monitor.monitor_query_metrics(
        resource_id=RESOURCE_ID,
        metric_names=["Percentage CPU"],
        start_time="2026-05-29T10:00:00Z",
        end_time="2026-05-29T11:00:00Z",
    )
    assert result["ok"] is True
    assert len(calls) == 3


def test_metrics_403_returns_structured_error(monkeypatch):
    def handler(req: httpx.Request) -> httpx.Response:
        return httpx.Response(
            403,
            json={"error": {"code": "AuthorizationFailed", "message": "no perms"}},
        )

    install_transport(monkeypatch, handler)
    result = monitor.monitor_query_metrics(
        resource_id=RESOURCE_ID,
        metric_names=["Percentage CPU"],
        start_time="2026-05-29T10:00:00Z",
        end_time="2026-05-29T11:00:00Z",
    )
    assert result["ok"] is False
    assert result["errorType"] == "PermissionDenied"
    assert result["statusCode"] == 403
    assert result["details"]["error"]["code"] == "AuthorizationFailed"


def test_metrics_empty_metric_names_rejected(monkeypatch):
    """`metric_names=[]` must be guarded before any HTTP call is issued."""
    called: list[int] = []

    def handler(req: httpx.Request) -> httpx.Response:
        called.append(1)
        return httpx.Response(500)

    install_transport(monkeypatch, handler)
    result = monitor.monitor_query_metrics(
        resource_id=RESOURCE_ID,
        metric_names=[],
        start_time="2026-05-29T10:00:00Z",
        end_time="2026-05-29T11:00:00Z",
    )
    assert result["ok"] is False
    assert result["errorType"] == "AzureError"
    assert "metric_names" in result["error"]
    assert called == [], "no HTTP call should be made when metric_names is empty"


# ---------------------------------------------------------------------------
# monitor_query_logs
# ---------------------------------------------------------------------------


WORKSPACE_GUID = "11111111-1111-1111-1111-111111111111"


def test_logs_happy_path(monkeypatch, _no_real_az):
    seen: dict = {}

    def handler(req: httpx.Request) -> httpx.Response:
        seen["url"] = str(req.url)
        seen["method"] = req.method
        seen["auth"] = req.headers.get("Authorization")
        seen["body"] = json.loads(req.content.decode("utf-8"))
        assert str(req.url) == f"https://api.loganalytics.io/v1/workspaces/{WORKSPACE_GUID}/query"
        return httpx.Response(200, json={"tables": [{"name": "PrimaryResult", "rows": []}]})

    install_transport(monkeypatch, handler)
    result = monitor.monitor_query_logs(
        workspace_id=WORKSPACE_GUID,
        kql="Heartbeat | take 1",
        timespan="2026-05-29T10:00:00Z/2026-05-29T11:00:00Z",
    )
    assert result["ok"] is True
    assert result["result"]["tables"][0]["name"] == "PrimaryResult"
    assert seen["method"] == "POST"
    # MUST request a Log-Analytics-scoped token (audience).
    assert seen["auth"] == f"Bearer fake-token-for-{az.LOG_ANALYTICS_ENDPOINT}"
    assert az.LOG_ANALYTICS_ENDPOINT in _no_real_az["resources"]
    assert seen["body"] == {
        "query": "Heartbeat | take 1",
        "timespan": "2026-05-29T10:00:00Z/2026-05-29T11:00:00Z",
    }


def test_logs_429_then_success(monkeypatch):
    calls: list[int] = []

    def handler(req: httpx.Request) -> httpx.Response:
        calls.append(1)
        if len(calls) < 2:
            return httpx.Response(429, headers={"Retry-After": "0"})
        return httpx.Response(200, json={"tables": []})

    install_transport(monkeypatch, handler)
    result = monitor.monitor_query_logs(workspace_id=WORKSPACE_GUID, kql="Heartbeat")
    assert result["ok"] is True
    assert len(calls) == 2


def test_logs_403_structured_error(monkeypatch):
    def handler(req: httpx.Request) -> httpx.Response:
        return httpx.Response(403, json={"error": {"code": "Forbidden"}})

    install_transport(monkeypatch, handler)
    result = monitor.monitor_query_logs(workspace_id=WORKSPACE_GUID, kql="Heartbeat")
    assert result["ok"] is False
    assert result["statusCode"] == 403
    assert result["errorType"] == "PermissionDenied"


def test_logs_empty_kql_rejected(monkeypatch):
    install_transport(monkeypatch, lambda req: httpx.Response(500))
    result = monitor.monitor_query_logs(workspace_id=WORKSPACE_GUID, kql="   ")
    assert result["ok"] is False
    assert result["errorType"] == "AzureError"


# ---------------------------------------------------------------------------
# monitor_search_activity_log
# ---------------------------------------------------------------------------


SUB_ID = "22222222-2222-2222-2222-222222222222"


def test_activity_log_happy_path_with_resource(monkeypatch):
    seen: dict = {}

    def handler(req: httpx.Request) -> httpx.Response:
        seen["url"] = str(req.url)
        params = parse_qs(urlparse(str(req.url)).query)
        assert params["api-version"] == ["2015-04-01"]
        f = params["$filter"][0]
        assert "eventTimestamp ge '2026-05-29T10:00:00Z'" in f
        assert "eventTimestamp le '2026-05-29T11:00:00Z'" in f
        assert f"resourceUri eq '{RESOURCE_ID}'" in f
        # Filter property MUST be `resourceUri`, NOT `resourceId`.
        assert "resourceId eq" not in f
        return httpx.Response(
            200,
            json={"value": [{"eventName": {"value": "BeginRequest"}}, {"eventName": {"value": "EndRequest"}}]},
        )

    install_transport(monkeypatch, handler)
    result = monitor.monitor_search_activity_log(
        subscription_id=SUB_ID,
        start_time="2026-05-29T10:00:00Z",
        end_time="2026-05-29T11:00:00Z",
        resource_uri=RESOURCE_ID,
    )
    assert result["ok"] is True
    assert result["result"]["count"] == 2
    assert len(result["result"]["events"]) == 2
    assert f"/subscriptions/{SUB_ID}/" in seen["url"]


def test_activity_log_happy_path_without_resource(monkeypatch):
    def handler(req: httpx.Request) -> httpx.Response:
        params = parse_qs(urlparse(str(req.url)).query)
        f = params["$filter"][0]
        assert "resourceUri" not in f
        return httpx.Response(200, json={"value": []})

    install_transport(monkeypatch, handler)
    result = monitor.monitor_search_activity_log(
        subscription_id=SUB_ID,
        start_time="2026-05-29T10:00:00Z",
        end_time="2026-05-29T11:00:00Z",
    )
    assert result["ok"] is True
    assert result["result"]["count"] == 0


def test_activity_log_429_then_success(monkeypatch):
    calls: list[int] = []

    def handler(req: httpx.Request) -> httpx.Response:
        calls.append(1)
        if len(calls) < 4:
            return httpx.Response(503 if len(calls) == 1 else 429, headers={"Retry-After": "0"})
        return httpx.Response(200, json={"value": []})

    install_transport(monkeypatch, handler)
    result = monitor.monitor_search_activity_log(
        subscription_id=SUB_ID,
        start_time="2026-05-29T10:00:00Z",
        end_time="2026-05-29T11:00:00Z",
    )
    assert result["ok"] is True
    assert len(calls) == 4


def test_activity_log_403_structured_error(monkeypatch):
    def handler(req: httpx.Request) -> httpx.Response:
        return httpx.Response(403, json={"error": {"code": "AuthorizationFailed"}})

    install_transport(monkeypatch, handler)
    result = monitor.monitor_search_activity_log(
        subscription_id=SUB_ID,
        start_time="2026-05-29T10:00:00Z",
        end_time="2026-05-29T11:00:00Z",
    )
    assert result["ok"] is False
    assert result["errorType"] == "PermissionDenied"
    assert result["statusCode"] == 403


# ---------------------------------------------------------------------------
# Registration / server integration
# ---------------------------------------------------------------------------


def test_server_lists_thirteen_tools():
    """Importing server.py should register all 13 tools on the FastMCP instance."""
    import asyncio
    from chaos_mcp import server as srv

    tools = asyncio.run(srv.mcp.list_tools())
    names = {t.name for t in tools}
    assert "monitor_query_metrics" in names
    assert "monitor_query_logs" in names
    assert "monitor_search_activity_log" in names
    assert len(names) == 13, f"expected 13 tools, got {len(names)}: {sorted(names)}"
