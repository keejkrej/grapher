import { z } from 'zod';
import { operationLimit, operationSchema, sceneSchema, type Scene, type verifyScene } from './engine';

export const defaultWorkspaceUrl = 'http://localhost:5173';
export const formatSchema = z.enum(['svg', 'png', 'glb', 'json']);
export type ExportFormat = z.infer<typeof formatSchema>;

const revision = z.number().int().positive().optional().describe('Expected workspace revision. The request fails if the scene has changed.');
export const applyInput = z.object({ operations: z.array(operationSchema).min(1).max(operationLimit), revision });
export const replaceInput = z.object({ scene: sceneSchema, revision });
export const repairInput = z.object({ revision });
export const exportInput = z.object({ format: formatSchema, revision });

export const workspaceTools = {
  inspect: { name: 'grapher_inspect', description: 'Read the active graphics scene, its revision and current checks.' },
  verify: { name: 'grapher_verify', description: 'Run the deterministic scene checks and return layer-specific findings with supported fixes.' },
  apply: { name: 'grapher_apply', description: 'Apply a batch of scene operations atomically. Inspect first and pass the current revision to avoid overwriting concurrent edits.' },
  replace: { name: 'grapher_replace', description: 'Replace the active scene with a complete layer document. Raster layers use embedded PNG or JPEG data URLs.' },
  repair: { name: 'grapher_repair', description: 'Apply the supported fixes to the active scene and return the subsequent check report.' },
  export: { name: 'grapher_export', description: 'Render the active revision. PNG returns an image you can visually review, SVG returns vector markup, GLB returns the 3D meshes, and JSON returns the source scene.' },
} as const;

export type Workspace = {
  scene: Scene;
  revision: number;
  workspaceId?: string;
  report: ReturnType<typeof verifyScene>;
  changes?: string[];
};

type Edit = ({ action: 'apply' } & z.infer<typeof applyInput>)
  | ({ action: 'replace' } & z.infer<typeof replaceInput>)
  | ({ action: 'repair' } & z.infer<typeof repairInput>);

export function workspaceClient(baseUrl: string) {
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
    return (await request('/api/scene', undefined, signal)).json();
  }

  return {
    inspect,
    async verify(signal?: AbortSignal) {
      const { revision, report } = await inspect(signal);
      return { revision, ...report };
    },
    async edit(edit: Edit, signal?: AbortSignal): Promise<Workspace> {
      return (await request('/api/scene', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(edit),
      }, signal)).json();
    },
    export(format: ExportFormat, revision?: number, signal?: AbortSignal) {
      const params = new URLSearchParams({ format });
      if (revision !== undefined) params.set('revision', String(revision));
      return request(`/api/export?${params}`, undefined, signal);
    },
  };
}
