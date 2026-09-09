import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  API_VERSION,
  MODES,
  DEFAULT_MODE,
  INPUT_NAMES,
  OUTPUT_NAMES,
  VALIDATION_STATES,
  VALIDATION_TERMINAL_SUCCESS,
  VALIDATION_TERMINAL_FAILURE,
  RUN_STATES,
  RUN_TERMINAL_SUCCESS,
  RUN_TERMINAL_FAILURE,
  STATUS_FIELD,
  START_TIME_FIELD,
  END_TIME_FIELD,
  VALIDATION_ERROR_CHANNELS,
  RUN_ERROR_CHANNELS,
  DEFAULT_RETRY_AFTER_SECONDS,
  GUID_PATTERN,
  PROVIDER_OPERATIONS,
  ERROR_CATEGORIES,
} from '../../src/contract.ts';

test('API version is pinned to 2026-05-01-preview (D5, VF14)', () => {
  assert.equal(API_VERSION, '2026-05-01-preview');
});

test('mode enum is closed with the documented default (D1)', () => {
  assert.deepEqual([...MODES], ['validate-and-execute', 'validate-only', 'execute-only']);
  assert.equal(DEFAULT_MODE, 'validate-and-execute');
});

test('canonical input names are kebab-case and cover every Inputs field (NFR5)', () => {
  assert.deepEqual(INPUT_NAMES, {
    subscriptionId: 'subscription-id',
    resourceGroup: 'resource-group',
    workspaceName: 'workspace-name',
    scenarioName: 'scenario-name',
    scenarioConfigurationName: 'scenario-configuration-name',
    mode: 'mode',
    waitForCompletion: 'wait-for-completion',
    completionTimeoutSeconds: 'completion-timeout-seconds',
    cancelOnTimeoutOrCancellation: 'cancel-on-timeout-or-cancellation',
  });
});

test('canonical outputs are exactly the eight scalars (D11)', () => {
  assert.deepEqual(
    [...OUTPUT_NAMES],
    [
      'validation-state',
      'run-id',
      'run-resource-id',
      'run-state',
      'started-at',
      'completed-at',
      'correlation-id',
      'request-id',
    ],
  );
});

test('validation states and terminal classification match VF3', () => {
  assert.deepEqual(
    [...VALIDATION_STATES],
    [
      'Resolving',
      'Generating',
      'Validating',
      'Accepted',
      'NotStarted',
      'RequiresAttention',
      'NoResolvedResources',
      'Succeeded',
    ],
  );
  assert.deepEqual([...VALIDATION_TERMINAL_SUCCESS], ['Succeeded']);
  assert.deepEqual([...VALIDATION_TERMINAL_FAILURE], ['RequiresAttention', 'NoResolvedResources']);
});

test('run states and terminal classification match VF7', () => {
  assert.deepEqual(
    [...RUN_STATES],
    [
      'Queued',
      'Resolving',
      'Generating',
      'Validating',
      'ValidationSucceeded',
      'Starting',
      'Preparing',
      'Running',
      'CleaningUp',
      'Canceling',
      'Canceled',
      'Succeeded',
      'Failed',
    ],
  );
  assert.deepEqual([...RUN_TERMINAL_SUCCESS], ['Succeeded']);
  assert.deepEqual([...RUN_TERMINAL_FAILURE], ['Failed', 'Canceled']);
});

test('DX2: wire fields are status + startTime/endTime + dual error channels', () => {
  assert.equal(STATUS_FIELD, 'status');
  assert.equal(START_TIME_FIELD, 'startTime');
  assert.equal(END_TIME_FIELD, 'endTime');
  assert.deepEqual([...VALIDATION_ERROR_CHANNELS], ['errors', 'validationErrors']);
  assert.deepEqual([...RUN_ERROR_CHANNELS], ['errors', 'executionErrors']);
});

test('default Retry-After is 10 seconds (VF1, VF5, VF8)', () => {
  assert.equal(DEFAULT_RETRY_AFTER_SECONDS, 10);
});

test('GUID pattern accepts a run GUID and rejects non-GUIDs (DX3)', () => {
  assert.ok(GUID_PATTERN.test('22222222-2222-2222-2222-222222222222'));
  assert.ok(!GUID_PATTERN.test('latest'));
  assert.ok(!GUID_PATTERN.test('22222222-2222-2222-2222'));
});

test('DX1: generated provider operations use execute/action, never run/action', () => {
  const values: string[] = Object.values(PROVIDER_OPERATIONS);
  assert.ok(values.includes('Microsoft.Chaos/workspaces/scenarios/configurations/execute/action'));
  assert.ok(!values.includes('Microsoft.Chaos/workspaces/scenarios/run/action'));
});

test('error categories are the normalized set', () => {
  assert.deepEqual(
    [...ERROR_CATEGORIES],
    ['auth', 'identifier', 'transport', 'validation-failed', 'run-failed', 'timeout', 'ambiguous-acceptance'],
  );
});
