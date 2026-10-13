---
name: Bug report
about: Something in antechamber doesn't work as expected
title: ""
labels: bug
assignees: ""
---

## What happened

A clear description of the bug.

## Expected behavior

What you expected to happen instead.

## Steps to reproduce

1.
2.
3.

## Environment

- antechamber version / commit:
- Backend: pi / OmO (which, and version)
- OpenChamber version:
- Node.js version:
- OS:

## Logs

If relevant, run with `ANTECHAMBER_DEBUG=1` and attach the output of
`ANTECHAMBER_DEBUG_LOG` (redact any paths, hostnames, or tokens specific to
your machine first).

## Smoke test output

If this looks like an OpenChamber/OpenCode API compatibility break, the
fastest way to pin it down is `npm run smoke` (or `npm run omo-smoke` for
OmO). Paste the failing check's output here if you ran it.
