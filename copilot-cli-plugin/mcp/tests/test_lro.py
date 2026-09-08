# Copyright (c) Microsoft Corporation.
# Licensed under the MIT License.

"""Unit tests for the LRO poll helpers in ``chaos_mcp.azure``.

These exercise the poll-type-aware terminal detection that keeps
Azure-AsyncOperation polls from returning early on an empty/unknown status,
while still letting a Location poll finish on a non-202 success with an empty
body. The HTTP layer (``arm_request`` / ``arm_get``) is faked — no network, no
``az`` shell-outs — and a deterministic clock replaces ``time`` so timeout
paths are exercised without real waiting.
"""
from __future__ import annotations

import httpx
import pytest

from chaos_mcp import azure as az


@pytest.fixture
def fake_clock(monkeypatch):
    """Install a deterministic monotonic clock that advances only on sleep.

    ``wait_for_lro`` / ``wait_until_provisioned`` gate on ``time.monotonic()``
    and pace with ``time.sleep()``. Advancing the clock inside the patched
    ``sleep`` makes timeout paths deterministic and instantaneous.
    """
    state = {"now": 1000.0}
    monkeypatch.setattr(az.time, "monotonic", lambda: state["now"])

    def _sleep(seconds: float) -> None:
        state["now"] += max(0.0, float(seconds))

    monkeypatch.setattr(az.time, "sleep", _sleep)
    return state


def _initial(headers: dict[str, str]) -> httpx.Response:
    """A 202 Accepted LRO kickoff response carrying the given poll headers."""
    return httpx.Response(
        202,
        headers=headers,
        request=httpx.Request("PUT", "https://management.azure.com/resource"),
    )


def _fake_arm_request(monkeypatch, responses):
    """Route ``az.arm_request`` through a fixed sequence of poll responses.

    When the sequence is exhausted the last response repeats, which models a
    poll endpoint that never changes (the empty-forever timeout case).
    """
    calls: list[str] = []
    queue = list(responses)

    def _fake(method: str, url: str, **_kw) -> httpx.Response:
        calls.append(url)
        return queue.pop(0) if len(queue) > 1 else queue[0]

    monkeypatch.setattr(az, "arm_request", _fake)
    return calls


ASYNC_HEADERS = {"Azure-AsyncOperation": "https://management.azure.com/op/123"}
LOCATION_HEADERS = {"Location": "https://management.azure.com/loc/123"}


# ---------------------------------------------------------------------------
# wait_for_lro — Azure-AsyncOperation style
# ---------------------------------------------------------------------------


def test_async_op_no_status_then_succeeded_does_not_return_early(fake_clock, monkeypatch):
    """(a) A 200 with no status on an async-op poll must NOT be treated as done.

    The poll must keep going until the status resource reports ``Succeeded``.
    """
    calls = _fake_arm_request(
        monkeypatch,
        [
            httpx.Response(200, json={}),  # 200 but no populated status yet
            httpx.Response(200, json={"status": "Running"}),  # explicit in-progress
            httpx.Response(200, json={"status": "Succeeded", "id": "op/123"}),
        ],
    )

    result = az.wait_for_lro(_initial(ASYNC_HEADERS), timeout_s=60, interval_s=1)

    assert result == {"status": "Succeeded", "id": "op/123"}
    # All three polls were consumed — it did not short-circuit on the empty 200.
    assert len(calls) == 3


def test_async_op_succeeded_returns_body(fake_clock, monkeypatch):
    """(b) A ``Succeeded`` status resource returns its body."""
    _fake_arm_request(
        monkeypatch,
        [httpx.Response(200, json={"status": "Succeeded", "properties": {"k": "v"}})],
    )

    result = az.wait_for_lro(_initial(ASYNC_HEADERS), timeout_s=60, interval_s=1)

    assert result["status"] == "Succeeded"
    assert result["properties"] == {"k": "v"}


def test_async_op_failed_raises(fake_clock, monkeypatch):
    """(c) A ``Failed`` status resource raises AzureError."""
    _fake_arm_request(
        monkeypatch,
        [httpx.Response(200, json={"status": "Failed", "error": {"code": "Boom"}})],
    )

    with pytest.raises(az.AzureError, match="terminated with status 'failed'"):
        az.wait_for_lro(_initial(ASYNC_HEADERS), timeout_s=60, interval_s=1)


def test_async_op_canceled_raises(fake_clock, monkeypatch):
    """A ``Canceled`` status resource raises AzureError."""
    _fake_arm_request(monkeypatch, [httpx.Response(200, json={"status": "Canceled"})])

    with pytest.raises(az.AzureError, match="terminated with status 'canceled'"):
        az.wait_for_lro(_initial(ASYNC_HEADERS), timeout_s=60, interval_s=1)


def test_async_op_empty_forever_times_out(fake_clock, monkeypatch):
    """(d) An async-op poll that never populates a status times out."""
    calls = _fake_arm_request(monkeypatch, [httpx.Response(200, json={})])

    with pytest.raises(az.AzureError, match="did not reach a terminal state"):
        az.wait_for_lro(_initial(ASYNC_HEADERS), timeout_s=30, interval_s=5)

    # It kept polling (rather than returning after the first empty 200).
    assert len(calls) >= 2


def test_async_op_takes_precedence_over_location(fake_clock, monkeypatch):
    """When both headers are present, the async-op status governs termination.

    An empty 200 must not be treated as done just because a Location header
    also exists on the kickoff response.
    """
    calls = _fake_arm_request(
        monkeypatch,
        [
            httpx.Response(200, json={}),  # empty — async-op still running
            httpx.Response(200, json={"status": "Succeeded"}),
        ],
    )

    result = az.wait_for_lro(
        _initial({**ASYNC_HEADERS, **LOCATION_HEADERS}), timeout_s=60, interval_s=1
    )

    assert result == {"status": "Succeeded"}
    assert len(calls) == 2


# ---------------------------------------------------------------------------
# wait_for_lro — Location style
# ---------------------------------------------------------------------------


def test_location_empty_body_is_done(fake_clock, monkeypatch):
    """(e) A Location poll returning 200 with an empty body IS terminal-done."""
    calls = _fake_arm_request(monkeypatch, [httpx.Response(200)])

    result = az.wait_for_lro(_initial(LOCATION_HEADERS), timeout_s=60, interval_s=1)

    assert result == {}
    assert len(calls) == 1


def test_location_202_then_empty_200_is_done(fake_clock, monkeypatch):
    """A Location poll: 202 keeps polling, a later empty 200 completes."""
    calls = _fake_arm_request(
        monkeypatch,
        [
            httpx.Response(202, headers=LOCATION_HEADERS),
            httpx.Response(200),
        ],
    )

    result = az.wait_for_lro(_initial(LOCATION_HEADERS), timeout_s=60, interval_s=1)

    assert result == {}
    assert len(calls) == 2


def test_location_explicit_failed_provisioning_state_raises(fake_clock, monkeypatch):
    """A Location poll still honors an explicit terminal failure in the body."""
    _fake_arm_request(
        monkeypatch,
        [httpx.Response(200, json={"properties": {"provisioningState": "Failed"}})],
    )

    with pytest.raises(az.AzureError, match="terminated with status 'failed'"):
        az.wait_for_lro(_initial(LOCATION_HEADERS), timeout_s=60, interval_s=1)


# ---------------------------------------------------------------------------
# wait_for_lro — kickoff / header edge cases
# ---------------------------------------------------------------------------


def test_non_202_success_returns_immediately(monkeypatch):
    """A synchronous (non-202) 2xx completes without polling."""
    called: list[str] = []
    monkeypatch.setattr(
        az, "arm_request", lambda *a, **k: called.append(a) or httpx.Response(200)
    )

    resp = httpx.Response(
        200,
        json={"provisioningState": "Succeeded"},
        request=httpx.Request("PUT", "https://management.azure.com/resource"),
    )
    assert az.wait_for_lro(resp) == {"provisioningState": "Succeeded"}
    assert called == []


def test_missing_poll_headers_raises(monkeypatch):
    """A 202 with neither poll header is unusable and raises."""
    with pytest.raises(az.AzureError, match="missing Azure-AsyncOperation / Location"):
        az.wait_for_lro(_initial({}))


# ---------------------------------------------------------------------------
# wait_until_provisioned
# ---------------------------------------------------------------------------


def test_wait_until_provisioned_succeeded(fake_clock, monkeypatch):
    monkeypatch.setattr(
        az,
        "arm_get",
        lambda path, **_kw: {"properties": {"provisioningState": "Succeeded"}},
    )
    out = az.wait_until_provisioned("/resource", timeout_s=30, interval_s=5)
    assert out["properties"]["provisioningState"] == "Succeeded"


def test_wait_until_provisioned_pending_then_succeeded(fake_clock, monkeypatch):
    states = [
        {"properties": {"provisioningState": "Creating"}},
        {"properties": {"provisioningState": "Succeeded"}},
    ]

    def _get(path, **_kw):
        return states.pop(0) if len(states) > 1 else states[0]

    monkeypatch.setattr(az, "arm_get", _get)
    out = az.wait_until_provisioned("/resource", timeout_s=30, interval_s=5)
    assert out["properties"]["provisioningState"] == "Succeeded"


def test_wait_until_provisioned_failed_raises(fake_clock, monkeypatch):
    monkeypatch.setattr(
        az,
        "arm_get",
        lambda path, **_kw: {"properties": {"provisioningState": "Failed"}},
    )
    with pytest.raises(az.AzureError, match="terminal state 'Failed'"):
        az.wait_until_provisioned("/resource", timeout_s=30, interval_s=5)


def test_wait_until_provisioned_reads_status_fallback(fake_clock, monkeypatch):
    """Evaluations report progress under properties.status, not provisioningState."""
    monkeypatch.setattr(
        az,
        "arm_get",
        lambda path, **_kw: {"properties": {"status": "PartiallySucceeded"}},
    )
    out = az.wait_until_provisioned(
        "/evaluations/latest",
        timeout_s=30,
        interval_s=5,
        success_states=("succeeded", "partiallysucceeded"),
    )
    assert out["properties"]["status"] == "PartiallySucceeded"


def test_wait_until_provisioned_times_out(fake_clock, monkeypatch):
    monkeypatch.setattr(
        az,
        "arm_get",
        lambda path, **_kw: {"properties": {"provisioningState": "Creating"}},
    )
    with pytest.raises(az.AzureError, match="did not reach a terminal provisioning state"):
        az.wait_until_provisioned("/resource", timeout_s=30, interval_s=5)
