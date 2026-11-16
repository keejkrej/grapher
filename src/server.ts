import type { IncomingMessage, ServerResponse } from 'node:http';
import { Buffer } from 'node:buffer';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { Document, NodeIO } from '@gltf-transform/core';
import {
  createGateway, createUIMessageStream, createUIMessageStreamResponse, stepCountIs, streamText, tool,
} from 'ai';
import { Color, Euler, Quaternion } from 'three';
import { z } from 'zod';
import { applyOperations, operationLimit, operationSchema, repairScene, sceneSchema, sceneSvg, verifyScene } from './engine.ts';
import { examples, initialExample } from './examples.ts';
import { makeGeometry, meshScale } from './geometry.ts';
import type { Scene } from './engine.ts';
import { createStore, StoreError, type DocumentSnapshot } from './store.ts';
import { portableSvg, renderPdf, renderPng, verifyArtifact } from './render.ts';
import { composeDiagram } from './diagram.ts';
import { composePlot } from './plot.ts';
import { figureExamples } from './figure-examples.ts';
import { plotExamples } from './plot-examples.ts';
import { fontCatalog } from './font-catalog.ts';
import { createInput, diagramInput, exportInput, plotInput, restoreInput } from './workspace-client.ts';
import { chatSelectionContext, chatSelectionPrompt, InvalidSelectionError, selectedLayerIdsSchema } from './chat-context.ts';

const revisionInput = z.number().int().positive().optional();
const targetFields = { documentId: z.string().uuid().optional(), revision: revisionInput };
const sceneAction = z.discriminatedUnion('action', [
  z.object({ action: z.literal('replace'), scene: sceneSchema, ...targetFields }),
  z.object({ action: z.literal('apply'), operations: z.array(operationSchema).min(1).max(operationLimit), ...targetFields }),
  z.object({ action: z.literal('repair'), ...targetFields }),
]);

class RequestError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  if (!req.headers['content-type']?.includes('application/json')) {
    throw new RequestError(415, 'Expected application/json.');
  }
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of req) {
    const buffer = Buffer.from(chunk);
    bytes += buffer.length;
    if (bytes > 8_000_000) throw new RequestError(413, 'Request exceeds 8 MB.');
    chunks.push(buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new RequestError(400, 'Invalid JSON.');
  }
}

async function exportGlb(scene: Scene) {
  const document = new Document();
  const buffer = document.createBuffer();
  const output = document.createScene(scene.name);
  for (const layer of scene.layers) {
    if (!layer.visible || layer.opacity === 0 || layer.kind !== 'mesh') continue;
    if ((layer.opacity ?? 1) !== 1 || (layer.rotationDeg ?? 0) !== 0) {
      throw new RequestError(422, 'GLB export does not yet support compositing opacity or 2D rotation on mesh layers. Use the mesh rotation property for 3D orientation.');
    }
    const geometry = makeGeometry(layer.shape);
    const color = new Color(layer.color);
    const material = document.createMaterial(layer.name).setBaseColorFactor([color.r, color.g, color.b, 1])
      .setMetallicFactor(0.14).setRoughnessFactor(0.55);
    const primitive = document.createPrimitive().setMaterial(material);
    for (const [attribute, semantic] of [['position', 'POSITION'], ['normal', 'NORMAL'], ['uv', 'TEXCOORD_0']] as const) {
      const value = geometry.getAttribute(attribute);
      primitive.setAttribute(semantic, document.createAccessor().setBuffer(buffer)
        .setType(value.itemSize === 2 ? 'VEC2' : 'VEC3').setArray(new Float32Array(value.array)));
    }
    const index = geometry.getIndex();
    if (index) {
      primitive.setIndices(document.createAccessor().setBuffer(buffer).setType('SCALAR')
        .setArray(new Uint32Array(index.array)));
    }
    const mesh = document.createMesh(layer.name).addPrimitive(primitive);
    output.addChild(document.createNode(layer.name).setMesh(mesh)
      .setTranslation([(layer.x + layer.width / 2 - scene.width / 2) / 100, (scene.height / 2 - layer.y - layer.height / 2) / 100, 0])
      .setScale(meshScale(layer))
      .setRotation(new Quaternion().setFromEuler(new Euler(0.35, layer.rotation * Math.PI / 180, 0)).toArray()));
    geometry.dispose();
  }
  if (!output.listChildren().length) throw new RequestError(422, 'Add a visible 3D layer before exporting GLB.');
  return new NodeIO().writeBinary(document);
}

function writeJson(res: ServerResponse, body: unknown, status = 200) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

async function sendStream(response: Response, res: ServerResponse) {
  res.writeHead(response.status, Object.fromEntries(response.headers));
  if (response.body) {
    for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
      if (res.destroyed) break;
      res.write(chunk);
    }
  }
  res.end();
}

export function workspaceMiddleware(env: Record<string, string | undefined>) {
  const store = createStore({
    path: resolve(env.GRAPHER_DATA_DIR || '.grapher', 'workspace.sqlite'),
    initialScene: examples[initialExample],
  });
  const reports = new Map<string, { revision: number; report: Promise<Awaited<ReturnType<typeof verifyArtifact>>> }>();
  const gateway = env.AI_GATEWAY_API_KEY && createGateway({ apiKey: env.AI_GATEWAY_API_KEY });

  async function enrich(document: DocumentSnapshot) {
    const cached = reports.get(document.documentId);
    const report = cached?.revision === document.revision ? cached.report : verifyArtifact(document.scene);
    reports.set(document.documentId, { revision: document.revision, report });
    return { ...document, workspaceId: store.workspaceId, report: await report };
  }

  function snapshot(documentId?: string) { return enrich(store.get(documentId)); }

  function checkRevision(document: DocumentSnapshot, expected?: number) {
    if (expected !== undefined && document.revision !== expected) {
      throw new RequestError(409, 'The document changed. Inspect its latest revision and try again.');
    }
  }

  async function preflight(scene: Scene) {
    const report = await verifyArtifact(scene);
    const blocking = report.issues.filter((issue) => issue.severity !== 'warning'
      && ['canvas', 'geometry', 'assets', 'unique', 'decode', 'fonts', 'render'].includes(issue.checkId));
    if (blocking.length) throw new RequestError(422, blocking.map((issue) => issue.message).join(' '));
    return report;
  }

  async function mutate(input: z.infer<typeof sceneAction>) {
    const before = store.get(input.documentId);
    checkRevision(before, input.revision);
    let changes: string[] = [];
    let next: Scene;
    switch (input.action) {
      case 'replace': next = input.scene; break;
      case 'apply': next = applyOperations(before.scene, input.operations); break;
      case 'repair': {
        const result = repairScene(before.scene);
        next = result.scene;
        changes = result.changes;
        break;
      }
    }
    const report = await preflight(next);
    const saved = store.update(before.documentId, before.revision, () => next,
      input.action === 'repair' ? 'Repair verification issues' : input.action === 'apply' ? 'Edit layers' : 'Replace scene');
    reports.set(saved.documentId, { revision: saved.revision, report: Promise.resolve(report) });
    return { ...await enrich(saved), changes };
  }

  async function createDocument(input: z.infer<typeof createInput>) {
    if (input.scene && input.template) throw new RequestError(400, 'Choose a scene or a template.');
    let scene = input.scene ?? { name: input.name || 'Untitled figure', width: 1200, height: 800, background: '#FFFFFF', layers: [] };
    if (input.template) {
      if (Object.hasOwn(examples, input.template)) scene = examples[input.template];
      else if (Object.hasOwn(figureExamples, input.template)) {
        scene = await composeDiagram(figureExamples[input.template as keyof typeof figureExamples]);
      } else if (Object.hasOwn(plotExamples, input.template)) {
        scene = composePlot(plotExamples[input.template as keyof typeof plotExamples]);
      } else throw new RequestError(404, 'Sample scene was not found.');
    }
    if (input.name) scene = { ...scene, name: input.name };
    await preflight(scene);
    return enrich(store.create(scene));
  }

  const promptInput = z.object({
    messages: z.array(z.object({
      role: z.enum(['user', 'assistant', 'system']),
      parts: z.array(z.object({ type: z.string(), text: z.string().optional() })),
    })).max(60),
    selectedLayerIds: selectedLayerIdsSchema,
    ...targetFields,
  });
  const presets: Record<string, string> = {
    ...Object.fromEntries(Object.entries(examples).map(([key, sample]) => ['load ' + sample.name.toLowerCase() + ' sample', key])),
    'load the orbital mechanics example': 'orbital',
    'load the web design example': 'web',
    'load the game asset example': 'game',
    'load the poster example': 'poster',
  };

  function chat(input: z.infer<typeof promptInput>, signal: AbortSignal) {
    const documentId = input.documentId || store.defaultDocumentId;
    const selection = chatSelectionContext(store.get(documentId), input.selectedLayerIds);
    const brief = input.messages.findLast((message) => message.role === 'user')
      ?.parts.filter((part) => part.type === 'text').map((part) => part.text).join(' ').trim();
    if (!brief || brief.length > 4000) throw new RequestError(400, 'Enter a brief of up to 4,000 characters.');
    const command = brief.toLowerCase().replace(/[.!?]$/, '');
    const example = Object.hasOwn(presets, command) ? presets[command] : undefined;
    const repair = ['fix issues', 'repair', 'fix the current issues'].includes(command);
    const verify = ['verify', 'verify canvas', 'verify the canvas'].includes(command);

    if (gateway && !example && !repair && !verify) {
      const history = input.messages.flatMap(({ role, parts }) => {
        const content = parts.filter((part) => part.type === 'text').map((part) => part.text).join(' ').trim();
        return role === 'system' || !content ? [] : [{ role, content }];
      });
      const result = streamText({
        model: gateway(env.GRAPHER_MODEL || 'openai/gpt-5-mini'),
        system: 'You create polished editable figures in Grapher. Inspect before changing a document. Use compose_diagram for automatic layout of connected nodes and labeled edges. Use compose_plot for line, scatter and bar figures from user-supplied numeric data, including supplied uncertainty intervals. Never infer an interval or fabricate scientific data, claims, or citations. Ask for missing data. Use native vector operations for precise refinement. Bundled fonts are Source Sans 3 (supports Greek), Barlow, Crimson Text, and Courier Prime. Text supports maxWidth wrapping, lineHeight, and letterSpacing. Paths support arrows and dashes, shapes support strokes, opacity, rotationDeg and gradient paints. Use a restrained palette, measured typography and clear hierarchy. Verify after editing and review the rendered PNG. Correct defects you can substantiate. Describe unresolved warnings. Pass the latest revision to every edit. Keep responses concise. '
          + chatSelectionPrompt(selection),
        messages: history,
        abortSignal: signal,
        stopWhen: stepCountIs(12),
        tools: {
          inspect: tool({
            description: 'Inspect editable content, saved document ID, revision, checks, and selected layer IDs and names captured when the human submitted this request.',
            inputSchema: z.object({}),
            execute: async () => {
              const state = await snapshot(documentId);
              return { ...state, selection, scene: { ...state.scene, layers: state.scene.layers.map((layer) =>
                layer.kind === 'raster' ? { ...layer, src: '(embedded image preserved in document)' } : layer) } };
            },
          }),
          apply: tool({
            description: 'Commit an atomic batch of layer edits to the saved document.',
            inputSchema: z.object({ revision: z.number().int(), operations: z.array(operationSchema).min(1).max(operationLimit) }),
            execute: async (args) => {
              const result = await mutate({ action: 'apply', documentId, ...args });
              return { revision: result.revision, report: result.report };
            },
          }),
          compose_diagram: tool({
            description: 'Automatically arrange an editable diagram with connected nodes, arrowheads, labels and wrapped descriptions. Replaces the current composition.',
            inputSchema: diagramInput.omit({ documentId: true, create: true }),
            execute: async ({ spec, revision }) => {
              const before = store.get(documentId);
              checkRevision(before, revision);
              const scene = await composeDiagram(spec);
              const result = await mutate({ action: 'replace', documentId, revision: before.revision, scene });
              return { revision: result.revision, report: result.report };
            },
          }),
          compose_plot: tool({
            description: 'Create an editable scientific plot from supplied numeric series. Linear axes, line/scatter/bar marks, labeled units and optional supplied uncertainty intervals. Replaces the current composition.',
            inputSchema: plotInput.omit({ documentId: true, create: true }),
            execute: async ({ spec, revision }) => {
              const before = store.get(documentId);
              checkRevision(before, revision);
              const scene = composePlot(spec);
              const result = await mutate({ action: 'replace', documentId, revision: before.revision, scene });
              return { revision: result.revision, report: result.report };
            },
          }),
          verify: tool({
            description: 'Run structural and render preflight checks on the saved revision.',
            inputSchema: z.object({}),
            execute: async () => {
              const state = await snapshot(documentId);
              return { revision: state.revision, report: state.report };
            },
          }),
          repair: tool({
            description: 'Apply supported fixes and verify the saved result.',
            inputSchema: z.object({ revision: z.number().int() }),
            execute: async (args) => {
              const result = await mutate({ action: 'repair', documentId, ...args });
              return { revision: result.revision, report: result.report, changes: result.changes };
            },
          }),
          render: tool({
            description: 'Get a PNG of a specified revision for visual inspection.',
            inputSchema: z.object({ revision: z.number().int() }),
            execute: async ({ revision }) => {
              const state = store.get(documentId);
              checkRevision(state, revision);
              return { revision, pngBase64: renderPng(state.scene, Math.min(1, 1600 / Math.max(state.scene.width, state.scene.height))).toString('base64') };
            },
            toModelOutput: ({ output }) => ({
              type: 'content',
              value: [
                { type: 'text', text: 'Rendered revision ' + output.revision },
                { type: 'file', mediaType: 'image/png', data: { type: 'data', data: output.pngBase64 } },
              ],
            }),
          }),
        },
      });
      return result.toUIMessageStreamResponse({ onError: () => 'The model request failed. Check the AI Gateway configuration.' });
    }

    return createUIMessageStreamResponse({
      stream: createUIMessageStream({
        async execute({ writer }) {
          const id = randomUUID();
          writer.write({ type: 'start' });
          writer.write({ type: 'text-start', id });
          let message: string;
          if (example) {
            const result = await mutate({ action: 'replace', scene: examples[example], documentId, revision: input.revision });
            message = 'Loaded ' + result.scene.name + '. ' + result.report.passed + ' of ' + result.report.total + ' checks passed on revision ' + result.revision + '.';
          } else if (repair) {
            const result = await mutate({ action: 'repair', documentId, revision: input.revision });
            message = (result.changes.length ? result.changes.join(' ') : 'No automatic repairs were needed.') + ' '
              + result.report.passed + ' of ' + result.report.total + ' checks passed on revision ' + result.revision + '.';
          } else if (verify) {
            const result = await snapshot(documentId);
            message = result.report.passed + ' of ' + result.report.total + ' checks passed on revision ' + result.revision + '. '
              + result.report.issues.map((issue) => issue.message).join(' ');
          } else {
            message = 'Set AI_GATEWAY_API_KEY for open-ended briefs. Verification, repair, samples and all CLI/MCP editing tools work locally.';
          }
          writer.write({ type: 'text-delta', id, delta: message });
          writer.write({ type: 'text-end', id });
          writer.write({ type: 'finish', finishReason: 'stop' });
        },
        onError: (error) => error instanceof Error ? error.message : 'The document command failed.',
      }),
    });
  }

  async function handle(req: IncomingMessage, res: ServerResponse) {
    let requestHost: URL;
    try { requestHost = new URL(`http://${req.headers.host || ''}`); }
    catch { throw new RequestError(400, 'Invalid workspace host.'); }
    if (!['localhost', '127.0.0.1', '[::1]'].includes(requestHost.hostname)
      || requestHost.host.toLowerCase() !== req.headers.host?.toLowerCase()) {
      throw new RequestError(403, 'The workspace API is available only through a loopback host.');
    }
    const url = new URL(req.url || '/', 'http://localhost');
    const documentId = url.searchParams.get('documentId') || undefined;
    if (req.headers.origin) {
      let origin: URL;
      try { origin = new URL(req.headers.origin); }
      catch { throw new RequestError(403, 'Requests must originate from this workspace.'); }
      if (origin.origin !== requestHost.origin) throw new RequestError(403, 'Requests must originate from this workspace.');
    }
    if (url.pathname === '/api/scene' && req.method === 'GET') return writeJson(res, await snapshot(documentId));
    if (url.pathname === '/api/scene' && req.method === 'POST') return writeJson(res, await mutate(sceneAction.parse(await readJson(req))));
    if (url.pathname === '/api/documents' && req.method === 'GET') {
      return writeJson(res, { documents: store.list(), defaultDocumentId: store.defaultDocumentId });
    }
    if (url.pathname === '/api/documents' && req.method === 'POST') return writeJson(res, await createDocument(createInput.parse(await readJson(req))), 201);
    if (url.pathname === '/api/history' && req.method === 'GET') return writeJson(res, { entries: store.history(documentId || store.defaultDocumentId) });
    if (url.pathname === '/api/restore' && req.method === 'POST') {
      const input = restoreInput.parse(await readJson(req));
      return writeJson(res, await enrich(store.restore(input.documentId || store.defaultDocumentId, input.targetRevision, input.revision)));
    }
    if (url.pathname === '/api/diagram' && req.method === 'POST') {
      const input = diagramInput.parse(await readJson(req));
      const before = store.get(input.documentId);
      if (!input.create) checkRevision(before, input.revision);
      const scene = await composeDiagram(input.spec);
      return writeJson(res, input.create ? await createDocument({ scene }) :
        await mutate({ action: 'replace', documentId: before.documentId, revision: before.revision, scene }));
    }
    if (url.pathname === '/api/plot' && req.method === 'POST') {
      const input = plotInput.parse(await readJson(req));
      const before = store.get(input.documentId);
      if (!input.create) checkRevision(before, input.revision);
      const scene = composePlot(input.spec);
      return writeJson(res, input.create ? await createDocument({ scene }) :
        await mutate({ action: 'replace', documentId: before.documentId, revision: before.revision, scene }));
    }
    if (url.pathname === '/api/capabilities' && req.method === 'GET') {
      return writeJson(res, {
        version: 1,
        formats: ['svg', 'png', 'pdf', 'json', 'glb'],
        layerKinds: ['rect', 'ellipse', 'path', 'text', 'raster', 'mesh'],
        fonts: [...new Set(fontCatalog.map((font) => font.family))],
        samples: [
          ...Object.entries(examples).map(([id, scene]) => ({ id, name: scene.name })),
          ...Object.entries(figureExamples).map(([id, spec]) => ({ id, name: spec.title })),
          ...Object.entries(plotExamples).map(([id, spec]) => ({ id, name: spec.title })),
        ],
        sceneSchema: z.toJSONSchema(sceneSchema, { io: 'input' }),
        operationSchema: z.toJSONSchema(operationSchema, { io: 'input' }),
        diagramSchema: z.toJSONSchema(diagramInput.shape.spec, { io: 'input' }),
        plotSchema: z.toJSONSchema(plotInput.shape.spec, { io: 'input' }),
        limits: { layers: 750, operationsPerBatch: operationLimit, maxPngPixels: 64_000_000, requestBytes: 8_000_000 },
      });
    }
    if (url.pathname === '/api/config' && req.method === 'GET') return writeJson(res, { modelEnabled: Boolean(gateway) });
    if (url.pathname === '/api/chat' && req.method === 'POST') {
      const controller = new AbortController();
      res.once('close', () => controller.abort());
      return sendStream(chat(promptInput.parse(await readJson(req)), controller.signal), res);
    }
    if (url.pathname === '/api/export' && req.method === 'GET') {
      const options = exportInput.parse({
        documentId,
        format: url.searchParams.get('format') || 'svg',
        revision: url.searchParams.has('revision') ? Number(url.searchParams.get('revision')) : undefined,
        scale: url.searchParams.has('scale') ? Number(url.searchParams.get('scale')) : undefined,
        outlineText: url.searchParams.has('outlineText') ? url.searchParams.get('outlineText') === 'true' : undefined,
      });
      const active = store.get(documentId);
      checkRevision(active, options.revision);
      if (options.format !== 'json') await preflight(active.scene);
      let bytes: string | Uint8Array;
      let type: string;
      switch (options.format) {
        case 'svg': bytes = portableSvg(active.scene, options.outlineText); type = 'image/svg+xml'; break;
        case 'png': bytes = renderPng(active.scene, options.scale); type = 'image/png'; break;
        case 'pdf': bytes = await renderPdf(active.scene); type = 'application/pdf'; break;
        case 'glb': bytes = await exportGlb(active.scene); type = 'model/gltf-binary'; break;
        case 'json': bytes = JSON.stringify(active.scene, null, 2); type = 'application/json'; break;
      }
      const filename = active.scene.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'grapher';
      res.writeHead(200, {
        'Content-Type': type,
        'Content-Disposition': 'attachment; filename="' + filename + '.' + options.format + '"',
        'X-Grapher-Revision': String(active.revision),
        'X-Grapher-Document': active.documentId,
        'Cache-Control': 'no-store',
      });
      return res.end(bytes);
    }
    return writeJson(res, { error: 'Unknown workspace endpoint.' }, 404);
  }

  const middleware = (req: IncomingMessage, res: ServerResponse, next: () => void) => {
    if (!req.url?.startsWith('/api/')) return next();
    void handle(req, res).catch((error: unknown) => {
      if (res.headersSent) return res.end();
      const status = error instanceof RequestError || error instanceof StoreError ? error.status
        : error instanceof z.ZodError || error instanceof InvalidSelectionError ? 400 : 422;
      const message = error instanceof z.ZodError
        ? error.issues.map((issue) => issue.path.join('.') + ' — ' + issue.message).join('; ')
        : error instanceof Error ? error.message : 'Workspace request failed.';
      return writeJson(res, { error: message }, status);
    });
  };
  return Object.assign(middleware, { close: () => store.close() });
}
