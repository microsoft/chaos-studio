// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

using System.Threading;
using System.Threading.Tasks;

namespace Chaos.Workspaces.Application.Resolution
{
    /// <summary>
    /// Resolves the resource-selector map for a scenario configuration on demand.
    /// The evaluation snapshot is optional: the parameter is nullable and a null
    /// snapshot is accepted (resolution proceeds against the live selector map).
    /// There is no evaluation prerequisite and no evaluation-required failure.
    /// </summary>
    public sealed class ResourceSelectorResolver : IResourceSelectorResolver
    {
        private readonly ISelectorEvaluator evaluator;

        public ResourceSelectorResolver(ISelectorEvaluator evaluator)
        {
            this.evaluator = evaluator;
        }

        public async Task<ResolvedSelectorMap> ResolveAsync(
            ScenarioConfigurationReference configuration,
            EvaluationSnapshot? evaluationSnapshot,
            CancellationToken cancellationToken)
        {
            // A null snapshot is valid: resolve against the live selectors instead
            // of a cached evaluation. No prerequisite check, no conflict.
            var source = evaluationSnapshot?.SelectorMap
                ?? await this.evaluator.ResolveLiveAsync(configuration, cancellationToken).ConfigureAwait(false);

            return ResolvedSelectorMap.From(source);
        }
    }
}
