# studio-mcp

An MCP server and command line that edit an openDAW project with the openDAW Script API, without a browser, and
render it with openDAW's WASM engine. An agent (any MCP client, or a shell) writes ordinary Script API code; the
server checks it, runs it on a copy of the project, applies its edits as one undoable step, and renders. The plan is
in [plans/studio-mcp.md](../../../plans/studio-mcp.md).

The agent works through six tools, as MCP tools (`studio-mcp serve`) or as commands:

| Tool | Does |
| --- | --- |
| `status` | The project overview (tempo, units, effects, tracks, regions, markers, the script path of each object) and the last requests |
| `read PATH` | Details of one object by its script path; a region shows its notes; `read requests` lists all requests |
| `run` | Runs a TypeScript request against the Script API. All its edits apply as one step, or none do |
| `undo` | Takes back the newest applied request; again for the one before |
| `render` | Renders the mix, a bar range, or one stem per instrument to 24-bit WAV files |
| `docs QUERY` | The guide, or Script API declarations that match the query |

A request type-checks against the Script API declarations, runs in a worker thread on a copy of the project, and
returns its edits as openDAW updates. The edits are applied to the project in one transaction and saved; undo
inverts them as openDAW's own undo history does, and refuses when the project changed outside these tools after
the request. A request can also call `project.mixdown()` (rendered here with the same engine) and
`openDAW.saveFile(...)`, and add or list samples.

A workspace is a directory:

| Path | Holds |
| --- | --- |
| `project.od` | The project, in the file format the studio opens |
| `requests/` | Each request's script and result, numbered; undo reads the edits from here |
| `renders/` | WAV files from `render`, `mixdown()` and `saveFile` |
| `samples/` | `index.json` and WAV files that requests add and the renderer plays |

```sh
npm ci && npx turbo run build --filter=@opendaw/studio-mcp...   # at the repository root
cd packages/studio/mcp
bin/studio-mcp init --dir /tmp/song                              # a new project, or --from FILE.od
bin/studio-mcp run --dir /tmp/song -e 'project.bpm = 96'
bin/studio-mcp serve --dir /tmp/song                             # MCP over stdio
npm run distribution -- /tmp/studio-mcp                          # a self-contained copy with its source reference
```

An MCP client starts it as `studio-mcp serve --dir DIR`, for example
`claude mcp add opendaw -- /path/to/packages/studio/mcp/bin/studio-mcp serve --dir /tmp/song`.

Commands exit with 1 when the tool fails and 3 when a request was not applied. `npm test` runs the tests and
`npx tsc -p .` checks types.

## Benchmark graders

`studio-mcp-verify` (`src/Verify.ts`, `src/VerifyCli.ts`) is for the graders of benchmark tasks and is not part of
the proposal in the plan. It applies a workspace's requests again from the task's starting project, checks that
each one makes the project it recorded and that `project.od` is the result, checks a policy (no script devices
unless allowed, only the supplied samples, optionally no audio tracks), and writes `verification.json`,
`project.json` (the audible notes of every part in seconds) and, with `--render`, `final.wav` and `render.json`. It
exits with 2 when the workspace is invalid. `--run-scripts` renders script devices by running their JavaScript in the
verifier's process, so a grader runs it as a user that cannot read the task's hidden files. `studio-mcp render` runs
the workspace's own script devices. See `studio-mcp-verify --help`.
