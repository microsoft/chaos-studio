// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

using System;
using System.Net;
using System.Threading;
using System.Threading.Tasks;
using Microsoft.Azure.Chaos.ArmGatewayService.Common.Api.AsyncOperations;

namespace Microsoft.Azure.Chaos.ArmGatewayService.Resources.Workspace.Scenario.Configuration.Api.DomainLogic
{
    /// <summary>
    /// Version-agnostic V1 domain logic for scenario-configuration actions. The
    /// version-specific controllers (including V2026_05_01_preview) delegate to
    /// this implementation.
    /// </summary>
    public partial class ConfigurationDomainLogicV1
    {
        // GW default Retry-After for the validate/execute/cancel async operations.
        private const int DefaultRetryAfterSeconds = 10;

        /// <summary>
        /// Starts validation of a scenario configuration. Validation always writes
        /// the single validations/latest resource; the request carries no body and
        /// no caller-supplied key. The method returns an accepted async operation
        /// whose Location points directly at validations/latest for the caller to
        /// poll.
        /// </summary>
        public async Task<AsyncOperationResponse> ValidateAsync(
            ConfigurationResourceReference reference,
            RequestContext context,
            CancellationToken cancellationToken)
        {
            var validationResourceId = reference.ChildResourceId("validations", "latest");

            await this.backendClient
                .StartScenarioValidationAsync(reference, context, cancellationToken)
                .ConfigureAwait(false);

            return AsyncOperationRequestUtility.AcceptedAsyncOperation(
                statusCode: HttpStatusCode.Accepted,
                location: AsyncOperationRequestUtility.BuildResourceLocation(validationResourceId, context.ApiVersion),
                retryAfterSeconds: DefaultRetryAfterSeconds);
        }

        /// <summary>
        /// Reads the validations/latest resource. Returns the full validation
        /// resource with HTTP 202 while nonterminal and HTTP 200 once terminal.
        /// </summary>
        public async Task<HttpResponseResult> GetLatestValidationAsync(
            ConfigurationResourceReference reference,
            RequestContext context,
            CancellationToken cancellationToken)
        {
            var validation = await this.backendClient
                .GetLatestScenarioValidationAsync(reference, context, cancellationToken)
                .ConfigureAwait(false);

            if (validation.Properties.Status.IsTerminal())
            {
                return HttpResponseResult.Ok(validation);
            }

            return HttpResponseResult.Accepted(validation, retryAfterSeconds: DefaultRetryAfterSeconds);
        }

        /// <summary>
        /// Executes a scenario configuration, creating a scenario run. The backend
        /// generates the run identifier synchronously and returns it to the gateway
        /// before the external response is produced. The method returns an accepted
        /// async operation whose Location is the full run resource id ending in the
        /// generated run id, which the caller parses to obtain the run id.
        /// </summary>
        public async Task<AsyncOperationResponse> ExecuteAsync(
            ConfigurationResourceReference reference,
            RequestContext context,
            CancellationToken cancellationToken)
        {
            var runId = await this.backendClient
                .StartScenarioExecutionAsync(reference, context, cancellationToken)
                .ConfigureAwait(false);

            var runResourceId = reference.ScenarioRunResourceId(runId);

            return AsyncOperationRequestUtility.AcceptedAsyncOperation(
                statusCode: HttpStatusCode.Accepted,
                location: AsyncOperationRequestUtility.BuildResourceLocation(runResourceId, context.ApiVersion),
                retryAfterSeconds: DefaultRetryAfterSeconds);
        }
    }
}
