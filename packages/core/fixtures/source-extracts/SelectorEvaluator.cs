// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

using System.Threading;
using System.Threading.Tasks;

namespace Chaos.Workspaces.Application.Resolution
{
    /// <summary>
    /// Evaluates resource selectors LIVE (without a cached evaluation snapshot).
    /// This is the path <see cref="ResourceSelectorResolver.ResolveAsync"/> takes
    /// when the caller passes a null snapshot. It queries the live selector targets
    /// and returns whatever resolves — including an EMPTY map — without requiring a
    /// prior evaluation and without raising an evaluation-required conflict.
    /// </summary>
    public sealed class SelectorEvaluator : ISelectorEvaluator
    {
        private readonly ISelectorTargetQuery targetQuery;

        public SelectorEvaluator(ISelectorTargetQuery targetQuery)
        {
            this.targetQuery = targetQuery;
        }

        public async Task<SelectorMap> ResolveLiveAsync(
            ScenarioConfigurationReference configuration,
            CancellationToken cancellationToken)
        {
            // Query the live targets for each selector. No evaluation prerequisite
            // is enforced and no conflict is thrown for an unevaluated workspace: an
            // empty or partial result is returned as-is for the caller to act on.
            var targets = await this.targetQuery
                .QueryAsync(configuration, cancellationToken)
                .ConfigureAwait(false);

            return SelectorMap.FromLiveTargets(targets);
        }
    }
}
