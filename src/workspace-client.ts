import { z } from 'zod';
import { operationLimit, operationSchema, sceneSchema, type Scene, type verifyScene } from './engine.ts';
import type { DocumentSummary, HistoryEntry } from './store.ts';
import { diagramSchema } from './diagram-schema.ts';
import { plotSchema } from './plot-schema.ts';

export const defaultWorkspaceUrl = 'http://localhost:5173';
export const formatSchema = z.enum(['svg', 'png', 'pdf', 'glb', 'json']);
export type ExportFormat = z.infer<typeof formatSchema>;

const revision = z.number().int().positive().optional().describe('Expected workspace revision. The request fails if the scene has changed.');
const documentId = z.string().uuid().optional().describe('Saved document ID. Omit to use the current/default document for this transport.');
export const targetInput = z.object({ documentId });
export const applyInput = z.object({ operations: z.array(operationSchema).min(1).max(operationLimit), revision, documentId });
export const replaceInput = z.object({ scene: sceneSchema, revision, documentId });
export const repairInput = z.object({ revision, documentId });
export const exportInput = z.object({
  format: formatSchema, revision, documentId,
  scale: z.number().min(0.1).max(4).optional().describe('PNG pixel scale, up to 64 million output pixels.'),
  outlineText: z.boolean().optional().describe('Convert text to vector paths in SVG. Editable source is retained in the document.'),
});
export const createInput = z.object({ scene: sceneSchema.optional(), template: z.string().optional(), name: z.string().min(1).max(300).optional() });
export const restoreInput = z.object({ documentId, targetRevision: z.number().int().positive(), revision });
export const diagramInput = z.object({ spec: diagramSchema, documentId, revision, create: z.boolean().optional() });
export const plotInput = z.object({ spec: plotSchema, documentId, revision, create: z.boolean().optional() });

export const workspaceTools = {
  inspect: { name: 'grapher_inspect', description: 'Read the active graphics scene, its revision and current checks.' },
  verify: { name: 'grapher_verify', description: 'Run the deterministic scene checks and return layer-specific findings with supported fixes.' },
  apply: { name: 'grapher_apply', description: 'Apply a batch of scene operations atomically. Inspect first and pass the current revision to avoid overwriting concurrent edits.' },
  replace: { name: 'grapher_replace', description: 'Replace the active scene with a complete layer document. Raster layers use embedded PNG or JPEG data URLs.' },
  repair: { name: 'grapher_repair', description: 'Apply the supported fixes to the active scene and return the subsequent check report.' },
  export: { name: 'grapher_export', description: 'Export a document revision as PNG for visual review, portable SVG with optional outlined text, vector PDF, GLB meshes, or editable JSON. PNG scale ranges from 0.1 to 4.' },
  documents: { name: 'grapher_documents', description: 'List saved documents and their IDs, current revisions and update times.' },
  create: { name: 'grapher_create', description: 'Create a saved document from a scene, a sample template ID, or a blank artboard. Discover template IDs with grapher_capabilities.' },
  history: { name: 'grapher_history', description: 'List a document’s saved revisions and change descriptions.' },
  restore: { name: 'grapher_restore', description: 'Restore a historical document revision as a new revision, preserving the full history. Pass the current revision to prevent concurrent overwrites.' },
  compose: { name: 'grapher_compose', description: 'Compile a structured graph into an editable diagram with measured labels and orthogonal arrow routes. Replaces the target document; set create true to create a new document.' },
  plot: { name: 'grapher_plot', description: 'Compile supplied numeric data into an editable line, scatter or bar figure, with axis labels, units, legends and optional uncertainty intervals. Never invent source data. Replaces the target document; set create true for a new document.' },
  capabilities: { name: 'grapher_capabilities', description: 'Discover supported formats, fonts, sample templates, document and diagram schemas, and resource limits.' },
} as const;

export type Workspace = {
  scene: Scene;
  revision: number;
  workspaceId?: string;
  documentId?: string;
  updatedAt?: string;
  report: ReturnType<typeof verifyScene>;
  changes?: string[];
};

type Edit = ({ action: 'apply' } & z.infer<typeof applyInput>)
  | ({ action: 'replace' } & z.infer<typeof replaceInput>)
  | ({ action: 'repair' } & z.infer<typeof repairInput>);

export function workspaceClient(baseUrl: string, activeDocumentId?: string) {
  function targetPath(path: string, id = activeDocumentId) {
    const url = new URL(path, baseUrl);
    if (id) url.searchParams.set('documentId', id);
    return url.toString();
  }
  async function request(path: string, init?: RequestInit, signal?: AbortSignal) {
    const response = await fetch(new URL(path, baseUrl), { ...init, signal });
    if (!response.ok) {
      const body = await response.json().catch(() => undefined);
      const message = typeof body?.error === 'string' ? body.error : response.statusText;
      throw new Error(`Grapher responded with HTTP ${response.status}: ${message}`);
    }
    return response;
  }

  async function inspect(signal?: AbortSignal): Promise<Workspace> {
    return (await request(targetPath('/api/scene'), undefined, signal)).json();
  }

  return {
    inspect,
    async documents(signal?: AbortSignal): Promise<{ documents: DocumentSummary[]; defaultDocumentId: string }> {
      return (await request('/api/documents', undefined, signal)).json();
    },
    async create(input: z.infer<typeof createInput>, signal?: AbortSignal): Promise<Workspace> {
      return (await request('/api/documents', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input) }, signal)).json();
    },
    async history(signal?: AbortSignal): Promise<{ entries: HistoryEntry[] }> {
      return (await request(targetPath('/api/history'), undefined, signal)).json();
    },
    async restore(targetRevision: number, revision?: number, signal?: AbortSignal): Promise<Workspace> {
      return (await request('/api/restore', { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ documentId: activeDocumentId, targetRevision, revision }) }, signal)).json();
    },
    async compose(input: z.infer<typeof diagramInput>, signal?: AbortSignal): Promise<Workspace> {
      return (await request('/api/diagram', { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ...input, documentId: input.documentId ?? activeDocumentId }) }, signal)).json();
    },
    async plot(input: z.infer<typeof plotInput>, signal?: AbortSignal): Promise<Workspace> {
      return (await request('/api/plot', { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ...input, documentId: input.documentId ?? activeDocumentId }) }, signal)).json();
    },
    async capabilities(signal?: AbortSignal) {
      return (await request('/api/capabilities', undefined, signal)).json();
    },
    async verify(signal?: AbortSignal) {
      const { documentId, revision, report } = await inspect(signal);
      return { documentId, revision, ...report };
    },
    async edit(edit: Edit, signal?: AbortSignal): Promise<Workspace> {
      return (await request('/api/scene', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ...edit, documentId: edit.documentId ?? activeDocumentId }),
      }, signal)).json();
    },
    export(format: ExportFormat, revision?: number, signal?: AbortSignal, options: { scale?: number; outlineText?: boolean } = {}) {
      const params = new URLSearchParams({ format });
      if (revision !== undefined) params.set('revision', String(revision));
      if (options.scale !== undefined) params.set('scale', String(options.scale));
      if (options.outlineText !== undefined) params.set('outlineText', String(options.outlineText));
      return request(targetPath(`/api/export?${params}`), undefined, signal);
    },
  };
}
