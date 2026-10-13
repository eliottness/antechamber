## What

Short description of the change.

## Why

What problem this solves, or what it enables.

## How to verify

Commands you ran and their results (not just "should work"):

```
npm run typecheck
npm test
npm run build
```

If this touches the OpenCode API surface or agent RPC handling, note whether
you ran a smoke script (`npm run smoke` / `npm run omo-smoke`) and against
which backend.

## Checklist

- [ ] `npm run typecheck` passes
- [ ] `npm test` passes
- [ ] `npm run build` succeeds
- [ ] New/changed behavior has a test; no fixed sleeps were added
- [ ] Commit messages follow Conventional Commits
- [ ] `docs/api-surface.md` updated if routes/events changed
- [ ] `docs/configuration.md` updated if an environment variable was added, renamed, or had its default changed
- [ ] No personal paths, hostnames, or credentials in the diff
