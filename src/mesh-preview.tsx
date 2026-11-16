import { useEffect, useRef, useState } from 'react';
import {
  AmbientLight, Color, DirectionalLight, GridHelper, Group, Mesh, MeshStandardMaterial,
  PerspectiveCamera, Scene as ThreeScene, WebGLRenderer,
} from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import type { Scene } from './engine';
import { makeGeometry, meshScale } from './geometry';

export function MeshPreview({ scene }: { scene: Scene }) {
  const host = useRef<HTMLDivElement>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    const element = host.current;
    if (!element) return;
    let renderer: WebGLRenderer;
    try {
      renderer = new WebGLRenderer({ antialias: true });
    } catch {
      setFailed(true);
      return;
    }
    setFailed(false);
    renderer.setPixelRatio(Math.min(2, window.devicePixelRatio));
    element.appendChild(renderer.domElement);
    const stage = new ThreeScene();
    stage.background = new Color('#222223');
    const group = new Group();
    stage.add(group);
    for (const layer of scene.layers) {
      if (layer.kind !== 'mesh' || !layer.visible) continue;
      const mesh = new Mesh(makeGeometry(layer.shape), new MeshStandardMaterial({ color: layer.color, metalness: 0.14, roughness: 0.55 }));
      mesh.position.set((layer.x + layer.width / 2 - scene.width / 2) / 100, (scene.height / 2 - layer.y - layer.height / 2) / 100, 0);
      mesh.scale.set(...meshScale(layer));
      mesh.rotation.set(0.35, layer.rotation * Math.PI / 180, 0);
      group.add(mesh);
    }
    const grid = new GridHelper(60, 60, '#666360', '#3c3b3a');
    grid.position.y = -Math.max(scene.height / 200, 2.5);
    stage.add(grid);
    const key = new DirectionalLight('#ffe2bf', 3);
    key.position.set(5, 8, 7);
    const rim = new DirectionalLight('#b8c7ff', 1.6);
    rim.position.set(-5, 3, -7);
    stage.add(new AmbientLight('#ffffff', 1.4), key, rim);
    const camera = new PerspectiveCamera(40, 1, 0.05, 200);
    const distance = Math.max(scene.width, scene.height) / 100;
    camera.position.set(0, distance * 0.44, distance * 1.65);
    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    const observer = new ResizeObserver(() => {
      if (!element.clientWidth || !element.clientHeight) return;
      camera.aspect = element.clientWidth / element.clientHeight;
      camera.updateProjectionMatrix();
      renderer.setSize(element.clientWidth, element.clientHeight);
    });
    observer.observe(element);
    renderer.setAnimationLoop(() => {
      controls.update();
      renderer.render(stage, camera);
    });
    return () => {
      observer.disconnect();
      controls.dispose();
      renderer.setAnimationLoop(null);
      grid.geometry.dispose();
      for (const material of [grid.material].flat()) material.dispose();
      for (const child of group.children) {
        if (!(child instanceof Mesh)) continue;
        child.geometry.dispose();
        child.material.dispose();
      }
      renderer.dispose();
      renderer.domElement.remove();
    };
  }, [scene]);

  return <div ref={host} className="mesh-preview" aria-label="Interactive 3D preview">
    {failed ? <span>WebGL is unavailable in this browser. Switch back to Canvas to see the projection.</span> :
      <span>Drag to orbit · Scroll to zoom</span>}
  </div>;
}
