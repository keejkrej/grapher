import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { Resvg } from '@resvg/resvg-js';
import { SVGPathData } from 'svg-pathdata';
import { applyOperations, layerBounds, repairScene, sceneSchema, sceneSvg, textLayout, verifyScene, type Layer, type Scene } from './engine';
import { measureText, registerFont, textMetrics, textOutline } from './typography';
import { examples } from './examples';

for (const [family, regular, bold] of [
  ['Source Sans 3', 'SourceSans3-Regular.otf', 'SourceSans3-Bold.otf'],
  ['Barlow', 'Barlow-Regular.ttf', 'Barlow-Bold.ttf'],
  ['Crimson Text', 'CrimsonText-Regular.ttf', 'CrimsonText-Bold.ttf'],
  ['Courier Prime', 'CourierPrime-Regular.ttf', 'CourierPrime-Bold.ttf'],
]) {
  registerFont(family, new Uint8Array(readFileSync(new URL(`../public/fonts/${regular}`, import.meta.url))).buffer, 400);
  registerFont(family, new Uint8Array(readFileSync(new URL(`../public/fonts/${bold}`, import.meta.url))).buffer, 700);
}

function composition(layers: Layer[]): Scene {
  return { name: 'Regression figure', width: 400, height: 300, background: '#ffffff', layers };
}

function path(d: string): Extract<Layer, { kind: 'path' }> {
  return { id: 'curve', name: 'Curve', visible: true, kind: 'path', d, fill: 'none', stroke: '#000000', bounds: { x: 20, y: 20, width: 100, height: 100 } };
}

test('malformed and empty paths fail verification and cannot silently render blank', () => {
  for (const data of ['M20 20 L', 'M20 20', 'M20 20Z', 'M0 0 C1 2 3']) {
    const scene = composition([path(data)]);
    assert.equal(verifyScene(scene).checks.find((check) => check.id === 'geometry')?.status, 'fail');
    assert.throws(() => sceneSvg(scene), /invalid|empty/);
  }
});

test('bounds use actual curves even when supplied path bounds are wrong', () => {
  const scene = composition([path('M 20 20 C 20 20 500 40 500 40')]);
  const bounds = layerBounds(scene.layers[0]);
  assert.equal(bounds.x, 19.5);
  assert.equal(bounds.width, 481);
  assert.equal(verifyScene(scene).checks.find((check) => check.id === 'bounds')?.status, 'fail');
});

test('truncated PNG content fails and cannot export as an empty image', () => {
  const scene = composition([{
    id: 'raster', name: 'Broken image', visible: true, kind: 'raster',
    x: 10, y: 10, width: 100, height: 100, src: 'data:image/png;base64,iVBORw0KGgoAAAA',
  }]);
  assert.equal(verifyScene(scene).checks.find((check) => check.id === 'assets')?.status, 'fail');
  assert.throws(() => sceneSvg(scene), /complete embedded/);
});

test('unsupported contrast is a warning and automatic repairs preserve its paint', () => {
  const scene = composition([
    { id: 'mesh', name: 'Surface', visible: true, kind: 'mesh', x: 0, y: 0, width: 200, height: 200, shape: 'cube', color: '#d4e5ef', rotation: 30 },
    { id: 'label', name: 'Surface label', visible: true, kind: 'text', x: 25, y: 60, text: 'Surface', fontSize: 20, fill: '#123456' },
  ]);
  const report = verifyScene(scene);
  assert.equal(report.checks.find((check) => check.id === 'contrast')?.status, 'warn');
  assert.equal(report.issues.find((issue) => issue.checkId === 'contrast')?.severity, 'warning');
  assert.ok(report.passed < report.total);
  assert.deepEqual(repairScene(scene).scene, scene);
  // The mesh intersects the start of the label without covering its center.
  const partial = { ...scene, layers: [{ ...scene.layers[0], width: 30 }, { ...scene.layers[1], text: 'Surface annotation' }] } as Scene;
  assert.equal(verifyScene(partial).checks.find((check) => check.id === 'contrast')?.status, 'warn');
});

test('text wraps with measured advances and outlines preserve Greek glyphs', () => {
  const label: Layer = {
    id: 'label', name: 'Scientific label', visible: true, kind: 'text', x: 30, y: 50,
    text: 'Alpha α and beta β measurements', fontSize: 20, maxWidth: 150,
    lineHeight: 1.5, letterSpacing: 0.4, fill: '#111111', fontFamily: 'Source Sans 3',
  };
  assert.equal(textMetrics(label).measured, true);
  const lines = textLayout(label);
  assert.ok(lines.length > 1);
  assert.ok(lines.every((line) => line.width <= 150));
  assert.equal(lines[1].y - lines[0].y, 30);
  const box = layerBounds(label);
  assert.ok(box.height > 30);
  const svg = sceneSvg(composition([label]), { outlineText: true });
  assert.ok(!svg.includes('<text'));
  assert.ok(svg.includes('aria-label="Alpha α and beta β measurements"'));
  const rendered = new Resvg(svg, { font: { loadSystemFonts: false } }).render();
  assert.equal(rendered.width, 400);
  assert.ok(rendered.pixels.some((channel, index) => index % 4 !== 3 && channel < 100));
  assert.ok(measureText('WWW', label) > measureText('iii', label));
});

test('rotation bounds, gradients, strokes, arrows and transparency survive SVG rendering', () => {
  const scene = sceneSchema.parse({
    ...composition([
      { id: 'box', name: 'Rotated box', visible: true, kind: 'rect', x: 80, y: 80, width: 80, height: 40, fill: 'url(#blue)', stroke: '#123456', strokeWidth: 2, rotationDeg: 90, opacity: 0.8 },
      { ...path('M 40 200 L 250 200'), markerStart: 'circle', markerEnd: 'arrow', strokeWidth: 2, strokeDasharray: [6, 3], strokeLinecap: 'round' },
    ]),
    background: 'transparent',
    gradients: [{ id: 'blue', kind: 'linear', x1: 0, y1: 0, x2: 1, y2: 1, stops: [{ offset: 0, color: '#0088cc' }, { offset: 1, color: '#005588' }] }],
  });
  const bounds = layerBounds(scene.layers[0]);
  assert.ok(Math.abs(bounds.width - 42) < 0.0001);
  assert.ok(Math.abs(bounds.height - 82) < 0.0001);
  const svg = sceneSvg(scene);
  assert.match(svg, /<linearGradient/);
  assert.match(svg, /marker-end=/);
  assert.match(svg, /stroke-dasharray="6 3"/);
  assert.match(svg, /opacity="0.8"/);
  const image = new Resvg(svg).render();
  assert.equal(image.pixels[3], 0);
  assert.ok(image.pixels.some((channel, index) => index % 4 === 3 && channel > 0));
});

test('reorder is atomic with failures and preserves layer identity', () => {
  const first = path('M20 20L100 100');
  const second = { ...path('M40 20L140 100'), id: 'second' };
  const scene = composition([first, second]);
  const updated = applyOperations(scene, [{ op: 'reorder', id: first.id, index: 1 }]);
  assert.deepEqual(updated.layers.map((layer) => layer.id), ['second', 'curve']);
  assert.deepEqual(scene.layers.map((layer) => layer.id), ['curve', 'second']);
  assert.throws(() => applyOperations(scene, [
    { op: 'reorder', id: first.id, index: 1 }, { op: 'reorder', id: first.id, index: 50 },
  ]), /outside/);
  assert.deepEqual(scene.layers.map((layer) => layer.id), ['curve', 'second']);
});

test('vertical arrows follow connector tangents in portable raster exports', () => {
  const scene = composition([{ ...path('M100 50L100 200'), strokeWidth: 2, markerStart: 'arrow', markerEnd: 'arrow' }]);
  scene.background = 'transparent';
  const rendered = new Resvg(sceneSvg(scene)).render();
  const alpha = (x: number, y: number) => rendered.pixels[(y * rendered.width + x) * 4 + 3];
  assert.ok(alpha(102, 194) > 100, 'end arrow must point down along the path');
  assert.ok(alpha(102, 55) > 100, 'start arrow must point up against the path');
  assert.equal(alpha(94, 202), 0, 'end arrow must not point horizontally');
});

test('old scenes retain their schema defaults and SVG can use embedded text', () => {
  const scene = sceneSchema.parse({ name: 'Legacy', width: 200, height: 100, background: 'white', layers: [
    { id: 'title', name: 'Title', kind: 'text', x: 20, y: 40, text: 'Legacy scene', fontSize: 18, fontFamily: 'Arial', fill: 'black' },
  ] });
  assert.equal(scene.layers[0].visible, true);
  assert.equal(verifyScene(scene).passed, 8);
  assert.match(sceneSvg(scene), /font-family="Source Sans 3"/);
});

test('every bundled font lays out starter text without unsupported GSUB failures', () => {
  for (const scene of Object.values(examples)) {
    assert.doesNotThrow(() => verifyScene(scene));
    assert.doesNotThrow(() => sceneSvg(scene, { outlineText: true }));
  }
  for (const fontFamily of ['Source Sans 3', 'Barlow', 'Crimson Text', 'Courier Prime']) {
    const style = { fontFamily, fontSize: 24 };
    assert.ok(measureText('Orbital Mechanics', style) > 0);
    assert.equal(measureText('é', style), measureText('e\u0301', style));
    assert.ok(Math.abs(measureText('ABC', { ...style, letterSpacing: 2 }) - measureText('ABC', style) - 4) < 0.00001);
  }
});

test('unimplemented complex text shaping is reported instead of certified', () => {
  const scene = composition([{
    id: 'overbar', name: 'Combining mark', visible: true, kind: 'text', x: 20, y: 50,
    text: 'x\u0304', fontSize: 24, fill: '#000000', fontFamily: 'Source Sans 3',
  }]);
  const report = verifyScene(scene);
  assert.ok(report.issues.some((issue) => issue.severity === 'warning' && /text shaping/.test(issue.message)));
  assert.ok(report.passed < report.total);
});

test('outline serialization preserves finite coordinates near whole pixels', () => {
  for (const fontFamily of ['Source Sans 3', 'Barlow', 'Crimson Text', 'Courier Prime']) {
    for (const x of [0, 151.25000000000003, 958.927]) {
      const d = textOutline('Baseline factors and reproducible RNA-seq results', { fontFamily, fontSize: 13 }, x, 412.804)!;
      assert.ok(!d.includes('NaN'));
      assert.doesNotThrow(() => new SVGPathData(d));
    }
  }
});
