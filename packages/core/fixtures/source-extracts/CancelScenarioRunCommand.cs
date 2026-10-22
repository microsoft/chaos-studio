// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

using System.Threading;
using System.Threading.Tasks;

namespace Chaos.Workspaces.Application.Commands
{
    /// <summary>
    /// Cancels a scenario run. The cancel operation is state-aware and IDEMPOTENT:
    ///  - if the run is already in a TERMINAL state (Succeeded/Failed/Canceled) the
    ///    handler NO-OPs (it neither transitions the run nor throws), so a cancel
    ///    against a finished run is accepted and harmless;
    ///  - if the run is already Canceling/Canceled a repeated cancel NO-OPs as well,
    ///    so issuing cancel more than once is safe (idempotent);
    ///  - otherwise it records the cancellation by transitioning the run to Canceling.
    /// The handler returns without throwing in every case, so the gateway can return
    /// the accepted async-operation response regardless of the run's current state.
    /// </summary>
    public sealed class CancelScenarioRunCommandHandler
        : IRequestHandler<CancelScenarioRunCommand, Unit>
    {
        private readonly IScenarioRunStore runStore;

        public CancelScenarioRunCommandHandler(IScenarioRunStore runStore)
        {
            this.runStore = runStore;
        }

        public async Task<Unit> Handle(
            CancelScenarioRunCommand command,
            CancellationToken cancellationToken)
        {
            var run = await this.runStore
                .GetAsync(command.RunId, cancellationToken)
                .ConfigureAwait(false);

            // Terminal runs no-op: a cancel against a finished run neither transitions
            // it nor throws — the request is accepted and has no effect.
            if (run.Status.IsTerminal())
            {
                return Unit.Value;
            }

            // Idempotent: a run already being canceled no-ops on a repeated cancel.
            if (run.Status == ScenarioRunState.Canceling)
            {
                return Unit.Value;
            }

            // Otherwise record the cancellation request by moving to Canceling.
            run.TransitionTo(ScenarioRunState.Canceling);
            await this.runStore
                .UpdateAsync(run, cancellationToken)
                .ConfigureAwait(false);

            return Unit.Value;
        }
    }
}
