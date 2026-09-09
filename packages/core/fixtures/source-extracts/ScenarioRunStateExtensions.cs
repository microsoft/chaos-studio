// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

namespace Chaos.Workspaces.Domain
{
    /// <summary>
    /// State predicates over <see cref="ScenarioRunState"/>. The cancel handler and the
    /// run GET both branch on <see cref="IsTerminal"/> to decide whether a run has
    /// reached a final, non-advancing state.
    /// </summary>
    public static class ScenarioRunStateExtensions
    {
        // A run is TERMINAL once it has reached a final, non-advancing state: it has
        // Succeeded, Failed, or been Canceled. Every other state — including Canceling,
        // which is a cancel STILL IN PROGRESS — is non-terminal. This is the exact
        // predicate the cancel handler's terminal-no-op guard applies to run.Status.
        public static bool IsTerminal(this ScenarioRunState state)
        {
            return state == ScenarioRunState.Succeeded
                || state == ScenarioRunState.Failed
                || state == ScenarioRunState.Canceled;
        }
    }
}
