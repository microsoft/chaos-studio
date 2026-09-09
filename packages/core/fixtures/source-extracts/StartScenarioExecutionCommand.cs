// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

using System;
using System.Threading;
using System.Threading.Tasks;

namespace Chaos.Workspaces.Application.Commands
{
    /// <summary>
    /// Starts a scenario execution, creating a scenario run. Resolves the
    /// resource-selector map on the fly; evaluation is advisory, not required, so
    /// a null discovery/evaluation snapshot is accepted. The run identifier is
    /// generated synchronously (before persistence) and returned so the gateway
    /// can place it in the external Location header.
    /// </summary>
    public sealed class StartScenarioExecutionCommandHandler
        : IRequestHandler<StartScenarioExecutionCommand, Guid>
    {
        private readonly IResourceSelectorResolver resolver;
        private readonly IScenarioRunStore runStore;

        public StartScenarioExecutionCommandHandler(
            IResourceSelectorResolver resolver,
            IScenarioRunStore runStore)
        {
            this.resolver = resolver;
            this.runStore = runStore;
        }

        public async Task<Guid> Handle(
            StartScenarioExecutionCommand command,
            CancellationToken cancellationToken)
        {
            // Evaluation is not required. Resolve on demand, accepting a null
            // evaluation snapshot rather than requiring an evaluation prerequisite.
            var resolved = await this.resolver
                .ResolveAsync(command.Configuration, evaluationSnapshot: null, cancellationToken)
                .ConfigureAwait(false);

            // Generate the run id up front so it can be returned synchronously.
            var runId = Guid.NewGuid();
            var run = ScenarioRun.CreateQueued(runId, command.Configuration, resolved);

            await this.runStore
                .InsertAsync(run, cancellationToken)
                .ConfigureAwait(false);

            return runId;
        }
    }
}
