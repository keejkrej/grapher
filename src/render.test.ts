import assert from 'node:assert/strict';
import { test } from 'node:test';
import sharp from 'sharp';
import { portableSvg, renderPdf, renderPng, verifyArtifact } from './render.ts';
import type { Scene } from './engine.ts';
import { composeDiagram } from './diagram.ts';
import { figureExamples } from './figure-examples.ts';

const figure: Scene = {
  name: 'Measured result', width: 400, height: 240, background: '#FFFFFF',
  layers: [
    { id: 'box', name: 'Panel', kind: 'rect', visible: true, x: 20, y: 20, width: 360, height: 200, fill: '#EDF5F4', stroke: '#456F68', strokeWidth: 2, rx: 12 },
    { id: 'text', name: 'Result', kind: 'text', visible: true, x: 40, y: 90, text: 'α = 0.05 · β = 0.20', fontSize: 24, fill: '#163B34', fontFamily: 'Source Sans 3' },
  ],
};

test('portable vector, high-resolution raster and PDF preserve real figure content', async () => {
  const report = await verifyArtifact(figure);
  assert.equal(report.passed, report.total, JSON.stringify(report.issues));
  assert.match(portableSvg(figure), /@font-face.*data:font\/otf;base64,/);
  const outlined = portableSvg(figure, true);
  assert.ok(!outlined.includes('<text'));
  assert.match(outlined, /aria-label="α = 0.05/);
  const png = renderPng(figure, 2);
  const { width, height } = await sharp(png).metadata();
  assert.deepEqual([width, height], [800, 480]);
  const stats = await sharp(png).stats();
  assert.ok(stats.channels[0].stdev > 10, 'PNG must contain more than a blank surface');
  const pdf = await renderPdf(figure);
  assert.equal(pdf.subarray(0, 5).toString(), '%PDF-');
  assert.match(pdf.toString('latin1'), /\/MediaBox \[0 0 300 180\]/);
});

test('decoding catches corrupt raster containers and unsupported glyphs remain actionable', async () => {
  const corrupt = Buffer.alloc(128);
  corrupt[0] = 255; corrupt[1] = 216; corrupt[126] = 255; corrupt[127] = 217;
  const image: Scene = { ...figure, layers: [{ id: 'bad', name: 'Damaged photograph', kind: 'raster', visible: true, x: 0, y: 0, width: 100, height: 100, src: `data:image/jpeg;base64,${corrupt.toString('base64')}` }] };
  assert.equal((await verifyArtifact(image)).checks.find((check) => check.id === 'decode')?.status, 'fail');
  const unsupported: Scene = { ...figure, layers: [{ id: 'glyph', name: 'Missing glyph', kind: 'text', visible: true, x: 30, y: 80, text: '🧬', fontSize: 24, fill: '#111111' }] };
  const result = await verifyArtifact(unsupported);
  assert.equal(result.checks.find((check) => check.id === 'fonts')?.status, 'fail');
  assert.ok(result.issues.some((issue) => issue.layerId === 'glyph' && issue.message.includes('🧬')));
});

test('scientific diagram samples export to PDF without structural or rendering errors', async () => {
  for (const spec of Object.values(figureExamples)) {
    const scene = await composeDiagram(spec);
    const report = await verifyArtifact(scene);
    // Contrast over a diamond path needs visual review; it must stay an honest warning.
    assert.deepEqual(report.issues.filter((issue) => issue.severity === 'error'), [], scene.name);
    assert.equal(report.checks.find((check) => check.id === 'render')?.status, 'pass');
    assert.equal((await renderPdf(scene)).subarray(0, 5).toString(), '%PDF-');
    assert.throws(() => renderPng(scene, 5), /scale/);
  }
});

test('fully transparent content does not fail visible artifact preflight', async () => {
  const scene: Scene = { ...figure, layers: [...figure.layers,
    { id: 'hidden', name: 'Hidden draft', kind: 'text', visible: true, opacity: 0, x: 20, y: 30, text: '🧬', fontSize: 24, fill: '#000000' },
  ] };
  const report = await verifyArtifact(scene);
  assert.equal(report.passed, report.total, JSON.stringify(report.issues));
  assert.equal((await renderPdf(scene)).subarray(0, 5).toString(), '%PDF-');
});
