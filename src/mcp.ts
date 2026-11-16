import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { applyInput, createInput, defaultWorkspaceUrl, diagramInput, exportInput, plotInput, repairInput, replaceInput, restoreInput, targetInput, workspaceClient, workspaceTools } from './workspace-client';

const baseUrl = process.env.GRAPHER_URL ?? defaultWorkspaceUrl;
const workspace = workspaceClient(baseUrl);
function target(documentId?: string) { return workspaceClient(baseUrl, documentId); }
const server = new McpServer({ name: 'grapher', version: '0.2.0' }, {
  instructions: 'Discover capabilities and list saved documents. Inspect a document, compose a structured diagram or edit its layers, then verify it, fix findings and export a PNG for visual review. Pass documentId and the last observed revision when making changes. Restore history as a new revision if needed. The Grapher workspace server must be running.',
});

function jsonResult(value: Record<string, unknown>): CallToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value };
}

const readOnly = { readOnlyHint: true };

server.registerTool(workspaceTools.inspect.name, { ...workspaceTools.inspect, inputSchema: targetInput, annotations: readOnly }, async ({ documentId }, { signal }) => {
  return jsonResult(await target(documentId).inspect(signal));
});

server.registerTool(workspaceTools.verify.name, { ...workspaceTools.verify, inputSchema: targetInput, annotations: readOnly }, async ({ documentId }, { signal }) => {
  return jsonResult(await target(documentId).verify(signal));
});

server.registerTool(workspaceTools.documents.name, { ...workspaceTools.documents, annotations: readOnly }, async ({ signal }) => {
  return jsonResult(await workspace.documents(signal));
});

server.registerTool(workspaceTools.capabilities.name, { ...workspaceTools.capabilities, annotations: readOnly }, async ({ signal }) => {
  return jsonResult(await workspace.capabilities(signal));
});

server.registerTool(workspaceTools.history.name, { ...workspaceTools.history, inputSchema: targetInput, annotations: readOnly }, async ({ documentId }, { signal }) => {
  return jsonResult(await target(documentId).history(signal));
});

server.registerTool(workspaceTools.create.name, { ...workspaceTools.create, inputSchema: createInput }, async (args, { signal }) => {
  return jsonResult(await workspace.create(args, signal));
});

server.registerTool(workspaceTools.restore.name, { ...workspaceTools.restore, inputSchema: restoreInput }, async ({ documentId, targetRevision, revision }, { signal }) => {
  return jsonResult(await target(documentId).restore(targetRevision, revision, signal));
});

server.registerTool(workspaceTools.compose.name, { ...workspaceTools.compose, inputSchema: diagramInput }, async (args, { signal }) => {
  return jsonResult(await target(args.documentId).compose(args, signal));
});

server.registerTool(workspaceTools.plot.name, { ...workspaceTools.plot, inputSchema: plotInput }, async (args, { signal }) => {
  return jsonResult(await target(args.documentId).plot(args, signal));
});

server.registerTool(workspaceTools.apply.name, { ...workspaceTools.apply, inputSchema: applyInput }, async (args, { signal }) => {
  return jsonResult(await workspace.edit({ action: 'apply', ...args }, signal));
});

server.registerTool(workspaceTools.replace.name, { ...workspaceTools.replace, inputSchema: replaceInput }, async (args, { signal }) => {
  return jsonResult(await workspace.edit({ action: 'replace', ...args }, signal));
});

server.registerTool(workspaceTools.repair.name, { ...workspaceTools.repair, inputSchema: repairInput }, async (args, { signal }) => {
  return jsonResult(await workspace.edit({ action: 'repair', ...args }, signal));
});

server.registerTool(workspaceTools.export.name, { ...workspaceTools.export, inputSchema: exportInput, annotations: readOnly }, async ({ format, revision: expected, documentId, scale, outlineText }, { signal }) => {
  const response = await target(documentId).export(format, expected, signal, { scale, outlineText });
  const revision = response.headers.get('x-grapher-revision');
  const description = { type: 'text' as const, text: JSON.stringify({ format, revision, documentId: response.headers.get('x-grapher-document') }) };
  if (format === 'svg' || format === 'json') {
    return { content: [description, { type: 'text', text: await response.text() }] };
  }

  const data = Buffer.from(await response.arrayBuffer()).toString('base64');
  if (format === 'png') {
    return { content: [description, { type: 'image', data, mimeType: 'image/png' }] };
  }

  return { content: [description, {
    type: 'resource',
    resource: { uri: response.url, mimeType: format === 'pdf' ? 'application/pdf' : 'model/gltf-binary', blob: data },
  }] };
});

await server.connect(new StdioServerTransport());
