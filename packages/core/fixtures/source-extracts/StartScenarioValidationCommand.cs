// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

using System.Threading;
using System.Threading.Tasks;

namespace Chaos.Workspaces.Application.Commands
{
    /// <summary>
    /// Starts a scenario-configuration validation. Resolves the resource-selector
    /// map on the fly and writes the validations/latest resource. Evaluation is
    /// advisory, not required: a null discovery/evaluation snapshot is accepted.
    /// The handler reads no conditional-update header or version guard and no
    /// caller-supplied key; the write overwrites the existing validations/latest
    /// in place.
    /// </summary>
    public sealed class StartScenarioValidationCommandHandler
        : IRequestHandler<StartScenarioValidationCommand, ScenarioValidation>
    {
        private readonly IResourceSelectorResolver resolver;
        private readonly IScenarioValidationStore validationStore;

        public StartScenarioValidationCommandHandler(
            IResourceSelectorResolver resolver,
            IScenarioValidationStore validationStore)
        {
            this.resolver = resolver;
            this.validationStore = validationStore;
        }

        public async Task<ScenarioValidation> Handle(
            StartScenarioValidationCommand command,
            CancellationToken cancellationToken)
        {
            // Evaluation is not required. Resolve the selector map on demand,
            // accepting a null discovery/evaluation snapshot. The legacy
            // evaluation prerequisite was removed and signed off.
            var resolved = await this.resolver
                .ResolveAsync(command.Configuration, evaluationSnapshot: null, cancellationToken)
                .ConfigureAwait(false);

            var validation = ScenarioValidation.Create(command.Configuration, resolved);

            // Overwrite semantics: validations/latest is a single resource per
            // configuration. The store upserts it, replacing any prior validation
            // (and its execution plan) in place. No conditional-update guard.
            await this.validationStore
                .UpsertLatestAsync(command.Configuration, validation, cancellationToken)
                .ConfigureAwait(false);

            return validation;
        }
    }
}
