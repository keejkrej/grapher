import assert from 'node:assert/strict';
import { createServer, request } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import sharp from 'sharp';
import { workspaceMiddleware } from './server.ts';

async function start(directory: string) {
  const middleware = workspaceMiddleware({ GRAPHER_DATA_DIR: directory });
  const server = createServer((req, res) => middleware(req, res, () => { res.writeHead(404); res.end(); }));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const origin = `http://127.0.0.1:${address.port}`;
  return {
    origin,
    get: (path: string) => fetch(origin + path),
    post: (path: string, body: unknown, headers = {}) => fetch(origin + path, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) }),
    close: async () => { await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); middleware.close(); },
  };
}

test('HTTP documents retain revisions across restart, reject conflicts and restore without destroying history', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'grapher-api-'));
  let app = await start(directory);
  try {
    const initial = await (await app.get('/api/scene')).json();
    const created = await (await app.post('/api/documents', { name: 'Experiment A' })).json();
    assert.ok(created.documentId);
    assert.notEqual(created.documentId, initial.documentId);
    const command = { action: 'apply', documentId: created.documentId, revision: 1, operations: [{ op: 'canvas', name: 'Experiment B' }] };
    const updates = await Promise.all([app.post('/api/scene', command), app.post('/api/scene', command)]);
    assert.deepEqual(updates.map((response) => response.status).sort(), [200, 409]);
    assert.equal((await (await app.get('/api/scene')).json()).revision, initial.revision);
    await app.close();
    app = await start(directory);
    const restoredState = await (await app.get(`/api/scene?documentId=${created.documentId}`)).json();
    assert.equal(restoredState.scene.name, 'Experiment B');
    assert.equal(restoredState.revision, 2);
    assert.equal(restoredState.workspaceId, initial.workspaceId);
    const restored = await app.post('/api/restore', { documentId: created.documentId, targetRevision: 1, revision: 2 });
    assert.equal(restored.status, 200);
    const body = await restored.json();
    assert.equal(body.revision, 3);
    assert.equal(body.scene.name, 'Experiment A');
    const history = await (await app.get(`/api/history?documentId=${created.documentId}`)).json();
    assert.deepEqual(history.entries.map((entry: { revision: number }) => entry.revision), [3, 2, 1]);
  } finally { await app.close(); await rm(directory, { recursive: true, force: true }); }
});

test('API composes editable diagrams, pins exports and atomically rejects broken assets', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'grapher-api-'));
  const app = await start(directory);
  try {
    const response = await app.post('/api/diagram', { create: true, spec: { title: 'Signal flow', nodes: [{ id: 'input', label: 'Input α' }, { id: 'output', label: 'Output β' }], edges: [{ from: 'input', to: 'output', label: 'transform' }] } });
    assert.equal(response.status, 200, await response.clone().text());
    const state = await response.json();
    assert.equal(state.report.passed, state.report.total);
    assert.ok(state.scene.layers.some((layer: { kind: string }) => layer.kind === 'text'));
    const query = `documentId=${state.documentId}&revision=${state.revision}`;
    const png = await app.get(`/api/export?format=png&scale=2&${query}`);
    assert.equal(png.status, 200);
    assert.equal(png.headers.get('x-grapher-document'), state.documentId);
    const raster = await sharp(Buffer.from(await png.arrayBuffer())).metadata();
    assert.equal(raster.width, state.scene.width * 2);
    const pdf = await app.get(`/api/export?format=pdf&${query}`);
    assert.equal(pdf.headers.get('content-type'), 'application/pdf');
    assert.equal(Buffer.from(await pdf.arrayBuffer()).subarray(0, 5).toString(), '%PDF-');
    assert.equal((await app.get(`/api/export?format=png&documentId=${state.documentId}&revision=999`)).status, 409);
    assert.equal((await app.get(`/api/export?format=png&scale=9&${query}`)).status, 400);
    const invalid = await app.post('/api/scene', { action: 'apply', documentId: state.documentId, revision: state.revision, operations: [{ op: 'add', layer: { id: 'bad', name: 'Malformed path', kind: 'path', visible: true, d: 'M20 20 L', fill: 'none', stroke: '#000000', bounds: { x: 0, y: 0, width: 40, height: 40 } } }] });
    assert.equal(invalid.status, 422);
    assert.equal((await (await app.get(`/api/scene?documentId=${state.documentId}`)).json()).revision, state.revision);
    assert.equal((await app.post('/api/documents', { name: 'Cross origin' }, { Origin: 'https://unrelated.example' })).status, 403);
    const reboundStatus = await new Promise<number | undefined>((resolve, reject) => {
      const req = request(`${app.origin}/api/documents`, { method: 'POST', headers: {
        Host: 'attacker.example', Origin: 'http://attacker.example', 'Content-Type': 'application/json',
      } }, (res) => { res.resume(); res.on('end', () => resolve(res.statusCode)); });
      req.on('error', reject);
      req.end(JSON.stringify({ name: 'Rebinding attempt' }));
    });
    assert.equal(reboundStatus, 403);
    const capabilities = await (await app.get('/api/capabilities')).json();
    assert.ok(capabilities.diagramSchema && capabilities.formats.includes('pdf'));
  } finally { await app.close(); await rm(directory, { recursive: true, force: true }); }
});

test('scientific plot API retains supplied values, exports vector PDF and rejects clipped data', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'grapher-plot-api-'));
  const app = await start(directory);
  try {
    const spec = { kind: 'scatter', title: 'Supplied observations', xLabel: 'Time', xUnit: 'h',
      series: [{ id: 'sample', name: 'Observed', points: [{ x: 1, y: 3, yLow: 2, yHigh: 4 }, { x: 2, y: 5 }] }] };
    const response = await app.post('/api/plot', { create: true, spec });
    assert.equal(response.status, 200, await response.clone().text());
    const state = await response.json();
    assert.equal(state.report.passed, state.report.total, JSON.stringify(state.report.issues));
    const pdf = await app.get(`/api/export?format=pdf&documentId=${state.documentId}&revision=1`);
    assert.equal(pdf.status, 200, await pdf.clone().text());
    const rejected = await app.post('/api/plot', { spec: { ...spec, yDomain: [0, 2] }, documentId: state.documentId, revision: 1 });
    assert.equal(rejected.status, 400);
    assert.equal((await (await app.get(`/api/scene?documentId=${state.documentId}`)).json()).revision, 1);
    const sample = await app.post('/api/documents', { template: 'response-curve' });
    assert.equal(sample.status, 201, await sample.clone().text());
    const primitive = await app.post('/api/documents', { scene: { name: 'Composited mesh', width: 400, height: 300, background: '#FFFFFF',
      layers: [{ id: 'mesh', name: 'Transparent mesh', kind: 'mesh', visible: true, opacity: 0.5, x: 100, y: 100, width: 100, height: 100, color: '#336699', shape: 'cube', rotation: 15 }] } });
    assert.equal(primitive.status, 201);
    const mesh = await primitive.json();
    const glb = await app.get(`/api/export?format=glb&documentId=${mesh.documentId}&revision=1`);
    assert.equal(glb.status, 422, 'Unsupported 2D compositing must not silently disappear in GLB');
  } finally { await app.close(); await rm(directory, { recursive: true, force: true }); }
});
