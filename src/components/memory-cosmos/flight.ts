import { Euler, Vector3, type PerspectiveCamera } from "three";

/** Keyboard ownership is the canvas focus, never the surrounding application. */
export class FlightControls {
  enabled = false;
  private keys = new Set<string>();
  private dragging: number | null = null;
  private pitch = new Euler(0, 0, 0, "YXZ");
  private direction = new Vector3();
  private movement = new Vector3();
  private abort = new AbortController();
  private disposed = false;
  private ownsCapture = false;
  private captureRequest: { resolve: () => void; reject: (error: Error) => void } | null = null;
  constructor(private canvas: HTMLCanvasElement, private camera: PerspectiveCamera, private exit: () => void) {
    const signal = this.abort.signal;
    window.addEventListener("keydown", e => {
      if (!this.enabled || document.activeElement !== canvas || e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === "Escape") { e.preventDefault(); this.stop(); this.exit(); return; }
      if (["KeyW", "KeyA", "KeyS", "KeyD", "KeyQ", "KeyE", "ShiftLeft", "ShiftRight"].includes(e.code)) { e.preventDefault(); this.keys.add(e.code); }
    }, { signal });
    window.addEventListener("keyup", e => this.keys.delete(e.code), { signal });
    window.addEventListener("blur", () => this.stop(), { signal });
    canvas.addEventListener("blur", () => this.stop(), { signal });
    document.addEventListener("visibilitychange", () => { if (document.hidden) this.stop(); }, { signal });
    document.addEventListener("pointerlockchange", () => {
      if (document.pointerLockElement === canvas) {
        if (!this.enabled || this.disposed || document.activeElement !== canvas) { this.stop(); return; }
        if (!this.captureRequest) {
          if (!this.ownsCapture) document.exitPointerLock();
          return;
        }
        this.ownsCapture = true;
        const request = this.captureRequest; this.captureRequest = null; request.resolve();
      } else if (this.ownsCapture) {
        // Browsers consume Escape to release pointer lock before DOM keydown.
        // This event is the reliable exit path for captured mouse navigation.
        this.ownsCapture = false; this.stop(); this.exit();
      }
    }, { signal });
    document.addEventListener("pointerlockerror", () => {
      const request = this.captureRequest; this.captureRequest = null;
      request?.reject(new Error("Mouse capture was denied. Drag to look instead."));
    }, { signal });
    canvas.addEventListener("pointerdown", e => {
      if (!this.enabled || e.button !== 0) return;
      canvas.focus(); this.dragging = e.pointerId; canvas.setPointerCapture(e.pointerId);
    }, { signal });
    const up = () => { this.dragging = null; };
    canvas.addEventListener("pointerup", up, { signal });
    canvas.addEventListener("pointercancel", up, { signal });
    canvas.addEventListener("lostpointercapture", up, { signal });
    canvas.addEventListener("pointermove", e => {
      if (!this.enabled || (this.dragging !== e.pointerId && document.pointerLockElement !== canvas)) return;
      this.pitch.setFromQuaternion(camera.quaternion, "YXZ");
      this.pitch.y -= e.movementX * 0.003;
      this.pitch.x = Math.max(-Math.PI / 2 + 0.02, Math.min(Math.PI / 2 - 0.02, this.pitch.x - e.movementY * 0.003));
      camera.quaternion.setFromEuler(this.pitch);
    }, { signal });
  }
  step(dt: number) {
    if (!this.enabled || document.activeElement !== this.canvas || !this.keys.size) return;
    const has = (key: string) => this.keys.has(key) ? 1 : 0;
    this.camera.getWorldDirection(this.direction);
    const right = new Vector3().crossVectors(this.direction, this.camera.up).normalize();
    this.movement.copy(this.direction).multiplyScalar(has("KeyW") - has("KeyS"))
      .addScaledVector(right, has("KeyD") - has("KeyA"));
    this.movement.y += has("KeyE") - has("KeyQ");
    const speed = has("ShiftLeft") || has("ShiftRight") ? 480 : 120;
    if (this.movement.lengthSq()) this.camera.position.addScaledVector(this.movement.normalize(), Math.min(dt, 0.05) * speed);
  }
  async capture() {
    if (!this.enabled || this.disposed || !this.canvas.isConnected) throw new Error("Choose Fly before capturing the mouse.");
    if (!this.canvas.requestPointerLock) throw new Error("Mouse capture is unavailable. Drag to look instead.");
    if (this.ownsCapture && document.pointerLockElement === this.canvas) return;
    this.stop();
    this.canvas.focus();
    await new Promise<void>((resolve, reject) => {
      const request = { resolve, reject }; this.captureRequest = request;
      const fail = (error: unknown) => {
        if (this.captureRequest !== request) return;
        this.captureRequest = null;
        reject(new Error(`Mouse capture was denied. Drag to look instead. ${String(error)}`));
      };
      try {
        const result = this.canvas.requestPointerLock();
        // Safari also exposes the older, event-only API which returns void.
        if (result && typeof result.then === "function") void result.then(() => {
          if (this.captureRequest !== request) {
            if (!this.ownsCapture && document.pointerLockElement === this.canvas) document.exitPointerLock();
            return;
          }
          if (!this.enabled || this.disposed || document.activeElement !== this.canvas) { this.stop(); return; }
          if (document.pointerLockElement !== this.canvas) { fail("The browser did not capture the pointer."); return; }
          this.ownsCapture = true; this.captureRequest = null; resolve();
        }, fail);
      } catch (error) { fail(error); }
    });
  }
  stop() {
    this.keys.clear();
    if (this.dragging !== null && this.canvas.hasPointerCapture?.(this.dragging)) this.canvas.releasePointerCapture(this.dragging);
    this.dragging = null;
    this.ownsCapture = false;
    const pending = this.captureRequest; this.captureRequest = null; pending?.resolve();
    if (document.pointerLockElement === this.canvas) document.exitPointerLock();
  }
  dispose() { if (this.disposed) return; this.disposed = true; this.enabled = false; this.stop(); this.abort.abort(); }
}
