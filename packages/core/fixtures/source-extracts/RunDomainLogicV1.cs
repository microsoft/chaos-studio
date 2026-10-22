// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

using System;
using System.Net;
using System.Threading;
using System.Threading.Tasks;
using Microsoft.Azure.Chaos.ArmGatewayService.Common.Api.AsyncOperations;

namespace Microsoft.Azure.Chaos.ArmGatewayService.Resources.Workspace.Scenario.Run.Api.DomainLogic
{
    /// <summary>
    /// Version-agnostic V1 domain logic for scenario-run reads and the cancel
    /// action. The version-specific controllers delegate to this implementation.
    /// </summary>
    public partial class RunDomainLogicV1
    {
        // GW default Retry-After for the run poll and cancel async operations.
        private const int DefaultRetryAfterSeconds = 10;

        /// <summary>
        /// Reads a scenario run. Returns the full run resource with HTTP 202 while
        /// the run is nonterminal and HTTP 200 once it reaches a terminal state.
        /// </summary>
        public async Task<HttpResponseResult> GetRunAsync(
            RunResourceReference reference,
            RequestContext context,
            CancellationToken cancellationToken)
        {
            var run = await this.backendClient
                .GetScenarioRunAsync(reference, context, cancellationToken)
                .ConfigureAwait(false);

            // Terminal runs return 200; nonterminal runs return 202 with a
            // Retry-After so the client keeps polling the same resource.
            if (run.Properties.Status.IsTerminal())
            {
                return HttpResponseResult.Ok(run);
            }

            return HttpResponseResult.Accepted(run, retryAfterSeconds: DefaultRetryAfterSeconds);
        }

        /// <summary>
        /// Cancels a scenario run. Cancellation requires the run id (the run must
        /// already exist). The backend records the cancellation request; repeated
        /// cancellation is idempotent and terminal runs no-op. The method returns
        /// an accepted async operation whose Location is the SAME run resource the
        /// client already polls, so no new resource is introduced.
        /// </summary>
        public async Task<AsyncOperationResponse> CancelRunAsync(
            RunResourceReference reference,
            RequestContext context,
            CancellationToken cancellationToken)
        {
            await this.backendClient
                .CancelScenarioRunAsync(reference, context, cancellationToken)
                .ConfigureAwait(false);

            var runResourceId = reference.RunResourceId;

            return AsyncOperationRequestUtility.AcceptedAsyncOperation(
                statusCode: HttpStatusCode.Accepted,
                location: AsyncOperationRequestUtility.BuildResourceLocation(runResourceId, context.ApiVersion),
                retryAfterSeconds: DefaultRetryAfterSeconds);
        }
    }
}
