// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

using System.Collections.Generic;
using System.Threading;
using System.Threading.Tasks;

namespace Chaos.Workspaces.Application.Resolution
{
    /// <summary>
    /// Concrete terminal callee of the live-resolution path: queries the live
    /// selector targets for a configuration. This is the deepest delegate
    /// <see cref="SelectorEvaluator.ResolveLiveAsync"/> invokes. It performs a plain
    /// read of the current targets and returns whatever exists — including an EMPTY
    /// list — WITHOUT requiring a prior evaluation and WITHOUT raising an
    /// evaluation-required conflict or any 409. There is no throw on this path.
    /// </summary>
    public sealed class SelectorTargetQuery : ISelectorTargetQuery
    {
        private readonly ISelectorTargetStore store;

        public SelectorTargetQuery(ISelectorTargetStore store)
        {
            this.store = store;
        }

        public async Task<IReadOnlyList<SelectorTarget>> QueryAsync(
            ScenarioConfigurationReference configuration,
            CancellationToken cancellationToken)
        {
            // A plain read of the live targets. No evaluation prerequisite, no
            // conflict, no 409: an empty or partial result is returned as-is.
            var targets = await this.store
                .ListTargetsAsync(configuration, cancellationToken)
                .ConfigureAwait(false);

            return targets;
        }
    }
}
