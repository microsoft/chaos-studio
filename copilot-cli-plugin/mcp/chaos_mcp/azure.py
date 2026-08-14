# Copyright (c) Microsoft Corporation.
# Licensed under the MIT License.

"""Thin wrappers around `az` CLI + ARM REST calls.

By default the MCP server relies on the operator's local `az` session for auth
rather than managing tokens itself. This matches the skill's auth model and
keeps the server stateless. Setting ``CHAOS_MCP_AUTH_MODE=managed-identity``
flips a lever so the server instead acquires tokens from an Azure Managed
Identity — letting the skills run unattended (CI, containers, AKS, VMs) with
no interactive `az login`.
"""
from __future__ import annotations

import json
import os
import shutil
import subprocess
import time
from collections.abc import Mapping
from dataclasses import dataclass
from typing import Any

import httpx

ARM_ENDPOINT = "https://management.azure.com"
LOG_ANALYTICS_ENDPOINT = "https://api.loganalytics.io"
DEFAULT_API_VERSION = "2026-05-01-preview"
DEFAULT_LRO_TIMEOUT_S = 30 * 60
DEFAULT_LRO_INTERVAL_S = 5

# Test-only hook: when set, all new monitor helpers route through this transport.
# Production callers leave it None; pytest sets it to an httpx.MockTransport.
_TEST_TRANSPORT: Any = None

# -----------------------------------------------------------------------------
# Authentication mode (the "user principal vs managed identity" lever)
# -----------------------------------------------------------------------------
# The server can authenticate either as the operator's local `az login` session
# (the user principal, default) or as an Azure Managed Identity — so the tools
# can run unattended (CI, containers, AKS, VMs) with no `az` session.
#
# The mode is chosen at three levels, highest precedence first:
#   1. A runtime override set *during the session* via `set_auth_mode(...)`
#      (surfaced to agents as the `chaos_set_auth_mode` MCP tool). This lets the
#      customer flip between user principal and MI mid-conversation, no config
#      edit or server restart required.
#   2. The CHAOS_MCP_AUTH_MODE / CHAOS_MCP_MSI_CLIENT_ID env vars (a startup
#      default, e.g. for headless deployments).
#   3. The built-in default: `cli` (user principal).
AUTH_MODE_ENV = "CHAOS_MCP_AUTH_MODE"
MSI_CLIENT_ID_ENV = "CHAOS_MCP_MSI_CLIENT_ID"

AUTH_MODE_CLI = "cli"
AUTH_MODE_MANAGED_IDENTITY = "managed-identity"

_MANAGED_IDENTITY_ALIASES = frozenset(
    {"managed-identity", "managed_identity", "managedidentity", "msi", "mi", "identity"}
)
_CLI_ALIASES = frozenset({"cli", "az", "user", "user-principal", "userprincipal", "default"})

# IMDS token endpoint (VMs, VMSS, AKS).
IMDS_TOKEN_ENDPOINT = "http://169.254.169.254/metadata/identity/oauth2/token"
IMDS_API_VERSION = "2018-02-01"
# App Service / Container Apps / Functions inject IDENTITY_ENDPOINT +
# IDENTITY_HEADER instead of exposing IMDS.
APP_SERVICE_IDENTITY_API_VERSION = "2019-08-01"

# Session-scoped runtime override (set via the chaos_set_auth_mode tool). None
# means "not overridden — fall back to env / default". This is process-global
# in-memory state: it lives for the life of the MCP server process (i.e. the
# customer's session) and is never persisted to disk.
_auth_mode_override: str | None = None
_msi_client_id_override: str | None = None


def _normalize_mode(value: str) -> str:
    """Map a user-supplied mode string to a canonical mode, or raise.

    Accepts the managed-identity aliases (managed-identity/msi/mi/...) and the
    cli aliases (cli/az/user-principal/...).
    """
    raw = (value or "").strip().lower()
    if raw in _MANAGED_IDENTITY_ALIASES:
        return AUTH_MODE_MANAGED_IDENTITY
    if raw in _CLI_ALIASES:
        return AUTH_MODE_CLI
    raise AzureError(
        f"Unknown auth mode '{value}'. Use 'cli' (user principal) or "
        "'managed-identity'."
    )


def set_auth_mode(mode: str, msi_client_id: str | None = None) -> dict:
    """Set the session-scoped auth mode override and return the effective config.

    `mode` is 'cli' (user principal) or 'managed-identity' (aliases accepted).
    `msi_client_id` optionally pins a user-assigned identity when mode is
    managed-identity; pass None/empty to use the system-assigned identity.
    """
    global _auth_mode_override, _msi_client_id_override
    normalized = _normalize_mode(mode)
    _auth_mode_override = normalized
    if normalized == AUTH_MODE_MANAGED_IDENTITY:
        _msi_client_id_override = (msi_client_id or "").strip() or None
    else:
        _msi_client_id_override = None
    return get_auth_config()


def reset_auth_mode() -> dict:
    """Clear the runtime override so mode falls back to env vars / default."""
    global _auth_mode_override, _msi_client_id_override
    _auth_mode_override = None
    _msi_client_id_override = None
    return get_auth_config()


def get_auth_config() -> dict:
    """Return the effective auth configuration and where it came from."""
    source = "override" if _auth_mode_override is not None else (
        "env" if os.environ.get(AUTH_MODE_ENV) else "default"
    )
    return {
        "mode": _auth_mode(),
        "msiClientId": _msi_client_id(),
        "source": source,
    }


def _auth_mode() -> str:
    """Return the effective auth mode: 'managed-identity' or 'cli' (default).

    Precedence: runtime override > CHAOS_MCP_AUTH_MODE env var > 'cli'.
    """
    if _auth_mode_override is not None:
        return _auth_mode_override
    raw = (os.environ.get(AUTH_MODE_ENV) or "cli").strip().lower()
    return AUTH_MODE_MANAGED_IDENTITY if raw in _MANAGED_IDENTITY_ALIASES else AUTH_MODE_CLI


def _msi_client_id() -> str | None:
    """Return the effective user-assigned MI client id, or None.

    Only meaningful in managed-identity mode (returns None otherwise). Within MI
    mode the precedence is: explicit runtime override > CHAOS_MCP_MSI_CLIENT_ID
    env var > None (the system-assigned identity). A mode switch that doesn't
    name a client id therefore keeps any env-pinned identity rather than
    silently dropping it.
    """
    if _auth_mode() != AUTH_MODE_MANAGED_IDENTITY:
        return None
    if _msi_client_id_override is not None:
        return _msi_client_id_override
    return (os.environ.get(MSI_CLIENT_ID_ENV) or "").strip() or None


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
        check=False,
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
    """Acquire an access token for the given audience.

    `resource` is the token audience URL (e.g., `https://management.azure.com`
    for ARM or `https://api.loganalytics.io` for Log Analytics queries).

    Uses the local `az` session (user principal) by default; when
    ``CHAOS_MCP_AUTH_MODE`` selects a managed identity, tokens come from the
    Azure identity endpoint instead. Tokens are not cached — each call acquires
    a fresh token.
    """
    if _auth_mode() == "managed-identity":
        return _get_token_via_managed_identity(resource)
    return _get_token_via_cli(resource)


def _get_token_via_cli(resource: str) -> str:
    """Acquire a token from the local `az` session (the user principal)."""
    proc = subprocess.run(
        [_az_path(), "account", "get-access-token", "--resource", resource, "-o", "json"],
        capture_output=True,
        text=True,
        check=False,
    )
    if proc.returncode != 0:
        raise AzureError(
            f"Failed to acquire access token for {resource}: {proc.stderr.strip()}"
        )
    return json.loads(proc.stdout)["accessToken"]


def _get_token_via_managed_identity(resource: str) -> str:
    """Acquire a token from an Azure Managed Identity (no `az` session needed).

    Honors the App Service / Container Apps / Functions identity endpoint
    (``IDENTITY_ENDPOINT`` + ``IDENTITY_HEADER``) when present, otherwise falls
    back to the IMDS endpoint used by VMs, VMSS and AKS. The user-assigned
    identity (if any) comes from the runtime override or
    ``CHAOS_MCP_MSI_CLIENT_ID``.
    """
    client_id = _msi_client_id()
    identity_endpoint = os.environ.get("IDENTITY_ENDPOINT")
    identity_header = os.environ.get("IDENTITY_HEADER")

    if identity_endpoint and identity_header:
        url = identity_endpoint
        params: dict[str, str] = {
            "resource": resource,
            "api-version": APP_SERVICE_IDENTITY_API_VERSION,
        }
        headers = {"X-IDENTITY-HEADER": identity_header}
    else:
        url = IMDS_TOKEN_ENDPOINT
        params = {"resource": resource, "api-version": IMDS_API_VERSION}
        headers = {"Metadata": "true"}
    if client_id:
        params["client_id"] = client_id

    try:
        # trust_env=False: never route the IMDS / identity-endpoint request
        # through HTTP(S)_PROXY. 169.254.169.254 must be reached directly, and
        # proxying would also leak the App Service X-IDENTITY-HEADER secret. The
        # Azure SDKs bypass proxies for IMDS for the same reasons.
        resp = httpx.get(url, params=params, headers=headers, timeout=10.0, trust_env=False)
    except httpx.HTTPError as e:
        raise AzureError(
            f"Failed to reach the managed-identity token endpoint for {resource}: {e}. "
            "Is a managed identity available on this host?"
        ) from e

    if resp.status_code != 200:
        raise AzureError(
            f"Managed-identity token request for {resource} failed with HTTP "
            f"{resp.status_code}: {resp.text.strip()}"
        )

    try:
        token = resp.json().get("access_token")
    except Exception as e:
        raise AzureError(
            f"Malformed managed-identity token response for {resource}: {resp.text.strip()}"
        ) from e
    if not token:
        raise AzureError(
            f"Managed-identity token response for {resource} contained no access_token."
        )
    return token


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
    if path.startswith(("http://", "https://")):
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
    except Exception:  # noqa: BLE001 - best-effort parse; error body is optional
        payload = {"raw": resp.text}
    raise AzureError(f"ARM {resp.status_code} {resp.request.method} {resp.request.url}: {json.dumps(payload)}")


def arm_get(path: str, **kw) -> dict:
    resp = arm_request("GET", path, **kw)
    _raise_for_arm(resp)
    return resp.json() if resp.content else {}


def arm_list(path: str, *, max_pages: int = 100, **kw) -> list[dict]:
    """GET an ARM collection endpoint and follow `nextLink` until exhausted.

    Returns the concatenated `value` arrays. `nextLink` is an absolute URL that
    already carries its own `api-version`, so it is passed through unchanged.
    `max_pages` bounds a server that returns a self-referential `nextLink`.
    """
    items: list[dict] = []
    seen: set[str] = set()
    next_path: str | None = path
    for _ in range(max_pages):
        if next_path is None:
            return items
        body = arm_get(next_path, **kw)
        value = body.get("value", [])
        if not isinstance(value, list):
            raise AzureError(f"ARM collection response 'value' is not an array: {next_path}")
        items.extend(item for item in value if isinstance(item, dict))
        link = body.get("nextLink") or None
        if link is None:
            return items
        if not isinstance(link, str) or link in seen:
            raise AzureError(f"ARM collection returned an invalid or repeated nextLink: {link!r}")
        seen.add(link)
        next_path = link
    raise AzureError(f"ARM collection exceeded {max_pages} pages: {path}")


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
        except Exception:  # noqa: BLE001 - best-effort parse; empty body is acceptable
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
        except Exception:  # noqa: BLE001 - best-effort parse; empty body is acceptable
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
    if path.startswith(("http://", "https://")):
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
