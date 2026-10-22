// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

using System.Collections.Generic;

namespace Chaos.Workspaces.Application.Resolution
{
    /// <summary>
    /// The map of resolved selectors returned by the resolution pipeline. The
    /// construction helper <see cref="From"/> is a PURE, total factory: it wraps the
    /// provided selector map without validation, evaluation prerequisite, conflict,
    /// or 409 — an empty input yields an empty ResolvedSelectorMap. It never throws.
    /// </summary>
    public sealed class ResolvedSelectorMap
    {
        private readonly SelectorMap map;

        private ResolvedSelectorMap(SelectorMap map)
        {
            this.map = map;
        }

        public static ResolvedSelectorMap From(SelectorMap map)
        {
            // Pure wrap. No conflict, no throw, no 409.
            return new ResolvedSelectorMap(map);
        }
    }

    /// <summary>
    /// The live selector map. The construction helper <see cref="FromLiveTargets"/>
    /// is a PURE, total factory that projects the queried live targets into a map.
    /// It performs no evaluation prerequisite check, raises no conflict, maps to no
    /// 409, and never throws — an empty target list yields an empty SelectorMap.
    /// </summary>
    public sealed class SelectorMap
    {
        private readonly IReadOnlyList<SelectorTarget> targets;

        private SelectorMap(IReadOnlyList<SelectorTarget> targets)
        {
            this.targets = targets;
        }

        public static SelectorMap FromLiveTargets(IReadOnlyList<SelectorTarget> targets)
        {
            // Pure projection. No conflict, no throw, no 409.
            return new SelectorMap(targets);
        }
    }
}
