"""Unit tests for the auth-mode lever (`az` user principal vs managed identity).

No network, no `az` shell-outs: `httpx.get` is monkeypatched and the managed
identity env vars are set per test. Validates that:
- the default / `cli` mode routes through the `az` CLI helper;
- `managed-identity` mode acquires tokens from IMDS;
- the App Service / Container Apps identity endpoint is preferred when present;
- `CHAOS_MCP_MSI_CLIENT_ID` pins a user-assigned identity;
- mode aliases (`msi`, `mi`) are honored;
- error cases surface as `AzureError`.
"""
from __future__ import annotations

import httpx
import pytest

from chaos_mcp import azure as az


@pytest.fixture(autouse=True)
def _clear_auth_env(monkeypatch):
    """Ensure a clean auth environment for every test."""
    for var in (
        az.AUTH_MODE_ENV,
        az.MSI_CLIENT_ID_ENV,
        "IDENTITY_ENDPOINT",
        "IDENTITY_HEADER",
    ):
        monkeypatch.delenv(var, raising=False)


def _fake_get(recorder: dict):
    def fake_get(url, params=None, headers=None, timeout=None):
        recorder["url"] = url
        recorder["params"] = dict(params or {})
        recorder["headers"] = dict(headers or {})
        return httpx.Response(200, json={"access_token": "mi-token", "expires_in": "3600"})

    return fake_get


# ---------------------------------------------------------------------------
# Mode selection
# ---------------------------------------------------------------------------


def test_default_mode_is_cli(monkeypatch):
    assert az._auth_mode() == "cli"
    called: dict = {}

    def fake_cli(resource):
        called["resource"] = resource
        return "cli-token"

    monkeypatch.setattr(az, "_get_token_via_cli", fake_cli)
    monkeypatch.setattr(
        az,
        "_get_token_via_managed_identity",
        lambda *_a, **_k: pytest.fail("MI path must not run in cli mode"),
    )
    assert az._get_token(az.ARM_ENDPOINT) == "cli-token"
    assert called["resource"] == az.ARM_ENDPOINT


@pytest.mark.parametrize("value", ["managed-identity", "msi", "mi", "MANAGED-IDENTITY", " mi "])
def test_managed_identity_aliases(monkeypatch, value):
    monkeypatch.setenv(az.AUTH_MODE_ENV, value)
    assert az._auth_mode() == "managed-identity"


# ---------------------------------------------------------------------------
# IMDS path (VM / VMSS / AKS)
# ---------------------------------------------------------------------------


def test_managed_identity_uses_imds(monkeypatch):
    monkeypatch.setenv(az.AUTH_MODE_ENV, "managed-identity")
    rec: dict = {}
    monkeypatch.setattr(az.httpx, "get", _fake_get(rec))

    token = az._get_token(az.ARM_ENDPOINT)

    assert token == "mi-token"
    assert rec["url"] == az.IMDS_TOKEN_ENDPOINT
    assert rec["headers"]["Metadata"] == "true"
    assert rec["params"]["resource"] == az.ARM_ENDPOINT
    assert rec["params"]["api-version"] == az.IMDS_API_VERSION
    assert "client_id" not in rec["params"]


def test_managed_identity_pins_user_assigned_client_id(monkeypatch):
    monkeypatch.setenv(az.AUTH_MODE_ENV, "managed-identity")
    monkeypatch.setenv(az.MSI_CLIENT_ID_ENV, "abc-123")
    rec: dict = {}
    monkeypatch.setattr(az.httpx, "get", _fake_get(rec))

    az._get_token(az.LOG_ANALYTICS_ENDPOINT)

    assert rec["params"]["client_id"] == "abc-123"
    assert rec["params"]["resource"] == az.LOG_ANALYTICS_ENDPOINT


# ---------------------------------------------------------------------------
# App Service / Container Apps identity endpoint takes precedence
# ---------------------------------------------------------------------------


def test_managed_identity_prefers_app_service_endpoint(monkeypatch):
    monkeypatch.setenv(az.AUTH_MODE_ENV, "managed-identity")
    monkeypatch.setenv("IDENTITY_ENDPOINT", "http://localhost:42/token")
    monkeypatch.setenv("IDENTITY_HEADER", "secret-header")
    rec: dict = {}
    monkeypatch.setattr(az.httpx, "get", _fake_get(rec))

    az._get_token(az.ARM_ENDPOINT)

    assert rec["url"] == "http://localhost:42/token"
    assert rec["headers"]["X-IDENTITY-HEADER"] == "secret-header"
    assert "Metadata" not in rec["headers"]
    assert rec["params"]["api-version"] == az.APP_SERVICE_IDENTITY_API_VERSION


# ---------------------------------------------------------------------------
# Error handling
# ---------------------------------------------------------------------------


def test_managed_identity_non_200_raises(monkeypatch):
    monkeypatch.setenv(az.AUTH_MODE_ENV, "managed-identity")
    monkeypatch.setattr(
        az.httpx,
        "get",
        lambda *a, **k: httpx.Response(400, text="no identity assigned"),
    )
    with pytest.raises(az.AzureError, match="HTTP 400"):
        az._get_token(az.ARM_ENDPOINT)


def test_managed_identity_transport_error_raises(monkeypatch):
    monkeypatch.setenv(az.AUTH_MODE_ENV, "managed-identity")

    def boom(*_a, **_k):
        raise httpx.ConnectError("no route to IMDS")

    monkeypatch.setattr(az.httpx, "get", boom)
    with pytest.raises(az.AzureError, match="managed-identity token endpoint"):
        az._get_token(az.ARM_ENDPOINT)


def test_managed_identity_missing_token_raises(monkeypatch):
    monkeypatch.setenv(az.AUTH_MODE_ENV, "managed-identity")
    monkeypatch.setattr(
        az.httpx, "get", lambda *a, **k: httpx.Response(200, json={"expires_in": "3600"})
    )
    with pytest.raises(az.AzureError, match="no access_token"):
        az._get_token(az.ARM_ENDPOINT)
