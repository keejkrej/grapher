import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { SVGPathData } from 'svg-pathdata';
import { applyOperations, layerBounds, type Layer, type Scene } from './engine.ts';
import { boundsForLayers, duplicateLayers, layerUpdate, resizeLayer, translateLayer, type Box } from './interaction.ts';
import { registerFont } from './typography.ts';

registerFont('Source Sans 3', new Uint8Array(readFileSync(new URL('../public/fonts/SourceSans3-Regular.otf', import.meta.url))).buffer);

const common = { visible: true, name: 'Selection' };
const fixtures: Layer[] = [
  { ...common, id: 'rect', kind: 'rect', x: 10, y: 20, width: 100, height: 50, fill: '#FFFFFF', stroke: '#000000', strokeWidth: 4 },
  { ...common, id: 'ellipse', kind: 'ellipse', x: 50, y: 50, rx: 30, ry: 10, fill: '#123456', stroke: '#000000', strokeWidth: 2 },
  { ...common, id: 'text', kind: 'text', x: 30, y: 60, text: 'Label α\nSecond line', fontFamily: 'Source Sans 3', fontSize: 20, maxWidth: 180, lineHeight: 1.4, letterSpacing: 0.5, fill: '#000000', align: 'center' },
  { ...common, id: 'path', kind: 'path', d: 'M10 20L50 20L50 60Z', offsetX: 100, offsetY: 80, bounds: { x: 10, y: 20, width: 40, height: 40 }, fill: '#123456', stroke: '#000000', strokeWidth: 2 },
  { ...common, id: 'raster', kind: 'raster', x: 20, y: 25, width: 80, height: 60, src: 'data:image/png;base64,aGVsbG8=', fit: 'contain' },
  { ...common, id: 'mesh', kind: 'mesh', x: 40, y: 50, width: 100, height: 100, shape: 'cube', rotation: 25, color: '#AABBCC' },
];

function scene(layers: Layer[] = fixtures): Scene {
  return { name: 'Direct interaction', width: 800, height: 600, background: '#FFFFFF', layers };
}

function sameBox(actual: Box, expected: Box) {
  for (const field of ['x', 'y', 'width', 'height'] as const) assert.ok(Math.abs(actual[field] - expected[field]) < 0.0001, `${field}: ${actual[field]} should equal ${expected[field]}`);
}

test('dragging translates every primitive and rotated geometry by exact scene deltas', () => {
  for (const fixture of fixtures) {
    for (const rotationDeg of [0, 37]) {
      const original = { ...fixture, rotationDeg };
      const before = structuredClone(original);
      const oldBounds = layerBounds(original);
      const moved = translateLayer(original, 17.25, -9.5);
      assert.deepEqual(original, before);
      sameBox(layerBounds(moved), { ...oldBounds, x: oldBounds.x + 17.25, y: oldBounds.y - 9.5 });
      const result = applyOperations(scene([original]), [layerUpdate(original, moved)]);
      assert.deepEqual(result.layers[0], moved);
    }
  }
});

test('path dragging preserves source geometry and modifies only translation offsets', () => {
  const original = fixtures[3];
  const moved = translateLayer(original, 12, -4);
  assert.equal(moved.kind, 'path');
  if (moved.kind !== 'path') return;
  assert.equal(moved.d, 'M10 20L50 20L50 60Z');
  assert.deepEqual(moved.bounds, { x: 10, y: 20, width: 40, height: 40 });
  assert.equal(moved.offsetX, 112);
  assert.equal(moved.offsetY, 76);
  assert.deepEqual(layerUpdate(original, moved), { op: 'update', id: 'path', patch: { offsetX: 112, offsetY: 76 } });
});

test('rectangles, ellipses, images and meshes resize to their painted bounds', () => {
  const target = { x: 30, y: 40, width: 204, height: 104 };
  for (const original of fixtures.filter((item) => ['rect', 'ellipse', 'raster', 'mesh'].includes(item.kind))) {
    const resized = resizeLayer(original, target);
    sameBox(layerBounds(resized), target);
    assert.equal(resized.id, original.id);
    const result = applyOperations(scene([original]), [layerUpdate(original, resized)]);
    sameBox(layerBounds(result.layers[0]), target);
  }
  const square: Layer = { ...common, id: 'square', kind: 'rect', x: 0, y: 0, width: 100, height: 50, fill: '#000000' };
  sameBox(layerBounds(resizeLayer(square, { x: 10, y: 20, width: 200, height: 200 }, { preserveAspect: true })), { x: 10, y: 20, width: 200, height: 100 });
});

test('path resizing transforms real vertices and arcs rather than the supplied bounds hint', () => {
  const original = fixtures[3];
  const resized = resizeLayer(original, { x: 20, y: 30, width: 82, height: 122 });
  assert.equal(resized.kind, 'path');
  if (resized.kind !== 'path') return;
  sameBox(layerBounds(resized), { x: 20, y: 30, width: 82, height: 122 });
  assert.equal(resized.offsetX, 0);
  assert.equal(resized.offsetY, 0);
  const coordinates = new SVGPathData(resized.d).toAbs().commands.filter((command) => 'x' in command && 'y' in command).map((command) => ({ x: 'x' in command ? command.x : 0, y: 'y' in command ? command.y : 0 }));
  assert.deepEqual(coordinates, [{ x: 21, y: 31 }, { x: 101, y: 31 }, { x: 101, y: 151 }]);
  const arc: Layer = { ...common, id: 'arc', kind: 'path', d: 'M10 20A20 20 0 1 0 50 20A20 20 0 1 0 10 20Z', offsetX: 77, offsetY: -9, bounds: { x: 999, y: 999, width: 1, height: 1 }, fill: 'none', stroke: '#000000', strokeWidth: 2 };
  sameBox(layerBounds(resizeLayer(arc, { x: 100, y: 200, width: 122, height: 82 })), { x: 100, y: 200, width: 122, height: 82 });
});

test('text resizing scales real font metrics while retaining text and wrap proportions', () => {
  const original = fixtures[2];
  const bounds = layerBounds(original);
  const target = { x: 100, y: 120, width: bounds.width * 2, height: bounds.height * 3 };
  const resized = resizeLayer(original, target);
  assert.equal(resized.kind, 'text');
  if (resized.kind !== 'text' || original.kind !== 'text') return;
  assert.equal(resized.text, original.text);
  assert.equal(resized.fontSize, 40);
  assert.equal(resized.maxWidth, 360);
  assert.equal(resized.letterSpacing, 1);
  assert.equal(resized.lineHeight, 1.4);
  sameBox(layerBounds(resized), { ...target, height: bounds.height * 2 });
});

test('unsupported or invalid resizing fails without changing the source layer', () => {
  const original = fixtures[0];
  assert.throws(() => translateLayer(original, NaN, 0), /finite/);
  assert.throws(() => resizeLayer(original, { x: 0, y: 0, width: 0, height: 20 }), /positive/);
  assert.throws(() => resizeLayer(original, { x: 0, y: 0, width: 1, height: 20 }), /stroke/);
  assert.throws(() => resizeLayer({ ...original, rotationDeg: 30 }, { x: 0, y: 0, width: 40, height: 20 }), /rotation/);
  const horizontal: Layer = { ...common, id: 'line', kind: 'path', d: 'M10 20L50 20', bounds: { x: 10, y: 20, width: 40, height: 0 }, fill: 'none', stroke: '#000000', strokeWidth: 2 };
  assert.throws(() => resizeLayer(horizontal, { x: 0, y: 0, width: 100, height: 30 }), /horizontal path/);
  sameBox(layerBounds(resizeLayer(horizontal, { x: 10, y: 20, width: 100, height: 2 })), { x: 10, y: 20, width: 100, height: 2 });
});

test('duplicate selection preserves stacking order, source content and independent identities', () => {
  const original = scene([fixtures[0], fixtures[3], { ...fixtures[0], id: 'rect-copy' }]);
  const snapshot = structuredClone(original);
  const operations = duplicateLayers(original, ['path', 'rect', 'rect']);
  const updated = applyOperations(original, operations);
  assert.deepEqual(original, snapshot);
  assert.deepEqual(updated.layers.slice(-2).map((item) => item.id), ['rect-copy-2', 'path-copy']);
  for (const [index, source] of [fixtures[0], fixtures[3]].entries()) {
    const copy = updated.layers[index + 3];
    const box = layerBounds(source);
    sameBox(layerBounds(copy), { ...box, x: box.x + 20, y: box.y + 20 });
  }
  assert.throws(() => duplicateLayers(original, ['rect'], () => 'rect'), /already in use/);
  assert.throws(() => duplicateLayers(original, ['missing']), /not found/);
  assert.deepEqual(duplicateLayers(original, []), []);
  const generated = duplicateLayers(original, ['path'], () => 'generated-id');
  assert.equal(generated[0].op, 'add');
  if (generated[0].op === 'add' && generated[0].layer.kind === 'path' && fixtures[3].kind === 'path') {
    assert.notEqual(generated[0].layer.bounds, fixtures[3].bounds);
  }
});

test('selection bounds and serializable updates preserve identity and optional-property removal', () => {
  assert.equal(boundsForLayers([]), undefined);
  const box = boundsForLayers([fixtures[0], fixtures[1]])!;
  assert.ok(box.x <= layerBounds(fixtures[0]).x);
  assert.ok(box.x + box.width >= layerBounds(fixtures[1]).x + layerBounds(fixtures[1]).width);
  assert.throws(() => layerUpdate(fixtures[0], { ...fixtures[0], id: 'other' }), /identity/);
  const original = { ...fixtures[0], opacity: 0.4 };
  const updated = { ...fixtures[0] };
  const operation = layerUpdate(original, updated);
  assert.equal(operation.op, 'replace');
  assert.equal(applyOperations(scene([original]), [JSON.parse(JSON.stringify(operation))]).layers[0].opacity, undefined);
});
