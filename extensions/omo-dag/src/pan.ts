export type PanPointer = { pointerId: number; clientX: number; clientY: number };
export type PanMove = { x: number; y: number; started: boolean };

const THRESHOLD = 4;

// Primary-button pan gesture. A missed pointerup (button released outside the sandboxed iframe, lost capture,
// pointercancel, window blur) must not leave the gesture armed, so a move without the primary button ends it.
export class PanGesture {
  private drag: { id: number; x: number; y: number; vx: number; vy: number; moved: boolean } | undefined;

  get active() {
    return this.drag !== undefined;
  }

  down(event: PanPointer & { button: number }, view: { x: number; y: number }) {
    if (event.button !== 0) return;
    this.drag = { id: event.pointerId, x: event.clientX, y: event.clientY, vx: view.x, vy: view.y, moved: false };
  }

  move(event: PanPointer & { buttons: number }): PanMove | "end" | undefined {
    const drag = this.drag;
    if (!drag || event.pointerId !== drag.id) return undefined;
    if ((event.buttons & 1) === 0) return "end";
    const dx = event.clientX - drag.x;
    const dy = event.clientY - drag.y;
    if (!drag.moved && Math.hypot(dx, dy) < THRESHOLD) return undefined;
    const started = !drag.moved;
    drag.moved = true;
    return { x: drag.vx + dx, y: drag.vy + dy, started };
  }

  end(pointerId?: number): boolean {
    const drag = this.drag;
    if (!drag || (pointerId !== undefined && pointerId !== drag.id)) return false;
    this.drag = undefined;
    return drag.moved;
  }
}
