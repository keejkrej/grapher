import { BoxGeometry, SphereGeometry, TorusGeometry } from 'three';
import type { Layer } from './engine.ts';

export type MeshLayer = Extract<Layer, { kind: 'mesh' }>;

export function makeGeometry(shape: MeshLayer['shape']) {
  switch (shape) {
    case 'cube': return new BoxGeometry(1.45, 1.45, 1.45);
    case 'sphere': return new SphereGeometry(1, 32, 20);
    case 'torus': return new TorusGeometry(0.72, 0.28, 20, 44);
  }
}

export function meshScale(layer: MeshLayer) {
  return [layer.width / 100, layer.height / 100, Math.min(layer.width, layer.height) / 100] as [number, number, number];
}
