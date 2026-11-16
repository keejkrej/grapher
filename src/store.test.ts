import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test, type TestContext } from 'node:test';
import { promisify } from 'node:util';
import { sceneSchema, type Scene } from './engine.ts';
import { createStore, StoreError, type DocumentStore } from './store.ts';

const initialScene: Scene = {
  name: 'Saved figure',
  width: 640,
  height: 480,
  background: '#ffffff',
  layers: [{ id: 'box', name: 'Box', visible: true, kind: 'rect', x: 40, y: 40, width: 100, height: 80, fill: '#aa6622' }],
};

function workspace(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'grapher-store-'));
  const path = join(directory, 'workspace.sqlite');
  const stores: DocumentStore[] = [];
  t.after(() => {
    for (const store of stores) store.close();
    assert.equal(dirname(resolve(directory)), resolve(tmpdir()));
    assert.ok(basename(directory).startsWith('grapher-store-'));
    rmSync(directory, { recursive: true, force: true });
  });
  return {
    path,
    open(seed = initialScene) {
      const store = createStore({ path, initialScene: seed });
      stores.push(store);
      return store;
    },
  };
}

function status(expected: number) {
  return (error: unknown) => error instanceof StoreError && error.status === expected;
}

test('documents, workspace identity and history survive reopening without reseeding', (t) => {
  const fixture = workspace(t);
  const first = fixture.open();
  const identity = { workspaceId: first.workspaceId, documentId: first.defaultDocumentId };
  const edited = first.update(identity.documentId, 1, (scene) => ({ ...scene, name: 'Revised figure' }), 'Renamed figure');
  const additional = first.create({ ...initialScene, name: 'Companion figure' });
  first.close();

  const reopened = fixture.open({ ...initialScene, name: 'Changed seed' });
  assert.equal(reopened.workspaceId, identity.workspaceId);
  assert.equal(reopened.defaultDocumentId, identity.documentId);
  assert.deepEqual(reopened.get(), edited);
  assert.deepEqual(reopened.get(additional.documentId), additional);
  assert.equal(reopened.list().length, 2);
  assert.deepEqual(reopened.history(identity.documentId).map(({ revision, summary }) => ({ revision, summary })), [
    { revision: 2, summary: 'Renamed figure' },
    { revision: 1, summary: 'Created workspace' },
  ]);
});

test('independent connections reject stale revisions before running the change callback', (t) => {
  const fixture = workspace(t);
  const first = fixture.open();
  const second = fixture.open();
  const observed = second.get();
  first.update(observed.documentId, observed.revision, (scene) => ({ ...scene, name: 'First writer' }));
  let callbackRan = false;
  assert.throws(() => second.update(observed.documentId, observed.revision, (scene) => {
    callbackRan = true;
    return { ...scene, name: 'Stale writer' };
  }), status(409));
  assert.equal(callbackRan, false);
  assert.equal(second.get().scene.name, 'First writer');
  assert.equal(second.get().revision, 2);
  assert.equal(second.history(observed.documentId).length, 2);
});

test('concurrent processes serialize edits and commit one version for an expected revision', async (t) => {
  const fixture = workspace(t);
  const store = fixture.open();
  const documentId = store.defaultDocumentId;
  const script = `
    import { createStore, StoreError } from ${JSON.stringify(new URL('./store.ts', import.meta.url).href)};
    const [path, documentId, name] = process.argv.slice(1);
    const store = createStore({ path, initialScene: ${JSON.stringify(initialScene)} });
    try {
      const result = store.update(documentId, 1, (scene) => {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 150);
        return { ...scene, name };
      });
      process.stdout.write(JSON.stringify({ status: 200, revision: result.revision, name }));
    } catch (error) {
      if (!(error instanceof StoreError)) throw error;
      process.stdout.write(JSON.stringify({ status: error.status }));
    } finally {
      store.close();
    }
  `;
  const execute = promisify(execFile);
  const results = await Promise.all(['Process A', 'Process B'].map(async (name) => {
    const { stdout } = await execute(process.execPath, [
      '--import', 'tsx', '--input-type=module', '-e', script, fixture.path, documentId, name,
    ]);
    return JSON.parse(stdout) as { status: number; revision?: number; name?: string };
  }));
  assert.deepEqual(results.map((result) => result.status).sort(), [200, 409]);
  const winner = results.find((result) => result.status === 200)!;
  assert.equal(store.get().scene.name, winner.name);
  assert.equal(store.get().revision, 2);
  assert.equal(store.history(documentId).length, 2);
});

test('failed and schema-invalid updates roll back both document and history', (t) => {
  const store = workspace(t).open();
  const before = store.get();
  assert.throws(() => store.update(before.documentId, 1, (scene) => {
    scene.layers[0].name = 'Mutated before failure';
    throw new Error('Edit failed');
  }), /Edit failed/);
  assert.throws(() => store.update(before.documentId, 1, (scene) => ({
    ...scene,
    layers: [{ ...scene.layers[0], kind: 'unsupported' }],
  } as unknown as Scene)));
  assert.deepEqual(store.get(), before);
  assert.equal(store.history(before.documentId).length, 1);

  const succeeded = store.update(before.documentId, 1, (scene) => ({ ...scene, name: 'After rollback' }));
  assert.equal(succeeded.revision, 2);
});

test('restoring an old revision appends a new revision containing that scene', (t) => {
  const store = workspace(t).open();
  const original = store.get();
  store.update(original.documentId, 1, (scene) => ({ ...scene, name: 'Second', layers: [] }));
  store.update(original.documentId, 2, (scene) => ({ ...scene, name: 'Third' }));
  const restored = store.restore(original.documentId, 1, 3);
  assert.equal(restored.revision, 4);
  assert.deepEqual(restored.scene, original.scene);
  assert.deepEqual(store.history(original.documentId).map((entry) => entry.revision), [4, 3, 2, 1]);
  assert.equal(store.history(original.documentId)[0].summary, 'Restored revision 1');
  const replay = store.restore(original.documentId, 2, 4);
  assert.equal(replay.revision, 5);
  assert.equal(replay.scene.name, 'Second');
  assert.deepEqual(replay.scene.layers, []);
});

test('no-op edits and restores retain the existing revision and timestamp', (t) => {
  const store = workspace(t).open();
  const original = store.get();
  assert.deepEqual(store.update(original.documentId, 1, (scene) => ({ ...scene })), original);
  assert.deepEqual(store.restore(original.documentId, 1, 1), original);
  assert.equal(store.history(original.documentId).length, 1);
});

test('missing documents, missing revisions and invalid identifiers are rejected without writes', (t) => {
  const store = workspace(t).open();
  const existing = store.defaultDocumentId;
  const missing = randomUUID();
  assert.throws(() => store.get(missing), status(404));
  assert.throws(() => store.history(missing), status(404));
  assert.throws(() => store.update(missing, 1, (scene) => scene), status(404));
  assert.throws(() => store.restore(existing, 99, 1), status(404));
  assert.throws(() => store.get("' OR 1=1 --"), status(400));
  assert.throws(() => store.update(existing, 0, (scene) => scene), status(400));
  assert.throws(() => store.restore(existing, 1.5, 1), status(400));
  assert.equal(store.list().length, 1);
  assert.equal(store.history(existing).length, 1);
});

test('legacy scene input receives schema defaults and stored scenes are validated when read', (t) => {
  const fixture = workspace(t);
  const store = fixture.open();
  const legacy = structuredClone(initialScene);
  delete (legacy.layers[0] as Partial<typeof legacy.layers[number]>).visible;
  const imported = store.create(legacy);
  assert.equal(imported.scene.layers[0].visible, true);
  assert.deepEqual(imported.scene, sceneSchema.parse(legacy));

  const raw = new DatabaseSync(fixture.path);
  try {
    raw.prepare('UPDATE documents SET scene = ? WHERE id = ?').run('{"name":"Incomplete"}', imported.documentId);
  } finally {
    raw.close();
  }
  assert.throws(() => store.get(imported.documentId), status(500));
});

test('opening an unsupported database version fails without modifying existing contents', (t) => {
  const fixture = workspace(t);
  const first = fixture.open();
  const identity = first.defaultDocumentId;
  first.close();
  const raw = new DatabaseSync(fixture.path);
  try {
    raw.exec('PRAGMA user_version = 99');
    assert.throws(() => fixture.open(), status(500));
    assert.equal(raw.prepare('PRAGMA user_version').get()?.user_version, 99);
    assert.equal(raw.prepare('SELECT id FROM documents').get()?.id, identity);
  } finally {
    raw.close();
  }
});
