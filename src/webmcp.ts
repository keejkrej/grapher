import { useWebMCP } from 'use-webmcp-tool';
import { z } from 'zod';
import { applyInput, createInput, diagramInput, exportInput, plotInput, repairInput, replaceInput, restoreInput, targetInput, workspaceClient, workspaceTools, type Workspace } from './workspace-client';

const emptySchema = { type: 'object', properties: {}, additionalProperties: false };
const inspectSchema = z.toJSONSchema(targetInput, { io: 'input' });
const applySchema = z.toJSONSchema(applyInput, { io: 'input' });
const replaceSchema = z.toJSONSchema(replaceInput, { io: 'input' });
const repairSchema = z.toJSONSchema(repairInput, { io: 'input' });
const exportSchema = z.toJSONSchema(exportInput, { io: 'input' });
const createSchema = z.toJSONSchema(createInput, { io: 'input' });
const diagramJsonSchema = z.toJSONSchema(diagramInput, { io: 'input' });
const plotJsonSchema = z.toJSONSchema(plotInput, { io: 'input' });
const restoreSchema = z.toJSONSchema(restoreInput, { io: 'input' });
const sceneOutput = { untrustedContentHint: true };
const readOnly = { ...sceneOutput, readOnlyHint: true };

export function useGrapherTools(onChange?: (workspace: Workspace) => void, activeDocumentId?: string) {
  function client(documentId = activeDocumentId) { return workspaceClient(location.origin, documentId); }
  async function changed(result: Promise<Workspace>) {
    const workspace = await result;
    onChange?.(workspace);
    return workspace;
  }
  async function edit(request: Parameters<ReturnType<typeof workspaceClient>['edit']>[0], signal?: AbortSignal) {
    return changed(client(request.documentId).edit(request, signal));
  }

  const inspect = useWebMCP({
    ...workspaceTools.inspect,
    inputSchema: inspectSchema,
    annotations: readOnly,
    execute: (args, options) => client(targetInput.parse(args).documentId).inspect(options?.signal),
  });

  useWebMCP({
    ...workspaceTools.verify,
    inputSchema: inspectSchema,
    annotations: readOnly,
    execute: (args, options) => client(targetInput.parse(args).documentId).verify(options?.signal),
  });

  useWebMCP({
    ...workspaceTools.documents, inputSchema: emptySchema, annotations: readOnly,
    execute: (_, options) => client().documents(options?.signal),
  });
  useWebMCP({
    ...workspaceTools.capabilities, inputSchema: emptySchema, annotations: readOnly,
    execute: (_, options) => client().capabilities(options?.signal),
  });
  useWebMCP({
    ...workspaceTools.history, inputSchema: inspectSchema, annotations: readOnly,
    execute: (args, options) => client(targetInput.parse(args).documentId).history(options?.signal),
  });
  useWebMCP({
    ...workspaceTools.create, inputSchema: createSchema, annotations: sceneOutput,
    execute: (args, options) => changed(client().create(createInput.parse(args), options?.signal)),
  });
  useWebMCP({
    ...workspaceTools.restore, inputSchema: restoreSchema, annotations: sceneOutput,
    execute: (args, options) => {
      const input = restoreInput.parse(args);
      return changed(client(input.documentId).restore(input.targetRevision, input.revision, options?.signal));
    },
  });
  useWebMCP({
    ...workspaceTools.compose, inputSchema: diagramJsonSchema, annotations: sceneOutput,
    execute: (args, options) => {
      const input = diagramInput.parse(args);
      return changed(client(input.documentId).compose(input, options?.signal));
    },
  });
  useWebMCP({
    ...workspaceTools.plot, inputSchema: plotJsonSchema, annotations: sceneOutput,
    execute: (args, options) => {
      const input = plotInput.parse(args);
      return changed(client(input.documentId).plot(input, options?.signal));
    },
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
      const { format, revision: expected, documentId, scale, outlineText } = exportInput.parse(args);
      const response = await client(documentId).export(format, expected, options?.signal, { scale, outlineText });
      const revision = response.headers.get('x-grapher-revision');
      const description = { type: 'text', text: JSON.stringify({ format, revision, documentId: response.headers.get('x-grapher-document') }) };
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
        resource: { uri: response.url, mimeType: format === 'pdf' ? 'application/pdf' : 'model/gltf-binary', blob: data },
      }] };
    },
  });

  return inspect.registered;
}
