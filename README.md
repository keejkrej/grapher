# Grapher

Grapher is a local prototype for agents that create and revise graphics. It gives an agent an editable scene, a deterministic verification report, and a rendered artifact to inspect before handing off the work.

## Run the studio

Requires Node.js 22.12 or later.

```sh
npm install
npm run dev
```

Open [the local studio](http://localhost:5173). Orbital Mechanics starts at **6/8** checks. Select an issue to find its layer, or use **Auto-fix issues** to correct both seeded findings and get to **8/8**. **Samples** loads editable scenes that share the same document model and tools. Cryo Cache contains raster and 3D layers, and its **3D** control opens another view of those meshes.

The server holds one shared workspace in memory. Restarting it reloads Orbital Mechanics. Export JSON to keep a scene and reopen it using the CLI.

## Run the agent loop

1. Inspect the scene and its revision.
2. Apply an atomic batch of layer operations with that revision.
3. Verify the new scene. Apply suggested repairs or edit the flagged layers.
4. Export PNG with the resulting revision and visually inspect it. Export SVG for vector delivery, GLB for visible 3D primitives, or JSON to preserve the editable scene.

```sh
npm run --silent cli -- inspect
npm run --silent cli -- verify
npm run --silent cli -- repair --revision 1
npm run --silent cli -- export png orbital.png --revision 2
npm run --silent cli -- export json orbital.json --revision 2
npm run --silent cli -- verify orbital.json
```

The example revision numbers assume a fresh server. `verify` returns exit code 2 when there are findings. A stale revision returns HTTP 409, so fetch the latest scene before retrying.

`apply` takes a JSON array. For example, save the following as `edit.json` and run `npm run --silent cli -- apply edit.json --revision 2`.

```json
[
  { "op": "update", "id": "node-caption", "patch": { "fill": "#414039" } }
]
```

### MCP and WebMCP

Run the stdio server with the repository as its working directory.

```sh
node --import tsx src/mcp.ts
```

Configure your MCP client to launch that command. Keep the local studio server running. Set `GRAPHER_URL` to target a different workspace.

The studio also registers native WebMCP tools when the browser exposes the API. Both transports expose `grapher_inspect`, `grapher_apply`, `grapher_replace`, `grapher_verify`, `grapher_repair`, and `grapher_export`. PNG export returns image content for a vision-capable agent. [Chrome WebMCP setup](https://developer.chrome.com/docs/ai/webmcp/)

### Studio agent console

The console uses Vercel AI SDK UI for streamed messages. Built-in verification, repair, and example commands work without credentials. For open-ended briefs, add your Vercel AI Gateway key to a local `.env.local` and restart the server. `GRAPHER_MODEL` optionally selects a Gateway model with tool and image input support. The default is `openai/gpt-5-mini`. The model can inspect, edit, verify, repair, and review a rendered PNG inside one run. [AI SDK UI](https://ai-sdk.dev/docs/reference/ai-sdk-ui)

## Implementation

TypeScript and Zod define the scene and edit operations. React and Vite run the studio. The scene renderer emits SVG, Resvg rasterizes it to PNG, and Three.js and glTF Transform provide the live 3D view and GLB export.

The interface uses Vercel's UI SDK through `@ui-sdk/core` and `@ui-sdk/react`, pinned to `0.1.0-beta.3`. It supplies the sample and export menus, sidebar tabs, toolbar buttons, keyboard navigation, focus handling, and component semantics. Its agent bridge registers `snapshot`, `query`, and `act` WebMCP tools before React renders, alongside Grapher's scene tools. AI SDK UI handles the streamed console messages. [Vercel UI SDK](https://github.com/vercel-labs/ui)

The checks cover document structure, bounds, sampled text contrast, raster references, shape geometry, visibility, and layer identifiers. Text bounds are estimated and SVG path bounds are declared by the author. Scientific accuracy, composition, and readability still call for visual or domain review. Raster layers accept embedded PNG/JPEG and can be composited into the artboard. The 3D prototype supports cubes, spheres, and tori.

The [graphics editor research](docs/research/graphics-modes.md) compares document models, workspaces, editing modes, and views across the requested products and proposes an architecture for Grapher.
