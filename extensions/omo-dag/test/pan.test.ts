import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { PanGesture } from "../src/pan.ts";

const at = (clientX: number, clientY: number, buttons = 1, pointerId = 1) => ({ pointerId, clientX, clientY, buttons });

function grab(x = 100, y = 100) {
  const pan = new PanGesture();
  pan.down({ pointerId: 1, clientX: x, clientY: y, button: 0 }, { x: 10, y: 20 });
  return pan;
}

describe("PanGesture", () => {
  test("pans past the threshold relative to the starting view", () => {
    const pan = grab();
    assert.equal(pan.move(at(102, 101)), undefined);
    assert.deepEqual(pan.move(at(130, 90)), { x: 40, y: 10, started: true });
    assert.deepEqual(pan.move(at(140, 90)), { x: 50, y: 10, started: false });
    assert.equal(pan.end(1), true);
    assert.equal(pan.active, false);
  });

  test("a move with the primary button released ends a gesture whose pointerup was missed", () => {
    const pan = grab();
    pan.move(at(130, 90));
    assert.equal(pan.move(at(160, 90, 0)), "end");
    assert.equal(pan.end(1), true);
    assert.equal(pan.move(at(200, 200, 0)), undefined);
    assert.equal(pan.move(at(200, 200, 1)), undefined);
  });

  test("ignores non-primary buttons and other pointers", () => {
    const pan = new PanGesture();
    pan.down({ pointerId: 1, clientX: 0, clientY: 0, button: 2 }, { x: 0, y: 0 });
    assert.equal(pan.active, false);
    const grabbed = grab();
    assert.equal(grabbed.move(at(200, 200, 1, 2)), undefined);
    assert.equal(grabbed.end(2), false);
    assert.equal(grabbed.active, true);
  });

  test("ending without panning reports no movement so clicks still open sessions", () => {
    const pan = grab();
    assert.equal(pan.end(), false);
    assert.equal(pan.active, false);
  });
});
