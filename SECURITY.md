# Security Policy

## Threat model

antechamber is a local development tool. It runs a coding agent (pi or OmO)
that can execute arbitrary shell commands and edit files on the machine it
runs on, on behalf of whatever OpenChamber instance is talking to it. Treat
it like a local dev server with shell access, not a hardened network
service.

**Never expose antechamber to an untrusted network without authentication.**
By default it binds to loopback (`127.0.0.1`) with no auth, which is safe for
local use. antechamber refuses to bind a non-loopback address unless a password
is set (`OPENCODE_SERVER_PASSWORD`, which enables HTTP Basic auth on every
route) or you opt out explicitly with `ANTECHAMBER_ALLOW_INSECURE=1` or
`--insecure-no-auth`. See [docs/configuration.md](docs/configuration.md) and
the README's Security section for the details, including browser origin rules.

If you run antechamber behind a reverse proxy, on a shared machine, or on a
network reachable by other users, you are responsible for authentication,
TLS termination, and network-level access control in front of it.

## Supported versions

Only the latest published release and the `main` branch receive security
fixes. There is no long-term support branch.

| Version | Supported |
|---|---|
| latest 1.x release | yes |
| older 1.x releases | no |
| 0.x | no |

## Reporting a vulnerability

Please report security issues privately through
[GitHub's private vulnerability reporting](https://github.com/eliottness/antechamber/security/advisories/new)
for this repository, rather than opening a public issue.

Include:

- A description of the issue and its impact
- Steps to reproduce (a minimal repro is ideal, since this is a local tool)
- The antechamber version and backend (pi or OmO) involved

We'll acknowledge reports as soon as we can and work with you on a fix and
disclosure timeline before any public write-up.

## Out of scope

- Vulnerabilities in pi, OmO, or OpenChamber themselves. Report those
  upstream.
- The fact that antechamber's agent backend can run shell commands. That's
  the product; the mitigation is network isolation and authentication, not
  sandboxing the agent itself.
