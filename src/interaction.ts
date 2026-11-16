import { SVGPathData } from 'svg-pathdata';
import { layerBounds, operationLimit, operationSchema, type Layer, type Operation, type Scene } from './engine.ts';

export type Box = { x: number; y: number; width: number; height: number };
export type ResizeOptions = { preserveAspect?: boolean };

function finite(values: number[], message: string) {
  if (!values.every(Number.isFinite)) throw new Error(message);
}

function checkedLayer(layer: Layer): Layer {
  const operation = operationSchema.parse({ op: 'replace', id: layer.id, layer });
  if (operation.op !== 'replace') throw new Error('The layer could not be validated.');
  return operation.layer;
}

/** Translate the existing geometry without changing its local path data or text source. */
export function translateLayer(layer: Layer, dx: number, dy: number): Layer {
  finite([dx, dy], 'Movement must use finite horizontal and vertical distances.');
  if (layer.kind === 'path') {
    return checkedLayer({ ...layer, offsetX: (layer.offsetX ?? 0) + dx, offsetY: (layer.offsetY ?? 0) + dy });
  }
  return checkedLayer({ ...layer, x: layer.x + dx, y: layer.y + dy });
}

/** The union of selected layer bounds, including strokes and transforms. */
export function boundsForLayers(layers: readonly Layer[]): Box | undefined {
  if (!layers.length) return undefined;
  const bounds = layers.map(layerBounds);
  if (!bounds.every((box) => Object.values(box).every(Number.isFinite))) throw new Error('A selected layer has invalid bounds.');
  const x = Math.min(...bounds.map((box) => box.x));
  const y = Math.min(...bounds.map((box) => box.y));
  return {
    x, y,
    width: Math.max(...bounds.map((box) => box.x + box.width)) - x,
    height: Math.max(...bounds.map((box) => box.y + box.height)) - y,
  };
}

function padding(layer: Layer) {
  const stroke = 'stroke' in layer && layer.stroke && layer.stroke !== 'none' && layer.stroke !== 'transparent'
    ? (layer.strokeWidth ?? 1) / 2 : 0;
  const marker = layer.kind === 'path' && (layer.markerStart || layer.markerEnd) ? Math.max(6, (layer.strokeWidth ?? 1) * 4) : 0;
  return Math.max(stroke, marker);
}

/**
 * Resize into a target painted bounding box in scene coordinates. Stroke widths stay fixed.
 * Aspect-preserving fits use the target's upper-left corner. Text always scales uniformly
 * to retain its editable source and glyph proportions. Rotated and flat-path resizing
 * fails explicitly when the current scene model cannot express the requested result.
 */
export function resizeLayer(layer: Layer, target: Box, options: ResizeOptions = {}): Layer {
  finite(Object.values(target), 'Resize bounds must be finite.');
  if (target.width <= 0 || target.height <= 0) throw new Error('Resize bounds need a positive width and height.');
  const rotation = ((layer.rotationDeg ?? 0) % 360 + 360) % 360;
  if (rotation > 1e-8 && rotation < 360 - 1e-8) throw new Error('Reset this layer’s rotation before resizing it. Moving rotated layers is supported.');
  const original = layerBounds(layer);
  finite(Object.values(original), 'This layer has invalid bounds and cannot be resized.');
  let width = target.width;
  let height = target.height;
  if (options.preserveAspect || layer.kind === 'text') {
    if (original.width <= 0 || original.height <= 0) throw new Error('An empty layer cannot be resized proportionally.');
    const scale = Math.min(width / original.width, height / original.height);
    width = original.width * scale;
    height = original.height * scale;
  }

  if (layer.kind === 'text') {
    const scale = width / original.width;
    const resized = checkedLayer({
      ...layer, fontSize: layer.fontSize * scale,
      ...(layer.maxWidth !== undefined ? { maxWidth: layer.maxWidth * scale } : {}),
      ...(layer.letterSpacing !== undefined ? { letterSpacing: layer.letterSpacing * scale } : {}),
    });
    const bounds = layerBounds(resized);
    return translateLayer(resized, target.x - bounds.x, target.y - bounds.y);
  }
  if (layer.kind === 'raster' || layer.kind === 'mesh') {
    return checkedLayer({ ...layer, x: target.x, y: target.y, width, height });
  }

  const inset = padding(layer);
  const innerWidth = width - inset * 2;
  const innerHeight = height - inset * 2;
  if (innerWidth < 0 || innerHeight < 0) throw new Error('The requested size is smaller than the layer’s stroke or arrowheads.');
  if (layer.kind === 'rect' || layer.kind === 'ellipse') {
    if (innerWidth <= 0 || innerHeight <= 0) throw new Error('The resized shape needs a positive interior size.');
    if (layer.kind === 'rect') return checkedLayer({ ...layer, x: target.x + inset, y: target.y + inset, width: innerWidth, height: innerHeight });
    return checkedLayer({ ...layer, x: target.x + width / 2, y: target.y + height / 2, rx: innerWidth / 2, ry: innerHeight / 2 });
  }

  const path = new SVGPathData(layer.d).toAbs();
  const bounds = path.getBounds();
  finite([bounds.minX, bounds.minY, bounds.maxX, bounds.maxY], 'This path has no drawable geometry.');
  const rawWidth = bounds.maxX - bounds.minX;
  const rawHeight = bounds.maxY - bounds.minY;
  if (rawWidth === 0 && innerWidth > 1e-8) throw new Error('A vertical path has no width to scale. Move it or edit its geometry.');
  if (rawHeight === 0 && innerHeight > 1e-8) throw new Error('A horizontal path has no height to scale. Move it or edit its geometry.');
  const scaleX = rawWidth > 0 ? innerWidth / rawWidth : 1;
  const scaleY = rawHeight > 0 ? innerHeight / rawHeight : 1;
  if (scaleX <= 0 || scaleY <= 0) throw new Error('The requested size would collapse the path.');
  path.matrix(scaleX, 0, 0, scaleY, target.x + inset - bounds.minX * scaleX, target.y + inset - bounds.minY * scaleY);
  const transformed = path.getBounds();
  return checkedLayer({
    ...layer, d: path.encode(), offsetX: 0, offsetY: 0,
    bounds: { x: transformed.minX, y: transformed.minY, width: transformed.maxX - transformed.minX, height: transformed.maxY - transformed.minY },
  });
}

/** Derive the smallest serializable edit while preserving the layer's identity and type. */
export function layerUpdate(original: Layer, updated: Layer): Operation {
  if (original.id !== updated.id || original.kind !== updated.kind) throw new Error('An interaction cannot change a layer’s identity or type.');
  const validated = checkedLayer(updated);
  const before = original as Record<string, unknown>;
  const after = validated as Record<string, unknown>;
  const patch: Record<string, unknown> = {};
  for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
    if (key === 'id' || key === 'kind') continue;
    if (Object.is(before[key], after[key])) continue;
    if (JSON.stringify(before[key]) === JSON.stringify(after[key])) continue;
    // JSON update patches cannot communicate deletion of an optional property.
    if (after[key] === undefined) return { op: 'replace', id: original.id, layer: validated };
    patch[key] = after[key];
  }
  return { op: 'update', id: original.id, patch };
}

/** Duplicate selected layers in their existing stacking order, offset by 20 scene pixels. */
export function duplicateLayers(scene: Scene, ids: readonly string[], idFactory?: (source: Layer) => string): Operation[] {
  const wanted = new Set(ids);
  for (const id of wanted) if (!scene.layers.some((layer) => layer.id === id)) throw new Error(`Layer “${id}” was not found.`);
  const selected = scene.layers.filter((layer) => wanted.has(layer.id));
  if (scene.layers.length + selected.length > 750) throw new Error('Duplicating these layers would exceed the document’s 750-layer limit.');
  if (selected.length > operationLimit) throw new Error(`Duplicate at most ${operationLimit} layers at a time.`);
  const occupied = new Set(scene.layers.map((layer) => layer.id));
  return selected.map((source) => {
    let id: string;
    if (idFactory) id = idFactory(source);
    else {
      const base = `${source.id.slice(0, 84)}-copy`;
      id = base;
      let suffix = 2;
      while (occupied.has(id)) id = `${base}-${suffix++}`;
    }
    if (occupied.has(id)) throw new Error(`The duplicate layer ID “${id}” is already in use.`);
    occupied.add(id);
    const copy = translateLayer({ ...structuredClone(source), id, name: `${source.name} copy`.slice(0, 300) }, 20, 20);
    return { op: 'add', layer: copy };
  });
}
