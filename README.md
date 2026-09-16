# Azure Chaos Studio — Open Source

Community tooling, samples, and scenarios for **Azure Chaos Studio**, the managed
resilience-testing service for Azure: break things on purpose, prove your system
recovers.

> This is the open-source companion repo. The **service** is documented at
> [learn.microsoft.com/azure/chaos-studio](https://learn.microsoft.com/azure/chaos-studio).
> What lives here is community tooling and samples — not the service source.

## What's here

| Component | Path | What it is |
|---|---|---|
| **GitHub Action + Azure Pipelines task** | [`action.yml`](action.yml) · [`packages/`](packages/) · [`azure-pipelines-extension/`](azure-pipelines-extension/) | Validate and run a Chaos Studio v2 scenario configuration from CI/CD with workload identity — one step instead of a page of raw ARM calls. A shared TypeScript core drives both platforms. _(In active development — preview.)_ |
| **Copilot CLI plugin + MCP server** | [`copilot-cli-plugin/`](copilot-cli-plugin/) | Create workspaces, configure scenarios, run experiments, and analyze impact — from a conversation or an autonomous agent. |
| **Scenarios** | [`scenarios/`](scenarios/) | Shareable custom Scenario definitions (Bicep/JSON) beyond the built-in templates. |
| **Samples** | [`samples/`](samples/) | Sample apps and infrastructure you can deploy and break to practice. |

## GitHub Action preview status

> The runnable Action bundle is committed in this repository, but the public
> `microsoft/chaos-studio@v1` ref does **not exist yet**. The workflow below is
> the planned quickstart after the first preview release; it will return
> "reference not found" if copied before that release. Until a release appears
> on the repository's Releases page, use the local tests and packaging
> instructions rather than guessing a branch SHA.

```yaml
# Planned usage after the first public preview publishes v1.
permissions:
  id-token: write   # required for OIDC sign-in
  contents: read
steps:
  - uses: azure/login@a457da9ea143d694b1b9c7c869ebb04ebe844ef5 # v2.3.0
    with:
      client-id: ${{ secrets.AZURE_CLIENT_ID }}
      tenant-id: ${{ secrets.AZURE_TENANT_ID }}
      subscription-id: ${{ secrets.AZURE_SUBSCRIPTION_ID }}
  - uses: microsoft/chaos-studio@v1
    with:
      subscription-id: ${{ secrets.AZURE_SUBSCRIPTION_ID }}
      resource-group: my-rg
      workspace-name: my-workspace
      scenario-name: my-scenario
      scenario-configuration-name: my-config
      mode: validate-and-execute
```

**Learn more:** [CI/CD integrations guide](docs/ci-cd-integrations.md) — modes,
per-platform examples ([GitHub](examples/github/) · [Azure Pipelines](examples/azure-pipelines/)),
the deployment-gate and no-wait patterns, the least-privilege
[runner role](security/chaos-studio-runner.role-template.json), two-identity and
concurrency guidance.

## New to Chaos Studio?

Start with the docs: [Workspaces](https://learn.microsoft.com/azure/chaos-studio/chaos-studio-workspaces-overview)
· [Scenarios](https://learn.microsoft.com/azure/chaos-studio/chaos-studio-scenarios)
· [Scenario reports](https://learn.microsoft.com/azure/chaos-studio/chaos-studio-scenario-reports).

## Feedback (public preview)

We want it. [Open an issue](https://github.com/microsoft/chaos-studio/issues/new/choose)
for bugs and feature requests, or start a [Discussion](https://github.com/microsoft/chaos-studio/discussions)
for questions and ideas.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). This project follows the
[Microsoft Open Source Code of Conduct](https://opensource.microsoft.com/codeofconduct/)
and the [Microsoft CLA](https://cla.opensource.microsoft.com).

## License

[MIT](LICENSE)
