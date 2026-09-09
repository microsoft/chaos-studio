// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

using System.Threading;
using System.Threading.Tasks;

namespace Chaos.Workspaces.Infrastructure.Stores
{
    /// <summary>
    /// Persistence for the validations/latest singleton. There is exactly one
    /// validation resource per configuration; a new validation replaces it in
    /// place. The upsert takes no version, row-version, or conditional-update
    /// parameter, so the write is unconditional and overwrites any prior plan.
    /// </summary>
    public sealed class ScenarioValidationStore : IScenarioValidationStore
    {
        private readonly IDocumentContainer container;

        public ScenarioValidationStore(IDocumentContainer container)
        {
            this.container = container;
        }

        public async Task UpsertLatestAsync(
            ScenarioConfigurationReference configuration,
            ScenarioValidation validation,
            CancellationToken cancellationToken)
        {
            var document = ScenarioValidationDocument.From(configuration, validation);

            // Unconditional upsert: the id is the fixed "latest" partition key for
            // this configuration, so this replaces the existing document (and its
            // execution plan) with no conditional-update guard.
            await this.container
                .UpsertAsync(document, cancellationToken)
                .ConfigureAwait(false);
        }

        public async Task<ScenarioValidation> GetLatestAsync(
            ScenarioConfigurationReference configuration,
            CancellationToken cancellationToken)
        {
            var document = await this.container
                .ReadAsync(ScenarioValidationDocument.LatestId(configuration), cancellationToken)
                .ConfigureAwait(false);

            return document.ToDomain();
        }
    }
}
