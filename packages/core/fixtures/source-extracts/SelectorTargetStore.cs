// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

using System.Collections.Generic;
using System.Linq;
using System.Threading;
using System.Threading.Tasks;

namespace Chaos.Workspaces.Application.Resolution
{
    /// <summary>
    /// Concrete store the live-resolution path reads from. This is the deepest,
    /// state-touching callee of <see cref="SelectorTargetQuery.QueryAsync"/>. It is
    /// a PLAIN READ of the currently persisted selector targets: it never enforces
    /// an evaluation prerequisite, never raises an evaluation-required conflict, and
    /// never maps to a 409 — an empty result set is returned as-is. There is no
    /// throw on this path.
    /// </summary>
    public sealed class SelectorTargetStore : ISelectorTargetStore
    {
        private readonly IWorkspacesDbContext db;

        public SelectorTargetStore(IWorkspacesDbContext db)
        {
            this.db = db;
        }

        public async Task<IReadOnlyList<SelectorTarget>> ListTargetsAsync(
            ScenarioConfigurationReference configuration,
            CancellationToken cancellationToken)
        {
            // A straight query with no conflict/precondition semantics. If nothing is
            // persisted yet (unevaluated workspace), this returns an EMPTY list.
            var rows = await this.db.SelectorTargets
                .Where(t => t.ConfigurationId == configuration.ConfigurationId)
                .ToListAsync(cancellationToken)
                .ConfigureAwait(false);

            return rows;
        }
    }
}
