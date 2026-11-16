import assert from 'node:assert/strict';
import { createServer, type RequestListener } from 'node:http';
import { test, type TestContext } from 'node:test';
import { diagramInput, plotInput, workspaceClient, type ExportFormat } from './workspace-client.ts';

async function fixture(t: TestContext, handler: RequestListener) {
  const server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  return workspaceClient(`http://127.0.0.1:${address.port}`);
}

test('all JSON API operations explain an HTML index fallback instead of throwing a JSON syntax error', async (t) => {
  const client = await fixture(t, (_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end('<!doctype html><html><body><div id="root"></div></body></html>');
  });
  const calls = [
    () => client.inspect(), () => client.documents(), () => client.history(), () => client.capabilities(),
    () => client.create({ name: 'Untitled' }), () => client.restore(1),
    () => client.edit({ action: 'repair' }),
    () => client.compose(diagramInput.parse({ spec: { nodes: [{ id: 'n', label: 'Node' }] } })),
    () => client.plot(plotInput.parse({ spec: { kind: 'line', title: 'Result', series: [{ id: 's', name: 'Series', points: [{ x: 1, y: 2 }] }] } })),
  ];
  for (const call of calls) {
    await assert.rejects(call, /workspace API is unavailable.*returned HTML.*Restart the Grapher workspace server/);
  }
  for (const format of ['svg', 'png', 'pdf', 'glb', 'json'] as const) {
    await assert.rejects(() => client.export(format), /workspace API is unavailable.*returned HTML/);
  }
});

test('JSON responses require the proper media type and report malformed bodies clearly', async (t) => {
  const cases = [
    { type: 'text/plain', body: '{}', error: /returned text\/plain instead of JSON/ },
    { type: undefined, body: '{}', error: /returned no Content-Type instead of JSON/ },
    { type: 'application/json', body: '{"scene":', error: /API returned invalid JSON for \/api\/scene.*Restart/ },
    { type: 'application/json', body: '<!DOCTYPE html><html></html>', error: /API is unavailable.*returned HTML instead of JSON/ },
  ];
  for (const value of cases) {
    const client = await fixture(t, (_req, res) => {
      res.writeHead(200, value.type ? { 'content-type': value.type } : {});
      res.end(value.body);
    });
    await assert.rejects(() => client.inspect(), value.error);
  }
});

test('JSON error responses preserve the API status and actionable error message', async (t) => {
  const client = await fixture(t, (_req, res) => {
    res.writeHead(400, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'Document ID must be a UUID.' }));
  });
  await assert.rejects(() => client.inspect(), /^Error: Grapher responded with HTTP 400: Document ID must be a UUID\.$/);
  await assert.rejects(() => client.export('png'), /HTTP 400: Document ID must be a UUID/);
});

test('valid JSON responses and binary exports retain their content and headers', async (t) => {
  const exports: Record<ExportFormat, { type: string; data: Buffer }> = {
    png: { type: 'image/png', data: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64') },
    pdf: { type: 'application/pdf', data: Buffer.from('%PDF-1.7\nfixture\n%%EOF') },
    glb: { type: 'model/gltf-binary', data: Buffer.from([0x67, 0x6c, 0x54, 0x46, 2, 0, 0, 0]) },
    svg: { type: 'image/svg+xml', data: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>') },
    json: { type: 'application/json', data: Buffer.from('{"name":"Saved figure"}') },
  };
  const client = await fixture(t, (req, res) => {
    const url = new URL(req.url!, 'http://localhost');
    if (url.pathname === '/api/export') {
      const output = exports[url.searchParams.get('format') as ExportFormat];
      res.writeHead(200, { 'content-type': output.type, 'x-grapher-revision': '7' });
      return res.end(output.data);
    }
    res.writeHead(200, { 'content-type': 'APPLICATION/JSON; charset=utf-8' });
    res.end(JSON.stringify({ version: 1, formats: Object.keys(exports) }));
  });
  assert.deepEqual(await client.capabilities(), { version: 1, formats: Object.keys(exports) });
  for (const format of Object.keys(exports) as ExportFormat[]) {
    const response = await client.export(format);
    assert.equal(response.headers.get('x-grapher-revision'), '7');
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), exports[format].data);
  }
});
