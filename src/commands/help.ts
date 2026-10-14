export const help = `Usage: antechamber [command] [options]

Commands:
  serve       Run the OpenCode-compatible HTTP/SSE server (also the default)
  setup       Point OpenChamber at this installation; back up changed files
  doctor      Read-only installation and backend checks (exit 1 on FAIL)
  version     Print the npm package and OpenCode API versions
  help        Show this help (--help, -h)

Serve:   --port 4096 --host 127.0.0.1 (or --hostname) --directory <path>
         --insecure-no-auth
Setup:   --settings <file> | --profile <dir>
         --binary <path> --dry-run --systemd [unit] --pi-binary <path> --restart
Doctor:  --settings <file> | --profile <dir> --json
Probe:   --version, -v prints the OpenCode compatibility version for OpenChamber`;
