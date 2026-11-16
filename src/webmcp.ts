import { useWebMCP } from 'use-webmcp-tool';
import { z } from 'zod';
import { applyInput, exportInput, repairInput, replaceInput, workspaceClient, workspaceTools, type Workspace } from './workspace-client';

const inspectSchema = { type: 'object', properties: {}, additionalProperties: false };
const applySchema = z.toJSONSchema(applyInput, { io: 'input' });
const replaceSchema = z.toJSONSchema(replaceInput, { io: 'input' });
const repairSchema = z.toJSONSchema(repairInput, { io: 'input' });
const exportSchema = z.toJSONSchema(exportInput, { io: 'input' });
const sceneOutput = { untrustedContentHint: true };
const readOnly = { ...sceneOutput, readOnlyHint: true };

export function useGrapherTools(onChange?: (workspace: Workspace) => void) {
  async function edit(request: Parameters<ReturnType<typeof workspaceClient>['edit']>[0], signal?: AbortSignal) {
    const result = await workspaceClient(location.origin).edit(request, signal);
    onChange?.(result);
    return result;
  }

  const inspect = useWebMCP({
    ...workspaceTools.inspect,
    inputSchema: inspectSchema,
    annotations: readOnly,
    execute: (_, options) => workspaceClient(location.origin).inspect(options?.signal),
  });

  useWebMCP({
    ...workspaceTools.verify,
    inputSchema: inspectSchema,
    annotations: readOnly,
    execute: (_, options) => workspaceClient(location.origin).verify(options?.signal),
  });

  useWebMCP({
    ...workspaceTools.apply,
    inputSchema: applySchema,
    annotations: sceneOutput,
    execute: (args, options) => edit({ action: 'apply', ...applyInput.parse(args) }, options?.signal),
  });

  useWebMCP({
    ...workspaceTools.replace,
    inputSchema: replaceSchema,
    annotations: sceneOutput,
    execute: (args, options) => edit({ action: 'replace', ...replaceInput.parse(args) }, options?.signal),
  });

  useWebMCP({
    ...workspaceTools.repair,
    inputSchema: repairSchema,
    annotations: sceneOutput,
    execute: (args, options) => edit({ action: 'repair', ...repairInput.parse(args) }, options?.signal),
  });

  useWebMCP({
    ...workspaceTools.export,
    inputSchema: exportSchema,
    annotations: readOnly,
    async execute(args, options) {
      const { format, revision: expected } = exportInput.parse(args);
      const response = await workspaceClient(location.origin).export(format, expected, options?.signal);
      const revision = response.headers.get('x-grapher-revision');
      const description = { type: 'text', text: JSON.stringify({ format, revision }) };
      if (format === 'svg' || format === 'json') {
        return { content: [description, { type: 'text', text: await response.text() }] };
      }

      const reader = new FileReader();
      const blob = await response.blob();
      const data = await new Promise<string>((resolve, reject) => {
        reader.onload = () => resolve(String(reader.result).split(',')[1]);
        reader.onerror = () => reject(reader.error);
        reader.readAsDataURL(blob);
      });
      if (format === 'png') {
        return { content: [description, { type: 'image', data, mimeType: 'image/png' }] };
      }
      return { content: [description, {
        type: 'resource',
        resource: { uri: response.url, mimeType: 'model/gltf-binary', blob: data },
      }] };
    },
  });

  return inspect.registered;
}
