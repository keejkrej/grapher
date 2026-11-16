import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test, { before } from 'node:test';
import { composeDiagram, diagramSchema } from './diagram';
import { layerBounds, sceneSchema, verifyScene } from './engine';
import { figureExamples } from './figure-examples';
import { registerFont } from './typography';

before(async () => {
  for (const [variant, weight] of [['Regular', 400], ['Bold', 700]] as const) {
    const bytes = await readFile(new URL(`../public/fonts/SourceSans3-${variant}.otf`, import.meta.url));
    registerFont('Source Sans 3', bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), weight);
  }
});

test('diagram rejects missing endpoints and duplicate node and edge identities', () => {
  const nodes = [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }];
  assert.equal(diagramSchema.safeParse({ nodes, edges: [{ from: 'a', to: 'missing' }] }).success, false);
  assert.equal(diagramSchema.safeParse({ nodes: [nodes[0], nodes[0]] }).success, false);
  assert.equal(diagramSchema.safeParse({ nodes, edges: [{ id: 'same', from: 'a', to: 'b' }, { id: 'same', from: 'b', to: 'a' }] }).success, false);
  assert.equal(diagramSchema.safeParse({ nodes, edges: [{ from: 'a', to: 'b' }, { id: 'auto-1', from: 'b', to: 'a' }] }).success, false);
});

test('diagram layout keeps node text inside shapes and produces reproducible scenes', async () => {
  const specification = {
    title: 'A reproducible analysis',
    nodes: [
      { id: 'source', label: 'Observation with a long descriptive label', description: 'A description wraps to several lines without escaping the node.', width: 180 },
      { id: 'decision', label: 'Quality accepted?', shape: 'diamond' as const },
      { id: 'result', label: 'Result', shape: 'ellipse' as const },
      { id: 'isolated', label: 'Independent measurement' },
    ],
    edges: [{ from: 'source', to: 'decision', label: 'Measured evidence' }, { from: 'decision', to: 'result', label: 'Accepted' }],
  };
  const scene = await composeDiagram(specification);
  assert.deepEqual(await composeDiagram(specification), scene);
  assert.equal(sceneSchema.safeParse(scene).success, true);
  assert.ok(scene.layers.some((layer) => layer.kind === 'path' && layer.markerEnd === 'arrow'));
  const source = layerBounds(scene.layers.find((layer) => layer.id === 'node-source-body')!);
  for (const layer of scene.layers.filter((layer) => layer.id.startsWith('node-source-') && layer.kind === 'text')) {
    const bounds = layerBounds(layer);
    assert.ok(bounds.x >= source.x && bounds.x + bounds.width <= source.x + source.width);
    assert.ok(bounds.y >= source.y && bounds.y + bounds.height <= source.y + source.height);
  }
  assert.deepEqual(verifyScene(scene).issues.filter((issue) => ['bounds', 'geometry', 'unique'].includes(issue.checkId)), []);
});

test('compiled sample figures retain editable nodes and routed edge labels', async () => {
  for (const specification of Object.values(figureExamples)) {
    const scene = await composeDiagram(specification);
    assert.equal(scene.name, specification.title);
    assert.equal(scene.layers.filter((layer) => /^node-.+-body$/.test(layer.id)).length, specification.nodes.length);
    assert.equal(scene.layers.filter((layer) => /^edge-.+-0$/.test(layer.id) && layer.kind === 'path').length, specification.edges.length);
    assert.deepEqual(verifyScene(scene).issues.filter((issue) => ['bounds', 'geometry', 'unique'].includes(issue.checkId)), []);
    const nodeBounds = specification.nodes.map((node) => ({ id: node.id, bounds: layerBounds(scene.layers.find((layer) => layer.id === `node-${node.id}-body`)!) }));
    for (const [index, edge] of specification.edges.entries()) {
      const path = scene.layers.find((layer) => layer.id === `edge-auto-${index + 1}-0`)!;
      assert.equal(path.kind, 'path');
      if (path.kind !== 'path') continue;
      const commands = path.d.split(' ');
      const points = Array.from({ length: commands.length / 3 }, (_, position) => ({ x: Number(commands[position * 3 + 1]), y: Number(commands[position * 3 + 2]) }));
      for (const [nodeId, point] of [[edge.from, points[0]], [edge.to, points.at(-1)!]] as const) {
        const node = scene.layers.find((layer) => layer.id === `node-${nodeId}-body`)!;
        if (node.kind === 'ellipse') {
          assert.ok(Math.abs(((point.x - node.x) / node.rx) ** 2 + ((point.y - node.y) / node.ry) ** 2 - 1) < 0.00001, 'ellipse connectors meet the curved outline');
        } else if (node.kind === 'path') {
          const { x, y, width, height } = node.bounds;
          assert.ok(Math.abs(Math.abs((point.x - x - width / 2) / (width / 2)) + Math.abs((point.y - y - height / 2) / (height / 2)) - 1) < 0.00001, 'diamond connectors meet the sloping outline');
        }
      }
      for (let position = 1; position < points.length; position += 1) {
        const start = points[position - 1];
        const end = points[position];
        assert.ok(start.x === end.x || start.y === end.y, 'every connector segment is orthogonal');
        for (const { id, bounds } of nodeBounds.filter((node) => node.id !== edge.from && node.id !== edge.to)) {
          const intersects = Math.min(start.x, end.x) < bounds.x + bounds.width && Math.max(start.x, end.x) > bounds.x
            && Math.min(start.y, end.y) < bounds.y + bounds.height && Math.max(start.y, end.y) > bounds.y;
          assert.equal(intersects, false, `${edge.from} → ${edge.to} must not cross node ${id}`);
        }
      }
    }
  }
});

test('parallel edges, cycles and self loops retain distinct editable routes', async () => {
  const scene = await composeDiagram({
    direction: 'DOWN',
    nodes: [{ id: 'a', label: 'α — observation' }, { id: 'b', label: 'β — feedback', shape: 'ellipse' }],
    edges: [
      { id: 'a', from: 'a', to: 'b', label: 'Forward pathway' },
      { id: 'parallel', from: 'a', to: 'b', label: 'Second pathway' },
      { id: 'reverse', from: 'b', to: 'a', label: 'Feedback', dashed: true },
      { id: 'loop', from: 'b', to: 'b', label: 'Internal update' },
    ],
  });
  const routes = scene.layers.filter((layer) => layer.kind === 'path' && layer.id.startsWith('edge-'));
  assert.equal(routes.length, 4);
  assert.notEqual(routes[0].kind === 'path' && routes[0].d, routes[1].kind === 'path' && routes[1].d);
  assert.deepEqual(verifyScene(scene).issues.filter((issue) => ['bounds', 'geometry', 'unique'].includes(issue.checkId)), []);
});

test('custom medium-tone fills retain readable label contrast', async () => {
  const scene = await composeDiagram({ nodes: [{ id: 'custom', label: 'Measured evidence', description: 'Labels remain readable on custom fills.', fill: '#777777' }] });
  assert.deepEqual(verifyScene(scene).issues.filter((issue) => issue.checkId === 'contrast'), []);
});
