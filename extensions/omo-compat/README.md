# OmO Compatibility

An OpenChamber extension that ships with antechamber. It changes how OpenChamber
displays some OmO tool calls, using only the display rules OpenChamber lets an
extension declare. It has no panel, page, service or permissions.

What it does today:

- **Eval cell headers.** OpenChamber 1.24 streams live output only for shell
  cards, so antechamber shows OmO eval cells as shell cards. With this extension
  their header reads `JS Eval` (or `Python Eval`) and the cell's summary instead
  of "Shell Command" and the first line of code. Other shell cards keep their
  normal header.

## Requirements

- OpenChamber **1.24 or newer** (the first release with `contributes.tools`).
- antechamber as OpenChamber's backend. Without it the rules match nothing and
  change nothing.

## Install

In OpenChamber, open **Settings → Extensions → Add**:

- **Folder**, when OpenChamber runs on the machine where antechamber is
  installed. `antechamber setup` prints the path:
  `$(npm root -g)/antechamber/extensions/omo-compat` for an npm install, or
  `<checkout>/extensions/omo-compat` from a source checkout. It needs no build.
- **URL**, from anywhere:
  `https://github.com/eliottness/antechamber/releases/latest/download/antechamber-omo-compat.zip`.
  Every GitHub release attaches this archive.

There is nothing to approve and no rail icon. Reload open chats after
installing so their cards pick up the new header.

For a server you reach over HTTP:

```bash
curl -sX POST "$OC/api/guests" -H 'content-type: application/json' \
  -d '{"path":"/abs/path/to/extensions/omo-compat"}'
```
