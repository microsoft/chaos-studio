<!-- Thanks for the PR! Quick checklist to keep CI green: -->

## Summary

<!-- One paragraph: what changed and why. -->

## Type of change

- [ ] Bug fix
- [ ] New feature
- [ ] Refactor / cleanup
- [ ] Docs only
- [ ] CI / tooling

## Checklist

- [ ] Tests added or updated (and passing locally — `Invoke-Pester ./skills` and `pytest mcp/tests`)
- [ ] No real subscription/tenant IDs, machine names, or usernames in new fixtures
- [ ] `plugin.json` `version` bumped if user-visible
- [ ] `mcp/pyproject.toml` `version` bumped if the Python package changed
- [ ] `CHANGELOG.md` entry added under **Unreleased**
- [ ] Conventional commit subject (e.g., `feat(chaos-impact): …`)

## Related issues

<!-- Closes #123, refs #456 -->
