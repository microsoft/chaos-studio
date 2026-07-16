# chaos-mcp

MCP server exposing Azure Chaos Studio v2 operations as agent-callable tools.

The server relies on the user's local `az` CLI session for authentication
rather than managing tokens itself, keeping the server stateless. It can also
be pointed at an Azure Managed Identity for unattended runs — see
[Authentication](#authentication). See the
[copilot-cli-plugin README](../README.md) for the full tool table and how
this package fits into the Chaos Studio Copilot CLI plugin.

## Authentication

By default every tool borrows the operator's local `az login` session — the
**user principal** — via `az account get-access-token`.

### Choose the mode during a session (no config change)

The customer can switch between the user principal and a **Managed Identity**
mid-conversation by asking the agent to call the `chaos_set_auth_mode` tool —
no config edit or server restart needed. The choice applies to every subsequent
tool call for the life of the session.

| Tool | Purpose |
|---|---|
| `chaos_set_auth_mode(mode, msi_client_id?)` | `mode` = `cli` (user principal) or `managed-identity` (aliases `msi`/`mi`); `msi_client_id` optionally pins a user-assigned identity. |
| `chaos_get_auth_mode()` | Report the effective `{mode, msiClientId, source}`. |

### Startup default (optional env vars)

For unattended hosts (CI, containers, AKS, VMs) you can also set the initial
mode via env vars so no interactive `az login` is required. A runtime
`chaos_set_auth_mode` call always takes precedence over these.

| Env var | Values | Effect |
|---|---|---|
| `CHAOS_MCP_AUTH_MODE` | `cli` (default), `managed-identity` (aliases: `msi`, `mi`) | Selects the token source. |
| `CHAOS_MCP_MSI_CLIENT_ID` | client id (optional) | Pins a **user-assigned** identity; omit to use the **system-assigned** identity. |

In `managed-identity` mode the server acquires tokens from the Azure identity
endpoint — the App Service / Container Apps / Functions endpoint
(`IDENTITY_ENDPOINT` + `IDENTITY_HEADER`) when present, otherwise IMDS
(`169.254.169.254`) for VMs / VMSS / AKS. Grant the identity the same ARM roles
you would grant the user (managing `Microsoft.Chaos` workspaces and querying
Azure Monitor).

## Install

```bash
pip install chaos-mcp        # from PyPI (once published)
pip install -e .             # from source
```

## Client configuration

Register the server in your MCP client config (see
[`mcp-config.example.json`](mcp-config.example.json)):

```json
{ "mcpServers": { "chaos-studio": { "command": "chaos-mcp" } } }
```

- **Claude Desktop**: add the block above to `claude_desktop_config.json`.
- **Claude Code**: `claude mcp add chaos-studio -- chaos-mcp`
- **Cursor**: add the block above to `.cursor/mcp.json`.

The server requires an active `az login` session (or a managed identity — see
[Authentication](#authentication)); tools return a structured
`{"ok": false, "errorType": ...}` envelope (rather than raising) when auth or
permissions are missing, so agents can remediate and retry.

## Development

```bash
pip install -e .
pip install pytest pytest-cov httpx ruff
python -m pytest
ruff check chaos_mcp tests
```
