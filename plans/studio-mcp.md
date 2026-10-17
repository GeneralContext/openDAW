# MCP Server for the Script API

A proposal for openDAW. The package is `packages/studio/mcp` on the `studio-mcp` branch of this fork; the questions
below are open.

Let an agent (any MCP client, or a shell) edit an openDAW project through the Script API without a browser, and
hear it through the real WASM engine. The agent writes ordinary Script API code; the server checks it, runs it on a
copy of the project, applies its edits as one undoable step, and renders.

## Tools

| Tool | Does |
| --- | --- |
| `status` | Overview: tempo, signature, units with instrument, volume, pan, effects and routing, tracks, regions with note ranges, markers, and the script path of every object |
| `read` | One object by script path, e.g. `instrument("Lead").noteTracks[0].regions[0]` (a note table) |
| `run` | A request: TypeScript against the Script API, with `project`, `instrument(label, key?)`, `unit(label)` and `console` |
| `undo` | Takes back the newest applied request |
| `render` | Mix, bar range or stems to WAV, with length, peak and RMS |
| `docs` | A short guide, or the API declarations matching a query |

The same tools run as commands (`studio-mcp run FILE.ts`) for agents that work in a shell.

## Mechanics

1. A request is type-checked against `api.declaration.d.ts` plus the request globals, with TypeScript's ES2022
   library, so mistakes come back with line numbers before anything runs.
2. It runs in a `worker_threads` worker: `ApiImpl` over a Node `ScriptHostProtocol`, `project` from
   `getProject()`, `ScriptGlobals` as in the studio. The worker records the immediate updates of every committed
   transaction, calls `validate()` at the end, and returns the updates. `openInStudio()` only validates; the edits
   apply when the script ends.
3. The host replays the updates in one transaction and records what `subscribeToAllUpdates` sees, optimised with
   `optimizeUpdates`, as `BoxEditing` does. It saves the project with `ProjectSkeleton.encode` as `project.od`.
4. Undo inverts the recorded updates in one transaction, as `Modification.inverse` does. It refuses when
   `graph.checksum()` differs from the checksum after the request, that is, when something else changed the
   project file in between.
5. The host protocol in Node: `renderMixdown` renders with the Node renderer, `saveFile` writes to `renders/`,
   `addSample` and `listSamples` use `samples/`.
6. The Node renderer follows `boot.ts`: it instantiates the engine and the device modules, registers the
   composites, streams the project as one full snapshot (`serializeUpdateTasks`), resolves samples, soundfonts and
   NAM models, and renders quanta with the transport range applied.

## Questions

1. Location: `packages/studio/mcp` as `@opendaw/studio-mcp`?
2. The renderer imports seven modules from `studio-core-wasm/src` (`boot`, `engine-exports`, `engine-modules`,
   `device-linker`, `nam-bridge`, `script-bridge`, `sync/serialize-update-tasks`), which the lint rules forbid.
   Options: (a) the renderer moves into `studio-core-wasm` as a Node export next to `offline-worker.ts`;
   (b) `offline-worker.ts` runs in a Node worker with a port adapter, so there is one offline path; (c)
   `studio-core-wasm` exports the seven modules.
3. Requests apply their edits without `openInStudio()`. Should the host use `applyUpdates(updates, checksum)`
   instead? It would need the replaced values for undo, which `UpdateTask` does not carry.
4. Later: the same tools against the project open in a studio tab, with the studio as the host. Out of scope for
   the first pull requests.
5. Found while testing: the WASM engine plays no sound for the Vaporisateur's noise generator, and a headless
   render cannot fetch WebCLAP bundles.

## Pull requests

Small and in order, each with its tests:

1. This plan.
2. The script runner: type check, worker, update codec.
3. Workspace, requests, undo and the overview.
4. The Node renderer, in the place question 2 decides.
5. The tools, the MCP server (stdio, newline-delimited JSON-RPC, no SDK), the command line and the guide.

## Files

| File | Lines | Purpose |
| --- | --- | --- |
| `Script.ts`, `ScriptWorker.ts`, `UpdateCodec.ts` | 307 | Type check, worker, updates as bytes |
| `Workspace.ts`, `Requests.ts` | 311 | Project file, request history, lock, apply and undo |
| `Overview.ts` | 204 | Overview, `read`, overview diffs |
| `Render.ts`, `Wav.ts` | 478 | Node renderer, WAV files |
| `Tools.ts`, `Mcp.ts`, `cli.ts`, `Guide.ts`, `index.ts` | 437 | Tools, MCP server, command line, guide |

## Tests

36 vitest tests in `src/test` (795 lines with the fixture): type errors and runtime lines, timeouts, edits returned without
touching the source, requests applied or refused as a whole, undo back to the same checksum, undo refused after an
outside change, concurrent requests in one process and in two, samples and `mixdown()` inside a request, the guide's
examples as one request, the MCP exchange, the command line, and the renderer (timing, ranges, tails, tempo maps,
samples, soundfonts, bit-identical renders, faster than real time).

## How this was written

- Claude Code (Claude Opus 5.5) wrote the code, split from musicbench's `daw` agent tool, which agents have used in
  musicbench's evaluation tasks. The split removes the room sync layer: one project file, one writer at a time.
- Style: openDAW's `CLAUDE.md` and eslint configuration. The only lint errors left are the imports of question 2.
- Built and tested in this repository at 0c66d11 with no other changes to openDAW: `tsc` passes and the 36 tests
  pass. The engine and device modules built here are bit-identical to the ones musicbench's tests ran against.
- Before each pull request to openDAW, the contributor reads every line and can explain it.
