import type { IncomingMessage, ServerResponse } from 'node:http';
import { Buffer } from 'node:buffer';
import { randomUUID } from 'node:crypto';
import { Document, NodeIO } from '@gltf-transform/core';
import { Resvg } from '@resvg/resvg-js';
import {
  createGateway, createUIMessageStream, createUIMessageStreamResponse, stepCountIs, streamText, tool,
} from 'ai';
import { Color, Euler, Quaternion } from 'three';
import { z } from 'zod';
import { applyOperations, operationLimit, operationSchema, repairScene, sceneSchema, sceneSvg, verifyScene } from './engine.ts';
import { examples, initialExample } from './examples.ts';
import { makeGeometry, meshScale } from './geometry.ts';
import type { Scene } from './engine.ts';

const revisionInput = z.number().int().positive().optional();
const sceneAction = z.discriminatedUnion('action', [
  z.object({ action: z.literal('replace'), scene: sceneSchema, revision: revisionInput }),
  z.object({ action: z.literal('apply'), operations: z.array(operationSchema).min(1).max(operationLimit), revision: revisionInput }),
  z.object({ action: z.literal('repair'), revision: revisionInput }),
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
    if (!layer.visible || layer.kind !== 'mesh') continue;
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
  let scene = sceneSchema.parse(examples[initialExample]);
  let revision = 1;
  const workspaceId = randomUUID();
  const snapshot = () => ({ scene, revision, workspaceId, report: verifyScene(scene) });
  const gateway = env.AI_GATEWAY_API_KEY && createGateway({ apiKey: env.AI_GATEWAY_API_KEY });

  function checkRevision(expected?: number) {
    if (expected !== undefined && revision !== expected) {
      throw new RequestError(409, 'The canvas changed. Inspect the latest revision and try again.');
    }
  }

  function mutate(input: z.infer<typeof sceneAction>) {
    checkRevision(input.revision);
    if (input.action === 'repair') {
      const result = repairScene(scene);
      if (result.changes.length) {
        scene = result.scene;
        revision += 1;
      }
      return { ...snapshot(), changes: result.changes };
    }
    scene = input.action === 'apply' ? applyOperations(scene, input.operations) : input.scene;
    revision += 1;
    return snapshot();
  }

  const promptInput = z.object({
    messages: z.array(z.object({
      role: z.enum(['user', 'assistant', 'system']),
      parts: z.array(z.object({ type: z.string(), text: z.string().optional() })),
    })).max(60),
    revision: revisionInput,
  });
  const presets: Record<string, string> = {
    ...Object.fromEntries(Object.entries(examples).map(([key, sample]) => [`load ${sample.name.toLowerCase()} sample`, key])),
    'load the orbital mechanics example': 'orbital',
    'load the web design example': 'web',
    'load the game asset example': 'game',
    'load the poster example': 'poster',
  };

  function chat(input: z.infer<typeof promptInput>, signal: AbortSignal) {
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
        system: 'You edit an existing Grapher design. Inspect the scene before editing. Use native layer types with unique ids. Edit the shared canvas with apply. Run verify after editing, fix suitable issues and verify again. Render the verified revision to visually review the composition. Use revision numbers to avoid overwriting other edits. Describe what you changed and any remaining issues. Keep responses short.',
        messages: history,
        abortSignal: signal,
        stopWhen: stepCountIs(9),
        tools: {
          inspect: tool({
            description: 'Inspect all editable layers and the latest revision.',
            inputSchema: z.object({}),
            execute: async () => ({
              revision,
              report: verifyScene(scene),
              scene: { ...scene, layers: scene.layers.map((layer) => layer.kind === 'raster'
                ? { ...layer, src: '(embedded raster)' } : layer) },
            }),
          }),
          apply: tool({
            description: 'Atomically apply operations to the canvas.',
            inputSchema: z.object({ revision: z.number().int(), operations: z.array(operationSchema).min(1).max(operationLimit) }),
            execute: async (args) => {
              const result = mutate({ action: 'apply', ...args });
              return { revision: result.revision, report: result.report };
            },
          }),
          verify: tool({
            description: 'Run deterministic scene checks.',
            inputSchema: z.object({}),
            execute: async () => ({ revision, report: verifyScene(scene) }),
          }),
          repair: tool({
            description: 'Apply deterministic fixes and rerun verification.',
            inputSchema: z.object({ revision: z.number().int() }),
            execute: async (args) => {
              const result = mutate({ action: 'repair', ...args });
              return { revision: result.revision, report: result.report, changes: 'changes' in result ? result.changes : [] };
            },
          }),
          render: tool({
            description: 'Get a PNG of the verified revision for visual inspection.',
            inputSchema: z.object({ revision: z.number().int() }),
            execute: async ({ revision: expected }) => {
              checkRevision(expected);
              const longest = Math.max(scene.width, scene.height);
              const png = new Resvg(sceneSvg(scene), longest > 1000
                ? { fitTo: { mode: 'zoom', value: 1000 / longest } } : undefined).render().asPng();
              return { revision: expected, pngBase64: png.toString('base64') };
            },
            toModelOutput: ({ output }) => ({
              type: 'content',
              value: [
                { type: 'text', text: `Rendered revision ${output.revision}` },
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
        execute({ writer }) {
          const id = randomUUID();
          writer.write({ type: 'start' });
          writer.write({ type: 'text-start', id });
          let message: string;
          if (example) {
            const result = mutate({ action: 'replace', scene: examples[example], revision: input.revision });
            message = `Loaded ${result.scene.name}. ${result.report.passed} of ${result.report.total} checks passed on revision ${result.revision}.`;
          } else if (repair) {
            const result = mutate({ action: 'repair', revision: input.revision });
            const changes = 'changes' in result ? result.changes ?? [] : [];
            message = changes.length ? `${changes.join(' ')} ` : 'No automatic repairs were needed. ';
            message += `${result.report.passed} of ${result.report.total} checks passed on revision ${result.revision}.`;
          } else if (verify) {
            const { report } = snapshot();
            message = `${report.passed} of ${report.total} checks passed on revision ${revision}. ${report.issues.map((issue) => issue.message).join(' ')}`;
          } else {
            message = 'This workspace is in demo mode. Use “Verify the canvas”, “Fix the current issues”, or a sample command below. Set AI_GATEWAY_API_KEY for open-ended briefs.';
          }
          writer.write({ type: 'text-delta', id, delta: message });
          writer.write({ type: 'text-end', id });
          writer.write({ type: 'finish', finishReason: 'stop' });
        },
        onError: (error) => error instanceof RequestError ? error.message : 'The workspace command failed.',
      }),
    });
  }

  async function handle(req: IncomingMessage, res: ServerResponse) {
    const url = new URL(req.url || '/', 'http://localhost');
    if (req.method === 'POST' && req.headers.origin && new URL(req.headers.origin).host !== req.headers.host) {
      throw new RequestError(403, 'Requests must originate from this workspace.');
    }
    if (url.pathname === '/api/scene' && req.method === 'GET') return writeJson(res, snapshot());
    if (url.pathname === '/api/scene' && req.method === 'POST') {
      return writeJson(res, mutate(sceneAction.parse(await readJson(req))));
    }
    if (url.pathname === '/api/config' && req.method === 'GET') {
      return writeJson(res, { modelEnabled: Boolean(env.AI_GATEWAY_API_KEY) });
    }
    if (url.pathname === '/api/chat' && req.method === 'POST') {
      const controller = new AbortController();
      res.once('close', () => controller.abort());
      return sendStream(chat(promptInput.parse(await readJson(req)), controller.signal), res);
    }
    if (url.pathname === '/api/export' && req.method === 'GET') {
      const format = url.searchParams.get('format') || 'svg';
      const expected = url.searchParams.get('revision');
      checkRevision(revisionInput.parse(expected === null ? undefined : Number(expected)));
      const active = scene;
      const exportedRevision = revision;
      let bytes: string | Uint8Array;
      let type: string;
      switch (format) {
        case 'svg': bytes = sceneSvg(active); type = 'image/svg+xml'; break;
        case 'png':
          bytes = new Resvg(sceneSvg(active)).render().asPng();
          type = 'image/png';
          break;
        case 'glb': bytes = await exportGlb(active); type = 'model/gltf-binary'; break;
        case 'json': bytes = JSON.stringify(active, null, 2); type = 'application/json'; break;
        default: throw new RequestError(400, 'Format must be svg, png, glb, or json.');
      }
      const filename = active.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'grapher';
      res.writeHead(200, {
        'Content-Type': type,
        'Content-Disposition': `attachment; filename="${filename}.${format}"`,
        'X-Grapher-Revision': String(exportedRevision),
        'Cache-Control': 'no-store',
      });
      return res.end(bytes);
    }
    return writeJson(res, { error: 'Unknown workspace endpoint.' }, 404);
  }

  return (req: IncomingMessage, res: ServerResponse, next: () => void) => {
    if (!req.url?.startsWith('/api/')) return next();
    void handle(req, res).catch((error: unknown) => {
      if (res.headersSent) return res.end();
      const status = error instanceof RequestError ? error.status : error instanceof z.ZodError ? 400 : 500;
      const message = error instanceof z.ZodError
        ? error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; ')
        : error instanceof Error ? error.message : 'Workspace request failed.';
      return writeJson(res, { error: message }, status);
    });
  };
}
