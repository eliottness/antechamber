// Runs the process table (src/proc-table.ts) under Bun on macOS against the real /bin/ps: the
// identities disposal records must be readable, cover the whole process group, and drop out once it exits.
// CI's macOS job runs this; the hermetic suite covers the same code on Node only.
import { spawn } from "node:child_process";
import { createProcessTable } from "../../src/proc-table.js";

if (process.platform !== "darwin") throw new Error("darwin-only probe");
const table = createProcessTable();

const self = table.identity(process.pid);
if (!self || self.pid !== process.pid || !Number.isInteger(self.group) || self.start === "")
  throw new Error(`identity of this process: ${JSON.stringify(self)}`);

async function until<T>(what: string, read: () => T | undefined): Promise<T> {
  const deadline = Date.now() + 10_000;
  for (;;) {
    const value = read();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

const leader = spawn("/bin/sh", ["-c", "sleep 300 & sleep 300 & wait"], { detached: true, stdio: "ignore" });
const group = leader.pid;
if (group === undefined) throw new Error("spawn failed");
const members = await until("the group's three processes", () => {
  const found = table.groupMembers(group);
  return found.length >= 3 ? found : undefined;
});
for (const member of members) {
  const again = table.identity(member.pid);
  if (again?.start !== member.start || again.group !== group)
    throw new Error(`identity changed between reads: ${JSON.stringify({ member, again })}`);
}
process.kill(-group, "SIGKILL");
await until("the group to exit", () => (table.groupMembers(group).length === 0 ? true : undefined));
console.log(`PASS bun ${process.versions.bun}: ${members.length} group members identified, none left after SIGKILL`);
