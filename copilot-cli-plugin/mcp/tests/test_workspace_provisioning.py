# Copyright (c) Microsoft Corporation.
# Licensed under the MIT License.

"""Tests for the provisioning-verification hardening in the workspace tools.

``chaos_create_workspace`` and ``chaos_refresh_recommendations`` must not
report success (nor grant RBAC) until the underlying resource is confirmed
terminal-Succeeded. These fake the ARM layer to prove the callers verify the
resource state after the LRO poll and surface a structured ``_err`` on a
terminal failure.
"""
from __future__ import annotations

import httpx
import pytest

from chaos_mcp import azure as az
from chaos_mcp import server as srv

SUBSCRIPTION_ID = "00000000-0000-0000-0000-000000000001"
RESOURCE_GROUP = "rg1"
WORKSPACE = "ws1"
SCOPE = (
    f"/subscriptions/{SUBSCRIPTION_ID}/resourceGroups/{RESOURCE_GROUP}"
    "/providers/Microsoft.ContainerService/managedClusters/aks1"
)


@pytest.fixture(autouse=True)
def _instant_lro(monkeypatch):
    """The PUT/POST LRO poll is covered elsewhere; make it a no-op here."""
    monkeypatch.setattr(az, "wait_for_lro", lambda *a, **k: {})


def test_create_workspace_grants_rbac_only_after_succeeded(monkeypatch):
    workspace = {
        "id": "/ws1",
        "identity": {"principalId": "pid-123"},
        "properties": {"provisioningState": "Succeeded"},
    }
    monkeypatch.setattr(az, "arm_put", lambda *a, **k: httpx.Response(202))
    monkeypatch.setattr(az, "wait_until_provisioned", lambda *a, **k: workspace)

    granted: list[tuple[str, str]] = []
    monkeypatch.setattr(
        srv,
        "_grant_reader",
        lambda scope, pid: granted.append((scope, pid)) or {"scope": scope, "status": "granted"},
    )

    result = srv.chaos_create_workspace(
        SUBSCRIPTION_ID, RESOURCE_GROUP, WORKSPACE, "westus3", [SCOPE]
    )

    assert result["ok"] is True
    assert result["result"]["workspace"] == workspace
    assert granted == [(SCOPE, "pid-123")]


def test_create_workspace_non_succeeded_returns_err_without_rbac(monkeypatch):
    monkeypatch.setattr(az, "arm_put", lambda *a, **k: httpx.Response(202))

    def _fail(*_a, **_k):
        raise az.AzureError("Resource provisioning ended in terminal state 'Failed': /ws1")

    monkeypatch.setattr(az, "wait_until_provisioned", _fail)

    granted: list = []
    monkeypatch.setattr(srv, "_grant_reader", lambda *a, **k: granted.append(1))

    result = srv.chaos_create_workspace(
        SUBSCRIPTION_ID, RESOURCE_GROUP, WORKSPACE, "westus3", [SCOPE]
    )

    assert result["ok"] is False
    assert result["errorType"] == "AzureError"
    assert "Failed" in result["error"]
    assert granted == [], "RBAC must not be granted on a non-Succeeded workspace"


def test_refresh_recommendations_waits_for_terminal_evaluation(monkeypatch):
    evaluation = {"properties": {"status": "Succeeded"}}
    captured: dict = {}

    def _wait(path, **kw):
        captured["path"] = path
        captured["success_states"] = kw.get("success_states")
        return evaluation

    monkeypatch.setattr(az, "arm_post", lambda *a, **k: httpx.Response(202))
    monkeypatch.setattr(az, "wait_until_provisioned", _wait)

    result = srv.chaos_refresh_recommendations(SUBSCRIPTION_ID, RESOURCE_GROUP, WORKSPACE)

    assert result == {"ok": True, "result": evaluation}
    assert captured["path"].endswith("/evaluations/latest")
    # PartiallySucceeded must count as terminal-success for evaluations.
    assert "partiallysucceeded" in captured["success_states"]


def test_refresh_recommendations_terminal_failure_returns_err(monkeypatch):
    monkeypatch.setattr(az, "arm_post", lambda *a, **k: httpx.Response(202))

    def _fail(*_a, **_k):
        raise az.AzureError("Resource provisioning ended in terminal state 'Failed': /evaluations/latest")

    monkeypatch.setattr(az, "wait_until_provisioned", _fail)

    result = srv.chaos_refresh_recommendations(SUBSCRIPTION_ID, RESOURCE_GROUP, WORKSPACE)

    assert result["ok"] is False
    assert result["errorType"] == "AzureError"
    assert "Failed" in result["error"]
