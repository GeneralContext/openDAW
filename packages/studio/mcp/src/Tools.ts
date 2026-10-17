import {writeFileSync} from "node:fs"
import {join} from "node:path"
import {int, isDefined, Optional} from "@opendaw/lib-std"
import {PPQN} from "@opendaw/lib-dsp"
import {ProjectImpl} from "@opendaw/studio-scripting"
import {docs} from "./Guide"
import {formatPosition, inspect, overview, readProject} from "./Overview"
import {encodeWav, Render, renderProject} from "./Render"
import {formatRecord, graphBytes, runRequest, undoRequest} from "./Requests"
import {RequestRecord, Workspace} from "./Workspace"

export type ToolResult = {text: string, ok: boolean}

export type Tool = {
    name: string
    description: string
    inputSchema: Record<string, unknown>
    call(workspace: Workspace, args: Record<string, unknown>): Promise<ToolResult>
}

export type RenderRequest = {name?: string, fromBar?: int, toBar?: int, seconds?: number, stems?: boolean}

export const REQUESTS_PATH = "requests"

const RECENT_REQUESTS = 5

const object = (properties: Record<string, unknown>, required: ReadonlyArray<string> = []) =>
    ({type: "object", properties, required, additionalProperties: false})

const text = (value: unknown): Optional<string> => typeof value === "string" ? value : undefined
const count = (value: unknown): Optional<number> => typeof value === "number" ? value : undefined

const done = (text: string): ToolResult => ({text, ok: true})

const outcome = (record: RequestRecord): ToolResult =>
    ({text: formatRecord(record), ok: record.status === "applied" || record.status === "unchanged"})

const requestLine = (record: RequestRecord): string =>
    `${record.id}  ${record.status.padEnd(9)} ${record.kind === "undo" ? `undo of ${record.target}` : record.label}`

export const status = (workspace: Workspace): string => {
    const sections = [overview(readProject(graphBytes(workspace.loadGraph())))]
    const records = workspace.records()
    if (records.length > 0) {
        const older = records.length > RECENT_REQUESTS ? `; ${records.length - RECENT_REQUESTS} older: read requests` : ""
        sections.push(`Last requests (newest last; undo takes back the newest applied one${older}):\n` +
            records.slice(-RECENT_REQUESTS).map(record => `  ${requestLine(record)}`).join("\n"))
    }
    return sections.join("\n\n")
}

export const read = (workspace: Workspace, path: string): string => {
    if (path.trim() !== REQUESTS_PATH) {return inspect(readProject(graphBytes(workspace.loadGraph())), path)}
    const records = workspace.records()
    return records.length === 0 ? "No requests yet." : records.map(requestLine).join("\n")
}

const dbfs = (value: number): string => value <= 0 ? "-inf dBFS" : `${(20 * Math.log10(value)).toFixed(1)} dBFS`

const describeRender = (path: string, render: Render): string => {
    const clipped = render.channels.reduce((sum, channel) => sum + channel.filter(sample => Math.abs(sample) >= 1).length, 0)
    const parts = [`${path}: ${render.seconds.toFixed(2)} s, ${render.sampleRate} Hz stereo, peak ${dbfs(render.peak)}, RMS ${dbfs(render.rms)}`]
    if (clipped > 0) {parts.push(`, ${clipped} clipped samples`)}
    if (render.missingSamples.length > 0) {parts.push(`, silent missing samples: ${render.missingSamples.join(", ")}`)}
    return parts.join("")
}

const fileName = (name: string): string => name.replace(/[^\w.-]/g, "_")

export const render = async (workspace: Workspace, request: RenderRequest): Promise<string> => {
    const graph = graphBytes(workspace.loadGraph())
    const project = readProject(graph)
    const bar = PPQN.Quarter * 4 / project.timeSignature.denominator * project.timeSignature.numerator
    const options = {
        samples: async (uuid: string) => workspace.loadSample(uuid), allowMissing: true, seconds: request.seconds,
        fromPpqn: isDefined(request.fromBar) ? (request.fromBar - 1) * bar : undefined,
        toPpqn: isDefined(request.toBar) ? request.toBar * bar : undefined
    }
    const name = fileName(request.name ?? `mix-${workspace.records().length}`)
    const write = async (file: string, bytes: Uint8Array): Promise<string> => {
        const rendered = await renderProject(bytes, options)
        const path = join(workspace.rendersDirectory, file)
        writeFileSync(path, encodeWav(rendered, 24))
        return describeRender(path, rendered)
    }
    const lines = [await write(`${name}.wav`, graph)]
    if (request.stems === true) {
        const stems = project.instrumentUnits.map(unit => fileName(unit.label) || "instrument")
        for (const [index, stem] of stems.entries()) {
            const solo = readProject(graph) as ProjectImpl
            solo.instrumentUnits.forEach((other, position) => other.mute = position !== index)
            const repeated = stems.filter(other => other === stem).length > 1
            const file = repeated ? `${stem}-${stems.slice(0, index + 1).filter(other => other === stem).length}` : stem
            lines.push(await write(`${name}.${file}.wav`, graphBytes(solo.context.boxGraph)))
        }
    }
    const range = isDefined(options.fromPpqn) ? ` from bar ${formatPosition(project, options.fromPpqn)}` : ""
    return [`Rendered with openDAW's engine${range}:`, ...lines.map(line => `  ${line}`)].join("\n")
}

export const TOOLS: ReadonlyArray<Tool> = [
    {
        name: "status",
        description: "Overview of the project: tempo, units with instruments, mixer and effects, tracks, regions with note ranges, " +
            "markers, and the script path of every object, followed by your last requests with their ids.",
        inputSchema: object({}),
        call: async workspace => done(status(workspace))
    },
    {
        name: "read",
        description: "Details of one object by its script path from the overview, e.g. instrument(\"Lead\", \"Vaporisateur\").instrument " +
            "for synth parameters or instrument(\"Lead\", \"Vaporisateur\").noteTracks[0].regions[0] for a note table. " +
            "The path requests lists all requests.",
        inputSchema: object({path: {type: "string"}}, ["path"]),
        call: async (workspace, args) => done(read(workspace, text(args.path) ?? "project"))
    },
    {
        name: "run",
        description: "Run a TypeScript request against the openDAW Script API. Globals: project, instrument(label, type?), unit(label), " +
            "PPQN (Quarter = 960 ticks), console.log. All edits apply together as one undoable request; a script that only reads changes " +
            "nothing and returns its console output. Type errors are reported with line numbers before anything runs. Call docs for the guide.",
        inputSchema: object({script: {type: "string", description: "TypeScript code"},
            label: {type: "string", description: "Short description of the change"}}, ["script", "label"]),
        call: async (workspace, args) => outcome(await runRequest(workspace, text(args.script) ?? "", text(args.label) ?? "request"))
    },
    {
        name: "undo",
        description: "Take back the newest applied request. Call it again to take back the one before.",
        inputSchema: object({}),
        call: async workspace => {
            const record = await undoRequest(workspace)
            return isDefined(record) ? outcome(record) : {text: "No applied request to undo.", ok: false}
        }
    },
    {
        name: "render",
        description: "Render the song with openDAW's audio engine to 24-bit WAV files in the workspace and report length, peak and RMS. " +
            "stems: also one file per instrument. fromBar/toBar: 1-based bar range.",
        inputSchema: object({name: {type: "string"}, fromBar: {type: "integer", minimum: 1}, toBar: {type: "integer", minimum: 1},
            seconds: {type: "number", exclusiveMinimum: 0}, stems: {type: "boolean"}}),
        call: async (workspace, args) => done(await render(workspace, {name: text(args.name), fromBar: count(args.fromBar),
            toBar: count(args.toBar), seconds: count(args.seconds), stems: args.stems === true}))
    },
    {
        name: "docs",
        description: "Without a query: the guide with conventions and examples. With a query: matching Script API declarations, " +
            "e.g. \"Vaporisateur\", \"addRegion\", \"DelayEffect\", \"globals\".",
        inputSchema: object({query: {type: "string"}}),
        call: async (_workspace, args) => done(docs(text(args.query)))
    }
]
