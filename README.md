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
| **Copilot CLI plugin + MCP server** | [`copilot-cli-plugin/`](copilot-cli-plugin/) | Create workspaces, configure scenarios, run experiments, and analyze impact — from a conversation or an autonomous agent. |
| **Scenarios** | [`scenarios/`](scenarios/) | Shareable custom Scenario definitions (Bicep/JSON) beyond the built-in templates. |
| **Samples** | [`samples/`](samples/) | Sample apps and infrastructure you can deploy and break to practice. |

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
