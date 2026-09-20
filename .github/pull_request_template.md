## What and why

<!-- One or two sentences. Link the issue or gate proposal if there is one. -->

## Evidence

Paste real output, not a statement that it passed. CONTRIBUTING.md, "Local
development", lists every check CI blocks on.

```
$ GITHUB_BASE_REF=main CI=true node --test "tests/**/*.test.mjs"
<paste the summary lines>
```

## Checklist

- [ ] I ran the full "Local development" list in CONTRIBUTING.md, not a subset.
- [ ] A new or changed gate lands with its can-fail proof, registered in
      `tests/canary/injections.json` (ground rule 6).
- [ ] Nothing project-specific entered `template/` (ground rule 2), and `installer/`
      still has zero runtime dependencies (ground rule 3).
- [ ] Any number I changed in README, CHANGELOG or the shipped docs is one
      `node scripts/check-claims.mjs` can recompute.
- [ ] If this changes what a consumer receives on `update`, `template/migrations.json`
      records it.
- [ ] No credentials, tokens or private data in the diff or in pasted output.
