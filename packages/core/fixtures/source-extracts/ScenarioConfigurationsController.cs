// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

using System.Net;
using System.Threading;
using System.Threading.Tasks;
using MediatR;
using Microsoft.AspNetCore.Mvc;

namespace Chaos.Workspaces.Api.Controllers
{
    /// <summary>
    /// Backend controller for scenario-configuration validate/execute actions and
    /// the validations/latest read. Each action dispatches a command/query and
    /// returns 202 Accepted for the long-running actions; there is no conditional
    /// request handling (no precondition binding, no precondition short-circuit)
    /// and no evaluation prerequisite (no conflict path for an unevaluated
    /// workspace).
    /// </summary>
    [ApiController]
    public sealed class ScenarioConfigurationsController : ControllerBase
    {
        private readonly IMediator mediator;

        public ScenarioConfigurationsController(IMediator mediator)
        {
            this.mediator = mediator;
        }

        [HttpPost("validate")]
        public async Task<IActionResult> Validate(
            ScenarioConfigurationRouteValues route,
            CancellationToken cancellationToken)
        {
            var command = StartScenarioValidationCommand.FromRoute(route);
            await this.mediator.Send(command, cancellationToken).ConfigureAwait(false);
            return this.StatusCode((int)HttpStatusCode.Accepted);
        }

        [HttpGet("validations/latest")]
        public async Task<IActionResult> GetLatestValidation(
            ScenarioConfigurationRouteValues route,
            CancellationToken cancellationToken)
        {
            var query = GetLatestScenarioValidationQuery.FromRoute(route);
            var validation = await this.mediator.Send(query, cancellationToken).ConfigureAwait(false);
            var status = validation.Properties.Status.IsTerminal()
                ? HttpStatusCode.OK
                : HttpStatusCode.Accepted;
            return this.StatusCode((int)status, validation);
        }

        [HttpPost("execute")]
        public async Task<IActionResult> Execute(
            ScenarioConfigurationRouteValues route,
            CancellationToken cancellationToken)
        {
            var command = StartScenarioExecutionCommand.FromRoute(route);
            var runId = await this.mediator.Send(command, cancellationToken).ConfigureAwait(false);
            this.Response.Headers["x-ms-run-id"] = runId.ToString();
            return this.StatusCode((int)HttpStatusCode.Accepted);
        }
    }
}
