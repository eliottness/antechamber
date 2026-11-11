import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type { Check } from "../core.js";
import type { SmokeContext } from "../context.js";

interface RouteRow {
  method: string;
  path: string;
  unavailable: boolean;
  staticOnly: boolean;
}

/**
 * docs/api-surface.md is the checked-in API contract. Its route tables are
 * intentionally human-readable, so derive the directly runnable static routes
 * here rather than depending on a second, stale endpoint-inventory document.
 */
export function routeInventory(): RouteRow[] {
  const contract = readFileSync(new URL("../../../../docs/api-surface.md", import.meta.url), "utf8");
  const rows = contract.split("\n").flatMap((line): RouteRow[] => {
    const row = line.match(/\|\s*`(GET|POST|PUT|PATCH|DELETE) ([^`]+)`\s*\|/);
    if (!row?.[1] || !row[2] || row[2].includes("{")) return [];
    return [
      {
        method: row[1],
        path: row[2],
        unavailable: line.includes("unsupported"),
        staticOnly: line.includes("static-only"),
      },
    ];
  });
  assert.ok(rows.length > 0, "docs/api-surface.md must supply runnable routes");
  return rows;
}

export function register(check: Check, context: SmokeContext): void {
  check(
    "routes",
    async (signal) => {
      const rows = routeInventory();
      const covered = new Set<string>();
      const staticStatuses: Array<{ method: string; path: string; status: number }> = [];
      const request = async (
        method: string,
        path: string,
        body?: unknown,
        unavailable = false,
        staticOnly = false,
      ): Promise<string> => {
        const response = await fetch(`${context.url}${path}`, {
          method,
          signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]),
          ...(body === undefined
            ? {}
            : { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }),
        });
        const text = await response.text();
        console.log(`route: ${method} ${path} -> ${response.status}`);
        if (staticOnly) {
          assert.notEqual(response.status, 500, `${method} ${path}: ${text}`);
          staticStatuses.push({ method, path, status: response.status });
        } else if (method === "POST" && path === "/api/experimental/generate") {
          assert.equal(response.status, 503, `${method} ${path}: ${text}`);
          const body = JSON.parse(text);
          assert.equal(body._tag, "ServiceUnavailableError");
          assert.equal(body.service, "opencode");
        } else {
          assert.notEqual(response.status, 404, `${method} ${path}: ${text}`);
          assert.notEqual(response.status, 501, `${method} ${path}: ${text}`);
          assert.ok([200, 204, 400].includes(response.status), `${method} ${path}: HTTP ${response.status}: ${text}`);
        }
        if (unavailable && method !== "GET") {
          assert.equal(response.status, 400, `${method} ${path} must reject unsupported mutations`);
        }
        return text;
      };
      assert.equal(
        new Set(rows.map((row) => `${row.method} ${row.path}`)).size,
        rows.length,
        "inventory routes must be unique",
      );
      for (const row of rows) {
        const body = row.method === "GET" || row.method === "DELETE" ? undefined : {};
        await request(row.method, row.path, body, row.unavailable, row.staticOnly);
        covered.add(`${row.method} ${row.path}`);
      }
      console.log(`routes: ${covered.size}/${rows.length} static inventory pairs`);
      console.log(`routes static-only statuses: ${JSON.stringify(staticStatuses)}`);
    },
    { timeoutMs: 300_000 },
  );
}
