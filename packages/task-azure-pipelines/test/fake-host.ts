/**
 * Deterministic fakes for the Azure Pipelines task adapter tests. Not a
 * `*.test.ts` file, so the runner treats it as a helper. No
 * `azure-pipelines-task-lib`, no `@azure/identity`, no network.
 */
import type { TaskHost } from '../src/adapter.ts';
import type { ICredentialProvider } from '../../core/src/contract.ts';

/** Records every `azure-pipelines-task-lib`-equivalent call the adapter makes. */
export class FakeTaskHost implements TaskHost {
  readonly inputs: Record<string, string>;
  readonly outputs: Record<string, string> = {};
  /** Every setVariable call, including its isOutput flag, in order. */
  readonly variables: Array<{ name: string; value: string; isOutput: boolean }> = [];
  readonly infos: string[] = [];
  readonly warnings: string[] = [];
  readonly errors: string[] = [];
  readonly masked: string[] = [];
  readonly results: Array<{ success: boolean; message: string }> = [];

  constructor(inputs: Record<string, string> = {}) {
    this.inputs = inputs;
  }

  /** Mirrors `tl.getInput`: returns undefined for an unset input. */
  getInput(name: string): string | undefined {
    return this.inputs[name];
  }
  setVariable(name: string, value: string, isOutput: boolean): void {
    this.variables.push({ name, value, isOutput });
    this.outputs[name] = value;
  }
  setResult(success: boolean, message: string): void {
    this.results.push({ success, message });
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

  /** Whether the task was failed (any Failed result). */
  get failed(): boolean {
    return this.results.some((r) => !r.success);
  }
  /** The message of the first failing result, if any. */
  get failureMessage(): string | undefined {
    return this.results.find((r) => !r.success)?.message;
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
