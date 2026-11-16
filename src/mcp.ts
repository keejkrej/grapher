import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { applyInput, defaultWorkspaceUrl, exportInput, repairInput, replaceInput, workspaceClient, workspaceTools } from './workspace-client';

const baseUrl = process.env.GRAPHER_URL ?? defaultWorkspaceUrl;
const workspace = workspaceClient(baseUrl);
const server = new McpServer({ name: 'grapher', version: '0.1.0' }, {
  instructions: 'Inspect the active workspace. Create or edit a scene, then verify it, fix findings and export a PNG for visual review. Pass the last observed revision when making changes. The Grapher web app must be running.',
});

function jsonResult(value: Record<string, unknown>): CallToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value };
}

const readOnly = { readOnlyHint: true };

server.registerTool(workspaceTools.inspect.name, { ...workspaceTools.inspect, annotations: readOnly }, async ({ signal }) => {
  return jsonResult(await workspace.inspect(signal));
});

server.registerTool(workspaceTools.verify.name, { ...workspaceTools.verify, annotations: readOnly }, async ({ signal }) => {
  return jsonResult(await workspace.verify(signal));
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

server.registerTool(workspaceTools.export.name, { ...workspaceTools.export, inputSchema: exportInput, annotations: readOnly }, async ({ format, revision: expected }, { signal }) => {
  const response = await workspace.export(format, expected, signal);
  const revision = response.headers.get('x-grapher-revision');
  const description = { type: 'text' as const, text: JSON.stringify({ format, revision }) };
  if (format === 'svg' || format === 'json') {
    return { content: [description, { type: 'text', text: await response.text() }] };
  }

  const data = Buffer.from(await response.arrayBuffer()).toString('base64');
  if (format === 'png') {
    return { content: [description, { type: 'image', data, mimeType: 'image/png' }] };
  }

  return { content: [description, {
    type: 'resource',
    resource: { uri: response.url, mimeType: 'model/gltf-binary', blob: data },
  }] };
});

await server.connect(new StdioServerTransport());
