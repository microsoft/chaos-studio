# chaos-mcp

MCP server exposing Azure Chaos Studio v2 operations as agent-callable tools.

The server relies on the user's local `az` CLI session for authentication
rather than managing tokens itself, keeping the server stateless. See the
[copilot-cli-plugin README](../README.md) for how this package fits into the
Chaos Studio Copilot CLI plugin.

## Development

```bash
pip install -e .
pip install pytest pytest-cov httpx
python -m pytest
```
