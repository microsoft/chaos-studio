# Copyright (c) Microsoft Corporation.
# Licensed under the MIT License.

"""Unit tests for the read-only workspace discovery tool.

`chaos_list_workspaces` is the preflight tool the Chaos Loop uses to decide
whether an existing `Microsoft.Chaos/workspaces` resource can be reused. These
tests cover the subscription and resource-group list endpoints, ARM paging via
`nextLink`, and the success/error envelopes — with no network and no `az`
shell-outs (`httpx.request` is monkeypatched).
"""
from __future__ import annotations

from urllib.parse import parse_qs, urlparse

import httpx
import pytest

from chaos_mcp import azure as az
from chaos_mcp import server

SUBSCRIPTION = "00000000-0000-0000-0000-000000000001"


@pytest.fixture(autouse=True)
def _no_real_az(monkeypatch):
    """Block token acquisition from shelling out to `az`."""
    monkeypatch.setattr(az, "_get_token", lambda resource=az.ARM_ENDPOINT: "fake-token")


def install_arm(monkeypatch, handler):
    """Route every `azure.arm_request` call through `handler`; record requests."""
    seen: list[httpx.Request] = []

    def fake_request(method, url, headers=None, json=None, timeout=None, **kwargs):
        request = httpx.Request(method, url, headers=headers, json=json)
        seen.append(request)
        response = handler(request)
        response.request = request
        return response

    monkeypatch.setattr(az.httpx, "request", fake_request)
    return seen


def workspace(name: str, resource_group: str = "rg1") -> dict:
    return {
        "id": (
            f"/subscriptions/{SUBSCRIPTION}/resourceGroups/{resource_group}"
            f"/providers/Microsoft.Chaos/workspaces/{name}"
        ),
        "name": name,
        "type": "Microsoft.Chaos/workspaces",
        "location": "eastus",
        "identity": {"type": "SystemAssigned", "principalId": "p-1"},
        "properties": {
            "provisioningState": "Succeeded",
            "scopes": [f"/subscriptions/{SUBSCRIPTION}/resourceGroups/{resource_group}"],
        },
    }


def test_list_workspaces_subscription_scope(monkeypatch):
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json={"value": [workspace("ws-a"), workspace("ws-b")]})

    seen = install_arm(monkeypatch, handler)
    result = server.chaos_list_workspaces(SUBSCRIPTION)

    assert result["ok"] is True
    assert result["result"]["scope"] == "subscription"
    assert result["result"]["resourceGroup"] is None
    assert result["result"]["count"] == 2
    assert [item["name"] for item in result["result"]["workspaces"]] == ["ws-a", "ws-b"]

    url = urlparse(str(seen[0].url))
    assert url.path == f"/subscriptions/{SUBSCRIPTION}/providers/Microsoft.Chaos/workspaces"
    assert parse_qs(url.query)["api-version"] == ["2026-05-01-preview"]


def test_list_workspaces_resource_group_scope(monkeypatch):
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json={"value": [workspace("ws-a", "rg-orders")]})

    seen = install_arm(monkeypatch, handler)
    result = server.chaos_list_workspaces(SUBSCRIPTION, "rg-orders")

    assert result["ok"] is True
    assert result["result"]["scope"] == "resourceGroup"
    assert result["result"]["resourceGroup"] == "rg-orders"
    assert result["result"]["count"] == 1

    url = urlparse(str(seen[0].url))
    assert url.path == (
        f"/subscriptions/{SUBSCRIPTION}/resourceGroups/rg-orders"
        "/providers/Microsoft.Chaos/workspaces"
    )


def test_list_workspaces_follows_next_link(monkeypatch):
    page_two = (
        f"https://management.azure.com/subscriptions/{SUBSCRIPTION}"
        "/providers/Microsoft.Chaos/workspaces?api-version=2026-05-01-preview&$skipToken=2"
    )

    def handler(request: httpx.Request) -> httpx.Response:
        if "skipToken" in str(request.url):
            return httpx.Response(200, json={"value": [workspace("ws-c")]})
        return httpx.Response(
            200, json={"value": [workspace("ws-a"), workspace("ws-b")], "nextLink": page_two}
        )

    seen = install_arm(monkeypatch, handler)
    result = server.chaos_list_workspaces(SUBSCRIPTION)

    assert result["ok"] is True
    assert result["result"]["count"] == 3
    assert [item["name"] for item in result["result"]["workspaces"]] == [
        "ws-a",
        "ws-b",
        "ws-c",
    ]
    assert len(seen) == 2
    assert str(seen[1].url) == page_two


def test_list_workspaces_rejects_repeated_next_link(monkeypatch):
    self_link = (
        f"https://management.azure.com/subscriptions/{SUBSCRIPTION}"
        "/providers/Microsoft.Chaos/workspaces?api-version=2026-05-01-preview&$skipToken=1"
    )

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json={"value": [workspace("ws-a")], "nextLink": self_link})

    install_arm(monkeypatch, handler)
    result = server.chaos_list_workspaces(SUBSCRIPTION)

    assert result["ok"] is False
    assert result["errorType"] == "AzureError"
    assert "repeated nextLink" in result["error"]


def test_list_workspaces_forbidden_returns_error_envelope(monkeypatch):
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            403,
            json={"error": {"code": "AuthorizationFailed", "message": "no Reader on scope"}},
        )

    install_arm(monkeypatch, handler)
    result = server.chaos_list_workspaces(SUBSCRIPTION)

    assert result["ok"] is False
    assert result["errorType"] == "AzureError"
    assert "AuthorizationFailed" in result["error"]


def test_list_workspaces_empty_subscription(monkeypatch):
    install_arm(monkeypatch, lambda request: httpx.Response(200, json={"value": []}))
    result = server.chaos_list_workspaces(SUBSCRIPTION)

    assert result["ok"] is True
    assert result["result"] == {
        "workspaces": [],
        "count": 0,
        "scope": "subscription",
        "resourceGroup": None,
    }


def test_create_workspace_user_assigned_identity_grants_reader(monkeypatch):
    identity_id = (
        f"/subscriptions/{SUBSCRIPTION}/resourceGroups/rg-identities"
        "/providers/Microsoft.ManagedIdentity/userAssignedIdentities/chaos-uai"
    )
    target_scope = f"/subscriptions/{SUBSCRIPTION}/resourceGroups/rg-orders"
    put_response = httpx.Response(
        200,
        request=httpx.Request("PUT", "https://management.azure.com/workspace"),
    )
    workspace_resource = workspace("orders", "rg-orders")
    workspace_resource["identity"] = {
        "type": "UserAssigned",
        "userAssignedIdentities": {
            identity_id: {"principalId": "uai-principal-id"}
        },
    }
    monkeypatch.setattr(az, "arm_put", lambda *_args, **_kwargs: put_response)
    monkeypatch.setattr(az, "wait_for_lro", lambda *_args, **_kwargs: {})
    monkeypatch.setattr(az, "arm_get", lambda *_args, **_kwargs: workspace_resource)
    grants: list[tuple[str, str]] = []

    def grant(scope: str, principal_id: str):
        grants.append((scope, principal_id))
        return {"scope": scope, "status": "granted"}

    monkeypatch.setattr(server, "_grant_reader", grant)

    result = server.chaos_create_workspace(
        SUBSCRIPTION,
        "rg-orders",
        "orders",
        "eastus",
        [target_scope],
        identity_type="UserAssigned",
        user_assigned_identity_resource_id=identity_id,
    )

    assert result["ok"] is True
    assert grants == [(target_scope, "uai-principal-id")]
    assert result["result"]["roleAssignments"] == [
        {"scope": target_scope, "status": "granted"}
    ]
