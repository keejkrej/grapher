import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { createServer } from 'vite';

test('the actual dev server serves JSON APIs before and after a config restart', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'grapher-dev-'));
  const previousDirectory = process.env.GRAPHER_DATA_DIR;
  process.env.GRAPHER_DATA_DIR = join(directory, 'data');
  const server = await createServer({
    configFile: resolve('vite.config.ts'),
    server: { host: '127.0.0.1', port: 0, strictPort: false },
    cacheDir: join(directory, 'cache'),
    logLevel: 'silent',
  });
  try {
    await server.listen();
    async function documents() {
      const url = server.resolvedUrls?.local[0];
      assert.ok(url);
      const response = await fetch(new URL('/api/documents', url));
      assert.equal(response.status, 200);
      assert.match(response.headers.get('content-type') || '', /application\/json/, 'The API must not fall through to the HTML application page');
      return response.json();
    }
    const before = await documents();
    assert.ok(before.defaultDocumentId);
    await server.restart();
    const after = await documents();
    assert.equal(after.defaultDocumentId, before.defaultDocumentId);
    assert.equal(after.documents.length, before.documents.length);
  } finally {
    await server.close();
    if (previousDirectory === undefined) delete process.env.GRAPHER_DATA_DIR;
    else process.env.GRAPHER_DATA_DIR = previousDirectory;
    await rm(directory, { recursive: true, force: true });
  }
});
