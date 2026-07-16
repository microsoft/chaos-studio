# Copyright (c) Microsoft Corporation.
# Licensed under the MIT License.

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
    """Ensure a clean auth environment (env vars AND runtime override) per test.

    The runtime override is process-global in-memory state, so it MUST be reset
    around every test or one test's `set_auth_mode` would poison the next.
    """
    for var in (
        az.AUTH_MODE_ENV,
        az.MSI_CLIENT_ID_ENV,
        "IDENTITY_ENDPOINT",
        "IDENTITY_HEADER",
    ):
        monkeypatch.delenv(var, raising=False)
    az.reset_auth_mode()
    yield
    az.reset_auth_mode()


def _fake_get(recorder: dict):
    def fake_get(url, params=None, headers=None, timeout=None, **kwargs):
        recorder["url"] = url
        recorder["params"] = dict(params or {})
        recorder["headers"] = dict(headers or {})
        recorder["kwargs"] = dict(kwargs)
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
    # Must bypass any HTTP(S)_PROXY when talking to IMDS.
    assert rec["kwargs"]["trust_env"] is False


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


# ---------------------------------------------------------------------------
# Runtime override — the customer chooses mid-session (chaos_set_auth_mode)
# ---------------------------------------------------------------------------


def test_runtime_override_switches_to_managed_identity():
    assert az._auth_mode() == "cli"
    cfg = az.set_auth_mode("managed-identity", "uami-client-id")
    assert cfg == {
        "mode": "managed-identity",
        "msiClientId": "uami-client-id",
        "source": "override",
    }
    assert az._auth_mode() == "managed-identity"
    assert az._msi_client_id() == "uami-client-id"


def test_runtime_override_beats_env(monkeypatch):
    # Env selects MI, but the customer overrides back to the user principal.
    monkeypatch.setenv(az.AUTH_MODE_ENV, "managed-identity")
    monkeypatch.setenv(az.MSI_CLIENT_ID_ENV, "from-env")
    assert az._auth_mode() == "managed-identity"

    az.set_auth_mode("cli")
    assert az._auth_mode() == "cli"
    # cli mode drops any user-assigned client id.
    assert az._msi_client_id() is None
    assert az.get_auth_config()["source"] == "override"


def test_runtime_switch_to_mi_without_client_id_keeps_env_pin(monkeypatch):
    """Switching to MI without naming a client id must NOT drop an env pin."""
    monkeypatch.setenv(az.MSI_CLIENT_ID_ENV, "env-pinned-uami")
    az.set_auth_mode("managed-identity")  # no client id supplied
    assert az._auth_mode() == "managed-identity"
    assert az._msi_client_id() == "env-pinned-uami"
    assert az.get_auth_config()["msiClientId"] == "env-pinned-uami"


def test_runtime_switch_to_mi_explicit_client_id_overrides_env(monkeypatch):
    monkeypatch.setenv(az.MSI_CLIENT_ID_ENV, "env-pinned-uami")
    az.set_auth_mode("managed-identity", "explicit-uami")
    assert az._msi_client_id() == "explicit-uami"


def test_cli_mode_reports_no_client_id_even_with_env(monkeypatch):
    monkeypatch.setenv(az.MSI_CLIENT_ID_ENV, "env-pinned-uami")
    assert az._auth_mode() == "cli"
    assert az._msi_client_id() is None
    assert az.get_auth_config()["msiClientId"] is None


def test_runtime_reset_falls_back_to_env(monkeypatch):
    monkeypatch.setenv(az.AUTH_MODE_ENV, "managed-identity")
    az.set_auth_mode("cli")
    assert az._auth_mode() == "cli"
    az.reset_auth_mode()
    assert az._auth_mode() == "managed-identity"
    assert az.get_auth_config()["source"] == "env"


def test_set_auth_mode_rejects_unknown():
    with pytest.raises(az.AzureError, match="Unknown auth mode"):
        az.set_auth_mode("kerberos")


def test_get_auth_config_default_source():
    cfg = az.get_auth_config()
    assert cfg == {"mode": "cli", "msiClientId": None, "source": "default"}


def test_override_drives_actual_token_acquisition(monkeypatch):
    """Flipping mode at runtime must route _get_token through the MI path."""
    rec: dict = {}
    monkeypatch.setattr(az.httpx, "get", _fake_get(rec))
    monkeypatch.setattr(
        az, "_get_token_via_cli", lambda *_a, **_k: pytest.fail("should use MI after override")
    )
    az.set_auth_mode("mi", "runtime-uami")
    assert az._get_token(az.ARM_ENDPOINT) == "mi-token"
    assert rec["params"]["client_id"] == "runtime-uami"


# ---------------------------------------------------------------------------
# MCP tool wrappers (server.chaos_set_auth_mode / chaos_get_auth_mode)
# ---------------------------------------------------------------------------


def test_tool_set_and_get_auth_mode():
    from chaos_mcp import server as srv

    set_result = srv.chaos_set_auth_mode("managed-identity", "tool-uami")
    assert set_result["ok"] is True
    assert set_result["result"]["mode"] == "managed-identity"
    assert set_result["result"]["msiClientId"] == "tool-uami"

    get_result = srv.chaos_get_auth_mode()
    assert get_result == {
        "ok": True,
        "result": {
            "mode": "managed-identity",
            "msiClientId": "tool-uami",
            "source": "override",
        },
    }


def test_tool_set_auth_mode_invalid_returns_error_envelope():
    from chaos_mcp import server as srv

    result = srv.chaos_set_auth_mode("nope")
    assert result["ok"] is False
    assert result["errorType"] == "AzureError"
    assert "Unknown auth mode" in result["error"]
