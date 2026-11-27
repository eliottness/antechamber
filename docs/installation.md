# Installation

The [README](../README.md#quick-start) covers the recommended install: the OpenChamber extension, which installs and
updates antechamber and OmO for you. This page covers everything else: the npm package, a source checkout, running the
server on its own, upgrades and rollback, and the CLI reference. Every `setup` flag and settings-file rule is specified
in [configuration.md](configuration.md#openchamber-setup).

All paths need [Bun](https://bun.sh) 1.4+ on the machine OpenChamber runs on.

## From npm

```bash
npm i -g antechamber        # or: bun add -g antechamber
antechamber doctor          # checks Bun, the backend, directories and OpenChamber
antechamber setup --auto-update
```

Restart OpenChamber afterwards. The npm package brings its pinned OmO along.

`setup` points OpenChamber's `opencodeBinary` at antechamber, keeps every other setting, and backs up an existing
settings file before changing it. Preview the change with `antechamber setup --dry-run`.

`--auto-update` keeps antechamber current with no action from you. It writes a small launcher,
`~/.config/antechamber/opencode-antechamber`, and points OpenChamber at it. Each time OpenChamber starts antechamber,
the launcher checks npm for a newer release once the server is up and installs it with the package manager that owns
the global install; the new version runs from the next start. Startup never waits on the network, and an offline start
skips the check. It needs a global npm or bun install, so it is refused for source checkouts and `npx`. Plain
`antechamber setup` points OpenChamber back at the `antechamber` bin and stops auto-updates.

`setup` ends by printing the bundled extension's folder (under `$(npm root -g)/antechamber/extensions/antechamber`).
Add it with **Settings → Extensions → Add → Folder** for the OmO Graph, OmO Work and tool headers; OpenChamber keeps
using the npm-installed `antechamber` as its OpenCode CLI.

### An isolated OpenChamber profile

To try antechamber without touching your main OpenChamber settings:

```bash
antechamber setup --profile ~/.config/antechamber-openchamber
# setup prints the command for this profile:
OPENCHAMBER_DATA_DIR=~/.config/antechamber-openchamber openchamber serve --port 57124
```

### A systemd-managed OpenChamber

`--systemd` also writes a user-service drop-in that captures the shell's PATH and the absolute OmO executable:

```bash
antechamber setup --systemd
# default unit: openchamber.service; another unit: --systemd my-openchamber.service
systemctl --user daemon-reload && systemctl --user restart openchamber.service
# or let setup run those two commands:
antechamber setup --systemd --restart
```

`--pi-binary /absolute/path/to/omo` overrides backend discovery for the drop-in. Other drop-ins that set
`ANTECHAMBER_*` or `OCPI_*` produce a warning, because later files can override the generated configuration. `setup`
never runs systemctl unless `--restart` is passed. A fuller service example is in
[backends/omo.md](backends/omo.md#example-running-omo-backed-antechamber-as-a-systemd-user-service).

## From source

```bash
git clone https://github.com/eliottness/antechamber.git
cd antechamber
npm ci
npm run build
bun dist/cli.js doctor
bun dist/cli.js setup --binary "$PWD/bin/opencode-antechamber"
# isolated alternative:
bun dist/cli.js setup --profile ~/.config/antechamber-openchamber \
  --binary "$PWD/bin/opencode-antechamber"
```

Building needs Node.js 22+ for the development tooling; the built CLI runs on Bun. The source launcher requires the
built `dist/cli.js` and finds Bun on PATH, in `$BUN_INSTALL/bin` or in `~/.bun/bin`. To update, pull, run
`npm ci && npm run build`, and restart OpenChamber.

`npm run build` also builds the extension; `setup` prints its folder (`$PWD/extensions/antechamber`) to add in
**Settings → Extensions → Add → Folder**. To run a checkout through the extension's launcher instead, `npm pack` it and
set `ANTECHAMBER_RUNTIME_SPEC` to the tarball in OpenChamber's environment.

## Running the server yourself

OpenChamber spawns whatever `settings.opencodeBinary` points at as `serve --hostname H --port P`, waits for the stdout
line `opencode server listening on <url>`, then health-checks `/global/health`. The installed `antechamber` bin
implements this contract itself, including the `--version` compatibility probe. `bin/opencode-antechamber` is only
needed for source checkouts; `bin/opencode-pi` remains a deprecated compatibility shim.

To run antechamber outside OpenChamber's managed lifecycle and point OpenChamber at it as an external server:

```bash
antechamber --port 4096 --host 127.0.0.1 --directory /path/to/project
# or, OpenCode-compatible:
antechamber serve --hostname 127.0.0.1 --port 4096
```

Binding a non-loopback host needs a password; see [configuration.md](configuration.md#security).

## Commands

| Command | Purpose / options |
|---|---|
| `antechamber serve` | OpenCode-compatible server; `--hostname`/`--host`, `--port`, `--directory`. Bare `antechamber` also starts the server. |
| `antechamber setup` | Configure OpenChamber; `--settings <file>`, `--profile <dir>`, `--binary <path>`, `--dry-run`, `--systemd [unit]`, `--pi-binary <path>`, `--restart`, `--auto-update`. |
| `antechamber doctor` | Read-only Bun, backend, agent/state directories, teardown, OpenChamber and auth checks, plus the installed, latest released and running adapter versions (a running server older than the install needs an OpenChamber restart); `--json`, `--settings <file>`, `--profile <dir>`. Exits 1 on any FAIL; warnings do not fail. |
| `antechamber upgrade` | Install the latest release over a global npm or bun install, with the package manager that owns it. Refused for source checkouts, `npx`, and when the extension's launcher manages antechamber. |
| `antechamber version` | Package version plus OpenCode API contract version. `--version`/`-v` deliberately print exactly `opencode v2.999.0` for OpenChamber. |
| `antechamber help` | Usage and options; also `--help`/`-h`. |

## Upgrade, uninstall and rollback

**Extension install:** update the extension in **Settings → Extensions**; that updates antechamber and OmO.

**npm install with `--auto-update`:** nothing to do; each start installs the latest release for the next one.

**npm install without it:**

```bash
antechamber upgrade
# equivalent: npm update -g antechamber (or: bun add -g antechamber)
```

Then restart OpenChamber (or `systemctl --user restart openchamber.service` for a managed service) and run
`antechamber doctor` again. If the executable moved, rerun `antechamber setup`.

OpenChamber can show an "OpenCode update" notice. Its **Update** button runs `<opencodeBinary> upgrade`: for an npm
install that upgrades antechamber itself (a no-op when it is already current); for the extension's launcher it only says
to update the extension in Settings → Extensions. Click **Reload OpenCode** afterwards to restart onto the new version.

To roll back the wiring, copy the backup printed by setup over the settings file:

```bash
cp /path/settings.json.bak-antechamber-YYYYMMDDHHMMSS /path/settings.json
```

If you used `--systemd`, restore the printed `antechamber.conf` backup, or remove only that generated drop-in if there
was no previous file. Then run `systemctl --user daemon-reload` and restart OpenChamber or the service. Restore the old
`opencodeBinary` before uninstalling:

```bash
npm uninstall -g antechamber
# or: bun remove -g antechamber
```

## Platform support

Linux is the primary platform. OmO's private task-host teardown (killing detached supervisor processes antechamber
spawned) uses Linux pidfds (`os.pidfd_open`, Linux 5.3+) and `python3` on PATH, because Node has no pidfd API; on Linux
it never signals a numeric PID. macOS has no pidfd, so there it reads `/bin/ps` and `/usr/sbin/lsof` and signals each
owned process by PID after re-checking its process group and start time (see
[the OmO backend notes](backends/omo.md#private-task-host-teardown)). CI runs the suite on macOS. On other platforms
that teardown step is skipped with one warning instead of crashing.
