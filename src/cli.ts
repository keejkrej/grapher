import { readFile, writeFile } from 'node:fs/promises';
import { stdin, stdout } from 'node:process';
import { parseArgs } from 'node:util';
import { sceneSchema } from './engine';
import { applyInput, createInput, defaultWorkspaceUrl, diagramInput, exportInput, plotInput, repairInput, replaceInput, restoreInput, workspaceClient } from './workspace-client';

const usage = `Grapher

Usage: npm run --silent cli -- <command> [arguments] [--document ID] [--revision N]

  inspect                   Print the open workspace, revision and checks
  documents                 List saved documents and their IDs
  capabilities              Discover formats, fonts, samples, schemas and limits
  create [scene.json]        Create a document; accepts --template ID and --name TEXT
  history                   List revisions for the selected document
  restore N                 Restore historical revision N as a new revision
  compose diagram.json      Compile a structured graph; --create saves a new document
  plot data.json            Compile a line, scatter or bar figure; accepts --create
  verify [scene.json]       Check the workspace or a saved scene (exit 2 on findings)
  apply operations.json     Apply a JSON array of edit operations to the workspace
  repair                    Apply supported fixes and verify the workspace again
  replace scene.json        Open a full scene in the workspace
  export svg|png|pdf|glb|json [output]
                            Export the open workspace to a file or stdout
  render scene.json [output.svg]
                            Render a saved scene to SVG offline

Pass - in place of an input filename to read JSON from stdin. The workspace
defaults to ${defaultWorkspaceUrl}. Set GRAPHER_URL or pass --url to override.
Pass --document ID to target a saved document. Omit to target the default document.
Pass --revision N for optimistic concurrency on edits, restore, compose and export.
Export options: --scale 0.1..4 for PNG, --outline-text for portable SVG paths.
Connection: --url URL overrides GRAPHER_URL.`;

async function readJson(filename: string) {
  if (filename !== '-') return JSON.parse(await readFile(filename, 'utf8'));
  const chunks: Buffer[] = [];
  for await (const chunk of stdin) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function print(value: unknown) {
  stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

async function output(data: string | Uint8Array, filename?: string) {
  if (filename && filename !== '-') await writeFile(filename, data);
  else stdout.write(data);
}

async function main() {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: {
      revision: { type: 'string' }, document: { type: 'string' }, url: { type: 'string' },
      scale: { type: 'string' }, 'outline-text': { type: 'boolean' },
      template: { type: 'string' }, name: { type: 'string' }, create: { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
    },
  });
  const [command, input, destination] = positionals;
  if (!command || command === 'help' || values.help) {
    stdout.write(`${usage}\n`);
    return;
  }

  const target = repairInput.parse({ documentId: values.document, revision: values.revision === undefined ? undefined : Number(values.revision) });
  const { revision } = target;
  const workspace = workspaceClient(values.url ?? process.env.GRAPHER_URL ?? defaultWorkspaceUrl, target.documentId);
  const argumentLimits: Record<string, [number, number]> = {
    inspect: [0, 0], verify: [0, 1], apply: [1, 1], repair: [0, 0],
    replace: [1, 1], export: [1, 2], render: [1, 2],
    documents: [0, 0], capabilities: [0, 0], create: [0, 1], history: [0, 0], restore: [1, 1], compose: [1, 1], plot: [1, 1],
  };
  const limits = Object.hasOwn(argumentLimits, command) ? argumentLimits[command] : undefined;
  if (!limits) throw new Error(`Unknown command “${command}”. Run with --help for usage.`);
  if (positionals.length - 1 < limits[0] || positionals.length - 1 > limits[1]) {
    throw new Error(`Invalid arguments to “${command}”. Run with --help for usage.`);
  }

  switch (command) {
    case 'inspect':
      print(await workspace.inspect());
      break;
    case 'documents':
      print(await workspace.documents());
      break;
    case 'capabilities':
      print(await workspace.capabilities());
      break;
    case 'create':
      print(await workspace.create(createInput.parse({ scene: input ? await readJson(input) : undefined, template: values.template, name: values.name })));
      break;
    case 'history':
      print(await workspace.history());
      break;
    case 'restore': {
      const request = restoreInput.parse({ targetRevision: Number(input), revision });
      print(await workspace.restore(request.targetRevision, request.revision));
      break;
    }
    case 'compose':
      print(await workspace.compose(diagramInput.parse({ spec: await readJson(input!), revision, create: values.create })));
      break;
    case 'plot':
      print(await workspace.plot(plotInput.parse({ spec: await readJson(input!), revision, create: values.create })));
      break;
    case 'verify': {
      const report = input ? await (await import('./render')).verifyArtifact(sceneSchema.parse(await readJson(input))) : await workspace.verify();
      print(report);
      if (report.passed !== report.total) process.exitCode = 2;
      break;
    }
    case 'apply':
      print(await workspace.edit({ action: 'apply', ...applyInput.parse({ revision, operations: await readJson(input!) }) }));
      break;
    case 'repair':
      print(await workspace.edit({ action: 'repair', ...repairInput.parse({ revision }) }));
      break;
    case 'replace':
      print(await workspace.edit({ action: 'replace', ...replaceInput.parse({ revision, scene: await readJson(input!) }) }));
      break;
    case 'export': {
      const { format, revision: expected, scale, outlineText } = exportInput.parse({
        format: input, revision, scale: values.scale === undefined ? undefined : Number(values.scale), outlineText: values['outline-text'],
      });
      const response = await workspace.export(format, expected, undefined, { scale, outlineText });
      await output(new Uint8Array(await response.arrayBuffer()), destination);
      break;
    }
    case 'render':
      await output((await import('./render')).portableSvg(sceneSchema.parse(await readJson(input!)), values['outline-text']), destination);
      break;
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`Grapher: ${message}\n`);
  process.exitCode = 1;
});
