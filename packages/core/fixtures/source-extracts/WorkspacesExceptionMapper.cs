// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

using System.Net;

namespace Chaos.Workspaces.Api.ErrorHandling
{
    /// <summary>
    /// Maps workspace domain exceptions to HTTP status codes for the scenario
    /// validate/execute/run surface. The validate and execute flows have neither a
    /// conditional-request nor an evaluation prerequisite, so this map defines no
    /// precondition-failed status and no evaluation-required conflict for them.
    /// </summary>
    public sealed class WorkspacesExceptionMapper : IExceptionMapper
    {
        public HttpStatusCode Map(WorkspacesDomainException exception)
        {
            return exception switch
            {
                ResourceNotFoundException => HttpStatusCode.NotFound,
                ResourceConflictException => HttpStatusCode.Conflict,
                InvalidRequestException => HttpStatusCode.BadRequest,
                UnauthorizedResourceAccessException => HttpStatusCode.Forbidden,
                RequestThrottledException => HttpStatusCode.TooManyRequests,
                _ => HttpStatusCode.InternalServerError,
            };
        }
    }
}
