/**
 * Deterministic fakes for the GitHub Action adapter tests. Not a `*.test.ts`
 * file, so the runner treats it as a helper. No `@actions/core`, no
 * `@azure/identity`, no network.
 */
import type { ActionsHost } from '../src/adapter.ts';
import type { ICredentialProvider } from '../../core/src/contract.ts';

/** Records every `@actions/core`-equivalent call the adapter makes. */
export class FakeActionsHost implements ActionsHost {
  readonly inputs: Record<string, string>;
  readonly outputs: Record<string, string> = {};
  readonly infos: string[] = [];
  readonly warnings: string[] = [];
  readonly errors: string[] = [];
  readonly masked: string[] = [];
  readonly failures: string[] = [];

  constructor(inputs: Record<string, string> = {}) {
    this.inputs = inputs;
  }

  /** Mirrors `@actions/core.getInput`: returns '' for an unset input. */
  getInput(name: string): string {
    return this.inputs[name] ?? '';
  }
  setOutput(name: string, value: string): void {
    this.outputs[name] = value;
  }
  setFailed(message: string): void {
    this.failures.push(message);
  }
  info(message: string): void {
    this.infos.push(message);
  }
  warning(message: string): void {
    this.warnings.push(message);
  }
  error(message: string): void {
    this.errors.push(message);
  }
  setSecret(secret: string): void {
    this.masked.push(secret);
  }

  /** Whether the step was failed. */
  get failed(): boolean {
    return this.failures.length > 0;
  }
}

/** A credential that returns a fixed token and records the scopes it was asked for. */
export class FakeTokenCredentialProvider implements ICredentialProvider {
  readonly scopes: string[] = [];
  private readonly token: string;
  constructor(token = 'fake-arm-access-token') {
    this.token = token;
  }
  getArmToken(scope: string): Promise<string> {
    this.scopes.push(scope);
    return Promise.resolve(this.token);
  }
}
