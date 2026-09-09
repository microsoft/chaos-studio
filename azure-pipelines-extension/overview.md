# Azure Chaos Studio Workspaces

Validate and run **Azure Chaos Studio v2** scenario configurations directly from
your Azure Pipelines, using **workload identity** (no long-lived secrets).

## What it does

This task drives the Chaos Studio v2 scenario journey from a pipeline:

1. **Sign in** with the pipeline's workload-identity federation.
2. **Validate** a scenario configuration and wait for the validation to reach a
   terminal state.
3. **Execute** the configuration, parse the run identifier from the service
   response, and **poll the run** until it reaches a terminal state.
4. **Pass or fail the pipeline** based on the service result.

## Requirements

- An Azure Chaos Studio **workspace** and a **scenario configuration**.
- A pipeline **service connection** configured for workload-identity federation
  with permission to validate and execute the configuration.

## Support

- **Source & issues:** <https://github.com/microsoft/chaos-studio>
- **API version:** `2026-05-01-preview`

> This extension is in **Preview**. Behavior and inputs may change before general
> availability.
