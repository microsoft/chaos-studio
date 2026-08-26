# Copyright (c) Microsoft Corporation.
# Licensed under the MIT License.

"""Tests for durable ScenarioRun discovery across agent sessions."""
from __future__ import annotations

import pytest

from chaos_mcp import azure as az
from chaos_mcp import server as srv

SUBSCRIPTION_ID = "00000000-0000-0000-0000-000000000001"
RESOURCE_GROUP = "hermetic-rg"
WORKSPACE = "hermetic-workspace"
SCENARIO = "11111111-1111-1111-1111-111111111111"
BASE_PATH = (
    f"/subscriptions/{SUBSCRIPTION_ID}/resourceGroups/{RESOURCE_GROUP}"
    f"/providers/Microsoft.Chaos/workspaces/{WORKSPACE}/scenarios/{SCENARIO}/runs"
)
TARGET_ONE = (
    f"/subscriptions/{SUBSCRIPTION_ID}/resourceGroups/{RESOURCE_GROUP}"
    "/providers/Microsoft.ContainerService/managedClusters/aks-one"
)
TARGET_TWO = (
    f"/subscriptions/{SUBSCRIPTION_ID}/resourceGroups/{RESOURCE_GROUP}"
    "/providers/Microsoft.ContainerService/managedClusters/aks-two"
)


def _run(
    run_id: str,
    *,
    started_at: str,
    configuration: str,
    status: str,
    target: str,
) -> dict:
    return {
        "id": f"{BASE_PATH}/{run_id}",
        "name": run_id,
        "properties": {
            "workspaceName": WORKSPACE,
            "scenarioName": SCENARIO,
            "scenarioConfigurationName": configuration,
            "status": status,
            "resources": [{"id": target}],
            "startTime": started_at,
        },
    }


def _summary(run: dict) -> dict:
    properties = run["properties"]
    return {
        "scenarioRunId": run["name"],
        "resourceId": run["id"],
        "workspaceName": properties["workspaceName"],
        "scenarioName": properties["scenarioName"],
        "configurationName": properties["scenarioConfigurationName"],
        "status": properties["status"],
        "startTime": properties["startTime"],
        "endTime": None,
        "managedIdentityPrincipalId": None,
        "targetResourceIds": [properties["resources"][0]["id"]],
        "createdAt": None,
    }


def test_arm_list_follows_service_next_links(monkeypatch):
    continuation = "https://management.azure.com/next-page?api-version=2026-05-01-preview"
    calls: list[str] = []
    pages = {
        BASE_PATH: {"value": [{"name": "run-one"}], "nextLink": continuation},
        continuation: {"value": [{"name": "run-two"}], "nextLink": None},
    }

    def fake_get(path: str, **_kwargs):
        calls.append(path)
        return pages[path]

    monkeypatch.setattr(az, "arm_get", fake_get)

    assert az.arm_list(BASE_PATH) == [{"name": "run-one"}, {"name": "run-two"}]
    assert calls == [BASE_PATH, continuation]


def test_arm_list_rejects_repeated_next_link(monkeypatch):
    monkeypatch.setattr(
        az,
        "arm_get",
        lambda path, **_kwargs: {"value": [], "nextLink": path},
    )

    with pytest.raises(az.AzureError, match="repeated nextLink"):
        az.arm_list(BASE_PATH)


def test_list_scenario_runs_returns_all_pages_newest_first(monkeypatch):
    older = _run(
        "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
        started_at="2026-08-11T10:00:00Z",
        configuration="baseline",
        status="Failed",
        target=TARGET_ONE,
    )
    newer = _run(
        "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
        started_at="2026-08-12T10:00:00Z",
        configuration="validation",
        status="Succeeded",
        target=TARGET_TWO,
    )
    seen: list[str] = []

    def fake_list(path: str, **_kwargs):
        seen.append(path)
        return [older, newer]

    monkeypatch.setattr(az, "arm_list", fake_list)

    result = srv.chaos_list_scenario_runs(
        SUBSCRIPTION_ID,
        RESOURCE_GROUP,
        WORKSPACE,
        SCENARIO,
    )

    assert result["ok"] is True
    assert result["result"] == [_summary(newer), _summary(older)]
    assert seen == [BASE_PATH]


def test_list_scenario_runs_filters_configuration_status_and_resource(monkeypatch):
    wanted = _run(
        "cccccccc-cccc-cccc-cccc-cccccccccccc",
        started_at="2026-08-12T10:00:00Z",
        configuration="post-fix",
        status="Succeeded",
        target=TARGET_ONE,
    )
    wrong_status = _run(
        "dddddddd-dddd-dddd-dddd-dddddddddddd",
        started_at="2026-08-13T10:00:00Z",
        configuration="post-fix",
        status="Failed",
        target=TARGET_ONE,
    )
    wrong_target = _run(
        "eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee",
        started_at="2026-08-14T10:00:00Z",
        configuration="post-fix",
        status="Succeeded",
        target=TARGET_TWO,
    )
    monkeypatch.setattr(az, "arm_list", lambda *_args, **_kwargs: [wrong_target, wanted, wrong_status])

    result = srv.chaos_list_scenario_runs(
        SUBSCRIPTION_ID,
        RESOURCE_GROUP,
        WORKSPACE,
        SCENARIO,
        configuration_name="POST-FIX",
        status="succeeded",
        target_resource_id=TARGET_ONE.upper(),
    )

    assert result == {"ok": True, "result": [_summary(wanted)]}


def test_list_scenario_runs_returns_structured_azure_error(monkeypatch):
    def fail(*_args, **_kwargs):
        raise az.AzureError("not authorized")

    monkeypatch.setattr(az, "arm_list", fail)

    result = srv.chaos_list_scenario_runs(
        SUBSCRIPTION_ID,
        RESOURCE_GROUP,
        WORKSPACE,
        SCENARIO,
    )

    assert result == {
        "ok": False,
        "errorType": "AzureError",
        "error": "not authorized",
    }
