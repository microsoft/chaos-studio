// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

namespace Chaos.Workspaces.Domain
{
    /// <summary>
    /// State predicates over <see cref="ScenarioValidationState"/>. The validate GET
    /// (GetLatestValidationAsync) branches on <see cref="IsTerminal"/> to decide whether
    /// a validation has reached a final, non-advancing state and should be returned with
    /// HTTP 200 (terminal) instead of HTTP 202 (still in progress).
    /// </summary>
    public static class ScenarioValidationStateExtensions
    {
        // A validation is TERMINAL once it has reached a final, non-advancing state:
        // Succeeded (terminal success), or RequiresAttention / NoResolvedResources
        // (terminal failures). Every other state — Resolving, Generating, Validating,
        // Accepted, NotStarted — is a still-advancing, non-terminal state. This is the
        // exact predicate GetLatestValidationAsync applies to validation.Properties.Status.
        public static bool IsTerminal(this ScenarioValidationState state)
        {
            return state == ScenarioValidationState.Succeeded
                || state == ScenarioValidationState.RequiresAttention
                || state == ScenarioValidationState.NoResolvedResources;
        }
    }
}
