import assert from "node:assert/strict";
import test from "node:test";
import { routeInventory } from "../contrib/omo/smoke/checks/90-routes.js";

test("R-010: route smoke loads a checked-in endpoint inventory", () => {
  const routes = routeInventory();
  assert.ok(routes.length > 0);
  assert.ok(routes.some((route) => route.method === "GET" && route.path === "/global/health"));
});
