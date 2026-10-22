/**
 * host.ts (E3-T1) — the ONLY module that imports `@actions/core`. It adapts the
 * real GitHub Actions toolkit to the platform-free {@link ActionsHost} interface
 * the rest of the adapter is written against, so the deterministic adapter tests
 * never load the toolkit. `warning`/`error` produce GitHub annotations; `info` is
 * a normal log line; `setSecret` emits the `::add-mask::` command; `setFailed`
 * fails the step with a nonzero exit code.
 */

import * as core from '@actions/core';
import type { ActionsHost } from './adapter.ts';

/** The real GitHub Actions host backed by `@actions/core`. */
export function githubActionsHost(): ActionsHost {
  return {
    getInput: (name) => core.getInput(name),
    setOutput: (name, value) => core.setOutput(name, value),
    setFailed: (message) => core.setFailed(message),
    info: (message) => core.info(message),
    warning: (message) => core.warning(message),
    error: (message) => core.error(message),
    setSecret: (secret) => core.setSecret(secret),
  };
}
