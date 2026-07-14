"""Azure Monitor MCP tools: metrics, Log Analytics (KQL), and Activity Log.

Each tool returns a structured envelope instead of raising:

    {"ok": True,  "result": <payload>}
    {"ok": False, "errorType": "PermissionDenied" | "AzureError" | ...,
     "error": <message>, "statusCode": <int, when an HTTP response exists>,
     "details": <response body, when an HTTP response exists>}

Agents branch on `ok`/`errorType` rather than parsing exception text. All
HTTP goes through the shared retry helper in `chaos_mcp.azure`, which
handles 429/5xx with exponential backoff and honors Retry-After.
"""
from __future__ import annotations

from typing import Any

import httpx

from . import azure as az

METRICS_API_VERSION = "2024-02-01"
ACTIVITY_LOG_API_VERSION = "2015-04-01"


def _validation_error(message: str) -> dict[str, Any]:
    return {"ok": False, "errorType": "AzureError", "error": message}


def _envelope(resp: httpx.Response, result: Any | None = None) -> dict[str, Any]:
    """Map an HTTP response to the structured tool envelope."""
    if resp.is_success:
        body = result if result is not None else (resp.json() if resp.content else {})
        return {"ok": True, "result": body}
    try:
        details = resp.json()
    except Exception:
        details = {"raw": resp.text}
    if resp.status_code == 403:
        error_type = "PermissionDenied"
    elif resp.status_code == 401:
        error_type = "AuthenticationFailed"
    else:
        error_type = "AzureError"
    return {
        "ok": False,
        "errorType": error_type,
        "error": f"Azure request failed with HTTP {resp.status_code}",
        "statusCode": resp.status_code,
        "details": details,
    }


def monitor_query_metrics(
    resource_id: str,
    metric_names: list[str],
    start_time: str,
    end_time: str,
    aggregation: str = "Average",
    interval: str = "PT1M",
) -> dict[str, Any]:
    """Query Azure Monitor metrics for a resource over a time window.

    `start_time`/`end_time` are ISO 8601 UTC timestamps (e.g.
    2026-05-29T10:00:00Z); they form the request `timespan`.
    """
    if not metric_names:
        return _validation_error("metric_names must contain at least one metric name.")
    try:
        resp = az.arm_get_with_query(
            f"{resource_id}/providers/Microsoft.Insights/metrics",
            {
                "metricnames": ",".join(metric_names),
                "timespan": f"{start_time}/{end_time}",
                "aggregation": aggregation,
                "interval": interval,
            },
            api_version=METRICS_API_VERSION,
        )
    except az.AzureError as e:
        return _validation_error(str(e))
    return _envelope(resp)


def monitor_query_logs(
    workspace_id: str,
    kql: str,
    timespan: str | None = None,
) -> dict[str, Any]:
    """Run a KQL query against a Log Analytics workspace (by workspace GUID).

    `timespan` is an optional ISO 8601 interval (start/end) that bounds the
    query server-side; omit it to let the query's own time filters apply.
    """
    if not kql or not kql.strip():
        return _validation_error("kql must be a non-empty query string.")
    body: dict[str, Any] = {"query": kql}
    if timespan is not None:
        body["timespan"] = timespan
    try:
        resp = az.loganalytics_post(workspace_id, body)
    except az.AzureError as e:
        return _validation_error(str(e))
    return _envelope(resp)


def monitor_search_activity_log(
    subscription_id: str,
    start_time: str,
    end_time: str,
    resource_uri: str | None = None,
) -> dict[str, Any]:
    """Search the Azure Activity Log for management events in a time window.

    When `resource_uri` is provided the search is scoped to that resource.
    The Activity Log filter property is `resourceUri` (not `resourceId`).
    """
    odata_filter = (
        f"eventTimestamp ge '{start_time}' and eventTimestamp le '{end_time}'"
    )
    if resource_uri:
        odata_filter += f" and resourceUri eq '{resource_uri}'"
    try:
        resp = az.arm_get_with_query(
            f"/subscriptions/{subscription_id}/providers/Microsoft.Insights/eventtypes/management/values",
            {"$filter": odata_filter},
            api_version=ACTIVITY_LOG_API_VERSION,
        )
    except az.AzureError as e:
        return _validation_error(str(e))
    if not resp.is_success:
        return _envelope(resp)
    events = (resp.json() if resp.content else {}).get("value", [])
    return _envelope(resp, result={"count": len(events), "events": events})
