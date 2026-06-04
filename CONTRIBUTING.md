# Contributing to startchaos

Thanks for your interest in improving the **startchaos** Copilot CLI plugin!
This doc covers the local dev loop, coding conventions, and the PR process.

## Quick start

```bash
git clone https://github.com/<org>/chaos-studio-copilot-plugin.git
cd chaos-studio-copilot-plugin

# PowerShell skill scripts — install Pester for tests
pwsh -Command "Install-Module Pester -MinimumVersion 5.5.0 -Scope CurrentUser -Force"

# Python MCP server — editable install + pytest
pip install -e ./mcp
pip install pytest httpx
```

## Repository layout

```
.
├── plugin.json                     # Copilot CLI plugin manifest
├── agents/                         # Top-level agent definitions
├── scripts/                        # Shared PowerShell helpers (sourced by skills)
├── skills/
│   ├── start-chaos/                # Orchestrator skill
│   ├── create-workspace/
│   ├── setup-scenario/
│   ├── run-scenario/
│   └── chaos-impact/               # Azure Monitor impact analysis
└── mcp/
    ├── pyproject.toml
    ├── chaos_mcp/                  # Python MCP server
    └── tests/                      # pytest unit tests
```

## Running tests

```bash
# PowerShell (Pester)
pwsh -Command "Invoke-Pester ./skills/chaos-impact/tests -CI -Output Detailed"

# Python (pytest)
cd mcp && python -m pytest -q
```

The full suite (89 Pester + 13 pytest at last count) runs in well under a
minute on a typical laptop.

## Coding conventions

### PowerShell

- PowerShell 7+ only — no Windows PowerShell 5.1 backports.
- One function per file when it's a reusable helper; multi-function files are
  fine for cohesive skill scripts.
- Use `Set-StrictMode -Version 3.0` at the top of every script.
- Prefer `param()` blocks with `[Parameter(Mandatory)]` and types over
  positional args.
- Output objects (`[pscustomobject]@{...}`) — let the caller decide how to
  render. Avoid `Write-Host` in library code; reserve it for the
  user-facing orchestrator.
- All ARM calls go through `scripts/Invoke-AzRest.ps1` so retry,
  paging, and LRO semantics stay consistent.

### Python

- Python 3.10+.
- Type hints on all public functions; the codebase passes basic `mypy`.
- Stick to `httpx.AsyncClient` for HTTP; avoid `requests`.
- All Azure access tokens come from `az account get-access-token` — never
  embed a service principal or managed identity in the server.

### Tests

- **Tests are required for every PR that touches behavior.** Bug fix → add a
  regression test. New feature → write tests first.
- Pester: mirror the script path under `tests/` (e.g.,
  `skills/foo/scripts/Bar.ps1` → `skills/foo/tests/Bar.Tests.ps1`).
- Hermetic E2E tests use recorded JSON fixtures under
  `skills/chaos-impact/tests/e2e/`. To add one, capture a real Azure response,
  scrub identifiers (replace subscription/tenant IDs with
  `00000000-0000-0000-0000-000000000001`), and drop it next to
  `Run-Hermetic.ps1`.

## Commit messages

Use [Conventional Commits](https://www.conventionalcommits.org/):

```
feat(chaos-impact): add resource-group fan-out
fix(mcp): retry on 429 with Retry-After honored
docs(readme): clarify Log Analytics workspace discovery
test(chaos-impact): cover severity boundary at 1.5x threshold
```

Scope is the skill name or `mcp` for the Python package.

## Pull request checklist

- [ ] Tests added or updated (and passing locally)
- [ ] No real subscription/tenant IDs, machine names, or usernames in new
      fixtures (use `0000…0001`, `hermetic-*`)
- [ ] `plugin.json` `version` bumped if the change is user-visible
- [ ] `mcp/pyproject.toml` `version` bumped if the MCP package changed
- [ ] `CHANGELOG.md` entry added under **Unreleased**
- [ ] No new dependencies without a justification line in the PR description

## Releasing

Maintainers cut releases by tagging `vX.Y.Z`:

```bash
git tag -a v0.4.0 -m "v0.4.0"
git push origin v0.4.0
```

The `release.yml` workflow then:

1. Runs the full test matrix one more time.
2. Builds the `chaos-mcp` wheel + sdist and uploads to PyPI.
3. Publishes a GitHub Release with auto-generated notes.
4. Notifies the Copilot CLI marketplace mirror to pick up the new version.

## Microsoft CLA

This project welcomes contributions and suggestions. Most contributions
require you to agree to a Contributor License Agreement (CLA) declaring that
you have the right to, and actually do, grant us the rights to use your
contribution. For details, visit <https://cla.opensource.microsoft.com>.

When you submit a pull request, a CLA bot will automatically determine whether
you need to provide a CLA and decorate the PR appropriately (e.g., status
check, comment). Simply follow the instructions provided by the bot. You will
only need to do this once across all repos using our CLA.

This project has adopted the [Microsoft Open Source Code of Conduct](https://opensource.microsoft.com/codeofconduct/).
For more information see the [Code of Conduct FAQ](https://opensource.microsoft.com/codeofconduct/faq/) or
contact [opencode@microsoft.com](mailto:opencode@microsoft.com) with any additional questions or comments.
