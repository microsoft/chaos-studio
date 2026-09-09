// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

using Microsoft.Extensions.DependencyInjection;

namespace Chaos.Workspaces.Application.Resolution
{
    /// <summary>
    /// The dependency-injection registration for the resolution pipeline. This
    /// binds each resolution INTERFACE to the CONCRETE implementation that the
    /// runtime resolves, so the VF11 authentication can follow the exact concrete
    /// callees the resolver depends on — not merely an interface that could be
    /// bound to a throwing implementation. The whole chain
    /// (resolver -> evaluator -> target query -> target store) is wired here.
    /// </summary>
    public static class ResolutionServiceRegistration
    {
        public static IServiceCollection AddResolution(this IServiceCollection services)
        {
            services.AddScoped<IResourceSelectorResolver, ResourceSelectorResolver>();
            services.AddScoped<ISelectorEvaluator, SelectorEvaluator>();
            services.AddScoped<ISelectorTargetQuery, SelectorTargetQuery>();
            services.AddScoped<ISelectorTargetStore, SelectorTargetStore>();
            return services;
        }
    }
}
