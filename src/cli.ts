import { readFile, writeFile } from 'node:fs/promises';
import { stdin, stdout } from 'node:process';
import { parseArgs } from 'node:util';
import { sceneSchema, sceneSvg, verifyScene } from './engine';
import { applyInput, defaultWorkspaceUrl, exportInput, repairInput, replaceInput, workspaceClient } from './workspace-client';

const usage = `Grapher prototype

Usage: npm run --silent cli -- <command> [arguments] [--revision N] [--url URL]

  inspect                   Print the open workspace, revision and checks
  verify [scene.json]       Check the workspace or a saved scene (exit 2 on findings)
  apply operations.json     Apply a JSON array of edit operations to the workspace
  repair                    Apply supported fixes and verify the workspace again
  replace scene.json        Open a full scene in the workspace
  export svg|png|glb|json [output]
                            Export the open workspace to a file or stdout
  render scene.json [output.svg]
                            Render a saved scene to SVG offline

Pass - in place of an input filename to read JSON from stdin. The workspace
defaults to ${defaultWorkspaceUrl}. Set GRAPHER_URL or pass --url to override.
Pass --revision N with apply, repair, replace or export to require revision N.`;

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
    options: { revision: { type: 'string' }, url: { type: 'string' }, help: { type: 'boolean', short: 'h' } },
  });
  const [command, input, destination] = positionals;
  if (!command || command === 'help' || values.help) {
    stdout.write(`${usage}\n`);
    return;
  }

  const workspace = workspaceClient(values.url ?? process.env.GRAPHER_URL ?? defaultWorkspaceUrl);
  const revision = values.revision === undefined ? undefined : Number(values.revision);
  const argumentLimits: Record<string, [number, number]> = {
    inspect: [0, 0], verify: [0, 1], apply: [1, 1], repair: [0, 0],
    replace: [1, 1], export: [1, 2], render: [1, 2],
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
    case 'verify': {
      const report = input ? verifyScene(sceneSchema.parse(await readJson(input))) : await workspace.verify();
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
      const { format, revision: expected } = exportInput.parse({ format: input, revision });
      const response = await workspace.export(format, expected);
      await output(new Uint8Array(await response.arrayBuffer()), destination);
      break;
    }
    case 'render':
      await output(sceneSvg(sceneSchema.parse(await readJson(input!))), destination);
      break;
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`Grapher: ${message}\n`);
  process.exitCode = 1;
});
