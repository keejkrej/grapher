import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { test, type TestContext } from 'node:test';
import { chatSelectionContext, chatSelectionPrompt, selectedLayerIdsSchema } from './chat-context.ts';
import { workspaceMiddleware } from './server.ts';
import type { Scene } from './engine.ts';

const scene = (name: string, id: string, x = 40): Scene => ({
  name, width: 400, height: 300, background: '#FFFFFF',
  layers: [{ id, name: `${name} panel`, kind: 'rect', visible: true, x, y: 40, width: 240, height: 160, fill: '#DDE9EC' }],
});

async function fixture(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'grapher-selection-'));
  const middleware = workspaceMiddleware({ GRAPHER_DATA_DIR: directory });
  const server = createServer((req, res) => middleware(req, res, () => { res.writeHead(404); res.end(); }));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    middleware.close();
    assert.ok(directory.startsWith(resolve(tmpdir()) + sep + 'grapher-selection-'));
    await rm(directory, { recursive: true, force: true });
  });
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const origin = `http://127.0.0.1:${address.port}`;
  return {
    get: async (path: string) => (await fetch(origin + path)).json(),
    post: (path: string, body: unknown) => fetch(origin + path, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    }),
  };
}

test('selection context snapshots layer identity and names from the target document', () => {
  const target = { documentId: 'document-b', revision: 4, updatedAt: '2026-11-16', scene: scene('Document B', 'shared-id') };
  const context = chatSelectionContext(target, ['shared-id', 'shared-id']);
  assert.deepEqual(context, {
    documentId: 'document-b', revision: 4, selectedLayerIds: ['shared-id'],
    selectedLayers: [{ id: 'shared-id', name: 'Document B panel', kind: 'rect' }],
  });
  target.scene.layers[0].name = 'Later edit';
  assert.equal(context.selectedLayers[0].name, 'Document B panel');
  assert.ok(chatSelectionPrompt(context).includes(JSON.stringify(context)));
  assert.throws(() => chatSelectionContext(target, ['foreign-id']), /not present in this document: foreign-id/);
  assert.deepEqual(selectedLayerIdsSchema.parse(undefined), []);
  assert.equal(selectedLayerIdsSchema.safeParse(Array(751).fill('shared-id')).success, false);
});

test('chat rejects selections from another document and missing layers before any mutation', async (t) => {
  const app = await fixture(t);
  const first = await (await app.post('/api/documents', { scene: scene('Document A', 'only-a') })).json();
  const second = await (await app.post('/api/documents', { scene: scene('Document B', 'only-b', -20) })).json();
  const initial = await app.get('/api/scene');
  const messages = [{ role: 'user', parts: [{ type: 'text', text: 'repair' }] }];
  for (const id of ['only-a', 'does-not-exist']) {
    const response = await app.post('/api/chat', { documentId: second.documentId, selectedLayerIds: [id], messages });
    assert.equal(response.status, 400);
    assert.match((await response.json()).error, new RegExp(`Selected layers are not present in this document: ${id}`));
  }
  assert.equal((await app.get(`/api/scene?documentId=${first.documentId}`)).revision, first.revision);
  assert.equal((await app.get(`/api/scene?documentId=${second.documentId}`)).revision, second.revision);
  assert.equal((await app.get('/api/scene')).revision, initial.revision);

  const valid = await app.post('/api/chat', { documentId: second.documentId, revision: second.revision, selectedLayerIds: ['only-b'], messages });
  assert.equal(valid.status, 200);
  assert.match(valid.headers.get('content-type') || '', /text\/event-stream/);
  await valid.text();
  const updated = await app.get(`/api/scene?documentId=${second.documentId}`);
  assert.equal(updated.revision, second.revision + 1);
  assert.equal(updated.scene.name, 'Document B');
  assert.ok(updated.scene.layers[0].x >= 0);
  assert.equal((await app.get(`/api/scene?documentId=${first.documentId}`)).revision, first.revision);
  assert.equal((await app.get('/api/scene')).revision, initial.revision);
});

test('chat validates the selection input and accepts omitted selection for existing callers', async (t) => {
  const app = await fixture(t);
  const messages = [{ role: 'user', parts: [{ type: 'text', text: 'verify' }] }];
  for (const selectedLayerIds of ['layer-id', [17], [''], Array(751).fill('id')]) {
    const response = await app.post('/api/chat', { selectedLayerIds, messages });
    assert.equal(response.status, 400);
    assert.match((await response.json()).error, /selectedLayerIds/);
  }
  const response = await app.post('/api/chat', { messages });
  assert.equal(response.status, 200);
  await response.text();
});
