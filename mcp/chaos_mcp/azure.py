"""Thin wrappers around `az` CLI + ARM REST calls.

The MCP server intentionally relies on the user's local `az` session for auth
rather than managing tokens itself. This matches the skill's auth model and
keeps the server stateless.
"""
from __future__ import annotations

import json
import shutil
import subprocess
import time
from dataclasses import dataclass
from typing import Any, Mapping

import httpx

ARM_ENDPOINT = "https://management.azure.com"
LOG_ANALYTICS_ENDPOINT = "https://api.loganalytics.io"
DEFAULT_API_VERSION = "2026-05-01-preview"
DEFAULT_LRO_TIMEOUT_S = 30 * 60
DEFAULT_LRO_INTERVAL_S = 5

# Test-only hook: when set, all new monitor helpers route through this transport.
# Production callers leave it None; pytest sets it to an httpx.MockTransport.
_TEST_TRANSPORT: Any = None


class AzureError(RuntimeError):
    """Raised when an ARM call or `az` invocation fails."""


@dataclass
class AzContext:
    subscription_id: str
    tenant_id: str
    user_name: str


def _az_path() -> str:
    path = shutil.which("az")
    if not path:
        raise AzureError("Azure CLI (`az`) not found on PATH. Install it from https://aka.ms/azcli.")
    return path


def az_show_account() -> AzContext:
    """Return the current `az` session context or raise if not signed in."""
    proc = subprocess.run(
        [_az_path(), "account", "show", "-o", "json"],
        capture_output=True,
        text=True,
    )
    if proc.returncode != 0:
        raise AzureError(
            "No active Azure CLI session. Run `az login` (or `az login --use-device-code` in a "
            "headless environment) and retry."
        )
    data = json.loads(proc.stdout)
    return AzContext(
        subscription_id=data["id"],
        tenant_id=data["tenantId"],
        user_name=data.get("user", {}).get("name", "unknown"),
    )


def _get_token(resource: str = ARM_ENDPOINT) -> str:
    """Acquire an access token for the given audience via the local `az` session.

    `resource` is the token audience URL (e.g., `https://management.azure.com`
    for ARM or `https://api.loganalytics.io` for Log Analytics queries).
    Tokens are not cached — each call invokes `az account get-access-token`.
    """
    proc = subprocess.run(
        [_az_path(), "account", "get-access-token", "--resource", resource, "-o", "json"],
        capture_output=True,
        text=True,
    )
    if proc.returncode != 0:
        raise AzureError(
            f"Failed to acquire access token for {resource}: {proc.stderr.strip()}"
        )
    return json.loads(proc.stdout)["accessToken"]


def az_get_arm_token() -> str:
    """Back-compat shim — acquire a token scoped to ARM."""
    return _get_token(ARM_ENDPOINT)


def arm_request(
    method: str,
    path: str,
    *,
    api_version: str = DEFAULT_API_VERSION,
    body: Mapping[str, Any] | None = None,
    extra_headers: Mapping[str, str] | None = None,
    timeout: float = 60.0,
) -> httpx.Response:
    """Issue an ARM REST call using the local `az` session for bearer auth.

    `path` may be an absolute ARM URL or a path beginning with '/'.
    """
    if path.startswith("http://") or path.startswith("https://"):
        url = path
    else:
        if not path.startswith("/"):
            path = "/" + path
        sep = "&" if "?" in path else "?"
        url = f"{ARM_ENDPOINT}{path}{sep}api-version={api_version}"

    headers = {
        "Authorization": f"Bearer {az_get_arm_token()}",
        "Content-Type": "application/json",
        "Accept": "application/json",
    }
    if extra_headers:
        headers.update(extra_headers)

    resp = httpx.request(
        method,
        url,
        headers=headers,
        json=body if body is not None else None,
        timeout=timeout,
    )
    return resp


def _raise_for_arm(resp: httpx.Response) -> None:
    if resp.is_success or resp.status_code in (202,):
        return
    try:
        payload = resp.json()
    except Exception:
        payload = {"raw": resp.text}
    raise AzureError(f"ARM {resp.status_code} {resp.request.method} {resp.request.url}: {json.dumps(payload)}")


def arm_get(path: str, **kw) -> dict:
    resp = arm_request("GET", path, **kw)
    _raise_for_arm(resp)
    return resp.json() if resp.content else {}


def arm_put(path: str, body: Mapping[str, Any], **kw) -> httpx.Response:
    resp = arm_request("PUT", path, body=body, **kw)
    _raise_for_arm(resp)
    return resp


def arm_post(path: str, body: Mapping[str, Any] | None = None, **kw) -> httpx.Response:
    resp = arm_request("POST", path, body=body, **kw)
    _raise_for_arm(resp)
    return resp


def wait_for_lro(
    response: httpx.Response,
    *,
    timeout_s: int = DEFAULT_LRO_TIMEOUT_S,
    interval_s: int = DEFAULT_LRO_INTERVAL_S,
) -> dict:
    """Poll an Azure LRO via Azure-AsyncOperation or Location header until terminal.

    Returns the final body (best-effort) as a dict, or {} when none.
    """
    if response.status_code != 202 and response.is_success:
        try:
            return response.json() if response.content else {}
        except Exception:
            return {}

    poll_url = (
        response.headers.get("Azure-AsyncOperation")
        or response.headers.get("azure-asyncoperation")
        or response.headers.get("Location")
        or response.headers.get("location")
    )
    if not poll_url:
        raise AzureError("LRO response missing Azure-AsyncOperation / Location header.")

    deadline = time.monotonic() + timeout_s
    last_body: dict = {}
    while time.monotonic() < deadline:
        retry_after = int(response.headers.get("Retry-After") or interval_s)
        time.sleep(max(1, retry_after))
        poll = arm_request("GET", poll_url)
        if poll.status_code == 202:
            response = poll
            continue
        if not poll.is_success:
            _raise_for_arm(poll)
        try:
            last_body = poll.json() if poll.content else {}
        except Exception:
            last_body = {}
        status = (last_body.get("status") or last_body.get("properties", {}).get("provisioningState") or "").lower()
        if status in ("succeeded", "failed", "canceled", "cancelled"):
            if status in ("failed", "canceled", "cancelled"):
                raise AzureError(f"LRO terminated with status '{status}': {json.dumps(last_body)}")
            return last_body
        # No status field but 200 — treat as done.
        if not status:
            return last_body
        response = poll
    raise AzureError(f"LRO did not reach a terminal state within {timeout_s}s. Last body: {last_body}")


# -----------------------------------------------------------------------------
# Monitor helpers (used by chaos_mcp.monitor)
# -----------------------------------------------------------------------------


def _http_client() -> httpx.Client:
    """Return an httpx.Client honoring the test transport hook when set."""
    if _TEST_TRANSPORT is not None:
        return httpx.Client(transport=_TEST_TRANSPORT)
    return httpx.Client()


def _request_with_retry(
    method: str,
    url: str,
    *,
    headers: Mapping[str, str],
    json_body: Mapping[str, Any] | None = None,
    timeout: float = 60.0,
    max_attempts: int = 5,
) -> httpx.Response:
    """Issue an HTTP request retrying with exponential backoff on 429/5xx.

    Honors `Retry-After` when present. Returns the final `httpx.Response`
    (success or the last failure). Caller decides how to interpret status.
    """
    backoff = 1.0
    last: httpx.Response | None = None
    with _http_client() as client:
        for attempt in range(max_attempts):
            resp = client.request(
                method,
                url,
                headers=dict(headers),
                json=json_body if json_body is not None else None,
                timeout=timeout,
            )
            last = resp
            # Only retry on known-transient statuses. 501/505 etc. will never
            # recover with a retry and would just waste round-trips.
            if resp.status_code in (429, 500, 502, 503, 504):
                if attempt == max_attempts - 1:
                    return resp
                retry_after = resp.headers.get("Retry-After") or resp.headers.get("retry-after")
                try:
                    sleep_s = float(retry_after) if retry_after else backoff
                except ValueError:
                    sleep_s = backoff
                time.sleep(max(0.0, sleep_s))
                backoff = min(backoff * 2, 30.0)
                continue
            return resp
    assert last is not None
    return last


def arm_get_with_query(
    path: str,
    query_params: Mapping[str, str],
    *,
    api_version: str = DEFAULT_API_VERSION,
    timeout: float = 60.0,
) -> httpx.Response:
    """GET an ARM resource with arbitrary query-string parameters.

    Used for endpoints (such as the Activity Log) where filtering happens via
    `$filter` / other OData query parameters rather than request bodies.
    Returns the raw `httpx.Response` so callers can inspect status codes
    (e.g., 403) without an exception.
    """
    if path.startswith("http://") or path.startswith("https://"):
        url = path
        sep = "&" if "?" in url else "?"
    else:
        if not path.startswith("/"):
            path = "/" + path
        url = f"{ARM_ENDPOINT}{path}"
        sep = "?"
    # httpx.QueryParams handles URL encoding (spaces, OData operators, quotes).
    qp = httpx.QueryParams({"api-version": api_version, **dict(query_params)})
    url = f"{url}{sep}{qp}"

    headers = {
        "Authorization": f"Bearer {_get_token(ARM_ENDPOINT)}",
        "Accept": "application/json",
    }
    return _request_with_retry("GET", url, headers=headers, timeout=timeout)


def loganalytics_post(
    workspace_id: str,
    body: Mapping[str, Any],
    *,
    timeout: float = 60.0,
) -> httpx.Response:
    """POST a query to the Log Analytics v1 query endpoint.

    Uses a token scoped to `https://api.loganalytics.io` (NOT ARM). Returns the
    raw `httpx.Response` so callers can inspect 4xx/5xx without exceptions.
    """
    url = f"{LOG_ANALYTICS_ENDPOINT}/v1/workspaces/{workspace_id}/query"
    headers = {
        "Authorization": f"Bearer {_get_token(LOG_ANALYTICS_ENDPOINT)}",
        "Content-Type": "application/json",
        "Accept": "application/json",
    }
    return _request_with_retry(
        "POST", url, headers=headers, json_body=body, timeout=timeout
    )
