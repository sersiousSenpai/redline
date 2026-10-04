import { AdditiveBlending, BufferGeometry, Color, Float32BufferAttribute, Points, ShaderMaterial } from "three";
import type { CosmosNode } from "../../lib/memoryMap3d";
import { somaColor } from "./planets";

/** Soft probability-cloud styling, with one sprite per actual memory. */
export function halos(nodes: CosmosNode[]) {
  const geometry = new BufferGeometry();
  geometry.setAttribute("position", new Float32BufferAttribute(nodes.flatMap(n => [n.x, n.y, n.z]), 3));
  geometry.setAttribute("tint", new Float32BufferAttribute(nodes.flatMap(n => new Color(somaColor(n)).toArray()), 3));
  geometry.setAttribute("radius", new Float32BufferAttribute(nodes.map(n => n.r), 1));
  const material = new ShaderMaterial({
    uniforms: { viewport: { value: 1 }, time: { value: 0 } },
    transparent: true, depthWrite: false, blending: AdditiveBlending,
    vertexShader: `attribute vec3 tint; attribute float radius; uniform float viewport; varying vec3 color;
      void main(){ color=tint; vec4 p=modelViewMatrix*vec4(position,1.0);
        gl_PointSize=clamp(radius*5.0*projectionMatrix[1][1]*viewport/max(1.0,-p.z),1.0,256.0);
        gl_Position=projectionMatrix*p; }`,
    fragmentShader: `uniform float time; varying vec3 color;
      void main(){ vec2 p=gl_PointCoord*2.0-1.0; float r=dot(p,p); if(r>1.0)discard;
        float glow=(exp(-4.5*r)-exp(-4.5))*(.15+.008*sin(time*.38));
        gl_FragColor=vec4(color,glow); }`,
  });
  const points = new Points(geometry, material);
  // A sprite extends beyond its center; avoid point-only frustum bounds.
  points.frustumCulled = false;
  return { points, update(height: number, time: number) { material.uniforms.viewport.value = height; material.uniforms.time.value = time; },
    dispose() { geometry.dispose(); material.dispose(); } };
}
