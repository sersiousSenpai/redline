import {
  BufferGeometry, Float32BufferAttribute, FogExp2, PerspectiveCamera, Points,
  PointsMaterial, Raycaster, Scene, Vector2, Vector3, WebGLRenderer,
} from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { acquireGraphics } from "../../lib/graphicsAllocation";
import { isSceneClick, seeded, type CosmosCamera, type CosmosLayout, type CosmosNode } from "../../lib/memoryMap3d";
import type { MapEdge } from "../../lib/memoryMap";
import { FlightControls } from "./flight";
import { planet } from "./planets";
import { filaments } from "./filaments";
import { halos } from "./halos";

/** With motion on, the ambient animation runs this long after the last input, then the loop sleeps until something wakes it. */
const IDLE_MS = 20_000;

interface Events {
  select(id: string | null): void;
  edge(edge: MapEdge | null): void;
  camera(camera: CosmosCamera): void;
  error(message: string): void;
  orbit(): void;
  stats(value: { median: number; p95: number; resolution: number; nodes: number; draws: number }): void;
}
export class CosmosScene {
  readonly renderer: WebGLRenderer;
  readonly scene = new Scene();
  readonly camera = new PerspectiveCamera(48, 1, .1, 12000);
  readonly orbit: OrbitControls;
  readonly flight: FlightControls;
  private release: () => void;
  private planets: ReturnType<typeof planet>[] = [];
  private web: ReturnType<typeof filaments> | null = null;
  private glow: ReturnType<typeof halos> | null = null;
  private layout: CosmosLayout | null = null;
  private labels: HTMLDivElement[] = [];
  private labelLayer = document.createElement("div");
  private dust: Points;
  private abort = new AbortController();
  private ro: ResizeObserver;
  private io: IntersectionObserver | null = null;
  private visible = true;
  private lost = false;
  private disposed = false;
  private frameId = 0;
  private time = 0;
  private lastFrame = 0;
  private frames: number[] = [];
  private slowBatches = 0;
  private selected: string | null = null;
  private hovered: string | null = null;
  private selectedEdge: MapEdge | null = null;
  private motion = true;
  private fitted: boolean;
  private w = 1;
  private h = 1;
  private transition: { from: Vector3; to: Vector3; targetFrom: Vector3; targetTo: Vector3; at: number } | null = null;
  // Idle gating. The loop used to render, re-run the label overlap pass and
  // restyle the parent on every frame forever, even with nothing moving.
  // Now: labels + camera save only when the view changed, and the loop sleeps
  // once it is still (no motion) or untouched for IDLE_MS (motion on) — any
  // input, selection or data change wakes it.
  private dirty = true;
  private viewKey = "";
  private lastInput = 0;
  private visorPx = NaN;

  constructor(private host: HTMLDivElement, private events: Events, saved?: CosmosCamera) {
    const release = acquireGraphics("cosmos");
    if (!release) throw new Error("The 3D scene is already open. Use the memory list or reopen this view.");
    this.release = release;
    const cleanup: Array<() => void> = [release];
    try {
    this.renderer = new WebGLRenderer({ antialias: true, alpha: false, powerPreference: "high-performance" });
    cleanup.push(() => { this.renderer.dispose(); this.renderer.forceContextLoss(); });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio || 1, 1.5));
    this.renderer.setClearColor("#070e15");
    const canvas = this.renderer.domElement;
    canvas.tabIndex = 0; canvas.setAttribute("aria-label", "Memory Cosmos. Drag to orbit, shift-drag to pan, wheel to zoom. Choose Fly for keyboard navigation.");
    canvas.className = "mc-canvas";
    this.labelLayer.className = "mc-labels";
    cleanup.push(() => { canvas.remove(); this.labelLayer.remove(); });
    host.append(canvas, this.labelLayer);
    this.scene.fog = new FogExp2("#070e15", .00024);
    this.orbit = new OrbitControls(this.camera, canvas);
    cleanup.push(() => this.orbit.dispose());
    this.orbit.enableDamping = true; this.orbit.dampingFactor = .08;
    this.orbit.minDistance = 12; this.orbit.maxDistance = 5500;
    this.fitted = !!saved;
    if (saved) { this.camera.position.fromArray(saved.position); this.orbit.target.fromArray(saved.target); }
    else this.camera.position.set(850, 450, 1100);
    this.orbit.update();
    this.flight = new FlightControls(canvas, this.camera, () => { this.setFly(false); events.orbit(); });
    cleanup.push(() => this.flight.dispose());
    const random = seeded("redline-cosmos-dust"), dustPositions: number[] = [];
    for (let i = 0; i < 1400; i++) dustPositions.push((random() - .5) * 5200, (random() - .5) * 5200, (random() - .5) * 5200);
    const dustGeometry = new BufferGeometry(); cleanup.push(() => dustGeometry.dispose());
    dustGeometry.setAttribute("position", new Float32BufferAttribute(dustPositions, 3));
    const dustMaterial = new PointsMaterial({ color: "#91acae", size: 1, transparent: true, opacity: .19, sizeAttenuation: true, depthWrite: false });
    cleanup.push(() => dustMaterial.dispose());
    this.dust = new Points(dustGeometry, dustMaterial);
    this.scene.add(this.dust);
    const signal = this.abort.signal;
    this.orbit.addEventListener("start", () => { this.transition = null; });
    canvas.addEventListener("contextmenu", e => e.preventDefault(), { signal });
    canvas.addEventListener("webglcontextlost", e => {
      e.preventDefault(); this.lost = true; this.flight.stop(); this.pause();
      events.error("The graphics context was lost. Use the memory list or Retry 3D to reopen the scene.");
    }, { signal });
    let down: { x: number; y: number; id: number; travel: number } | null = null;
    canvas.addEventListener("pointerdown", e => { canvas.focus(); if (e.button === 0) down = { x: e.clientX, y: e.clientY, id: e.pointerId, travel: 0 }; }, { signal });
    canvas.addEventListener("pointermove", e => {
      if (down) down.travel = Math.max(down.travel, Math.hypot(e.clientX - down.x, e.clientY - down.y));
      if (!down && !this.flight.enabled) { const hit = this.pick(e); const id = hit.node?.id ?? null; if (this.hovered !== id) { this.hovered = id; this.highlight(); } canvas.style.cursor = hit.node ? "pointer" : "grab"; }
    }, { signal });
    canvas.addEventListener("pointerleave", () => { this.hovered = null; this.highlight(); }, { signal });
    for (const type of ["pointerdown", "pointermove", "wheel", "keydown"] as const) canvas.addEventListener(type, () => this.wake(), { signal, passive: true });
    canvas.addEventListener("pointercancel", () => { down = null; }, { signal });
    canvas.addEventListener("pointerup", e => {
      if (down?.id === e.pointerId && !this.flight.enabled && isSceneClick(down, { x: e.clientX, y: e.clientY }, down.travel)) {
        const hit = this.pick(e); events.select(hit.node?.id ?? null); events.edge(hit.edge ?? null);
      }
      down = null;
    }, { signal });
    canvas.addEventListener("dblclick", e => { if (!this.flight.enabled) { const node = this.pick(e).node; if (node) { events.select(node.id); this.approach(node.id); } } }, { signal });
    canvas.addEventListener("keydown", e => {
      if (e.key === "Home") { e.preventDefault(); this.home(); }
      if (e.key === "Escape") { this.transition = null; this.flight.stop(); }
    }, { signal });
    document.addEventListener("visibilitychange", () => { if (document.hidden) { this.flight.stop(); this.pause(); } else this.resume(); }, { signal });
    this.ro = new ResizeObserver(() => this.resize()); cleanup.push(() => this.ro.disconnect()); this.ro.observe(host);
    if (typeof IntersectionObserver !== "undefined") {
      this.io = new IntersectionObserver(entries => { this.visible = entries[0]?.isIntersecting ?? false; if (this.visible) this.resume(); else { this.flight.stop(); this.pause(); } }); cleanup.push(() => this.io?.disconnect()); this.io.observe(host);
    }
    this.resize(); this.resume();
    } catch (error) {
      // A constructor that throws never reaches the React cleanup callback.
      // Release every resource already created so Retry 3D can acquire a slot.
      this.disposed = true; this.pause(); this.abort.abort();
      for (const dispose of cleanup.reverse()) { try { dispose(); } catch { /* Preserve the original initialization error. */ } }
      this.scene.clear();
      throw new Error(`The 3D scene could not start. Your memories are still in the list. ${String(error)}`);
    }
  }
  private resize() {
    this.w = this.host.clientWidth; this.h = this.host.clientHeight;
    if (this.w < 2 || this.h < 2) { this.pause(); return; }
    this.renderer.setSize(this.w, this.h); this.camera.aspect = this.w / this.h; this.camera.updateProjectionMatrix(); this.wake();
  }
  setData(layout: CosmosLayout, edges: MapEdge[]) {
    this.clearData(); this.layout = layout;
    const nodes = [...layout.nodes].sort((a, b) => b.mass - a.mass);
    this.planets = nodes.map((node, i) => planet(node, i < 24));
    for (const p of this.planets) {
      this.scene.add(p.mesh);
      const label = document.createElement("div"); label.className = "mc-label"; label.textContent = p.mesh.userData.node.label; this.labelLayer.append(label); this.labels.push(label);
    }
    this.glow = halos(layout.nodes); this.scene.add(this.glow.points);
    this.web = filaments(edges, layout.nodes); this.scene.add(this.web.line); this.highlight();
    if (!this.fitted && layout.nodes.length) { this.home(true); this.fitted = true; }
  }
  setSelection(id: string | null, edge: MapEdge | null) { this.selected = id; this.selectedEdge = edge; this.highlight(); }
  private highlight() {
    for (const p of this.planets) p.mesh.material.uniforms.selected.value = p.mesh.userData.node.id === this.selected ? 1 : p.mesh.userData.node.id === this.hovered ? .5 : 0;
    this.web?.select(this.hovered ?? this.selected, this.selectedEdge);
    this.wake();
  }
  private wake() { this.dirty = true; this.lastInput = performance.now(); this.resume(); }
  setMotion(enabled: boolean) { this.motion = enabled; this.orbit.enableDamping = enabled; if (!enabled) { this.transition = null; for (const p of this.planets) p.animate(0); } this.wake(); }
  setFly(enabled: boolean) {
    this.flight.stop(); this.flight.enabled = enabled; this.orbit.enabled = !enabled; this.transition = null;
    if (!enabled) this.orbit.target.copy(this.camera.position).addScaledVector(this.camera.getWorldDirection(new Vector3()), 150);
    this.renderer.domElement.focus(); this.wake();
  }
  async capture() { await this.flight.capture(); }
  home(immediate = false) {
    if (!this.layout) return;
    const target = new Vector3(this.layout.center.x, this.layout.center.y, this.layout.center.z);
    const vertical = this.camera.fov * Math.PI / 360, horizontal = Math.atan(Math.tan(vertical) * this.camera.aspect);
    const direction = new Vector3(.12, .08, 1).normalize();
    const right = new Vector3().crossVectors(this.camera.up, direction).normalize(), up = new Vector3().crossVectors(direction, right);
    // Fit the actual wide neural field, including soma radii, to both axes.
    const distance = Math.max(100, ...this.layout.nodes.map(n => {
      const offset = new Vector3(n.x, n.y, n.z).sub(target);
      return offset.dot(direction) + Math.max(Math.abs(offset.dot(right)) / Math.tan(horizontal) + n.r / Math.sin(horizontal), Math.abs(offset.dot(up)) / Math.tan(vertical) + n.r / Math.sin(vertical));
    })) * 1.16;
    this.orbit.maxDistance = Math.max(5500, distance * 2);
    this.camera.far = Math.max(12000, distance * 4); this.camera.updateProjectionMatrix();
    this.move(target.clone().addScaledVector(direction, distance), target, immediate);
  }
  approach(id: string) {
    const node = this.layout?.nodes.find(n => n.id === id); if (!node) return;
    const target = new Vector3(node.x, node.y, node.z);
    const direction = this.camera.position.clone().sub(target).normalize();
    const neighborIds = new Set(this.web?.spans.filter(({ edge }) => edge.kind === "contains" && (edge.from === id || edge.to === id))
      .map(({ edge }) => edge.from === id ? edge.to : edge.from));
    const extent = Math.max(node.r, ...this.layout!.nodes.filter(n => neighborIds.has(n.id))
      .map(n => target.distanceTo(new Vector3(n.x, n.y, n.z)) + n.r));
    const halfFov = Math.min(this.camera.fov * Math.PI / 360, Math.atan(Math.tan(this.camera.fov * Math.PI / 360) * this.camera.aspect));
    const distance = Math.max(node.r * 5 + 25, extent / Math.sin(halfFov) * 1.12);
    this.move(target.clone().addScaledVector(direction, distance), target);
  }
  private move(to: Vector3, target: Vector3, immediate = false) {
    if (this.flight.enabled) { this.setFly(false); this.events.orbit(); }
    if (immediate || !this.motion) { this.camera.position.copy(to); this.orbit.target.copy(target); this.orbit.update(); this.saveCamera(); }
    else this.transition = { from: this.camera.position.clone(), to, targetFrom: this.orbit.target.clone(), targetTo: target, at: performance.now() };
    this.wake();
  }
  private pick(e: PointerEvent | MouseEvent) {
    const rect = this.renderer.domElement.getBoundingClientRect();
    const ray = new Raycaster(); ray.params.Line.threshold = 2;
    ray.setFromCamera(new Vector2((e.clientX - rect.left) / rect.width * 2 - 1, -(e.clientY - rect.top) / rect.height * 2 + 1), this.camera);
    this.scene.updateMatrixWorld(true);
    const hits = ray.intersectObjects(this.planets.map(p => p.mesh), false);
    if (hits[0]) return { node: hits[0].object.userData.node as CosmosNode, edge: null };
    const edgeHit = this.web && ray.intersectObject(this.web.line, false)[0];
    const edge = edgeHit && this.web?.spans.find(s => (edgeHit.index ?? -1) >= s.start && (edgeHit.index ?? -1) < s.end)?.edge;
    return { node: null, edge: edge || null };
  }
  private drawLabels() {
    const projection = this.planets.map((p, index) => {
      const n = p.mesh.userData.node as CosmosNode, v = p.mesh.position.clone().project(this.camera), distance = this.camera.position.distanceTo(p.mesh.position);
      return { n, index, x: (v.x + 1) * this.w / 2, y: (1 - v.y) * this.h / 2, z: v.z, d: distance, radius: n.r / distance * this.h * 1.3 };
    });
    for (const label of this.labels) label.hidden = true;
    const boxes: Array<{ x: number; y: number; w: number }> = [];
    const ranked = [...projection].sort((a, b) => Number(b.n.id === this.selected || b.n.id === this.hovered) - Number(a.n.id === this.selected || a.n.id === this.hovered) || Number(b.n.depth === 0) - Number(a.n.depth === 0) || Number(b.n.pinned) - Number(a.n.pinned) || a.d - b.d);
    for (const p of ranked) {
      if (boxes.length >= 12 || p.z < -1 || p.z > 1 || p.x < 20 || p.x > this.w - 20 || p.y < 0 || p.y > this.h - 30) continue;
      if (p.n.id !== this.selected && p.n.id !== this.hovered && p.n.depth > 0 && !p.n.pinned && p.radius < 8) continue;
      if (projection.some(other => other.d < p.d - p.n.r && Math.hypot(other.x - p.x, other.y - p.y) < other.radius * .88)) continue;
      const width = Math.min(200, p.n.label.length * 6.2 + 12), x = Math.min(this.w - width - 6, Math.max(6, p.x - width / 2)), y = p.y + p.radius + 7;
      if (boxes.some(b => Math.abs(b.y - y) < 23 && x < b.x + b.w + 6 && x + width + 6 > b.x)) continue;
      boxes.push({ x, y, w: width }); const label = this.labels[p.index]; label.hidden = false; label.style.transform = `translate(${Math.round(x)}px,${Math.round(y)}px)`; label.style.maxWidth = `${width}px`; label.dataset.selected = String(p.n.id === this.selected);
    }
  }
  private saveCamera() {
    const target = this.flight.enabled ? this.camera.position.clone().addScaledVector(this.camera.getWorldDirection(new Vector3()), 150) : this.orbit.target;
    this.events.camera({ position: this.camera.position.toArray(), target: target.toArray() });
  }
  private frame = (now: number) => {
    this.frameId = 0;
    if (this.disposed || this.lost || !this.visible || document.hidden || this.w < 2 || this.h < 2) return;
    const elapsed = this.lastFrame ? now - this.lastFrame : 16.7; this.lastFrame = now; this.time += Math.min(elapsed, 50) / 1000;
    if (this.transition) {
      const t = Math.min(1, (now - this.transition.at) / 650), smooth = t * t * (3 - 2 * t);
      this.camera.position.lerpVectors(this.transition.from, this.transition.to, smooth); this.orbit.target.lerpVectors(this.transition.targetFrom, this.transition.targetTo, smooth);
      if (t === 1) this.transition = null;
    }
    this.flight.step(elapsed / 1000); if (this.orbit.enabled) this.orbit.update();
    for (const p of this.planets) {
      const distance = this.camera.position.distanceTo(p.mesh.position);
      p.setDetail(distance < p.mesh.userData.node.r * 18);
      if (this.motion && (distance < 1100 || p.mesh.userData.node.id === this.selected)) p.animate(this.time);
    }
    this.glow?.update(this.h * this.renderer.getPixelRatio(), this.motion ? this.time : 0);
    this.renderer.render(this.scene, this.camera);
    const p = this.camera.position, q = this.camera.quaternion;
    const key = `${p.x.toFixed(2)},${p.y.toFixed(2)},${p.z.toFixed(2)},${q.x.toFixed(4)},${q.y.toFixed(4)},${q.z.toFixed(4)},${q.w.toFixed(4)},${this.w},${this.h}`;
    const moved = key !== this.viewKey; this.viewKey = key;
    // The overlap pass projects every planet against every other — only
    // worth re-running when what it depends on changed.
    if (moved || this.dirty) this.drawLabels();
    if (moved) this.saveCamera();
    if (elapsed < 250) this.frames.push(elapsed);
    if (this.frames.length >= 180) {
      const sorted = this.frames.sort((a,b) => a-b), median = sorted[Math.floor(sorted.length / 2)], p95 = sorted[Math.floor(sorted.length * .95)];
      if (median > 22) this.slowBatches++; else this.slowBatches = 0;
      if (this.slowBatches >= 2 && this.renderer.getPixelRatio() > .75) { this.renderer.setPixelRatio(Math.max(.75, this.renderer.getPixelRatio() - .25)); this.resize(); this.slowBatches = 0; }
      const stats = { median, p95, resolution: this.renderer.getPixelRatio(), nodes: this.planets.length, draws: this.renderer.info.render.calls };
      this.host.dataset.frameStats = JSON.stringify(stats); this.events.stats(stats); this.frames = [];
    }
    if (this.motion && moved) {
      // Only on a whole-pixel change: a custom property on the parent restyles
      // the whole subtree (every label), so it must not be set per frame.
      const px = Math.round(Math.max(-1, Math.min(1, q.y)) * 12);
      if (px !== this.visorPx) { this.visorPx = px; this.host.parentElement?.style.setProperty("--mc-visor-x", `${px}px`); }
    }
    const settling = this.transition !== null || this.flight.enabled || moved || this.dirty;
    this.dirty = false;
    const idle = !settling && (!this.motion || now - this.lastInput > IDLE_MS);
    if (!idle) this.resume();
  };
  private pause() { if (this.frameId) cancelAnimationFrame(this.frameId); this.frameId = 0; this.lastFrame = 0; }
  private resume() { if (!this.frameId && !this.disposed && !this.lost && this.visible && !document.hidden && this.w > 1 && this.h > 1) this.frameId = requestAnimationFrame(this.frame); }
  private clearData() {
    for (const p of this.planets) { this.scene.remove(p.mesh); p.dispose(); } this.planets = [];
    if (this.web) { this.scene.remove(this.web.line); this.web.dispose(); this.web = null; }
    if (this.glow) { this.scene.remove(this.glow.points); this.glow.dispose(); this.glow = null; }
    this.labelLayer.replaceChildren(); this.labels = [];
  }
  dispose() {
    if (this.disposed) return;
    this.saveCamera(); this.disposed = true; this.pause(); this.abort.abort(); this.ro.disconnect(); this.io?.disconnect();
    this.flight.dispose(); this.orbit.dispose(); this.clearData(); this.dust.geometry.dispose(); (this.dust.material as PointsMaterial).dispose();
    this.scene.clear(); this.renderer.dispose(); this.renderer.forceContextLoss(); this.renderer.domElement.remove(); this.labelLayer.remove(); this.release();
  }
}
