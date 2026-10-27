import { BufferAttribute, Color, Mesh, ShaderMaterial, SphereGeometry } from "three";
import { mergeVertices } from "three/addons/utils/BufferGeometryUtils.js";
import { seedOf, type CosmosNode } from "../../lib/memoryMap3d";

const SOMA_COLORS = { class: "#b7e2d6", digest: "#b2aad8", session: "#8bbfd0", thread: "#85cbbb" };
export const somaColor = (node: CosmosNode) => node.pinned ? "#e4c58e" : SOMA_COLORS[node.kind];
export function planet(node: CosmosNode, detail: boolean) {
  const phase = seedOf(node.id) / 4294967296 * Math.PI * 2;
  const makeGeometry = (high: boolean) => {
    const sphere = new SphereGeometry(1, high ? 48 : 18, high ? 32 : 12);
    // The soma shader needs no UV seam. Weld its duplicated vertices before
    // recomputing normals so the luminous membrane stays smooth up close.
    sphere.deleteAttribute("uv"); sphere.deleteAttribute("normal");
    const geometry = mergeVertices(sphere); sphere.dispose();
    const positions = geometry.getAttribute("position") as BufferAttribute;
    const base = new Float32Array(positions.array.length);
    for (let i = 0; i < positions.count; i++) {
      const x = positions.getX(i), y = positions.getY(i), z = positions.getZ(i);
      const deformation = 1 + 0.035 * Math.sin(3.5 * x + phase) * Math.cos(y * 4.2 - phase)
        + 0.018 * Math.sin(z * 5.7 + y * 2.6 + phase);
      base[i * 3] = x * deformation; base[i * 3 + 1] = y * deformation; base[i * 3 + 2] = z * deformation;
    }
    positions.array.set(base); geometry.computeVertexNormals(); geometry.computeBoundingSphere();
    if (geometry.boundingSphere) geometry.boundingSphere.radius *= 1.04;
    return { geometry, positions, base };
  };
  const geometries: Partial<Record<"high" | "low", ReturnType<typeof makeGeometry>>> = {};
  let level: "high" | "low" = detail ? "high" : "low";
  let current = makeGeometry(detail); geometries[level] = current;
  const material = new ShaderMaterial({
    uniforms: { tint: { value: new Color(somaColor(node)) }, time: { value: 0 }, phase: { value: phase }, selected: { value: 0 }, digest: { value: node.kind === "digest" ? 1 : 0 } },
    vertexShader: `varying vec3 n; varying vec3 view; varying vec3 local;
      void main(){ local=position; vec4 p=modelViewMatrix*vec4(position,1.0); n=normalize(normalMatrix*normal); view=normalize(-p.xyz); gl_Position=projectionMatrix*p; }`,
    fragmentShader: `uniform vec3 tint; uniform float time,phase,selected,digest; varying vec3 n,view,local;
      void main(){
        float facing=max(0.0,dot(normalize(n),normalize(view)));
        float rim=pow(1.0-facing,2.4);
        float clouds=sin(local.x*3.0+phase+time*.06)*sin(local.y*3.0-local.z*2.0+phase);
        float nucleus=pow(facing,18.0)*(.5+.035*sin(time*.38+phase));
        float membrane=pow(facing,2.0)*(.22+.045*clouds)*(1.0-digest*.18);
        vec3 pearl=mix(tint,vec3(.94,.96,.9),.45);
        vec3 color=tint*(.13+membrane)+pearl*(rim*(.65+selected*.45)+nucleus*(1.0+selected*.35));
        gl_FragColor=vec4(color,1.0);
      }`,
  });
  const mesh = new Mesh(current.geometry, material);
  mesh.position.set(node.x, node.y, node.z); mesh.scale.setScalar(node.r); mesh.userData.node = node;
  return { mesh, phase, setDetail(high: boolean) {
    const next = high ? "high" : "low"; if (next === level) return;
    level = next; current = geometries[next] ??= makeGeometry(high); mesh.geometry = current.geometry;
  }, animate(time: number) {
    const { positions, base } = current;
    // CPU deformation means ray picking sees the same silhouette as rendering.
    for (let i = 0; i < positions.count; i++) {
      const x = base[i * 3], y = base[i * 3 + 1], z = base[i * 3 + 2];
      const wave = 1 + 0.008 * Math.sin(time * 0.38 + y * 3.7 + phase) * Math.cos(z * 3 + phase);
      positions.setXYZ(i, x * wave, y * wave, z * wave);
    }
    positions.needsUpdate = true; material.uniforms.time.value = time;
  }, dispose() { for (const value of Object.values(geometries)) value.geometry.dispose(); material.dispose(); } };
}
