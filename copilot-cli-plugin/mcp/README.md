# chaos-mcp

MCP server exposing Azure Chaos Studio v2 operations as agent-callable tools.

The server relies on the user's local `az` CLI session for authentication
rather than managing tokens itself, keeping the server stateless. See the
[copilot-cli-plugin README](../README.md) for the full tool table and how
this package fits into the Chaos Studio Copilot CLI plugin.

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

The server requires an active `az login` session; tools return a structured
`{"ok": false, "errorType": ...}` envelope (rather than raising) when auth or
permissions are missing, so agents can remediate and retry.

## Development

```bash
pip install -e .
pip install pytest pytest-cov httpx ruff
python -m pytest
ruff check chaos_mcp tests
```
