#!/usr/bin/env python3
"""Durable state controller for the Chaos Loop plugin.

The phase skills produce evidence. This script is the only component allowed to
mutate run state, select transitions, increment iterations, or accept the
external merge-and-deploy gate.
"""

from __future__ import annotations

import argparse
import copy
import datetime as dt
import hashlib
import json
import os
import re
import sys
import tempfile
import time
import uuid
from contextlib import contextmanager
from pathlib import Path
from typing import Any, Callable


STATE_VERSION = "chaos-loop-state/v1"
CONTRACT_VERSION = "chaos-loop-contract/v1"
GATE_VERSION = "chaos-loop-gate/v1"
POLICY_VERSION = "chaos-loop-policy/v2"
WORKSPACE_PLAN_VERSION = "chaos-loop-workspace-plan/v1"
CATALOG_PATH = (
    Path(__file__).resolve().parent.parent
    / "references"
    / "chaos-loop"
    / "scenario-catalog.v1.json"
)
PHASES = (
    "resilience-analysis",
    "chaos-execution",
    "diagnostic",
    "advisory",
    "advisory-approval",
    "coding",
    "awaiting-external-gate",
    "terminated",
)
INTERACTION_PHASES = {"advisory-approval", "awaiting-external-gate"}
TERMINATION_REASONS = {
    "analysis-only",
    "no-impact",
    "no-remediation",
    "resolved",
    "escalated",
}


VERDICTS = {"CONFIRMED", "REFUTED", "NOT EXERCISED"}
UTC_PATTERN = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$")

WORKSPACE_STATUSES = {"pending", "ready", "failed"}
WORKSPACE_DECISIONS = {"reused", "created"}
WORKSPACE_PLAN_DECISIONS = {"reuse", "create"}
WORKSPACE_RESOURCE_TYPE = "microsoft.chaos/workspaces"
USER_ASSIGNED_IDENTITY_TYPE = "microsoft.managedidentity/userassignedidentities"
IDENTITY_TYPES = ("SystemAssigned", "UserAssigned")
REQUIRED_PROVISIONING_STATE = "Succeeded"
UUID_PATTERN = re.compile(
    r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$"
)
RESOURCE_GROUP_PATTERN = re.compile(r"^[-\w\.\(\)]+$", re.UNICODE)
LOCATION_PATTERN = re.compile(r"^[a-z0-9]{3,64}$")
WORKSPACE_NAME_PATTERN = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,62}[A-Za-z0-9]$")
GENERATED_WORKSPACE_NAME_PREFIX = "chaos-loop-"

PHASE_OWNERSHIP = {
    "resilience-analysis": {"analysisDecision", "unresolvedCaveats"},
    "chaos-execution": {
        "executionDecision",
        "testIdentity",
        "buildIdentity",
        "steadyStateEvidence",
        "faultWindow",
        "provingFaultEvidence",
        "unresolvedCaveats",
    },
    "diagnostic": {
        "diagnosticDecision",
        "numericBaselines",
        "observedSLIs",
        "telemetryQueries",
        "starvationEvidence",
        "hypothesisResults",
        "targetedPathEvidence",
        "changedPathEvidence",
        "dlqState",
        "unresolvedCaveats",
    },
    "advisory": {"advisoryState", "unresolvedCaveats"},
    "coding": {"codeChanges", "unresolvedCaveats"},
}
PHASE_REQUIRED_HANDOFF = {
    "resilience-analysis": {"analysisDecision", "unresolvedCaveats"},
    "chaos-execution": {
        "executionDecision",
        "testIdentity",
        "buildIdentity",
        "steadyStateEvidence",
        "faultWindow",
        "provingFaultEvidence",
        "unresolvedCaveats",
    },
    "diagnostic": {
        "diagnosticDecision",
        "numericBaselines",
        "observedSLIs",
        "telemetryQueries",
        "starvationEvidence",
        "hypothesisResults",
        "targetedPathEvidence",
        "changedPathEvidence",
        "dlqState",
        "unresolvedCaveats",
    },
    "advisory": {"advisoryState", "unresolvedCaveats"},
    "coding": {"codeChanges", "unresolvedCaveats"},
}


class ContractError(RuntimeError):
    pass


def utc_now() -> str:
    return dt.datetime.now(dt.timezone.utc).isoformat(timespec="milliseconds").replace(
        "+00:00", "Z"
    )


def require(condition: bool, message: str) -> None:
    if not condition:
        raise ContractError(message)


def read_json(path: Path) -> dict[str, Any]:
    try:
        with path.open("r", encoding="utf-8") as stream:
            value = json.load(stream)
    except FileNotFoundError as exc:
        raise ContractError(f"JSON file does not exist: {path}") from exc
    except json.JSONDecodeError as exc:
        raise ContractError(f"Invalid JSON in {path}: {exc}") from exc
    require(isinstance(value, dict), f"Expected a JSON object in {path}")
    return value


def atomic_write_json(path: Path, value: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary_name = tempfile.mkstemp(
        dir=str(path.parent), prefix=f".{path.name}.", suffix=".tmp"
    )
    temporary = Path(temporary_name)
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8", newline="\n") as stream:
            json.dump(value, stream, indent=2, ensure_ascii=False)
            stream.write("\n")
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)


@contextmanager
def state_lock(state_path: Path):
    lock_path = state_path.with_suffix(state_path.suffix + ".lock")
    lock_path.parent.mkdir(parents=True, exist_ok=True)
    try:
        descriptor = os.open(lock_path, os.O_CREAT | os.O_EXCL | os.O_WRONLY)
    except FileExistsError as exc:
        raise ContractError(
            f"State is locked by another controller: {lock_path}"
        ) from exc
    try:
        os.write(descriptor, f"{os.getpid()} {utc_now()}\n".encode("utf-8"))
        os.close(descriptor)
        descriptor = -1
        yield
    finally:
        if descriptor >= 0:
            try:
                os.close(descriptor)
            except OSError:
                pass
        lock_path.unlink(missing_ok=True)


def add_event(
    state: dict[str, Any],
    event_type: str,
    phase: str,
    details: dict[str, Any] | None = None,
) -> None:
    event = {
        "eventId": str(uuid.uuid4()),
        "timestamp": utc_now(),
        "revision": state["stateRevision"],
        "phase": phase,
        "type": event_type,
    }
    if details:
        event["details"] = details
    state["events"].append(event)


def new_handoff() -> dict[str, Any]:
    return {
        "analysisDecision": {},
        "executionDecision": {},
        "diagnosticDecision": {},
        "testIdentity": {},
        "buildIdentity": {},
        "steadyStateEvidence": {},
        "faultWindow": None,
        "provingFaultEvidence": {},
        "numericBaselines": [],
        "observedSLIs": [],
        "telemetryQueries": [],
        "starvationEvidence": {},
        "hypothesisResults": [],
        "targetedPathEvidence": [],
        "changedPathEvidence": [],
        "dlqState": [],
        "advisoryState": {
            "previousSetId": None,
            "currentSetId": None,
            "defaultRecommendedAdvisoryIds": [],
            "advisories": [],
            "changeLedger": {
                "added": [],
                "changed": [],
                "unchanged": [],
                "removed": [],
            },
        },
        "codeChanges": {
            "implemented": [],
            "notImplemented": [],
            "deliveryDecision": {},
        },
        "unresolvedCaveats": [],
    }


def new_workspace(request: dict[str, Any] | None, caveats: list[str] | None = None) -> dict[str, Any]:
    """Return the pending workspace preflight record persisted at run start."""
    return {
        "status": "pending",
        "request": copy.deepcopy(request),
        "decision": None,
        "selected": None,
        "alternatives": [],
        "caveats": list(caveats or []),
        "discoveryEvidence": None,
        "provisioningEvidence": None,
        "observedAt": None,
        "remediationBrief": None,
    }


# -----------------------------------------------------------------------------
# Workspace preflight: normalization
# -----------------------------------------------------------------------------


def load_json_argument(value: Any, label: str) -> dict[str, Any]:
    """Accept an inline JSON object, a JSON string, or a path to a JSON file."""
    if isinstance(value, dict):
        return copy.deepcopy(value)
    require(isinstance(value, str) and value.strip(), f"{label} is required")
    text = value.strip()
    if text.startswith("{"):
        parsed = json.loads(text)
        require(isinstance(parsed, dict), f"{label} must be a JSON object")
        return parsed
    return read_json(Path(text))


def normalize_subscription_id(value: Any, field: str = "subscriptionId") -> str:
    require(isinstance(value, str), f"{field} must be a string")
    normalized = value.strip().lower()
    require(
        UUID_PATTERN.match(normalized) is not None,
        f"{field} must be an Azure subscription UUID: {value!r}",
    )
    return normalized


def normalize_resource_group(value: Any, field: str = "resourceGroup") -> str:
    require(isinstance(value, str), f"{field} must be a string")
    normalized = value.strip()
    require(normalized != "", f"{field} cannot be empty")
    require(len(normalized) <= 90, f"{field} cannot exceed 90 characters: {value!r}")
    require(not normalized.endswith("."), f"{field} cannot end with a period: {value!r}")
    require(
        RESOURCE_GROUP_PATTERN.match(normalized) is not None,
        f"{field} contains characters Azure does not allow: {value!r}",
    )
    return normalized


def normalize_location(value: Any, field: str = "location") -> str:
    require(isinstance(value, str), f"{field} must be a string")
    normalized = re.sub(r"\s+", "", value).strip().lower()
    require(normalized != "", f"{field} cannot be empty")
    require(
        LOCATION_PATTERN.match(normalized) is not None,
        f"{field} must be an Azure region name such as 'eastus': {value!r}",
    )
    return normalized


def parse_arm_id(value: Any, field: str = "ARM ID") -> dict[str, Any]:
    """Parse a subscription-rooted ARM ID into its canonical parts.

    Supports exactly three scope kinds: a subscription, a resource group, and a
    provider resource inside a resource group. Every other shape (management
    group, tenant, subscription-level provider resource, deployment scope) is
    rejected so an ambiguous scope can never be silently accepted.
    """
    require(isinstance(value, str), f"{field} must be a string")
    raw = value.strip()
    require(raw.startswith("/"), f"{field} must start with '/': {value!r}")
    segments = raw.strip("/").split("/")
    require(all(segments), f"{field} contains an empty segment: {value!r}")
    require(
        len(segments) >= 2 and segments[0].casefold() == "subscriptions",
        f"{field} must be a subscription-rooted ARM ID: {value!r}",
    )
    subscription = normalize_subscription_id(segments[1], f"{field} subscription")
    parsed: dict[str, Any] = {
        "subscriptionId": subscription,
        "resourceGroup": None,
        "resourceType": None,
        "name": None,
        "kind": "subscription",
        "canonical": f"/subscriptions/{subscription}",
    }
    rest = segments[2:]
    if not rest:
        return parsed
    require(
        rest[0].casefold() == "resourcegroups",
        f"{field} names an unsupported scope kind: {value!r}",
    )
    require(len(rest) >= 2, f"{field} names no resource group: {value!r}")
    resource_group = normalize_resource_group(rest[1], f"{field} resourceGroup")
    parsed["resourceGroup"] = resource_group
    parsed["kind"] = "resourceGroup"
    parsed["canonical"] = f"/subscriptions/{subscription}/resourceGroups/{resource_group}"
    tail = rest[2:]
    if not tail:
        return parsed
    require(
        tail[0].casefold() == "providers",
        f"{field} names an unsupported scope kind: {value!r}",
    )
    body = tail[1:]
    require(
        len(body) >= 3 and len(body) % 2 == 1,
        f"{field} is not a complete provider resource ID: {value!r}",
    )
    namespace = body[0]
    type_segments = [body[index] for index in range(1, len(body), 2)]
    name_segments = [body[index] for index in range(2, len(body), 2)]
    parsed["kind"] = "resource"
    parsed["resourceType"] = namespace + "/" + "/".join(type_segments)
    parsed["name"] = name_segments[-1]
    parsed["canonical"] = (
        f"{parsed['canonical']}/providers/{namespace}/"
        + "/".join(
            segment
            for pair in zip(type_segments, name_segments)
            for segment in pair
        )
    )
    return parsed


def scope_covers(scope: str, resource_id: str) -> bool:
    """True when `scope` is `resource_id` or one of its ARM ancestors."""
    outer = scope.casefold().rstrip("/")
    inner = resource_id.casefold().rstrip("/")
    return inner == outer or inner.startswith(outer + "/")


def normalize_managed_scope(
    value: Any, subscription_id: str | None, field: str = "managedScopes entry"
) -> str:
    parsed = parse_arm_id(value, field)
    require(
        parsed["kind"] in {"subscription", "resourceGroup", "resource"},
        f"{field} names an unsupported scope kind: {value!r}",
    )
    if subscription_id is not None:
        require(
            parsed["subscriptionId"] == subscription_id,
            f"{field} is outside the requested subscription: {value!r}",
        )
    return parsed["canonical"]


def normalize_workspace_identity(raw: Any) -> tuple[dict[str, Any], bool]:
    """Return the normalized identity and whether the request specified one."""
    if raw is None:
        return {"type": "SystemAssigned"}, False
    require(isinstance(raw, dict), "workspaceRequest.identity must be an object")
    unsupported = sorted(set(raw) - {"type", "userAssignedIdentityResourceId"})
    require(
        not unsupported,
        f"workspaceRequest.identity has unsupported fields: {unsupported}",
    )
    raw_type = raw.get("type")
    require(isinstance(raw_type, str), "workspaceRequest.identity.type is required")
    matches = [item for item in IDENTITY_TYPES if item.casefold() == raw_type.strip().casefold()]
    require(
        len(matches) == 1,
        "workspaceRequest.identity.type must be SystemAssigned or UserAssigned",
    )
    identity_type = matches[0]
    if identity_type == "SystemAssigned":
        require(
            not raw.get("userAssignedIdentityResourceId"),
            "SystemAssigned identity cannot name a userAssignedIdentityResourceId",
        )
        return {"type": "SystemAssigned"}, True
    resource_id = raw.get("userAssignedIdentityResourceId")
    require(
        isinstance(resource_id, str) and resource_id.strip(),
        "UserAssigned identity requires exactly one userAssignedIdentityResourceId",
    )
    parsed = parse_arm_id(resource_id, "workspaceRequest.identity.userAssignedIdentityResourceId")
    require(
        parsed["kind"] == "resource"
        and parsed["resourceType"].casefold() == USER_ASSIGNED_IDENTITY_TYPE,
        "userAssignedIdentityResourceId must name a "
        "Microsoft.ManagedIdentity/userAssignedIdentities resource",
    )
    return {
        "type": "UserAssigned",
        "userAssignedIdentityResourceId": parsed["canonical"],
    }, True


def workspace_request_hash(request: dict[str, Any]) -> str:
    payload = {key: value for key, value in request.items() if key != "requestHash"}
    return hashlib.sha256(canonical(payload).encode("utf-8")).hexdigest()


def normalize_workspace_request(
    raw: Any, target_resources: list[Any]
) -> dict[str, Any]:
    """Validate and canonicalize the required workspace request.

    Every field is grounded in the real `Microsoft.Chaos/workspaces` payload:
    subscription, resource group, region, managed scopes, optional preferred
    name, and optional managed identity. Target resources must be valid ARM
    resource IDs in the same subscription and covered by a requested scope.
    """
    require(isinstance(raw, dict), "workspace-request must be a JSON object")
    supported = {
        "subscriptionId",
        "resourceGroup",
        "location",
        "managedScopes",
        "preferredName",
        "identity",
    }
    unsupported = sorted(set(raw) - supported)
    require(not unsupported, f"workspace-request has unsupported fields: {unsupported}")
    missing = sorted(
        {"subscriptionId", "resourceGroup", "location", "managedScopes"} - set(raw)
    )
    require(not missing, f"workspace-request is missing: {missing}")

    subscription = normalize_subscription_id(raw["subscriptionId"])
    resource_group = normalize_resource_group(raw["resourceGroup"])
    location = normalize_location(raw["location"])

    raw_scopes = raw["managedScopes"]
    require(
        isinstance(raw_scopes, list) and raw_scopes,
        "workspaceRequest.managedScopes must be a non-empty array",
    )
    scopes: list[str] = []
    for item in raw_scopes:
        scope = normalize_managed_scope(item, subscription)
        if scope not in scopes:
            scopes.append(scope)
    scopes.sort(key=lambda item: (item.casefold(), item))

    preferred_name = raw.get("preferredName")
    if preferred_name is not None:
        require(isinstance(preferred_name, str), "workspaceRequest.preferredName must be a string")
        preferred_name = preferred_name.strip()
        require(
            WORKSPACE_NAME_PATTERN.match(preferred_name) is not None,
            f"workspaceRequest.preferredName is not a valid workspace name: {preferred_name!r}",
        )

    identity, identity_specified = normalize_workspace_identity(raw.get("identity"))

    require(
        isinstance(target_resources, list) and target_resources,
        "target-resources must be a non-empty JSON array",
    )
    targets: list[str] = []
    for target in target_resources:
        parsed = parse_arm_id(target, "target resource")
        require(
            parsed["kind"] == "resource",
            f"Target must be a provider resource ARM ID: {target!r}",
        )
        require(
            parsed["subscriptionId"] == subscription,
            f"Target is outside the requested subscription: {target!r}",
        )
        require(
            any(scope_covers(scope, parsed["canonical"]) for scope in scopes),
            f"Target is not covered by any requested managed scope: {target!r}",
        )
        if parsed["canonical"] not in targets:
            targets.append(parsed["canonical"])

    request = {
        "subscriptionId": subscription,
        "resourceGroup": resource_group,
        "location": location,
        "managedScopes": scopes,
        "preferredName": preferred_name,
        "identity": identity,
        "identitySpecified": identity_specified,
        "targetResources": targets,
    }
    request["requestHash"] = workspace_request_hash(request)
    return request


# -----------------------------------------------------------------------------
# Workspace preflight: discovery, compatibility, and planning
# -----------------------------------------------------------------------------


def workspace_discovery_candidates(
    document: Any,
) -> tuple[list[dict[str, Any]], str, str | None]:
    """Extract candidate workspaces from a raw `chaos_list_workspaces` result."""
    require(isinstance(document, dict), "Workspace discovery must be a JSON object")
    if "ok" in document:
        require(
            document.get("ok") is True,
            "Workspace discovery reported a failed tool call; "
            f"record it with workspace-fail: {document.get('error', 'unknown error')}",
        )
        payload = document.get("result")
        require(isinstance(payload, dict), "Workspace discovery result must be an object")
    else:
        payload = document
    keys = [key for key in ("workspaces", "value") if key in payload]
    require(
        len(keys) == 1,
        "Workspace discovery must contain exactly one of 'workspaces' or 'value'",
    )
    candidates = payload[keys[0]]
    require(isinstance(candidates, list), "Workspace discovery candidates must be an array")
    scope = payload.get("scope")
    resource_group = payload.get("resourceGroup")
    require(
        scope == "resourceGroup",
        "Workspace discovery must be resource-group scoped for deterministic reuse",
    )
    require(
        isinstance(resource_group, str) and resource_group.strip(),
        "Workspace discovery must identify its resourceGroup",
    )
    return candidates, scope, resource_group.strip()


def normalize_workspace_resource(raw: Any) -> dict[str, Any]:
    """Canonicalize one `Microsoft.Chaos/workspaces` ARM resource payload."""
    require(isinstance(raw, dict), "Workspace resource must be an object")
    parsed = parse_arm_id(raw.get("id"), "workspace id")
    require(
        parsed["kind"] == "resource"
        and parsed["resourceType"].casefold() == WORKSPACE_RESOURCE_TYPE,
        f"Resource is not a Microsoft.Chaos/workspaces resource: {raw.get('id')!r}",
    )
    name = raw.get("name") or parsed["name"]
    require(isinstance(name, str) and name.strip(), "Workspace resource requires a name")
    require(
        name.strip().casefold() == parsed["name"].casefold(),
        f"Workspace name {name!r} does not match its ARM ID {raw.get('id')!r}",
    )
    properties = raw.get("properties")
    require(isinstance(properties, dict), "Workspace resource requires a properties object")
    raw_scopes = properties.get("scopes")
    require(
        isinstance(raw_scopes, list),
        "Workspace resource requires a properties.scopes array",
    )
    scopes: list[str] = []
    for item in raw_scopes:
        scope = normalize_managed_scope(item, None, "workspace properties.scopes entry")
        if scope not in scopes:
            scopes.append(scope)
    scopes.sort(key=lambda item: (item.casefold(), item))
    provisioning_state = properties.get("provisioningState")
    require(
        isinstance(provisioning_state, str) and provisioning_state.strip(),
        "Workspace resource requires properties.provisioningState",
    )
    raw_identity = raw.get("identity")
    require(isinstance(raw_identity, dict), "Workspace resource requires an identity object")
    identity_type = raw_identity.get("type")
    require(
        isinstance(identity_type, str) and identity_type.strip(),
        "Workspace identity requires a type",
    )
    user_assigned = raw_identity.get("userAssignedIdentities") or {}
    require(
        isinstance(user_assigned, dict),
        "Workspace identity.userAssignedIdentities must be an object",
    )
    user_assigned_ids = sorted(
        (
            parse_arm_id(item, "workspace userAssignedIdentities key")["canonical"]
            for item in user_assigned
        ),
        key=lambda item: item.casefold(),
    )
    return {
        "id": parsed["canonical"],
        "name": name.strip(),
        "subscriptionId": parsed["subscriptionId"],
        "resourceGroup": parsed["resourceGroup"],
        "location": normalize_location(raw.get("location"), "workspace location"),
        "identity": {
            "type": identity_type.strip(),
            "userAssignedIdentityResourceIds": user_assigned_ids,
            "principalId": raw_identity.get("principalId"),
        },
        "managedScopes": scopes,
        "provisioningState": provisioning_state.strip(),
    }


def workspace_identity_mismatch(
    request: dict[str, Any], candidate: dict[str, Any]
) -> str | None:
    """Return why a candidate identity fails the request, or None when it fits."""
    requested = request["identity"]
    observed = candidate["identity"]
    if observed["type"].casefold() != requested["type"].casefold():
        return (
            f"identity type is {observed['type']!r}, requested {requested['type']!r}"
        )
    if requested["type"] == "UserAssigned":
        expected = requested["userAssignedIdentityResourceId"].casefold()
        observed_ids = [item.casefold() for item in observed["userAssignedIdentityResourceIds"]]
        if observed_ids != [expected]:
            return (
                "user-assigned identity set is "
                f"{observed['userAssignedIdentityResourceIds']}, requested exactly "
                f"[{requested['userAssignedIdentityResourceId']}]"
            )
    return None


def workspace_incompatibility(
    request: dict[str, Any], candidate: dict[str, Any]
) -> str | None:
    """Return the first concrete reason a candidate cannot be reused, or None."""
    if candidate["subscriptionId"] != request["subscriptionId"]:
        return (
            f"workspace is in subscription {candidate['subscriptionId']}, "
            f"requested {request['subscriptionId']}"
        )
    if candidate["resourceGroup"].casefold() != request["resourceGroup"].casefold():
        return (
            f"workspace is in resource group {candidate['resourceGroup']!r}, "
            f"requested {request['resourceGroup']!r}"
        )
    if candidate["provisioningState"] != REQUIRED_PROVISIONING_STATE:
        return (
            f"provisioningState is {candidate['provisioningState']!r}, "
            f"requires {REQUIRED_PROVISIONING_STATE!r}"
        )
    if candidate["location"] != request["location"]:
        return f"region is {candidate['location']!r}, requested {request['location']!r}"
    if request["identitySpecified"]:
        mismatch = workspace_identity_mismatch(request, candidate)
        if mismatch:
            return mismatch
    uncovered_scopes = [
        scope
        for scope in request["managedScopes"]
        if not any(scope_covers(owned, scope) for owned in candidate["managedScopes"])
    ]
    if uncovered_scopes:
        return f"managed scopes do not cover requested scopes: {uncovered_scopes}"
    uncovered_targets = [
        target
        for target in request["targetResources"]
        if not any(scope_covers(owned, target) for owned in candidate["managedScopes"])
    ]
    if uncovered_targets:
        return f"managed scopes do not cover target resources: {uncovered_targets}"
    return None


def workspace_candidate_sort_key(
    request: dict[str, Any], candidate: dict[str, Any]
) -> tuple[int, int, str]:
    """Stable selection precedence: preferred name, exact scope set, then ID."""
    preferred = request.get("preferredName")
    name_rank = (
        0 if preferred and candidate["name"].casefold() == preferred.casefold() else 1
    )
    scope_rank = (
        0
        if [item.casefold() for item in candidate["managedScopes"]]
        == [item.casefold() for item in request["managedScopes"]]
        else 1
    )
    return (name_rank, scope_rank, candidate["id"].casefold())


def deterministic_workspace_name(
    request: dict[str, Any], unavailable_names: set[str] | None = None
) -> str:
    unavailable = unavailable_names or set()
    for attempt in range(100):
        digest = (
            request["requestHash"]
            if attempt == 0
            else hashlib.sha256(
                f"{request['requestHash']}:{attempt}".encode("utf-8")
            ).hexdigest()
        )
        name = GENERATED_WORKSPACE_NAME_PREFIX + digest[:12]
        require(
            WORKSPACE_NAME_PATTERN.match(name) is not None,
            f"Generated workspace name is invalid: {name!r}",
        )
        if name.casefold() not in unavailable:
            return name
    raise ContractError("Could not allocate a collision-free deterministic workspace name")


def workspace_create_request(
    request: dict[str, Any], unavailable_names: set[str] | None = None
) -> dict[str, Any]:
    unavailable = unavailable_names or set()
    preferred = request.get("preferredName")
    workspace_name = (
        preferred
        if preferred and preferred.casefold() not in unavailable
        else deterministic_workspace_name(request, unavailable)
    )
    return {
        "subscriptionId": request["subscriptionId"],
        "resourceGroup": request["resourceGroup"],
        "workspaceName": workspace_name,
        "location": request["location"],
        "scopes": list(request["managedScopes"]),
        "identity": copy.deepcopy(request["identity"]),
    }


def plan_workspace(
    request: dict[str, Any], discovery: Any, observed_at: str
) -> dict[str, Any]:
    """Deterministically decide reuse-versus-create from raw discovery output."""
    validate_utc(observed_at, "observedAt")
    candidates, discovery_scope, discovery_resource_group = workspace_discovery_candidates(
        discovery
    )
    require(
        discovery_resource_group.casefold() == request["resourceGroup"].casefold(),
        f"Workspace discovery resource group {discovery_resource_group!r} does not "
        f"match requested {request['resourceGroup']!r}",
    )
    compatible: list[dict[str, Any]] = []
    rejected: list[dict[str, str]] = []
    observed_ids: list[str] = []
    observed_names: set[str] = set()
    for raw in candidates:
        if isinstance(raw, dict) and isinstance(raw.get("name"), str):
            observed_names.add(raw["name"].strip().casefold())
        try:
            candidate = normalize_workspace_resource(raw)
        except ContractError as exc:
            rejected.append(
                {"id": str((raw or {}).get("id", "")) if isinstance(raw, dict) else "", "reason": str(exc)}
            )
            continue
        observed_ids.append(candidate["id"])
        reason = workspace_incompatibility(request, candidate)
        if reason is None:
            compatible.append(candidate)
        else:
            rejected.append({"id": candidate["id"], "reason": reason})
    compatible.sort(key=lambda item: workspace_candidate_sort_key(request, item))
    rejected.sort(key=lambda item: (item["id"].casefold(), item["reason"]))

    discovery_evidence = {
        "source": "chaos_list_workspaces",
        "scope": discovery_scope,
        "resourceGroup": discovery_resource_group,
        "observedAt": observed_at,
        "candidateCount": len(candidates),
        "candidateIds": sorted(observed_ids, key=lambda item: item.casefold()),
        "compatibleIds": [item["id"] for item in compatible],
        "rejected": rejected,
    }

    caveats: list[str] = []
    if compatible:
        selected = compatible[0]
        alternatives = [
            {
                "id": item["id"],
                "name": item["name"],
                "reason": "compatible but not selected by deterministic precedence",
            }
            for item in compatible[1:]
        ]
        if alternatives:
            caveats.append(
                f"{len(alternatives)} other compatible workspace(s) were rejected by "
                "deterministic selection precedence"
            )
        if [item.casefold() for item in selected["managedScopes"]] != [
            item.casefold() for item in request["managedScopes"]
        ]:
            caveats.append(
                "reused workspace manages a broader scope set than requested: "
                f"{selected['managedScopes']}"
            )
        if not request["identitySpecified"] and workspace_identity_mismatch(request, selected):
            caveats.append(
                "reused workspace identity is "
                f"{selected['identity']['type']!r}; the request did not pin an identity"
            )
        return {
            "decision": "reuse",
            "selected": selected,
            "createRequest": None,
            "alternatives": alternatives,
            "caveats": caveats,
            "discoveryEvidence": discovery_evidence,
        }

    if rejected:
        caveats.append(
            f"{len(rejected)} discovered workspace(s) were incompatible; a new workspace is required"
        )
    preferred = request.get("preferredName")
    if preferred and preferred.casefold() in observed_names:
        caveats.append(
            f"preferred workspace name {preferred!r} already exists but is incompatible; "
            "using a deterministic collision-free name instead"
        )
    return {
        "decision": "create",
        "selected": None,
        "createRequest": workspace_create_request(request, observed_names),
        "alternatives": [],
        "caveats": caveats,
        "discoveryEvidence": discovery_evidence,
    }


def workspace_plan_document(
    state: dict[str, Any], request: dict[str, Any], plan: dict[str, Any], observed_at: str
) -> dict[str, Any]:
    return {
        "planVersion": WORKSPACE_PLAN_VERSION,
        "contractVersion": CONTRACT_VERSION,
        "runId": state["runId"],
        "expectedStateRevision": state["stateRevision"],
        "evaluation": evaluation_stamp(),
        "requestHash": request["requestHash"],
        "observedAt": observed_at,
        "decision": plan["decision"],
        "selected": plan["selected"],
        "createRequest": plan["createRequest"],
        "alternatives": plan["alternatives"],
        "caveats": plan["caveats"],
        "discoveryEvidence": plan["discoveryEvidence"],
    }


# -----------------------------------------------------------------------------
# Workspace preflight: finalization
# -----------------------------------------------------------------------------


def validate_workspace_plan(
    state: dict[str, Any], plan: Any, expected_revision: int
) -> dict[str, Any]:
    require(isinstance(plan, dict), "Workspace plan must be a JSON object")
    require(plan.get("planVersion") == WORKSPACE_PLAN_VERSION, "Unsupported workspace planVersion")
    require(plan.get("contractVersion") == CONTRACT_VERSION, "Workspace plan contractVersion mismatch")
    require(plan.get("runId") == state["runId"], "Workspace plan runId mismatch")
    require(
        plan.get("expectedStateRevision") == expected_revision,
        "Workspace plan expectedStateRevision mismatch",
    )
    require(
        plan.get("evaluation") == evaluation_stamp(),
        "Workspace plan was not produced by the deterministic policy evaluator",
    )
    require(
        plan.get("decision") in WORKSPACE_PLAN_DECISIONS,
        "Workspace plan decision must be reuse or create",
    )
    request = state["workspace"].get("request")
    require(
        isinstance(request, dict),
        "Workspace preflight requires a normalized workspaceRequest on the run",
    )
    require(
        plan.get("requestHash") == request["requestHash"],
        "Workspace plan was produced for a different workspace request",
    )
    validate_utc(plan.get("observedAt"), "Workspace plan observedAt")
    return request


def workspace_tool_result(document: Any, label: str) -> dict[str, Any]:
    require(isinstance(document, dict), f"{label} must be a JSON object")
    if "ok" not in document:
        return document
    require(
        document.get("ok") is True,
        f"{label} reported a failed tool call: {document.get('error', 'unknown error')}",
    )
    payload = document.get("result")
    require(isinstance(payload, dict), f"{label} result must be an object")
    return payload


def verify_workspace_readback(
    request: dict[str, Any], plan: dict[str, Any], result: Any
) -> dict[str, Any]:
    """Verify the raw MCP get/create result proves the planned workspace exists.

    Raises `ContractError` with a concrete reason on any tool failure, failed
    RBAC grant, non-`Succeeded` provisioning, or readback mismatch.
    """
    decision = plan["decision"]
    role_assignments: list[dict[str, Any]] = []
    if decision == "reuse":
        payload = workspace_tool_result(result, "Workspace get result")
        resource = payload.get("workspace") if "workspace" in payload else payload
    else:
        payload = workspace_tool_result(result, "Workspace create result")
        require(
            isinstance(payload.get("workspace"), dict),
            "chaos_create_workspace result must contain the workspace readback",
        )
        resource = payload["workspace"]
        raw_assignments = payload.get("roleAssignments") or []
        require(isinstance(raw_assignments, list), "roleAssignments must be an array")
        role_assignments = [item for item in raw_assignments if isinstance(item, dict)]
        failed = [
            item
            for item in role_assignments
            if str(item.get("status", "")).casefold() not in {"granted", "already-granted"}
        ]
        require(
            not failed,
            "workspace identity role assignment did not succeed: "
            + json.dumps(failed, sort_keys=True),
        )
        assigned_scopes = {
            str(item.get("scope", "")).casefold()
            for item in role_assignments
            if str(item.get("status", "")).casefold()
            in {"granted", "already-granted"}
        }
        expected_scopes = {
            str(item).casefold() for item in plan["createRequest"]["scopes"]
        }
        require(
            assigned_scopes == expected_scopes,
            "workspace identity role assignments do not cover exactly the requested "
            f"managed scopes: expected {sorted(expected_scopes)}, "
            f"observed {sorted(assigned_scopes)}",
        )
    observed = normalize_workspace_resource(resource)
    require(
        observed["provisioningState"] == REQUIRED_PROVISIONING_STATE,
        f"workspace provisioningState is {observed['provisioningState']!r}, "
        f"requires {REQUIRED_PROVISIONING_STATE!r}",
    )
    require(
        observed["subscriptionId"] == request["subscriptionId"],
        f"workspace readback subscription {observed['subscriptionId']} "
        f"does not match the requested {request['subscriptionId']}",
    )
    if decision == "reuse":
        selected = plan["selected"]
        require(isinstance(selected, dict), "Reuse plan must name the selected workspace")
        require(
            observed["id"].casefold() == str(selected["id"]).casefold(),
            f"workspace readback {observed['id']} is not the planned workspace {selected['id']}",
        )
        require(
            observed["name"] == selected["name"],
            f"workspace readback name {observed['name']!r} is not {selected['name']!r}",
        )
        require(
            observed["location"] == selected["location"],
            f"workspace readback region {observed['location']!r} is not {selected['location']!r}",
        )
        require(
            canonical(observed["managedScopes"]) == canonical(selected["managedScopes"]),
            "workspace readback managed scopes drifted from discovery: "
            f"{observed['managedScopes']}",
        )
    else:
        create_request = plan["createRequest"]
        require(isinstance(create_request, dict), "Create plan must contain the create request")
        require(
            observed["name"] == create_request["workspaceName"],
            f"created workspace name {observed['name']!r} is not the requested "
            f"{create_request['workspaceName']!r}",
        )
        require(
            observed["resourceGroup"].casefold() == create_request["resourceGroup"].casefold(),
            f"created workspace resource group {observed['resourceGroup']!r} is not the requested "
            f"{create_request['resourceGroup']!r}",
        )
        require(
            observed["location"] == create_request["location"],
            f"created workspace region {observed['location']!r} is not the requested "
            f"{create_request['location']!r}",
        )
        require(
            canonical(observed["managedScopes"]) == canonical(sorted(create_request["scopes"], key=lambda item: (item.casefold(), item))),
            "created workspace scopes are not exactly the requested managed scopes: "
            f"{observed['managedScopes']}",
        )
    mismatch = workspace_identity_mismatch(request, observed)
    require(
        not (request["identitySpecified"] and mismatch),
        f"workspace identity does not match the request: {mismatch}",
    )
    require(
        decision == "reuse" or not mismatch,
        f"created workspace identity does not match the request: {mismatch}",
    )
    uncovered = [
        target
        for target in request["targetResources"]
        if not any(scope_covers(scope, target) for scope in observed["managedScopes"])
    ]
    require(
        not uncovered,
        f"workspace managed scopes do not cover the target resources: {uncovered}",
    )
    return {"selected": observed, "roleAssignments": role_assignments}


def workspace_remediation_brief(
    stage: str, reason: str, corrections: list[str], evidence: Any = None
) -> dict[str, Any]:
    brief = {
        "stage": stage,
        "reason": reason,
        "requiredCorrections": list(corrections),
    }
    if evidence is not None:
        brief["evidence"] = evidence
    return brief


def fail_workspace(
    state: dict[str, Any],
    brief: dict[str, Any],
    observed_at: str,
    discovery_evidence: Any = None,
    provisioning_evidence: Any = None,
) -> None:
    workspace = state["workspace"]
    workspace["status"] = "failed"
    workspace["decision"] = None
    workspace["selected"] = None
    workspace["observedAt"] = observed_at
    workspace["remediationBrief"] = brief
    if discovery_evidence is not None:
        workspace["discoveryEvidence"] = discovery_evidence
    if provisioning_evidence is not None:
        workspace["provisioningEvidence"] = provisioning_evidence
    caveat = f"workspace preflight failed at stage {brief['stage']}: {brief['reason']}"
    if caveat not in workspace["caveats"]:
        workspace["caveats"].append(caveat)
    terminate(state, "resilience-analysis", "escalated")


def validate_workspace_selection(selected: Any) -> None:
    require(isinstance(selected, dict), "Ready workspace requires the selected workspace")
    required = {
        "id",
        "name",
        "subscriptionId",
        "resourceGroup",
        "location",
        "identity",
        "managedScopes",
        "provisioningState",
    }
    missing = sorted(required - selected.keys())
    require(not missing, f"Selected workspace is missing: {missing}")
    require(
        selected["provisioningState"] == REQUIRED_PROVISIONING_STATE,
        "Selected workspace must be provisioned Succeeded",
    )
    require(
        isinstance(selected["managedScopes"], list) and selected["managedScopes"],
        "Selected workspace must record its managed scopes",
    )
    require(isinstance(selected["identity"], dict), "Selected workspace must record its identity")


def validate_workspace(workspace: Any) -> None:
    require(isinstance(workspace, dict), "state.workspace must be an object")
    required = {
        "status",
        "request",
        "decision",
        "selected",
        "alternatives",
        "caveats",
        "discoveryEvidence",
        "provisioningEvidence",
        "observedAt",
        "remediationBrief",
    }
    missing = sorted(required - workspace.keys())
    require(not missing, f"state.workspace is missing: {missing}")
    status = workspace["status"]
    require(status in WORKSPACE_STATUSES, f"Invalid workspace status: {status}")
    require(
        workspace["request"] is None or isinstance(workspace["request"], dict),
        "state.workspace.request must be an object or null",
    )
    require(isinstance(workspace["alternatives"], list), "state.workspace.alternatives must be an array")
    require(isinstance(workspace["caveats"], list), "state.workspace.caveats must be an array")
    if status == "pending":
        require(
            workspace["decision"] is None and workspace["selected"] is None,
            "A pending workspace cannot record a decision or selection",
        )
    elif status == "ready":
        require(
            workspace["decision"] in WORKSPACE_DECISIONS,
            "A ready workspace decision must be reused or created",
        )
        validate_workspace_selection(workspace["selected"])
        require(
            isinstance(workspace["discoveryEvidence"], dict),
            "A ready workspace requires discovery evidence",
        )
        require(
            isinstance(workspace["provisioningEvidence"], dict),
            "A ready workspace requires provisioning evidence",
        )
        validate_utc(workspace["observedAt"], "state.workspace.observedAt")
        require(
            workspace["remediationBrief"] is None,
            "A ready workspace cannot carry a remediation brief",
        )
    else:
        brief = workspace["remediationBrief"]
        require(isinstance(brief, dict), "A failed workspace requires a remediationBrief")
        require(brief.get("stage"), "workspace remediationBrief.stage is required")
        require(brief.get("reason"), "workspace remediationBrief.reason is required")
        require(
            brief.get("requiredCorrections"),
            "workspace remediationBrief.requiredCorrections cannot be empty",
        )


def require_ready_workspace(state: dict[str, Any]) -> None:
    workspace = state.get("workspace")
    require(isinstance(workspace, dict), "State has no workspace preflight record")
    require(
        workspace.get("status") == "ready",
        "Workspace preflight is incomplete; run workspace-plan and workspace-finalize "
        f"before any phase (status: {workspace.get('status')})",
    )
    validate_workspace_selection(workspace.get("selected"))


def migrate_state_document(
    state: dict[str, Any], workspace_request: dict[str, Any] | None = None
) -> bool:
    require(state.get("schemaVersion") == STATE_VERSION, "Unsupported state schemaVersion")
    require(
        state.get("contractVersion") == CONTRACT_VERSION,
        "Unsupported state contractVersion",
    )
    supplied_request: dict[str, Any] | None = None
    if workspace_request is not None:
        supplied_request = normalize_workspace_request(
            workspace_request,
            state.get("analysis", {}).get("scope", {}).get("targetResources", []),
        )
    needs_workspace = not isinstance(state.get("workspace"), dict)
    needs_request = (
        supplied_request is not None
        and not isinstance(state.get("workspace", {}).get("request"), dict)
    )
    if (
        state.get("policyVersion") == POLICY_VERSION
        and not needs_workspace
        and not needs_request
    ):
        return False
    if needs_workspace:
        # A policy/v1 run never proved a workspace. Migrate it to a pending
        # preflight so an in-flight run cannot skip discovery and readback.
        state["workspace"] = new_workspace(
            supplied_request,
            [
                "migrated from an earlier policy version; workspace preflight has not "
                "been proven for this run"
            ],
        )
    elif needs_request:
        state["workspace"]["request"] = copy.deepcopy(supplied_request)
    handoff = state.setdefault("handoff", {})
    handoff.setdefault("analysisDecision", {})
    handoff.setdefault("executionDecision", {})
    handoff.setdefault("diagnosticDecision", {})
    advisory = handoff.setdefault("advisoryState", {})
    advisory.setdefault("defaultRecommendedAdvisoryIds", [])
    code_changes = handoff.setdefault("codeChanges", {})
    code_changes.setdefault("deliveryDecision", {})
    if (
        state.get("phase") == "advisory"
        and state.get("transition", {}).get("status") == "blocked"
    ):
        state["phase"] = "advisory-approval"
        state["transition"]["to"] = "advisory-approval"
        state["transition"]["reason"] = "migrated advisory selection interaction"
    state["policyVersion"] = POLICY_VERSION
    return True


def validate_state(state: dict[str, Any]) -> None:
    required = {
        "schemaVersion",
        "contractVersion",
        "policyVersion",
        "runId",
        "faultId",
        "stateRevision",
        "entryMode",
        "phase",
        "iteration",
        "maxIterations",
        "verdict",
        "terminationReason",
        "analysis",
        "frozenValidation",
        "guardrails",
        "approvedAdvisoryIds",
        "attemptedFixes",
        "iterations",
        "handoff",
        "transition",
        "events",
        "workspace",
    }
    require(required <= state.keys(), f"State is missing: {sorted(required - state.keys())}")
    require(state["schemaVersion"] == STATE_VERSION, "Unsupported state schemaVersion")
    require(
        state["contractVersion"] == CONTRACT_VERSION,
        "Unsupported state contractVersion",
    )
    require(state["policyVersion"] == POLICY_VERSION, "State requires policy migration")
    require(state["phase"] in PHASES, f"Invalid phase: {state['phase']}")
    require(
        isinstance(state["stateRevision"], int) and state["stateRevision"] >= 0,
        "stateRevision must be a non-negative integer",
    )
    require(
        isinstance(state["iteration"], int) and state["iteration"] >= 0,
        "iteration must be a non-negative integer",
    )
    require(
        isinstance(state["maxIterations"], int) and state["maxIterations"] >= 1,
        "maxIterations must be at least one",
    )
    if state["phase"] == "terminated":
        require(
            state["terminationReason"] in TERMINATION_REASONS,
            "A terminated run needs an allowed terminationReason",
        )
        require(
            state["verdict"] == state["terminationReason"],
            "verdict must equal terminationReason for a terminated run",
        )
    else:
        require(state["verdict"] == "in-progress", "Active run verdict must be in-progress")
        require(state["terminationReason"] is None, "Active run cannot have terminationReason")
    if state["transition"]["status"] == "blocked":
        require(
            state["phase"] in INTERACTION_PHASES,
            "Only advisory-approval and awaiting-external-gate may block",
        )
        require(
            state["transition"]["to"] == state["phase"],
            "Blocked transition must target its interaction phase",
        )
    if state["phase"] in INTERACTION_PHASES:
        require(
            state["transition"]["status"] == "blocked",
            f"{state['phase']} must be represented as a blocked interaction state",
        )
    require(isinstance(state["events"], list), "events must be an array")
    for event in state["events"]:
        require(UTC_PATTERN.match(event["timestamp"]) is not None, "Event timestamp must be UTC")
    validate_workspace(state["workspace"])


def validate_revision(state: dict[str, Any], expected: int) -> None:
    require(
        state["stateRevision"] == expected,
        f"Stale state revision: expected {expected}, observed {state['stateRevision']}",
    )


def deep_merge(target: dict[str, Any], patch: dict[str, Any]) -> None:
    for key, value in patch.items():
        if isinstance(value, dict) and isinstance(target.get(key), dict):
            deep_merge(target[key], value)
        else:
            target[key] = copy.deepcopy(value)


def canonical(value: Any) -> str:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


def validate_utc(value: Any, field: str) -> None:
    require(isinstance(value, str) and UTC_PATTERN.match(value) is not None, f"{field} must be UTC")


def validate_hypothesis(hypothesis: dict[str, Any]) -> None:
    required = {
        "hypothesisId",
        "rank",
        "statement",
        "codeOrIaCEvidence",
        "matchingFault",
        "steadyStatePredicates",
        "workExpected",
        "provingFault",
        "confirmPredicate",
        "executedCodePathPredicate",
    }
    require(
        required <= hypothesis.keys(),
        f"Hypothesis is missing: {sorted(required - hypothesis.keys())}",
    )
    require(isinstance(hypothesis["matchingFault"], dict), "matchingFault must be exactly one object")
    validate_frozen_validation(hypothesis["matchingFault"])
    require(len(hypothesis["steadyStatePredicates"]) > 0, "steadyStatePredicates cannot be empty")
    require(hypothesis["workExpected"].get("predicate"), "workExpected.predicate is required")
    require(hypothesis["workExpected"].get("query"), "workExpected.query is required")
    proving = hypothesis["provingFault"]
    require(proving.get("predicate"), "provingFault.predicate is required")
    require(proving.get("requiredEvidence"), "provingFault.requiredEvidence is required")
    require(proving.get("queryOrSource"), "provingFault.queryOrSource is required")
    confirm = hypothesis["confirmPredicate"]
    for field in (
        "predicate",
        "telemetryQuery",
        "metric",
        "operator",
        "threshold",
        "unit",
        "window",
    ):
        require(field in confirm and confirm[field] != "", f"confirmPredicate.{field} is required")
    require(
        confirm["operator"] in {">", ">=", "<", "<=", "==", "!="},
        "confirmPredicate.operator is invalid",
    )
    path = hypothesis["executedCodePathPredicate"]
    require(path.get("predicate"), "executedCodePathPredicate.predicate is required")
    require(path.get("queryOrTrace"), "executedCodePathPredicate.queryOrTrace is required")
    inputs = hypothesis.get("rankingInputs", {})
    expected_score = (
        inputs.get("likelihood", 0)
        * inputs.get("blastRadius", 0)
        * inputs.get("falsifiability", 0)
    )
    require(
        hypothesis.get("learningScore") == expected_score and expected_score > 0,
        "learningScore must equal the deterministic ranking-input product",
    )


def validate_frozen_validation(frozen: dict[str, Any]) -> None:
    required = {
        "scenarioName",
        "configurationName",
        "faultType",
        "parameters",
        "targetResources",
        "blastRadius",
        "duration",
    }
    require(required == frozen.keys(), "Frozen validation must contain only its seven identity fields")
    require(frozen["scenarioName"], "scenarioName is required")
    require(frozen["configurationName"], "configurationName is required")
    require(frozen["faultType"], "faultType is required")
    require(isinstance(frozen["parameters"], dict), "parameters must be an object")
    require(len(frozen["targetResources"]) > 0, "targetResources cannot be empty")
    require(frozen["duration"], "duration is required")
    require(frozen["blastRadius"].get("scope"), "blastRadius.scope is required")
    require(frozen["blastRadius"].get("targets"), "blastRadius.targets cannot be empty")


def arm_resource_type(resource_id: str) -> str:
    match = re.search(r"/providers/(.+)$", resource_id, re.IGNORECASE)
    require(match is not None, f"Target is not a valid ARM resource ID: {resource_id}")
    parts = [item for item in match.group(1).split("/") if item]
    require(len(parts) >= 3, f"Target is not a complete ARM resource ID: {resource_id}")
    namespace = parts[0]
    type_segments = [parts[index] for index in range(1, len(parts), 2)]
    return namespace + "/" + "/".join(type_segments)


def scenario_catalog_entry(scenario_name: str) -> dict[str, Any]:
    catalog = read_json(CATALOG_PATH)
    require(
        catalog.get("schemaVersion") == "chaos-loop-scenario-catalog/v1",
        "Unsupported Scenario catalog version",
    )
    matches = [
        entry
        for entry in catalog.get("scenarios", [])
        if re.match(entry["namePattern"], scenario_name)
    ]
    if matches:
        matches.sort(
            key=lambda entry: (
                -entry.get("priority", 0),
                -len(entry["namePattern"]),
                entry["family"].casefold(),
            )
        )
        return matches[0]
    raise ContractError(f"Scenario is not in the supported catalog: {scenario_name}")


def validate_scenario_eligibility(hypothesis: dict[str, Any]) -> None:
    fault = hypothesis["matchingFault"]
    entry = scenario_catalog_entry(fault["scenarioName"])
    allowed = {item.lower() for item in entry["allowedResourceTypes"]}
    observed = {
        arm_resource_type(item).lower() for item in fault["targetResources"]
    }
    require(
        observed <= allowed,
        f"Scenario targets include unsupported resource types: {sorted(observed - allowed)}",
    )
    eligibility = hypothesis.get("scenarioEligibility")
    require(isinstance(eligibility, dict), "scenarioEligibility is required")
    require(
        eligibility.get("discovered") is True,
        "Scenario must be present in workspace discovery",
    )
    require(
        eligibility.get("configurationValidated") is True,
        "Scenario configuration must already be validated",
    )
    require(
        eligibility.get("safetyEligible") is True,
        "Hypothesis is not safety eligible",
    )


def deterministic_rank(hypotheses: list[dict[str, Any]]) -> list[dict[str, Any]]:
    ranked: list[dict[str, Any]] = []
    for hypothesis in hypotheses:
        inputs = hypothesis.get("rankingInputs")
        require(isinstance(inputs, dict), "rankingInputs is required")
        values = []
        for field in ("likelihood", "blastRadius", "falsifiability"):
            value = inputs.get(field)
            require(
                isinstance(value, int) and 1 <= value <= 5,
                f"rankingInputs.{field} must be an integer from 1 to 5",
            )
            values.append(value)
        normalized = copy.deepcopy(hypothesis)
        normalized.setdefault("rank", 0)
        normalized["learningScore"] = values[0] * values[1] * values[2]
        validate_hypothesis(normalized)
        validate_scenario_eligibility(normalized)
        ranked.append(normalized)
    ranked.sort(
        key=lambda item: (-item["learningScore"], item["hypothesisId"].casefold())
    )
    for index, hypothesis in enumerate(ranked, start=1):
        hypothesis["rank"] = index
    return ranked


def calculate_numeric_evidence(result: dict[str, Any]) -> None:
    for sli in result.get("observedSLIs", []):
        current = sli.get("value")
        baseline = sli.get("baselineValue")
        if current is None or baseline is None:
            sli["absoluteDelta"] = None
            sli["relativeDeltaPercent"] = None
            continue
        sli["absoluteDelta"] = current - baseline
        sli["relativeDeltaPercent"] = (
            None if baseline == 0 else ((current - baseline) / baseline) * 100.0
        )
    for dlq in result.get("dlqState", []):
        baseline = dlq.get("baselineCount")
        current = dlq.get("currentCount", dlq.get("faultWindowCount"))
        dlq["delta"] = (
            None if baseline is None or current is None else current - baseline
        )
        if dlq.get("oldestEnqueuedTime") and dlq.get("windowEndTime"):
            start = dt.datetime.fromisoformat(
                dlq["oldestEnqueuedTime"].replace("Z", "+00:00")
            )
            end = dt.datetime.fromisoformat(
                dlq["windowEndTime"].replace("Z", "+00:00")
            )
            dlq["oldestMessageAgeSeconds"] = max(
                0, int((end - start).total_seconds())
            )


def deterministic_verdict(
    hypothesis_result: dict[str, Any], mode: str
) -> str:
    exercised = (
        hypothesis_result.get("provingFault", {}).get("satisfied") is True
        and hypothesis_result.get("eligibleWorkObserved") is True
        and bool(hypothesis_result.get("executedCodePathEvidence"))
        and hypothesis_result.get("telemetryAvailable", True) is True
    )
    if mode == "verify":
        exercised = exercised and hypothesis_result.get("changedCodePathObserved") is True
    if not exercised:
        return "NOT EXERCISED"
    evaluated = hypothesis_result.get("confirmPredicate", {}).get("evaluatedTrue")
    require(isinstance(evaluated, bool), "confirmPredicate.evaluatedTrue must be boolean")
    return "CONFIRMED" if evaluated else "REFUTED"


def deterministic_diagnostic_route(
    verdict: str,
    mode: str,
    backlog: bool,
    slo_holds: bool,
    iteration: int,
    max_iterations: int,
    fixable: bool,
) -> tuple[str, str, str]:
    if verdict == "NOT EXERCISED":
        return "exercise-repair", "ready", "resilience-analysis"
    if mode == "initial":
        if verdict == "CONFIRMED":
            return (
                ("advisory", "ready", "advisory")
                if fixable
                else ("no-remediation", "terminated", "terminated")
            )
        return (
            ("next-ranked-hypothesis", "ready", "resilience-analysis")
            if backlog
            else ("no-impact", "terminated", "terminated")
        )
    if verdict == "REFUTED":
        if slo_holds:
            return (
                ("next-ranked-hypothesis", "ready", "resilience-analysis")
                if backlog
                else ("resolved", "terminated", "terminated")
            )
        return (
            ("next-ranked-hypothesis", "ready", "resilience-analysis")
            if backlog
            else ("escalated", "terminated", "terminated")
        )
    return (
        ("escalated", "terminated", "terminated")
        if iteration >= max_iterations
        else ("advisory", "ready", "advisory")
    )


def stable_advisory_score(advisory: dict[str, Any]) -> float:
    inputs = advisory.get("rankingInputs")
    require(isinstance(inputs, dict), "Advisory rankingInputs is required")
    evidence = inputs.get("evidenceStrength")
    gain = inputs.get("expectedGain")
    risk = inputs.get("implementationRisk")
    for name, value in (
        ("evidenceStrength", evidence),
        ("expectedGain", gain),
        ("implementationRisk", risk),
    ):
        require(
            isinstance(value, int) and 1 <= value <= 5,
            f"Advisory rankingInputs.{name} must be an integer from 1 to 5",
        )
    return (evidence * gain) / risk


def advisory_ledger(
    prior: list[dict[str, Any]], current: list[dict[str, Any]]
) -> dict[str, Any]:
    prior_by_id = {item["advisoryId"]: item for item in prior}
    current_by_id = {item["advisoryId"]: item for item in current}
    added = sorted(set(current_by_id) - set(prior_by_id))
    removed = sorted(set(prior_by_id) - set(current_by_id))
    changed: list[str] = []
    unchanged: list[str] = []
    for advisory_id in sorted(set(prior_by_id) & set(current_by_id)):
        prior_value = {
            key: value
            for key, value in prior_by_id[advisory_id].items()
            if key not in {"rank", "rankingScore"}
        }
        current_value = {
            key: value
            for key, value in current_by_id[advisory_id].items()
            if key not in {"rank", "rankingScore"}
        }
        (unchanged if canonical(prior_value) == canonical(current_value) else changed).append(
            advisory_id
        )
    digest = hashlib.sha256(canonical(current).encode("utf-8")).hexdigest()[:12]
    return {
        "previousSetId": None,
        "currentSetId": f"advisory-set-{digest}",
        "added": [{"advisoryId": item} for item in added],
        "changed": [{"advisoryId": item} for item in changed],
        "unchanged": [{"advisoryId": item} for item in unchanged],
        "removed": [{"advisoryId": item} for item in removed],
    }


def validate_phase_envelope(
    state: dict[str, Any], output: dict[str, Any], phase: str, expected_revision: int
) -> None:
    require(output.get("contractVersion") == CONTRACT_VERSION, "Phase contractVersion mismatch")
    require(output.get("runId") == state["runId"], "Phase runId mismatch")
    require(output.get("expectedStateRevision") == expected_revision, "Phase expectedStateRevision mismatch")
    require(output.get("phase") == phase, "Phase output names the wrong phase")
    require(
        output.get("evaluation") == evaluation_stamp(),
        "Phase output was not produced by the deterministic policy evaluator",
    )
    require(isinstance(output.get("result"), dict), "Phase result must be an object")
    handoff = output.get("handoff")
    require(isinstance(handoff, dict), "handoff must be an object")
    forbidden = set(handoff) - PHASE_OWNERSHIP[phase]
    require(not forbidden, f"{phase} attempted to write unowned handoff fields: {sorted(forbidden)}")
    missing = PHASE_REQUIRED_HANDOFF[phase] - set(handoff)
    require(
        not missing,
        f"{phase} handoff is incomplete; missing fields: {sorted(missing)}",
    )
    transition = output.get("transition")
    require(isinstance(transition, dict), "transition must be an object")
    require(
        transition.get("status") in {"ready", "terminated"},
        "Phase transition.status must be ready or terminated; phases cannot create interaction blocks",
    )
    require(transition.get("from") == phase, "transition.from must equal the current phase")
    require(
        transition.get("to") in PHASES,
        "transition.to must name a valid Chaos Loop phase",
    )
    require(transition.get("reason"), "transition.reason is required")


def require_transition(
    output: dict[str, Any], status: str, target: str
) -> None:
    transition = output["transition"]
    require(
        transition["status"] == status,
        f"Phase decision requires transition.status={status}",
    )
    require(
        transition["to"] == target,
        f"Phase decision requires transition.to={target}",
    )


def selected_hypothesis(state: dict[str, Any]) -> dict[str, Any]:
    selected_id = state["analysis"].get("selectedHypothesisId")
    for hypothesis in state["analysis"].get("hypotheses", []):
        if hypothesis["hypothesisId"] == selected_id:
            return hypothesis
    raise ContractError("Selected hypothesis is absent from analysis.hypotheses")


def next_ranked_exists(state: dict[str, Any]) -> bool:
    selected = selected_hypothesis(state)
    return any(
        item["rank"] > selected["rank"] for item in state["analysis"].get("hypotheses", [])
    )


def set_transition(
    state: dict[str, Any], status: str, source: str, target: str | None, reason: str
) -> None:
    state["transition"] = {
        "status": status,
        "from": source,
        "to": target,
        "reason": reason,
    }


def terminate(state: dict[str, Any], source: str, reason: str) -> None:
    require(reason in TERMINATION_REASONS, f"Invalid termination reason: {reason}")
    state["phase"] = "terminated"
    state["verdict"] = reason
    state["terminationReason"] = reason
    set_transition(state, "terminated", source, "terminated", reason)


def apply_analysis(state: dict[str, Any], output: dict[str, Any]) -> None:
    result = output["result"]
    mode = result.get("mode")
    require(mode in {"initial", "reassess"}, "Analysis mode must be initial or reassess")
    decision = result.get("analysisHandoff")
    require(isinstance(decision, dict), "Analysis requires analysisHandoff")
    require(
        canonical(state["handoff"]["analysisDecision"]) == canonical(decision),
        "Analysis handoff.analysisDecision must equal result.analysisHandoff",
    )
    disposition = decision.get("disposition")
    require(
        disposition in {"executable", "repair", "escalated"},
        "Analysis disposition must be executable, repair, or escalated",
    )
    if disposition == "repair":
        require_transition(output, "ready", "resilience-analysis")
        repair = decision.get("repairBrief")
        require(isinstance(repair, dict), "Analysis repair requires repairBrief")
        require(repair.get("reason"), "Analysis repairBrief.reason is required")
        require(
            repair.get("requiredCorrections"),
            "Analysis repairBrief.requiredCorrections cannot be empty",
        )
        state["analysis"]["mode"] = mode
        state["analysis"]["routingIntent"] = (
            "repair-verify-exercise" if mode == "reassess" else "repair-exercise"
        )
        state["phase"] = "resilience-analysis"
        set_transition(
            state,
            "ready",
            "resilience-analysis",
            "resilience-analysis",
            repair["reason"],
        )
        return
    if disposition == "escalated":
        require_transition(output, "terminated", "terminated")
        terminate(state, "resilience-analysis", "escalated")
        return

    require_transition(output, "ready", "chaos-execution")
    hypotheses = result.get("hypotheses")
    require(isinstance(hypotheses, list) and hypotheses, "Analysis must return ranked hypotheses")
    for hypothesis in hypotheses:
        validate_hypothesis(hypothesis)
    ids = [item["hypothesisId"] for item in hypotheses]
    ranks = [item["rank"] for item in hypotheses]
    require(len(ids) == len(set(ids)), "Hypothesis IDs must be unique")
    require(len(ranks) == len(set(ranks)), "Hypothesis ranks must be unique")
    require(ranks == sorted(ranks), "Hypotheses must be ordered by rank")
    deterministic_order = [
        item["hypothesisId"]
        for item in sorted(
            hypotheses,
            key=lambda item: (
                -item["learningScore"],
                item["hypothesisId"].casefold(),
            ),
        )
    ]
    require(
        ids == deterministic_order,
        "Hypotheses are not in deterministic score/ID order",
    )
    selected_id = result.get("selectedHypothesisId")
    require(selected_id in ids, "selectedHypothesisId is not in hypotheses")
    selected = next(item for item in hypotheses if item["hypothesisId"] == selected_id)
    intent = state["analysis"].get("routingIntent", "select-initial")
    if intent == "select-initial":
        require(
            selected["rank"] == min(ranks),
            "Analysis must select the highest-ranked eligible hypothesis",
        )
    elif intent == "next-ranked":
        prior = selected_hypothesis(state)
        remaining_ranks = [rank for rank in ranks if rank > prior["rank"]]
        require(remaining_ranks, "No next-ranked hypothesis remains")
        require(
            selected["rank"] == min(remaining_ranks),
            "Analysis must select the highest-ranked remaining hypothesis",
        )

    selected_test_design = {
        "hypothesisId": selected_id,
        "frozenValidation": selected["matchingFault"],
        "steadyStatePredicates": selected["steadyStatePredicates"],
        "workExpected": selected["workExpected"],
        "provingFault": selected["provingFault"],
        "confirmPredicate": selected["confirmPredicate"],
        "executedCodePathPredicate": selected["executedCodePathPredicate"],
    }
    require(
        canonical(decision.get("selectedTestDesign"))
        == canonical(selected_test_design),
        "Analysis handoff must contain the complete selected executable test design",
    )
    require(
        decision.get("selectedHypothesisId") == selected_id,
        "Analysis handoff selectedHypothesisId mismatch",
    )

    if mode == "reassess":
        require(
            intent in {"reassess-identical", "repair-verify-exercise"},
            "Reassess mode is allowed only after the external gate or a verify exercise repair",
        )
        original = selected_hypothesis(state)
        require(selected_id == state["analysis"]["originalHypothesisId"], "Reassess changed the hypothesis ID")
        for field in ("statement", "provingFault", "confirmPredicate"):
            require(
                canonical(selected[field]) == canonical(original[field]),
                f"Reassess changed original hypothesis field: {field}",
            )
        require(
            canonical(selected["matchingFault"]) == canonical(state["frozenValidation"]),
            "Reassess changed the frozen validation fault",
        )
        state["analysis"]["mode"] = "reassess"
        state["analysis"]["reassessment"] = copy.deepcopy(result)
        state["analysis"]["routingIntent"] = "selected-verification"
    else:
        require(intent != "reassess-identical", "Post-gate analysis must use reassess mode")
        if intent == "repair-exercise":
            prior = selected_hypothesis(state)
            require(selected_id == prior["hypothesisId"], "Exercise repair changed selected hypothesis")
            require(
                canonical(selected["matchingFault"]) == canonical(state["frozenValidation"]),
                "Exercise repair changed the frozen fault",
            )
        elif intent == "next-ranked":
            prior = selected_hypothesis(state)
            require(selected["rank"] > prior["rank"], "Next hypothesis must have a lower priority rank")
        state["analysis"] = copy.deepcopy(result)
        state["analysis"]["routingIntent"] = "selected"
        state["analysis"]["originalHypothesisId"] = selected_id
        state["frozenValidation"] = copy.deepcopy(selected["matchingFault"])
        if state["faultId"] is None or intent == "next-ranked":
            stamp = dt.datetime.now(dt.timezone.utc).strftime("%Y%m%dT%H%M%SZ")
            state["faultId"] = f"{selected['matchingFault']['scenarioName']}-{stamp}"

    state["phase"] = "chaos-execution"
    set_transition(
        state,
        "ready",
        "resilience-analysis",
        "chaos-execution",
        "ranked falsifiable hypothesis and one matching fault validated",
    )


def apply_execution(state: dict[str, Any], output: dict[str, Any]) -> None:
    result = output["result"]
    expected_kind = "verify" if state["analysis"]["mode"] == "reassess" else "initial"
    require(result.get("mode") == expected_kind, f"Execution mode must be {expected_kind}")
    require(
        canonical(result.get("frozenValidation")) == canonical(state["frozenValidation"]),
        "Execution fault drifted from frozenValidation",
    )
    decision = result.get("executionHandoff")
    require(isinstance(decision, dict), "Execution requires executionHandoff")
    require(
        canonical(state["handoff"]["executionDecision"]) == canonical(decision),
        "Execution handoff.executionDecision must equal result.executionHandoff",
    )
    disposition = decision.get("disposition")
    require(
        disposition in {"diagnostic-eligible", "repair-analysis", "unsafe"},
        "Execution disposition is invalid",
    )
    for field in (
        "testIdentity",
        "buildIdentity",
        "steadyStateEvidence",
        "faultWindow",
    ):
        require(
            canonical(state["handoff"].get(field)) == canonical(result.get(field)),
            f"Execution handoff.{field} must equal result.{field}",
        )
    require(
        canonical(state["handoff"].get("provingFaultEvidence"))
        == canonical(result.get("faultEvidence")),
        "Execution handoff.provingFaultEvidence must equal result.faultEvidence",
    )
    if disposition == "repair-analysis":
        require_transition(output, "ready", "resilience-analysis")
        repair = decision.get("repairBrief")
        require(isinstance(repair, dict), "Execution repair requires repairBrief")
        require(
            repair.get("failureClass")
            in {"build-identity", "steady-state", "fault-design", "fault-proof"},
            "Execution repairBrief.failureClass is invalid",
        )
        require(repair.get("evidence"), "Execution repairBrief.evidence cannot be empty")
        require(
            repair.get("requiredCorrections"),
            "Execution repairBrief.requiredCorrections cannot be empty",
        )
        state["analysis"]["routingIntent"] = (
            "repair-verify-exercise"
            if expected_kind == "verify"
            else "repair-exercise"
        )
        state["phase"] = "resilience-analysis"
        set_transition(
            state,
            "ready",
            "chaos-execution",
            "resilience-analysis",
            repair.get("reason") or "mechanical exercise repair required",
        )
        return
    if disposition == "unsafe":
        require_transition(output, "terminated", "terminated")
        require(decision.get("evidence"), "Unsafe execution requires named evidence")
        terminate(state, "chaos-execution", "escalated")
        return

    require_transition(output, "ready", "diagnostic")
    build = result.get("buildIdentity", {})
    require(build.get("live") is True, "Intended build is not proven live")
    steady = result.get("steadyStateEvidence", {})
    require(steady.get("passed") is True, "Steady state did not pass")
    fault = result.get("faultEvidence", {})
    require(fault.get("faultLanded") is True, "Fault did not land on the intended target")
    require(fault.get("evidence"), "Fault-landed evidence is required")
    window = result.get("faultWindow", {})
    validate_utc(window.get("startTime"), "faultWindow.startTime")
    validate_utc(window.get("endTime"), "faultWindow.endTime")
    run = result.get("run", {})
    require(run.get("status") in {"completed", "aborted", "rolled-back"}, "Invalid run status")
    require(run.get("status") == "completed", "Only a completed run may reach Diagnostic")
    require(run.get("recoveryEvidence"), "Recovery evidence is required")
    state["iterations"].append(
        {
            "iteration": state["iteration"],
            "mode": expected_kind,
            "execution": copy.deepcopy(result),
        }
    )
    state["phase"] = "diagnostic"
    set_transition(
        state,
        "ready",
        "chaos-execution",
        "diagnostic",
        "build, steady state, fault landing, window, and recovery proven",
    )


def validate_bounded_critique(result: dict[str, Any], phase: str) -> None:
    critique = result.get("boundedCritique")
    require(isinstance(critique, dict), f"{phase} requires boundedCritique")
    require(critique.get("critiqueCount") == 1, f"{phase} must perform exactly one critique")
    require(critique.get("rewriteCount") == 1, f"{phase} must perform exactly one rewrite")
    require(critique.get("checks"), f"{phase} boundedCritique.checks cannot be empty")


def validate_numeric_evidence(result: dict[str, Any]) -> None:
    caveats = result.get("unresolvedCaveats", [])
    require(isinstance(caveats, list), "Diagnostic unresolvedCaveats must be an array")
    for baseline in result.get("numericBaselines", []):
        for field in ("metric", "value", "unit", "window", "query", "source"):
            require(field in baseline, f"Numeric baseline is missing {field}")
        if baseline["value"] is None:
            require(baseline.get("caveat"), "Null numeric baseline requires an item caveat")
        if baseline["value"] == 0:
            require(baseline.get("query"), "Measured zero baseline requires its query")
    for sli in result.get("observedSLIs", []):
        require(sli.get("query"), "Observed SLI requires its query")
        for field in (
            "value",
            "baselineValue",
            "absoluteDelta",
            "relativeDeltaPercent",
            "sloTarget",
        ):
            if field not in sli:
                continue
            if sli[field] is None:
                require(
                    sli.get("caveat") or caveats,
                    f"Null observed SLI {field} requires a caveat",
                )
            if sli[field] == 0:
                require(sli.get("query"), f"Measured zero observed SLI {field} requires its query")
    for dlq in result.get("dlqState", []):
        require(dlq.get("query"), "DLQ state requires its query")
        for field in (
            "baselineCount",
            "currentCount",
            "faultWindowCount",
            "delta",
            "oldestMessageAgeSeconds",
        ):
            if field not in dlq:
                continue
            if dlq[field] is None:
                require(dlq.get("caveat") or caveats, f"Null DLQ {field} requires a caveat")
            if dlq[field] == 0:
                require(dlq.get("query"), f"Measured zero DLQ {field} requires its query")


def apply_diagnostic(
    state: dict[str, Any],
    output: dict[str, Any],
    prior_handoff: dict[str, Any],
) -> None:
    result = output["result"]
    expected_mode = "verify" if state["analysis"]["mode"] == "reassess" else "initial"
    require(result.get("mode") == expected_mode, f"Diagnostic mode must be {expected_mode}")
    validate_bounded_critique(result, "Diagnostic")
    validate_numeric_evidence(result)
    decision = result.get("diagnosticHandoff")
    require(isinstance(decision, dict), "Diagnostic requires diagnosticHandoff")
    require(
        canonical(state["handoff"]["diagnosticDecision"]) == canonical(decision),
        "Diagnostic handoff.diagnosticDecision must equal result.diagnosticHandoff",
    )
    results = result.get("hypothesisResults")
    require(isinstance(results, list) and len(results) == 1, "Exactly one selected hypothesis is in scope")
    hypothesis_result = results[0]
    require(
        canonical(state["handoff"].get("hypothesisResults")) == canonical(results),
        "Diagnostic handoff.hypothesisResults must equal result.hypothesisResults",
    )
    for field in (
        "numericBaselines",
        "observedSLIs",
        "telemetryQueries",
        "starvationEvidence",
        "dlqState",
    ):
        require(
            canonical(state["handoff"].get(field)) == canonical(result.get(field, [] if field != "starvationEvidence" else {})),
            f"Diagnostic handoff.{field} must equal result.{field}",
        )
    require(
        hypothesis_result.get("hypothesisId") == state["analysis"]["selectedHypothesisId"],
        "Diagnostic result does not match selected hypothesis",
    )
    verdict = hypothesis_result.get("verdict")
    require(verdict in VERDICTS, "Diagnostic verdict is invalid")
    require(decision.get("verdict") == verdict, "Diagnostic handoff verdict mismatch")
    require(
        decision.get("hypothesisId") == state["analysis"]["selectedHypothesisId"],
        "Diagnostic handoff hypothesisId mismatch",
    )
    require(
        hypothesis_result.get("workStarvationChecked") is True,
        "Work starvation must be checked before verdict",
    )
    if verdict in {"CONFIRMED", "REFUTED"}:
        require(
            hypothesis_result.get("provingFault", {}).get("satisfied") is True,
            f"{verdict} requires proven fault landing",
        )
        require(
            hypothesis_result.get("eligibleWorkObserved") is True,
            f"{verdict} requires eligible work",
        )
        require(
            hypothesis_result.get("executedCodePathEvidence"),
            f"{verdict} requires targeted path execution evidence",
        )
        predicate = hypothesis_result.get("confirmPredicate", {})
        require(predicate.get("telemetryQuery"), f"{verdict} requires a telemetry query")
        require(predicate.get("observedValue") is not None, f"{verdict} requires a measured value")
    if expected_mode == "verify" and verdict in {"CONFIRMED", "REFUTED"}:
        require(
            hypothesis_result.get("changedCodePathObserved") is True,
            "Verify verdict requires observed changed-path execution",
        )
    if expected_mode == "verify":
        require(
            canonical(result.get("numericBaselines", []))
            == canonical(prior_handoff.get("numericBaselines", [])),
            "Verify Diagnostic must preserve initial numeric baselines exactly",
        )
        prior_dlq = {
            item.get("entity"): item
            for item in prior_handoff.get("dlqState", [])
            if item.get("entity")
        }
        current_dlq = {
            item.get("entity"): item
            for item in result.get("dlqState", [])
            if item.get("entity")
        }
        require(
            set(prior_dlq) <= set(current_dlq),
            "Verify Diagnostic dropped a prior DLQ entity",
        )
        for entity, prior in prior_dlq.items():
            current = current_dlq[entity]
            require(
                current.get("baselineCount") == prior.get("baselineCount"),
                f"Verify Diagnostic changed DLQ baseline for {entity}",
            )
            require(
                current.get("query") == prior.get("query"),
                f"Verify Diagnostic changed DLQ query for {entity}",
            )

    if verdict == "NOT EXERCISED":
        require_transition(output, "ready", "resilience-analysis")
        require(
            decision.get("route") == "exercise-repair",
            "NOT EXERCISED must decisively route to exercise-repair",
        )
        repair = decision.get("exerciseRepairBrief")
        require(isinstance(repair, dict), "NOT EXERCISED requires exerciseRepairBrief")
        require(repair.get("reason"), "exerciseRepairBrief.reason is required")
        require(
            repair.get("requiredCorrections"),
            "exerciseRepairBrief.requiredCorrections cannot be empty",
        )
        if expected_mode == "verify":
            state["analysis"]["mode"] = "reassess"
            state["analysis"]["routingIntent"] = "repair-verify-exercise"
        else:
            state["analysis"]["mode"] = "initial"
            state["analysis"]["routingIntent"] = "repair-exercise"
        state["phase"] = "resilience-analysis"
        set_transition(
            state,
            "ready",
            "diagnostic",
            "resilience-analysis",
            f"{expected_mode} exercise proof is incomplete; repair the same frozen exercise",
        )
        return

    if expected_mode == "initial":
        if verdict == "CONFIRMED":
            fixable_ids = result.get("fixableConfirmedHypothesisIds", [])
            if state["analysis"]["selectedHypothesisId"] in fixable_ids:
                require_transition(output, "ready", "advisory")
                require(
                    decision.get("route") == "advisory",
                    "Fixable CONFIRMED must decisively route to Advisory",
                )
                state["phase"] = "advisory"
                set_transition(
                    state,
                    "ready",
                    "diagnostic",
                    "advisory",
                    "fixable CONFIRMED hypothesis has measured evidence",
                )
            else:
                require_transition(output, "terminated", "terminated")
                require(
                    decision.get("route") == "no-remediation",
                    "Non-fixable CONFIRMED must terminate no-remediation",
                )
                terminate(state, "diagnostic", "no-remediation")
        elif next_ranked_exists(state):
            require_transition(output, "ready", "resilience-analysis")
            require(
                decision.get("route") == "next-ranked-hypothesis",
                "REFUTED with backlog must route to next ranked hypothesis",
            )
            state["analysis"]["mode"] = "initial"
            state["analysis"]["routingIntent"] = "next-ranked"
            state["phase"] = "resilience-analysis"
            set_transition(
                state,
                "ready",
                "diagnostic",
                "resilience-analysis",
                "selected hypothesis refuted; select the next ranked hypothesis",
            )
        else:
            require_transition(output, "terminated", "terminated")
            require(
                decision.get("route") == "no-impact",
                "REFUTED without backlog must terminate no-impact",
            )
            terminate(state, "diagnostic", "no-impact")
        return

    if verdict == "REFUTED":
        require(
            hypothesis_result.get("changedCodePathObserved") is True,
            "Verify REFUTED requires changed-path execution",
        )
        if next_ranked_exists(state):
            require_transition(output, "ready", "resilience-analysis")
            require(
                decision.get("route") == "next-ranked-hypothesis",
                "Resolved verification with backlog must route to next hypothesis",
            )
            state["analysis"]["mode"] = "initial"
            state["analysis"]["routingIntent"] = "next-ranked"
            state["phase"] = "resilience-analysis"
            set_transition(
                state,
                "ready",
                "diagnostic",
                "resilience-analysis",
                (
                    "fix validated; select the next ranked hypothesis"
                    if result.get("sloHolds") is True
                    else "selected predicate refuted but SLO still breached; select next hypothesis"
                ),
            )
        elif result.get("sloHolds") is True:
            require_transition(output, "terminated", "terminated")
            require(
                decision.get("route") == "resolved",
                "Successful final verification must terminate resolved",
            )
            terminate(state, "diagnostic", "resolved")
        else:
            require_transition(output, "terminated", "terminated")
            require(
                decision.get("route") == "escalated",
                "REFUTED without SLO recovery or backlog must escalate",
            )
            terminate(state, "diagnostic", "escalated")
    elif state["iteration"] >= state["maxIterations"]:
        require_transition(output, "terminated", "terminated")
        require(
            decision.get("route") == "escalated",
            "CONFIRMED at iteration cap must terminate escalated",
        )
        terminate(state, "diagnostic", "escalated")
    else:
        require_transition(output, "ready", "advisory")
        require(
            decision.get("route") == "advisory",
            "CONFIRMED below the cap must route to Advisory",
        )
        state["phase"] = "advisory"
        set_transition(
            state,
            "ready",
            "diagnostic",
            "advisory",
            "validation remains CONFIRMED and iteration cap is not reached",
        )


def ledger_ids(items: Any, label: str) -> set[str]:
    require(isinstance(items, list), f"changeLedger.{label} must be an array")
    values = [item.get("advisoryId") for item in items]
    require(all(values), f"changeLedger.{label} entries require advisoryId")
    require(len(values) == len(set(values)), f"changeLedger.{label} contains duplicates")
    return set(values)


def apply_advisory(
    state: dict[str, Any],
    output: dict[str, Any],
    prior_handoff: dict[str, Any],
) -> None:
    result = output["result"]
    validate_bounded_critique(result, "Advisory")
    advisories = result.get("advisories")
    require(isinstance(advisories, list), "advisories must be an array")
    ledger = result.get("changeLedger")
    require(isinstance(ledger, dict), "changeLedger is required")
    require(
        {"added", "changed", "unchanged", "removed"} <= ledger.keys(),
        "changeLedger requires added, changed, unchanged, and removed",
    )
    advisory_state = state["handoff"].get("advisoryState", {})
    require(
        canonical(advisory_state.get("advisories")) == canonical(advisories),
        "Advisory handoff.advisoryState.advisories must equal result.advisories",
    )
    require(
        canonical(advisory_state.get("changeLedger")) == canonical(ledger),
        "Advisory handoff.advisoryState.changeLedger must equal result.changeLedger",
    )
    prior_ids = {
        item.get("advisoryId")
        for item in prior_handoff.get("advisoryState", {}).get("advisories", [])
        if item.get("advisoryId")
    }
    current_ids = {item.get("advisoryId") for item in advisories if item.get("advisoryId")}
    added = ledger_ids(ledger["added"], "added")
    changed = ledger_ids(ledger["changed"], "changed")
    unchanged = ledger_ids(ledger["unchanged"], "unchanged")
    removed = ledger_ids(ledger["removed"], "removed")
    require(
        not ((added & changed) | (added & unchanged) | (added & removed)
             | (changed & unchanged) | (changed & removed) | (unchanged & removed)),
        "Advisory ledger categories must be disjoint",
    )
    require(added == current_ids - prior_ids, "Advisory ledger added set is incomplete")
    require(removed == prior_ids - current_ids, "Advisory ledger removed set is incomplete")
    require(
        changed | unchanged == prior_ids & current_ids,
        "Advisory ledger changed/unchanged set is incomplete",
    )
    confirmed = {
        item["hypothesisId"]
        for item in state["handoff"].get("hypothesisResults", [])
        if item.get("verdict") == "CONFIRMED"
    }
    for advisory in advisories:
        addressed = set(advisory.get("addressesHypothesisIds", []))
        require(addressed and addressed <= confirmed, "Advisory addresses a non-CONFIRMED hypothesis")
        require(advisory.get("evidence", {}).get("diagnosticQuery"), "Advisory lacks diagnostic evidence")
        require(advisory.get("grounding", {}).get("citation"), "Advisory lacks grounded guidance")
        require(
            advisory.get("acceptanceEvidence", {}).get("changedCodePathPredicate"),
            "Advisory lacks a changed-path acceptance predicate",
        )
        require(advisory.get("approvalStatus") == "proposed", "Advisory cannot self-approve")
    if not advisories:
        require_transition(output, "terminated", "terminated")
        terminate(state, "advisory", "no-remediation")
        return
    require_transition(output, "ready", "advisory-approval")
    default_ids = advisory_state.get("defaultRecommendedAdvisoryIds")
    require(
        isinstance(default_ids, list) and default_ids,
        "Advisory handoff must include a non-empty defaultRecommendedAdvisoryIds",
    )
    require(
        set(default_ids) <= current_ids,
        "Default recommended advisory IDs must come from the proposed set",
    )
    state["approvedAdvisoryIds"] = []
    state["phase"] = "advisory-approval"
    set_transition(
        state,
        "blocked",
        "advisory",
        "advisory-approval",
        "customer advisory selection is required before automatic coding",
    )


def apply_coding(state: dict[str, Any], output: dict[str, Any]) -> None:
    result = output["result"]
    implemented = result.get("implemented")
    not_implemented = result.get("notImplemented")
    require(isinstance(implemented, list), "implemented must be an array")
    require(isinstance(not_implemented, list), "notImplemented must be an array")
    covered: list[str] = []
    pr_urls: set[str] = set()
    change_ids: set[str] = set()
    prior_change_ids = {
        item.get("changeId") for item in state["attemptedFixes"] if item.get("changeId")
    }
    for change in implemented:
        change_id = change.get("changeId")
        require(change_id and change_id not in change_ids, "changeId must be unique")
        require(change_id not in prior_change_ids, "changeId must be unique across all iterations")
        change_ids.add(change_id)
        require(change.get("prUrl"), "Every implemented coherent change requires a PR URL")
        require(change["prUrl"] not in pr_urls, "One PR cannot represent multiple coherent changes")
        pr_urls.add(change["prUrl"])
        advisory_ids = change.get("advisoryIds", [])
        require(advisory_ids, "Implemented change must name approved advisory IDs")
        require(
            set(advisory_ids) <= set(state["approvedAdvisoryIds"]),
            "Coding implemented an unapproved advisory",
        )
        covered.extend(advisory_ids)
        verification = change.get("verification", {})
        status = verification.get("verificationStatus")
        require(status in {"passed", "failed", "not-run", "blocked"}, "Invalid verificationStatus")
        require(
            verification.get("hostedRunnersEnabled") is False,
            "Hosted runners must be recorded as disabled",
        )
        require(
            verification.get("notProofOfResilience") is True,
            "Build/test verification must be marked not proof of resilience",
        )
        if status == "passed":
            paths = verification.get("pathsRun", [])
            require(paths, "passed requires at least one allowed verification path")
            require(
                all(path.get("result") == "passed" for path in paths),
                "passed cannot contain a failed verification path",
            )
        require(
            change.get("acceptanceEvidence", {}).get("changedCodePathPredicate"),
            "Implemented change lacks a changed-path acceptance predicate",
        )
    for omission in not_implemented:
        advisory_id = omission.get("advisoryId")
        require(advisory_id, "notImplemented entry requires advisoryId")
        covered.append(advisory_id)
    require(
        sorted(covered) == sorted(state["approvedAdvisoryIds"]),
        "Every approved advisory must appear exactly once in implemented or notImplemented",
    )
    require(len(covered) == len(set(covered)), "An advisory appears more than once in coding output")
    require(
        canonical(state["handoff"]["codeChanges"].get("implemented")) == canonical(implemented),
        "Coding handoff.codeChanges.implemented must equal result.implemented",
    )
    require(
        canonical(state["handoff"]["codeChanges"].get("notImplemented"))
        == canonical(not_implemented),
        "Coding handoff.codeChanges.notImplemented must equal result.notImplemented",
    )
    delivery = state["handoff"]["codeChanges"].get("deliveryDecision")
    require(isinstance(delivery, dict), "Coding handoff requires deliveryDecision")
    if not implemented:
        require(
            delivery.get("route") == "no-remediation",
            "Coding without implemented changes must decide no-remediation",
        )
        require_transition(output, "terminated", "terminated")
        terminate(state, "coding", "no-remediation")
        return
    require_transition(output, "ready", "awaiting-external-gate")
    require(
        delivery.get("route") == "awaiting-external-gate",
        "Coding must decisively route delivered PRs to the external gate",
    )
    require(
        delivery.get("prUrls") == [item["prUrl"] for item in implemented],
        "Coding deliveryDecision must contain every created PR URL in order",
    )
    require(
        delivery.get("requiredGateEvidence")
        == [
            "merge",
            "build",
            "artifact",
            "deployment",
            "serving-revision",
        ],
        "Coding deliveryDecision must name the complete external gate evidence chain",
    )
    state["attemptedFixes"].extend(copy.deepcopy(implemented))
    state["phase"] = "awaiting-external-gate"
    set_transition(
        state,
        "blocked",
        "coding",
        "awaiting-external-gate",
        "controller stopped; external merge and deployment proof is required",
    )


def apply_phase(state: dict[str, Any], output: dict[str, Any], phase: str, expected: int) -> None:
    require(state["phase"] == phase, f"Expected phase {phase}, observed {state['phase']}")
    require_ready_workspace(state)
    validate_phase_envelope(state, output, phase, expected)
    prior_handoff = copy.deepcopy(state["handoff"])
    prior_workspace = canonical(state["workspace"])
    handoff = output["handoff"]
    deep_merge(state["handoff"], handoff)
    if phase == "resilience-analysis":
        apply_analysis(state, output)
    elif phase == "chaos-execution":
        apply_execution(state, output)
    elif phase == "diagnostic":
        apply_diagnostic(state, output, prior_handoff)
    elif phase == "advisory":
        apply_advisory(state, output, prior_handoff)
    elif phase == "coding":
        apply_coding(state, output)
    else:
        raise ContractError(f"Unsupported phase application: {phase}")
    require(
        canonical(state["workspace"]) == prior_workspace,
        "The selected workspace is immutable after preflight; no phase may change it",
    )


def mutate_state(
    state_path: Path,
    expected_revision: int,
    mutation: Callable[[dict[str, Any]], None],
    event_type: str,
    event_details: dict[str, Any] | None = None,
) -> dict[str, Any]:
    with state_lock(state_path):
        state = read_json(state_path)
        validate_state(state)
        validate_revision(state, expected_revision)
        prior_phase = state["phase"]
        mutation(state)
        state["stateRevision"] += 1
        add_event(state, event_type, prior_phase, event_details)
        validate_state(state)
        atomic_write_json(state_path, state)
        return state


def evaluation_stamp() -> dict[str, Any]:
    return {"engine": "chaos_loop_state.py", "policyVersion": POLICY_VERSION}


def phase_output(
    state: dict[str, Any],
    phase: str,
    result: dict[str, Any],
    handoff: dict[str, Any],
    status: str,
    target: str,
    reason: str,
) -> dict[str, Any]:
    return {
        "contractVersion": CONTRACT_VERSION,
        "runId": state["runId"],
        "expectedStateRevision": state["stateRevision"],
        "phase": phase,
        "evaluation": evaluation_stamp(),
        "result": result,
        "handoff": handoff,
        "transition": {
            "status": status,
            "from": phase,
            "to": target,
            "reason": reason,
        },
    }


def filter_and_rank_hypotheses(
    hypotheses: list[dict[str, Any]],
) -> tuple[list[dict[str, Any]], list[dict[str, str]]]:
    eligible: list[dict[str, Any]] = []
    rejected: list[dict[str, str]] = []
    for hypothesis in hypotheses:
        try:
            eligible.extend(deterministic_rank([hypothesis]))
        except ContractError as exc:
            rejected.append(
                {
                    "hypothesisId": str(hypothesis.get("hypothesisId", "")),
                    "reason": str(exc),
                }
            )
    eligible.sort(
        key=lambda item: (-item["learningScore"], item["hypothesisId"].casefold())
    )
    for index, hypothesis in enumerate(eligible, start=1):
        hypothesis["rank"] = index
    return eligible, rejected


def evaluate_analysis(
    state: dict[str, Any], proposal: dict[str, Any]
) -> dict[str, Any]:
    result = copy.deepcopy(proposal["result"])
    mode = result.get("mode", state["analysis"]["mode"])
    hypotheses, rejected = filter_and_rank_hypotheses(result.get("hypotheses", []))
    if not hypotheses:
        disposition = "escalated" if result.get("unrecoverable") is True else "repair"
        repair = {
            "reason": "No eligible executable hypothesis remains",
            "requiredCorrections": [
                item["reason"] for item in rejected
            ] or ["Provide a supported discovered Scenario and complete predicates"],
            "rejectedHypotheses": rejected,
        }
        decision = {
            "disposition": disposition,
            "selectedHypothesisId": None,
            "selectedTestDesign": None,
            "backlogHypothesisIds": [],
            "repairBrief": repair,
        }
        result.update(
            {
                "mode": mode,
                "hypotheses": [],
                "selectedHypothesisId": None,
                "originalHypothesisId": state["analysis"].get("originalHypothesisId"),
                "analysisHandoff": decision,
            }
        )
        return phase_output(
            state,
            "resilience-analysis",
            result,
            {
                "analysisDecision": decision,
                "unresolvedCaveats": result.get("unresolvedCaveats", []),
            },
            "terminated" if disposition == "escalated" else "ready",
            "terminated" if disposition == "escalated" else "resilience-analysis",
            repair["reason"],
        )

    intent = state["analysis"].get("routingIntent", "select-initial")
    if intent == "next-ranked":
        prior_rank = selected_hypothesis(state)["rank"]
        candidates = [item for item in hypotheses if item["rank"] > prior_rank]
    elif intent in {"repair-exercise", "repair-verify-exercise", "reassess-identical"}:
        selected_id = state["analysis"]["selectedHypothesisId"]
        candidates = [item for item in hypotheses if item["hypothesisId"] == selected_id]
    else:
        candidates = hypotheses
    require(candidates, "No hypothesis satisfies the deterministic routing intent")
    selected = candidates[0]
    design = {
        "hypothesisId": selected["hypothesisId"],
        "frozenValidation": selected["matchingFault"],
        "steadyStatePredicates": selected["steadyStatePredicates"],
        "workExpected": selected["workExpected"],
        "provingFault": selected["provingFault"],
        "confirmPredicate": selected["confirmPredicate"],
        "executedCodePathPredicate": selected["executedCodePathPredicate"],
    }
    decision = {
        "disposition": "executable",
        "selectedHypothesisId": selected["hypothesisId"],
        "selectedTestDesign": design,
        "backlogHypothesisIds": [
            item["hypothesisId"] for item in hypotheses if item["hypothesisId"] != selected["hypothesisId"]
        ],
        "repairBrief": None,
        "rejectedHypotheses": rejected,
    }
    result.update(
        {
            "mode": mode,
            "hypotheses": hypotheses,
            "selectedHypothesisId": selected["hypothesisId"],
            "originalHypothesisId": (
                state["analysis"].get("originalHypothesisId")
                or selected["hypothesisId"]
            ),
            "analysisHandoff": decision,
        }
    )
    return phase_output(
        state,
        "resilience-analysis",
        result,
        {
            "analysisDecision": decision,
            "unresolvedCaveats": result.get("unresolvedCaveats", []),
        },
        "ready",
        "chaos-execution",
        "highest-ranked eligible hypothesis selected deterministically",
    )


def build_identity_matches(build: dict[str, Any]) -> bool:
    if build.get("live") is not True:
        return False
    pairs = (
        ("expectedCommit", "observedCommit"),
        ("expectedBuildId", "observedBuildId"),
        ("expectedArtifact", "observedArtifact"),
        ("expectedDeploymentId", "observedDeploymentId"),
        ("expectedRevision", "observedRevision"),
    )
    provided = 0
    for expected, observed in pairs:
        if expected in build or observed in build:
            provided += 1
            if not build.get(expected) or build.get(expected) != build.get(observed):
                return False
    return provided > 0


def evaluate_execution(
    state: dict[str, Any], proposal: dict[str, Any]
) -> dict[str, Any]:
    result = copy.deepcopy(proposal["result"])
    predicates = result.get("steadyStateEvidence", {}).get("predicates", [])
    steady_passed = bool(predicates) and all(
        item.get("passed") is True for item in predicates
    )
    result.setdefault("steadyStateEvidence", {})["passed"] = steady_passed
    fault = result.get("faultEvidence", {})
    fault_landed = fault.get("faultLanded") is True and bool(fault.get("evidence"))
    run = result.get("run", {})
    unsafe = (
        result.get("safetyHaltTripped") is True
        or result.get("recoveryFailed") is True
        or run.get("status") in {"aborted", "rolled-back"}
        and result.get("unsafe") is True
    )
    build_ok = build_identity_matches(result.get("buildIdentity", {}))
    eligible = (
        build_ok
        and steady_passed
        and fault_landed
        and run.get("status") == "completed"
        and bool(run.get("recoveryEvidence"))
    )
    if eligible:
        window = result.get("faultWindow", {})
        validate_utc(window.get("startTime"), "faultWindow.startTime")
        validate_utc(window.get("endTime"), "faultWindow.endTime")
        start = dt.datetime.fromisoformat(window["startTime"].replace("Z", "+00:00"))
        end = dt.datetime.fromisoformat(window["endTime"].replace("Z", "+00:00"))
        require(start < end, "faultWindow.startTime must precede endTime")
        disposition, status, target = "diagnostic-eligible", "ready", "diagnostic"
        repair = None
    elif unsafe:
        disposition, status, target = "unsafe", "terminated", "terminated"
        repair = None
    else:
        disposition, status, target = "repair-analysis", "ready", "resilience-analysis"
        failure_class = (
            "build-identity"
            if not build_ok
            else "steady-state"
            if not steady_passed
            else "fault-proof"
        )
        repair = {
            "failureClass": failure_class,
            "reason": f"Mechanical {failure_class} gate did not pass",
            "evidence": result.get("mechanicalEvidence", ["required proof missing"]),
            "requiredCorrections": result.get(
                "requiredCorrections", [f"Repair {failure_class} evidence"]
            ),
        }
    decision = {
        "disposition": disposition,
        "diagnosticEligible": eligible,
        "repairBrief": repair,
        "evidence": result.get("mechanicalEvidence", []),
    }
    result["executionHandoff"] = decision
    handoff = {
        "executionDecision": decision,
        "testIdentity": result.get("testIdentity", {}),
        "buildIdentity": result.get("buildIdentity", {}),
        "steadyStateEvidence": result.get("steadyStateEvidence", {}),
        "faultWindow": result.get("faultWindow"),
        "provingFaultEvidence": result.get("faultEvidence", {}),
        "unresolvedCaveats": result.get("unresolvedCaveats", []),
    }
    return phase_output(
        state,
        "chaos-execution",
        result,
        handoff,
        status,
        target,
        repair["reason"] if repair else disposition,
    )


def evaluate_diagnostic(
    state: dict[str, Any], proposal: dict[str, Any]
) -> dict[str, Any]:
    result = copy.deepcopy(proposal["result"])
    mode = "verify" if state["analysis"]["mode"] == "reassess" else "initial"
    result["mode"] = mode
    calculate_numeric_evidence(result)
    hypothesis_results = result.get("hypothesisResults", [])
    require(len(hypothesis_results) == 1, "Exactly one selected hypothesis is in scope")
    hypothesis_result = hypothesis_results[0]
    verdict = deterministic_verdict(hypothesis_result, mode)
    hypothesis_result["verdict"] = verdict
    backlog = next_ranked_exists(state)
    selected_id = state["analysis"]["selectedHypothesisId"]
    route, status, target = deterministic_diagnostic_route(
        verdict,
        mode,
        backlog,
        result.get("sloHolds") is True,
        state["iteration"],
        state["maxIterations"],
        selected_id in result.get("fixableConfirmedHypothesisIds", []),
    )
    if verdict == "NOT EXERCISED":
        repair = {
            "reason": hypothesis_result.get("reason") or "Exercise evidence is incomplete",
            "requiredCorrections": result.get(
                "requiredCorrections", ["Supply the missing fault/work/path evidence"]
            ),
        }
    else:
        repair = None
    decision = {
        "hypothesisId": selected_id,
        "verdict": verdict,
        "route": route,
        "nextPhase": target,
        "exerciseRepairBrief": repair,
        "reason": hypothesis_result.get("reason", ""),
    }
    result["diagnosticHandoff"] = decision
    handoff = {
        "diagnosticDecision": decision,
        "numericBaselines": result.get("numericBaselines", []),
        "observedSLIs": result.get("observedSLIs", []),
        "telemetryQueries": result.get("telemetryQueries", []),
        "starvationEvidence": result.get("starvationEvidence", {}),
        "hypothesisResults": hypothesis_results,
        "targetedPathEvidence": result.get("targetedPathEvidence", []),
        "changedPathEvidence": result.get("changedPathEvidence", []),
        "dlqState": result.get("dlqState", []),
        "unresolvedCaveats": result.get("unresolvedCaveats", []),
    }
    return phase_output(
        state, "diagnostic", result, handoff, status, target, route
    )


def evaluate_advisory(
    state: dict[str, Any], proposal: dict[str, Any]
) -> dict[str, Any]:
    result = copy.deepcopy(proposal["result"])
    attempted_ids = {
        advisory_id
        for attempt in state["attemptedFixes"]
        for advisory_id in attempt.get("advisoryIds", [])
    }
    advisories = []
    for advisory in result.get("advisories", []):
        if (
            advisory["advisoryId"] in attempted_ids
            and not advisory.get("supersedesAttemptId")
        ):
            continue
        normalized = copy.deepcopy(advisory)
        normalized["rankingScore"] = stable_advisory_score(normalized)
        advisories.append(normalized)
    advisories.sort(
        key=lambda item: (-item["rankingScore"], item["advisoryId"].casefold())
    )
    for index, advisory in enumerate(advisories, start=1):
        advisory["rank"] = index
    prior = state["handoff"]["advisoryState"].get("advisories", [])
    ledger = advisory_ledger(prior, advisories)
    ledger["previousSetId"] = state["handoff"]["advisoryState"].get("currentSetId")
    defaults = [advisories[0]["advisoryId"]] if advisories else []
    result["advisories"] = advisories
    result["changeLedger"] = ledger
    result["defaultRecommendedAdvisoryIds"] = defaults
    advisory_state = {
        "previousSetId": state["handoff"]["advisoryState"].get("currentSetId"),
        "currentSetId": ledger["currentSetId"],
        "defaultRecommendedAdvisoryIds": defaults,
        "advisories": advisories,
        "changeLedger": ledger,
    }
    return phase_output(
        state,
        "advisory",
        result,
        {
            "advisoryState": advisory_state,
            "unresolvedCaveats": result.get("unresolvedCaveats", []),
        },
        "ready" if advisories else "terminated",
        "advisory-approval" if advisories else "terminated",
        "ranked advisory recommendation ready" if advisories else "no-remediation",
    )


def evaluate_coding(
    state: dict[str, Any], proposal: dict[str, Any]
) -> dict[str, Any]:
    result = copy.deepcopy(proposal["result"])
    implemented = result.get("implemented", [])
    delivery = {
        "route": "awaiting-external-gate" if implemented else "no-remediation",
        "prUrls": [item["prUrl"] for item in implemented],
        "requiredGateEvidence": [
            "merge",
            "build",
            "artifact",
            "deployment",
            "serving-revision",
        ],
    }
    return phase_output(
        state,
        "coding",
        result,
        {
            "codeChanges": {
                "implemented": implemented,
                "notImplemented": result.get("notImplemented", []),
                "deliveryDecision": delivery,
            },
            "unresolvedCaveats": result.get("unresolvedCaveats", []),
        },
        "ready" if implemented else "terminated",
        "awaiting-external-gate" if implemented else "terminated",
        delivery["route"],
    )


def evaluate_phase(
    state: dict[str, Any], proposal: dict[str, Any], phase: str
) -> dict[str, Any]:
    require(state["phase"] == phase, f"Expected phase {phase}, observed {state['phase']}")
    require_ready_workspace(state)
    require(proposal.get("runId") == state["runId"], "Proposal runId mismatch")
    require(
        proposal.get("expectedStateRevision") == state["stateRevision"],
        "Proposal revision mismatch",
    )
    require(proposal.get("phase") == phase, "Proposal phase mismatch")
    require(isinstance(proposal.get("result"), dict), "Proposal result must be an object")
    evaluators = {
        "resilience-analysis": evaluate_analysis,
        "chaos-execution": evaluate_execution,
        "diagnostic": evaluate_diagnostic,
        "advisory": evaluate_advisory,
        "coding": evaluate_coding,
    }
    return evaluators[phase](state, proposal)


def cmd_evaluate(args: argparse.Namespace) -> dict[str, Any]:
    state = read_json(Path(args.state))
    validate_state(state)
    validate_revision(state, args.expected_revision)
    proposal = read_json(Path(args.input))
    evaluated = evaluate_phase(state, proposal, args.phase)
    output_path = Path(args.output)
    atomic_write_json(output_path, evaluated)
    return {"outputPath": str(output_path), "output": evaluated}


def cmd_start(args: argparse.Namespace) -> dict[str, Any]:
    run_id = args.run_id or str(uuid.uuid4())
    state_path = Path(args.state_root) / run_id / "state.json"
    require(not state_path.exists(), f"Run already exists: {run_id}")
    targets = json.loads(args.target_resources)
    guardrails = json.loads(args.guardrails)
    require(isinstance(targets, list) and targets, "target-resources must be a non-empty JSON array")
    require(isinstance(guardrails, dict), "guardrails must be a JSON object")
    for field in ("environmentScope", "blastRadiusCap", "safetyHalts"):
        require(guardrails.get(field), f"guardrails.{field} is required")
    raw_request = getattr(args, "workspace_request", None)
    require(
        raw_request not in (None, ""),
        "workspace-request is required: a run cannot start without a validated "
        "Chaos Studio workspace request",
    )
    workspace_request = normalize_workspace_request(
        load_json_argument(raw_request, "workspace-request"), targets
    )
    state = {
        "schemaVersion": STATE_VERSION,
        "contractVersion": CONTRACT_VERSION,
        "policyVersion": POLICY_VERSION,
        "runId": run_id,
        "faultId": None,
        "stateRevision": 0,
        "entryMode": "start",
        "phase": "resilience-analysis",
        "iteration": 0,
        "maxIterations": args.max_iterations,
        "verdict": "in-progress",
        "terminationReason": None,
        "workspace": new_workspace(workspace_request),
        "analysis": {
            "mode": "initial",
            "scope": {
                "repo": args.repo,
                "commit": args.commit,
                "targetResources": list(workspace_request["targetResources"]),
            },
            "hypotheses": [],
            "selectedHypothesisId": None,
            "originalHypothesisId": None,
            "routingIntent": "select-initial",
        },
        "frozenValidation": None,
        "guardrails": guardrails,
        "approvedAdvisoryIds": [],
        "attemptedFixes": [],
        "iterations": [],
        "handoff": new_handoff(),
        "transition": {
            "status": "ready",
            "from": None,
            "to": "resilience-analysis",
            "reason": "new run initialized",
        },
        "events": [],
    }
    add_event(state, "run-started", "resilience-analysis")
    validate_state(state)
    with state_lock(state_path):
        atomic_write_json(state_path, state)
    return {"statePath": str(state_path), "state": state}


def cmd_status(args: argparse.Namespace) -> dict[str, Any]:
    state = read_json(Path(args.state))
    validate_state(state)
    workspace = state["workspace"]
    return {
        "statePath": str(Path(args.state)),
        "runId": state["runId"],
        "stateRevision": state["stateRevision"],
        "phase": state["phase"],
        "iteration": state["iteration"],
        "maxIterations": state["maxIterations"],
        "verdict": state["verdict"],
        "terminationReason": state["terminationReason"],
        "transition": state["transition"],
        "workspace": {
            "status": workspace["status"],
            "decision": workspace["decision"],
            "selected": workspace["selected"],
            "caveats": workspace["caveats"],
            "remediationBrief": workspace["remediationBrief"],
        },
    }


def cmd_migrate(args: argparse.Namespace) -> dict[str, Any]:
    state_path = Path(args.state)
    raw_request = getattr(args, "workspace_request", None)
    workspace_request = (
        load_json_argument(raw_request, "workspace-request")
        if raw_request not in (None, "")
        else None
    )
    with state_lock(state_path):
        state = read_json(state_path)
        validate_revision(state, args.expected_revision)
        changed = migrate_state_document(state, workspace_request)
        if changed:
            state["stateRevision"] += 1
            add_event(
                state,
                "state-migrated",
                state["phase"],
                {"policyVersion": POLICY_VERSION},
            )
            validate_state(state)
            atomic_write_json(state_path, state)
        else:
            validate_state(state)
    return {
        "statePath": str(state_path),
        "migrated": changed,
        "stateRevision": state["stateRevision"],
        "policyVersion": state["policyVersion"],
        "workspaceStatus": state["workspace"]["status"],
    }


def cmd_workspace_plan(args: argparse.Namespace) -> dict[str, Any]:
    """Produce the deterministic reuse-or-create plan. Never mutates state."""
    state = read_json(Path(args.state))
    validate_state(state)
    validate_revision(state, args.expected_revision)
    workspace = state["workspace"]
    require(
        workspace["status"] == "pending",
        "Workspace preflight is already complete for this run; later phases reuse the "
        f"selected workspace and never rediscover (status: {workspace['status']})",
    )
    request = workspace.get("request")
    require(
        isinstance(request, dict),
        "Workspace preflight requires a normalized workspaceRequest; start a new run "
        "or migrate this run with --workspace-request",
    )
    discovery = load_json_argument(args.discovery, "workspace discovery")
    observed_at = args.observed_at
    validate_utc(observed_at, "observedAt")
    plan = plan_workspace(request, discovery, observed_at)
    document = workspace_plan_document(state, request, plan, observed_at)
    output_path = Path(args.output)
    atomic_write_json(output_path, document)
    return {"planPath": str(output_path), "plan": document}


def cmd_workspace_finalize(args: argparse.Namespace) -> dict[str, Any]:
    """Prove the planned workspace exists and is usable, then persist it."""
    plan = load_json_argument(args.plan, "workspace plan")
    result_document = load_json_argument(args.result, "workspace tool result")
    outcome: dict[str, Any] = {}

    def finalize(state: dict[str, Any]) -> None:
        workspace = state["workspace"]
        require(
            workspace["status"] == "pending",
            "Workspace preflight is already complete for this run "
            f"(status: {workspace['status']})",
        )
        request = validate_workspace_plan(state, plan, args.expected_revision)
        observed_at = args.observed_at or plan["observedAt"]
        validate_utc(observed_at, "observedAt")
        stage = "readback" if plan["decision"] == "reuse" else "create"
        try:
            verified = verify_workspace_readback(request, plan, result_document)
        except ContractError as exc:
            brief = workspace_remediation_brief(
                stage,
                str(exc),
                [
                    "Correct the workspace so it matches the validated request "
                    f"(region {request['location']}, identity {request['identity']['type']}, "
                    f"scopes {request['managedScopes']}), or re-start the run with a "
                    "workspace request that matches the environment.",
                    "Start a new run after correcting the workspace or request.",
                ],
                {"decision": plan["decision"], "toolResult": result_document},
            )
            fail_workspace(
                state,
                brief,
                observed_at,
                discovery_evidence=plan.get("discoveryEvidence"),
            )
            outcome["workspaceStatus"] = "failed"
            outcome["remediationBrief"] = brief
            return
        workspace["status"] = "ready"
        workspace["decision"] = "reused" if plan["decision"] == "reuse" else "created"
        workspace["selected"] = verified["selected"]
        workspace["alternatives"] = copy.deepcopy(plan.get("alternatives") or [])
        for caveat in plan.get("caveats") or []:
            if caveat not in workspace["caveats"]:
                workspace["caveats"].append(caveat)
        workspace["discoveryEvidence"] = copy.deepcopy(plan["discoveryEvidence"])
        workspace["provisioningEvidence"] = {
            "source": (
                "chaos_get_workspace"
                if plan["decision"] == "reuse"
                else "chaos_create_workspace"
            ),
            "decision": plan["decision"],
            "observedAt": observed_at,
            "workspaceId": verified["selected"]["id"],
            "provisioningState": verified["selected"]["provisioningState"],
            "roleAssignments": verified["roleAssignments"],
        }
        workspace["observedAt"] = observed_at
        workspace["remediationBrief"] = None
        if (
            state["phase"] == "resilience-analysis"
            and state["transition"]["status"] == "ready"
        ):
            set_transition(
                state,
                "ready",
                state["transition"].get("from"),
                "resilience-analysis",
                f"workspace preflight complete: {workspace['decision']} "
                f"{verified['selected']['id']}",
            )
        outcome["workspaceStatus"] = "ready"

    state = mutate_state(
        Path(args.state),
        args.expected_revision,
        finalize,
        "workspace-finalized",
        {"decision": plan.get("decision")},
    )
    return {
        "statePath": args.state,
        "workspaceStatus": outcome.get("workspaceStatus"),
        "workspace": state["workspace"],
        "state": state,
    }


def cmd_workspace_fail(args: argparse.Namespace) -> dict[str, Any]:
    """Persist a list/get/create permission or policy failure and escalate."""
    failure = load_json_argument(args.result, "workspace tool result")
    require(
        failure.get("ok") is not True,
        "workspace-fail requires a failed tool result; a successful result must be "
        "finalized with workspace-finalize",
    )
    error_text = (
        failure.get("error")
        or json.dumps(failure.get("result", failure), sort_keys=True)
    )
    stage = args.stage
    corrections = {
        "list": [
            "Grant the caller Reader on the subscription or resource group so "
            "chaos_list_workspaces can enumerate Microsoft.Chaos/workspaces.",
            "Re-run the controller start protocol after the permission is in place.",
        ],
        "get": [
            "Grant the caller Reader on the selected workspace so chaos_get_workspace "
            "can read it back.",
            "Start a new run after the permission is in place.",
        ],
        "create": [
            "Grant the caller permission to create Microsoft.Chaos/workspaces and to "
            "assign Reader on the requested managed scopes, or supply an existing "
            "compatible workspace via preferredName.",
            "Resolve any Azure Policy denial for the requested region or resource group, "
            "then start a new run.",
        ],
    }[stage]

    def fail(state: dict[str, Any]) -> None:
        require(
            state["workspace"]["status"] == "pending",
            "Workspace preflight is already complete for this run "
            f"(status: {state['workspace']['status']})",
        )
        brief = workspace_remediation_brief(
            stage,
            f"chaos workspace {stage} failed: {error_text}",
            corrections,
            {"toolResult": failure},
        )
        fail_workspace(state, brief, args.observed_at or utc_now())

    state = mutate_state(
        Path(args.state),
        args.expected_revision,
        fail,
        "workspace-failed",
        {"stage": stage},
    )
    return {
        "statePath": args.state,
        "workspaceStatus": state["workspace"]["status"],
        "workspace": state["workspace"],
        "state": state,
    }


def cmd_apply(args: argparse.Namespace) -> dict[str, Any]:
    output = read_json(Path(args.output))
    state = mutate_state(
        Path(args.state),
        args.expected_revision,
        lambda current: apply_phase(current, output, args.phase, args.expected_revision),
        "phase-applied",
        {"phase": args.phase, "output": str(Path(args.output))},
    )
    return {"statePath": args.state, "state": state}


def cmd_approve(args: argparse.Namespace) -> dict[str, Any]:
    advisory_ids = [item.strip() for item in args.advisory_ids.split(",") if item.strip()]

    def approve(state: dict[str, Any]) -> None:
        require(
            state["phase"] == "advisory-approval",
            "Approvals are accepted only in advisory-approval phase",
        )
        proposed = {
            item["advisoryId"]
            for item in state["handoff"]["advisoryState"].get("advisories", [])
        }
        require(advisory_ids, "At least one advisory ID must be approved")
        require(set(advisory_ids) <= proposed, "Approval contains an unknown advisory ID")
        state["approvedAdvisoryIds"] = advisory_ids
        state["phase"] = "coding"
        set_transition(
            state,
            "ready",
            "advisory-approval",
            "coding",
            "explicit advisory IDs approved",
        )

    state = mutate_state(
        Path(args.state),
        args.expected_revision,
        approve,
        "advisories-approved",
        {"advisoryIds": advisory_ids},
    )
    return {"statePath": args.state, "state": state}


def validate_gate(state: dict[str, Any], gate: dict[str, Any], expected_revision: int) -> None:
    require(state["phase"] == "awaiting-external-gate", "Run is not awaiting the external gate")
    require(gate.get("schemaVersion") == GATE_VERSION, "Unsupported gate schemaVersion")
    require(gate.get("runId") == state["runId"], "Gate runId mismatch")
    require(gate.get("expectedStateRevision") == expected_revision, "Gate revision mismatch")
    changes = gate.get("changes")
    require(isinstance(changes, list) and changes, "Gate changes cannot be empty")
    required_changes = {
        item["changeId"]: item for item in state["handoff"]["codeChanges"]["implemented"]
    }
    observed_changes = {item.get("changeId"): item for item in changes}
    require(
        set(observed_changes) == set(required_changes),
        "Gate must contain exactly every implemented coherent change",
    )
    for change_id, change in observed_changes.items():
        required = required_changes[change_id]
        for field in (
            "prUrl",
            "mergeCommit",
            "targetEnv",
            "expectedBuildId",
            "observedBuildId",
            "expectedArtifact",
            "observedArtifact",
            "expectedDeploymentId",
            "observedDeploymentId",
            "expectedRevision",
            "observedRevision",
            "live",
            "evidence",
        ):
            require(field in change, f"Gate change {change_id} is missing {field}")
        require(change["prUrl"] == required["prUrl"], f"PR URL mismatch for {change_id}")
        require(change["targetEnv"] == required["targetEnv"], f"Target environment mismatch for {change_id}")
        require(change["mergeCommit"], f"Merge commit is missing for {change_id}")
        for expected_field, observed_field in (
            ("expectedBuildId", "observedBuildId"),
            ("expectedArtifact", "observedArtifact"),
            ("expectedDeploymentId", "observedDeploymentId"),
            ("expectedRevision", "observedRevision"),
        ):
            require(change[expected_field], f"{expected_field} is missing for {change_id}")
            require(
                change[expected_field] == change[observed_field],
                f"{expected_field}/{observed_field} mismatch for {change_id}",
            )
            if required.get(expected_field):
                require(
                    change[expected_field] == required[expected_field],
                    f"{expected_field} differs from Coding output for {change_id}",
                )
        require(change["live"] is True, f"Serving revision is not live for {change_id}")
        evidence = change["evidence"]
        require(len(evidence) == 5, f"Gate requires exactly five evidence stages for {change_id}")
        stages = {item.get("stage") for item in evidence}
        require(
            stages
            == {"merge", "build", "artifact", "deployment", "serving-revision"},
            f"Gate evidence chain is incomplete for {change_id}",
        )
        for item in evidence:
            require(item.get("name"), f"Gate evidence needs a name for {change_id}")
            require(item.get("source"), f"Gate evidence needs a source for {change_id}")
            validate_utc(item.get("observedAt"), f"gate evidence observedAt for {change_id}")
            require(item.get("value"), f"Gate evidence needs a value for {change_id}")
        by_stage = {item["stage"]: item for item in evidence}
        require(
            change["mergeCommit"] in by_stage["merge"]["value"],
            f"Merge evidence does not name mergeCommit for {change_id}",
        )
        require(
            change["expectedBuildId"] in by_stage["build"]["value"]
            and change["mergeCommit"] in by_stage["build"]["value"],
            f"Build evidence does not link build to mergeCommit for {change_id}",
        )
        require(
            change["expectedArtifact"] in by_stage["artifact"]["value"],
            f"Artifact evidence does not name expectedArtifact for {change_id}",
        )
        require(
            change["expectedDeploymentId"] in by_stage["deployment"]["value"]
            and change["expectedArtifact"] in by_stage["deployment"]["value"],
            f"Deployment evidence does not link deployment to artifact for {change_id}",
        )
        require(
            change["expectedRevision"] in by_stage["serving-revision"]["value"],
            f"Serving evidence does not name expectedRevision for {change_id}",
        )
        stage_order = ("merge", "build", "artifact", "deployment", "serving-revision")
        timestamps = [
            dt.datetime.fromisoformat(by_stage[stage]["observedAt"].replace("Z", "+00:00"))
            for stage in stage_order
        ]
        require(
            timestamps == sorted(timestamps),
            f"Gate evidence timestamps are not in merge-to-serving order for {change_id}",
        )


def cmd_resume(args: argparse.Namespace) -> dict[str, Any]:
    gate = read_json(Path(args.gate))

    def resume(state: dict[str, Any]) -> None:
        validate_gate(state, gate, args.expected_revision)
        if state["iteration"] >= state["maxIterations"]:
            terminate(state, "awaiting-external-gate", "escalated")
            return
        state["iteration"] += 1
        for attempted in state["attemptedFixes"]:
            matching = next(
                (
                    item
                    for item in gate["changes"]
                    if item["changeId"] == attempted["changeId"]
                ),
                None,
            )
            if matching is not None:
                attempted["externalGate"] = copy.deepcopy(matching)
        state["entryMode"] = "resume"
        state["analysis"]["mode"] = "reassess"
        state["analysis"]["routingIntent"] = "reassess-identical"
        state["phase"] = "resilience-analysis"
        set_transition(
            state,
            "ready",
            "awaiting-external-gate",
            "resilience-analysis",
            "merge-to-serving-revision chain proven; reassess identical validation",
        )

    state = mutate_state(
        Path(args.state),
        args.expected_revision,
        resume,
        "external-gate-accepted",
        {"gate": str(Path(args.gate))},
    )
    return {"statePath": args.state, "state": state}


def cmd_terminate_analysis(args: argparse.Namespace) -> dict[str, Any]:
    def stop(state: dict[str, Any]) -> None:
        require(
            state["phase"] == "resilience-analysis",
            "analysis-only is available only from resilience-analysis",
        )
        terminate(state, "resilience-analysis", "analysis-only")

    state = mutate_state(
        Path(args.state),
        args.expected_revision,
        stop,
        "run-terminated",
        {"reason": "analysis-only"},
    )
    return {"statePath": args.state, "state": state}


def parser() -> argparse.ArgumentParser:
    result = argparse.ArgumentParser(description=__doc__)
    sub = result.add_subparsers(dest="command", required=True)

    start = sub.add_parser("start")
    start.add_argument("--repo", required=True)
    start.add_argument("--commit", required=True)
    start.add_argument("--target-resources", required=True)
    start.add_argument("--guardrails", required=True)
    start.add_argument("--workspace-request", required=True)
    start.add_argument("--run-id")
    start.add_argument("--max-iterations", type=int, default=3)
    start.add_argument("--state-root", default="tmp/chaos-loop/runs")
    start.set_defaults(handler=cmd_start)

    status = sub.add_parser("status")
    status.add_argument("--state", required=True)
    status.set_defaults(handler=cmd_status)

    migrate = sub.add_parser("migrate")
    migrate.add_argument("--state", required=True)
    migrate.add_argument("--expected-revision", required=True, type=int)
    migrate.add_argument("--workspace-request")
    migrate.set_defaults(handler=cmd_migrate)

    workspace_plan = sub.add_parser("workspace-plan")
    workspace_plan.add_argument("--state", required=True)
    workspace_plan.add_argument("--expected-revision", required=True, type=int)
    workspace_plan.add_argument("--discovery", required=True)
    workspace_plan.add_argument("--observed-at", required=True)
    workspace_plan.add_argument("--output", required=True)
    workspace_plan.set_defaults(handler=cmd_workspace_plan)

    workspace_finalize = sub.add_parser("workspace-finalize")
    workspace_finalize.add_argument("--state", required=True)
    workspace_finalize.add_argument("--expected-revision", required=True, type=int)
    workspace_finalize.add_argument("--plan", required=True)
    workspace_finalize.add_argument("--result", required=True)
    workspace_finalize.add_argument("--observed-at")
    workspace_finalize.set_defaults(handler=cmd_workspace_finalize)

    workspace_fail = sub.add_parser("workspace-fail")
    workspace_fail.add_argument("--state", required=True)
    workspace_fail.add_argument("--expected-revision", required=True, type=int)
    workspace_fail.add_argument("--stage", required=True, choices=("list", "get", "create"))
    workspace_fail.add_argument("--result", required=True)
    workspace_fail.add_argument("--observed-at")
    workspace_fail.set_defaults(handler=cmd_workspace_fail)

    apply = sub.add_parser("apply")
    apply.add_argument("--state", required=True)
    apply.add_argument("--expected-revision", required=True, type=int)
    apply.add_argument("--phase", required=True, choices=tuple(PHASE_OWNERSHIP))
    apply.add_argument("--output", required=True)
    apply.set_defaults(handler=cmd_apply)

    evaluate = sub.add_parser("evaluate")
    evaluate.add_argument("--state", required=True)
    evaluate.add_argument("--expected-revision", required=True, type=int)
    evaluate.add_argument("--phase", required=True, choices=tuple(PHASE_OWNERSHIP))
    evaluate.add_argument("--input", required=True)
    evaluate.add_argument("--output", required=True)
    evaluate.set_defaults(handler=cmd_evaluate)

    approve = sub.add_parser("approve")
    approve.add_argument("--state", required=True)
    approve.add_argument("--expected-revision", required=True, type=int)
    approve.add_argument("--advisory-ids", required=True)
    approve.set_defaults(handler=cmd_approve)

    resume = sub.add_parser("resume")
    resume.add_argument("--state", required=True)
    resume.add_argument("--expected-revision", required=True, type=int)
    resume.add_argument("--gate", required=True)
    resume.set_defaults(handler=cmd_resume)

    terminate_analysis = sub.add_parser("terminate-analysis-only")
    terminate_analysis.add_argument("--state", required=True)
    terminate_analysis.add_argument("--expected-revision", required=True, type=int)
    terminate_analysis.set_defaults(handler=cmd_terminate_analysis)
    return result


def main(action: str, arguments: dict[str, Any]) -> dict[str, Any]:
    """Azure SRE Agent Python-tool entry point.

    Import this file as ``chaos_loop_state`` only when its working directory is
    a persistent repository workspace. The tool uses the same atomic files and
    optimistic revisions as the CLI.
    """
    handlers = {
        "start": cmd_start,
        "status": cmd_status,
        "migrate": cmd_migrate,
        "workspace_plan": cmd_workspace_plan,
        "workspace_finalize": cmd_workspace_finalize,
        "workspace_fail": cmd_workspace_fail,
        "evaluate": cmd_evaluate,
        "apply": cmd_apply,
        "approve": cmd_approve,
        "resume": cmd_resume,
        "terminate_analysis_only": cmd_terminate_analysis,
    }
    required_arguments = {
        "start": ("repo", "commit", "target_resources", "guardrails", "workspace_request"),
        "status": ("state",),
        "migrate": ("state", "expected_revision"),
        "workspace_plan": ("state", "expected_revision", "discovery", "observed_at", "output"),
        "workspace_finalize": ("state", "expected_revision", "plan", "result"),
        "workspace_fail": ("state", "expected_revision", "stage", "result"),
        "evaluate": ("state", "expected_revision", "phase", "input", "output"),
        "apply": ("state", "expected_revision", "phase", "output"),
        "approve": ("state", "expected_revision", "advisory_ids"),
        "resume": ("state", "expected_revision", "gate"),
        "terminate_analysis_only": ("state", "expected_revision"),
    }
    try:
        if action not in handlers:
            raise ContractError(f"Unsupported action: {action}")
        values = dict(arguments or {})
        missing = sorted(
            name
            for name in required_arguments[action]
            if values.get(name) in (None, "")
        )
        require(not missing, f"{action} is missing required arguments: {missing}")
        if action == "workspace_fail":
            require(
                values["stage"] in {"list", "get", "create"},
                "workspace_fail stage must be list, get, or create",
            )
        values.setdefault("run_id", None)
        values.setdefault("max_iterations", 3)
        values.setdefault("state_root", "tmp/chaos-loop/runs")
        values.setdefault("workspace_request", None)
        values.setdefault("observed_at", None)
        response = handlers[action](argparse.Namespace(**values))
        return {"ok": True, "result": response}
    except (
        ContractError,
        ValueError,
        KeyError,
        TypeError,
        AttributeError,
        json.JSONDecodeError,
    ) as exc:
        return {"ok": False, "errorType": type(exc).__name__, "error": str(exc)}


def cli_main() -> int:
    try:
        args = parser().parse_args()
        response = args.handler(args)
        print(json.dumps({"ok": True, "result": response}, indent=2, ensure_ascii=False))
        return 0
    except (
        ContractError,
        ValueError,
        KeyError,
        TypeError,
        AttributeError,
        json.JSONDecodeError,
    ) as exc:
        print(
            json.dumps(
                {"ok": False, "errorType": type(exc).__name__, "error": str(exc)},
                indent=2,
            ),
            file=sys.stderr,
        )
        return 2


if __name__ == "__main__":
    raise SystemExit(cli_main())
