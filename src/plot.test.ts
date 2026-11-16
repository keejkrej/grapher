import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SVGPathData } from 'svg-pathdata';
import { composePlot } from './plot';
import { plotSchema, type PlotSpec } from './plot-schema';
import { layerBounds, verifyScene, type Layer, type Scene } from './engine';
import { portableSvg, renderPdf, renderPng, verifyArtifact } from './render';
import sharp from 'sharp';

const basic: PlotSpec = {
  kind: 'line', title: 'Observed response', xLabel: 'Time', xUnit: 's', yLabel: 'Response', yUnit: 'a.u.',
  xDomain: [0, 10], yDomain: [0, 100],
  series: [{ id: 'observed', name: 'Observed', points: [{ x: 0, y: 0 }, { x: 5, y: 50, yLow: 40, yHigh: 60 }, { x: 10, y: 100 }] }],
};

function layer<K extends Layer['kind']>(scene: Scene, id: string, kind: K): Extract<Layer, { kind: K }> {
  const found = scene.layers.find((item) => item.id === id);
  assert.equal(found?.kind, kind, id);
  return found as Extract<Layer, { kind: K }>;
}

function close(actual: number, expected: number) {
  assert.ok(Math.abs(actual - expected) < 0.001, `${actual} should equal ${expected}`);
}

test('finite numeric data, complete error intervals and honest domains are required', () => {
  const input = (point: unknown) => ({ ...basic, series: [{ id: 'one', name: 'One', points: [point] }] });
  for (const point of [{ x: NaN, y: 1 }, { x: 1, y: Infinity }, { x: 1, y: 2, yLow: 1 }, { x: 1, y: 2, yLow: 3, yHigh: 4 }]) {
    assert.equal(plotSchema.safeParse(input(point)).success, false);
  }
  assert.throws(() => composePlot({ ...basic, yDomain: [10, 90] }), /exclude/);
  assert.throws(() => composePlot({ ...basic, kind: 'bar', yDomain: [1, 101] }), /zero baseline/);
  assert.throws(() => composePlot({ ...basic, series: [...basic.series, ...basic.series] }), /Duplicate/);
  assert.throws(() => composePlot({ ...basic, kind: 'bar', series: [{ id: 'one', name: 'One', points: [{ x: 1, y: 1 }, { x: 1, y: 2 }] }] }), /more than one/);
});

test('line coordinates, units and error endpoints preserve observations without mutation', () => {
  const original = structuredClone(basic);
  const scene = composePlot(basic);
  assert.deepEqual(basic, original);
  const first = layer(scene, 'series-observed-point-0', 'ellipse');
  const middle = layer(scene, 'series-observed-point-1', 'ellipse');
  const last = layer(scene, 'series-observed-point-2', 'ellipse');
  close(middle.x, (first.x + last.x) / 2);
  close(middle.y, (first.y + last.y) / 2);
  const intervals = layer(scene, 'series-observed-intervals', 'path');
  const bounds = new SVGPathData(intervals.d).getBounds();
  close(bounds.minY, first.y + (last.y - first.y) * 0.6);
  close(bounds.maxY, first.y + (last.y - first.y) * 0.4);
  assert.equal(layer(scene, 'x-axis-title', 'text').text, 'Time (s)');
  assert.equal(layer(scene, 'y-axis-title', 'text').text, 'Response (a.u.)');
  assert.equal(verifyScene(scene).passed, 8);
  assert.equal(scene.provenance?.generator, 'plot');
  assert.deepEqual(scene.provenance?.input.series, original.series);
});

test('small differences around large baselines retain distinct accurate tick labels and source data', () => {
  const input: PlotSpec = {
    kind: 'scatter', title: 'Small observed differences', yDomain: [1e9, 1e9 + 1],
    series: [{ id: 'precise', name: 'Measurements', points: [{ x: 1e9, y: 1e9 + 0.25 }, { x: 1e9 + 1, y: 1e9 + 0.75 }] }],
  };
  const scene = composePlot(input);
  for (const prefix of ['x-tick-label-', 'y-tick-label-']) {
    const labels = scene.layers.filter((item) => item.id.startsWith(prefix)).map((item) => {
      assert.equal(item.kind, 'text');
      return (item as Extract<Layer, { kind: 'text' }>).text;
    });
    assert.ok(labels.length > 1);
    assert.equal(new Set(labels).size, labels.length);
    assert.ok(labels.every((label) => Number(label) >= 1e9 && Number(label) <= 1e9 + 1));
  }
  assert.match(layer(scene, 'series-precise-point-0', 'ellipse').name, /y=1000000000\.25/);
  assert.equal(scene.provenance?.generator, 'plot');
  if (scene.provenance?.generator === 'plot') assert.deepEqual(scene.provenance.input.series[0].points, input.series[0].points);
  assert.equal(verifyScene(scene).passed, 8);
});

test('grouped bars share a zero baseline and render zero observations honestly', () => {
  const scene = composePlot({
    kind: 'bar', title: 'Measured differences', yDomain: [-10, 10],
    series: [
      { id: 'a', name: 'A', points: [{ x: 1, y: 5, label: 'Control' }, { x: 2, y: -5, label: 'Treatment' }] },
      { id: 'b', name: 'B', points: [{ x: 1, y: 0, label: 'Control' }, { x: 2, y: 8, label: 'Treatment', yLow: 6, yHigh: 9 }] },
    ],
  });
  const positive = layer(scene, 'series-a-point-0', 'rect');
  const negative = layer(scene, 'series-a-point-1', 'rect');
  const zero = layer(scene, 'series-b-point-0', 'path');
  close(positive.y + positive.height, negative.y);
  close(new SVGPathData(zero.d).getBounds().minY, negative.y);
  close(positive.height, negative.height);
  assert.ok(layer(scene, 'series-b-point-1', 'rect').x > negative.x + negative.width);
  assert.ok(scene.layers.some((item) => item.kind === 'text' && item.text === 'Treatment'));
  assert.deepEqual(verifyScene(scene).issues, []);
});

test('constant and very small observations get finite useful domains', () => {
  for (const [x, y] of [[0, 0], [1e-9, 2e-12], [1e9, -3e8]]) {
    const scene = composePlot({ kind: 'scatter', title: 'Single observation', series: [{ id: 'single', name: 'Single', points: [{ x, y }] }] });
    assert.ok(scene.layers.every((item) => Object.values(layerBounds(item)).every(Number.isFinite)));
    assert.equal(verifyScene(scene).passed, 8);
  }
  assert.throws(() => composePlot({ kind: 'scatter', title: 'Overflow', series: [{ id: 's', name: 'S', points: [{ x: -1e308, y: 1 }, { x: 1e308, y: 2 }] }] }), /rescale/);
});

test('data limits and layout limits fail clearly before producing broken figures', () => {
  assert.throws(() => composePlot({ ...basic, series: [{ id: 'many', name: 'Many', points: Array.from({ length: 401 }, (_, x) => ({ x, y: x })) }] }));
  assert.throws(() => composePlot({ ...basic, width: 480, height: 360, title: 'A long title '.repeat(12), caption: 'A complete detailed caption '.repeat(40) }), /too small/);
  assert.throws(() => composePlot({ kind: 'bar', title: 'Conflict', series: [
    { id: 'a', name: 'A', points: [{ x: 1, y: 2, label: 'Control' }] },
    { id: 'b', name: 'B', points: [{ x: 1, y: 3, label: 'Treatment' }] },
  ] }), /Conflicting category/);
});

test('scientific figures preserve captions and sources in SVG, PNG and PDF', async () => {
  const scene = composePlot({ ...basic, caption: 'Observed values; intervals were supplied with the data.', source: 'Experiment 42, instrument export.' });
  assert.equal(layer(scene, 'plot-caption', 'text').text, 'Observed values; intervals were supplied with the data.');
  assert.equal(layer(scene, 'plot-source', 'text').text, 'Source: Experiment 42, instrument export.');
  assert.deepEqual((await verifyArtifact(scene)).issues, []);
  assert.ok(!portableSvg(scene, true).includes('<text'));
  const png = renderPng(scene, 2);
  const info = await sharp(png).metadata();
  assert.deepEqual([info.width, info.height], [2000, 1360]);
  assert.ok((await sharp(png).stats()).channels[0].stdev > 10);
  assert.equal((await renderPdf(scene)).subarray(0, 5).toString(), '%PDF-');
});
