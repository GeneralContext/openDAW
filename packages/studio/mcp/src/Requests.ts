import {writeFileSync} from "node:fs"
import {join} from "node:path"
import {Exec, isDefined, Nullable, panic, tryCatch, UUID} from "@opendaw/lib-std"
import {AudioData} from "@opendaw/lib-dsp"
import {BoxGraph, Field, optimizeUpdates, Update} from "@opendaw/lib-box"
import {diffLines, overview, readProject} from "./Overview"
import {renderProject} from "./Render"
import {runScript, ScriptOptions, ScriptServices} from "./Script"
import {decodeUpdates, encodeUpdates} from "./UpdateCodec"
import {RequestRecord, RequestStatus, Workspace} from "./Workspace"

export const graphBytes = (graph: BoxGraph): Uint8Array => new Uint8Array(graph.toArrayBuffer())

export const checksumOf = (graph: BoxGraph): string => {
    const checksum = graph.checksum()
    return Buffer.from(checksum.buffer, checksum.byteOffset, checksum.byteLength).toString("hex")
}

// What undo inverts, recorded and optimised as openDAW's own undo history records it.
const transact = (graph: BoxGraph, procedure: Exec): ReadonlyArray<Update> => {
    const applied: Array<Update> = []
    const subscription = graph.subscribeToAllUpdates({onUpdate: update => {applied.push(update)}})
    graph.beginTransaction()
    const result = tryCatch(() => {
        procedure()
        graph.endTransaction()
    })
    subscription.terminate()
    if (result.status === "success") {return optimizeUpdates(applied)}
    if (graph.inTransaction()) {graph.abortTransaction()}
    return panic(result.error)
}

const messageOf = (error: unknown): string => error instanceof Error ? error.message : String(error)

// Created and deleted boxes, and changed fields of other boxes, such as "+1 AudioUnitBox, 18 NoteEventBox.duration".
export const describeUpdates = (graph: BoxGraph, updates: ReadonlyArray<Update>): string => {
    const counts = new Map<string, number>()
    const count = (key: string) => counts.set(key, (counts.get(key) ?? 0) + 1)
    const replaced = new Set(updates.flatMap(update => update.type === "new" || update.type === "delete" ? [UUID.toString(update.uuid)] : []))
    updates.forEach(update => {
        if (update.type === "new") {
            count(`+ ${update.name}`)
        } else if (update.type === "delete") {
            count(`- ${update.name}`)
        } else if (!replaced.has(UUID.toString(update.address.uuid))) {
            const box = graph.findBox(update.address.uuid).mapOr(box => box.name, "deleted")
            const field = graph.findVertex(update.address).mapOr(vertex => vertex instanceof Field ? vertex.fieldName : "?", "?")
            count(`${box}.${field}`)
        }
    })
    return Array.from(counts, ([key, value]) => key.startsWith("+ ") || key.startsWith("- ")
        ? `${key[0]}${value} ${key.slice(2)}` : `${value} ${key}`).join(", ")
}

export const scriptServices = (workspace: Workspace): ScriptServices => ({
    addSample: async (data, name) => workspace.addSample(data, name),
    listSamples: async () => workspace.listSamples(),
    renderMixdown: async (project, {sampleRate}) => {
        const render = await renderProject(new Uint8Array(project), {sampleRate, samples: async uuid => workspace.loadSample(uuid), allowMissing: true})
        const audio = AudioData.create(render.sampleRate, render.channels[0].length, render.channels.length)
        render.channels.forEach((channel, index) => audio.frames[index].set(channel))
        return audio
    },
    saveFile: async (data, fileName) => {
        const path = join(workspace.rendersDirectory, fileName.replace(/[\\/]/g, "_"))
        writeFileSync(path, new Uint8Array(data))
        return path
    }
})

type RecordFields = Partial<Omit<RequestRecord, "id" | "label" | "kind" | "target" | "status" | "startedAt" | "finishedAt">>

const recorder = (workspace: Workspace, graph: BoxGraph, base: Pick<RequestRecord, "label" | "kind" | "target">, script: Nullable<string>) => {
    const id = UUID.toString(UUID.generate()).slice(0, 8)
    const startedAt = new Date().toISOString()
    return (status: RequestStatus, fields: RecordFields = {}): RequestRecord => {
        const record: RequestRecord = {id, ...base, status, changes: [], details: "", logs: [], message: null, updates: null,
            checksum: checksumOf(graph), startedAt, finishedAt: new Date().toISOString(), ...fields}
        workspace.saveRecord(record, script)
        return record
    }
}

const request = async (workspace: Workspace, script: string, label: string, options: ScriptOptions): Promise<RequestRecord> => {
    const graph = workspace.loadGraph()
    const project = readProject(graphBytes(graph))
    const finish = recorder(workspace, graph, {label, kind: "request", target: null}, script)
    const run = await runScript(script, graphBytes(graph), project.name, scriptServices(workspace), options)
    if (run.status === "invalid") {
        return finish("invalid", {message: run.diagnostics.map(({line, column, message}) => `line ${line}:${column} ${message}`).join("\n")})
    }
    if (run.status === "timeout") {return finish("timeout", {message: "The script did not finish in time"})}
    if (run.status === "failed") {return finish("failed", {logs: run.logs, message: isDefined(run.line) ? `line ${run.line}: ${run.message}` : run.message})}
    if (run.updates.length === 0) {return finish("unchanged", {logs: run.logs})}
    const applied = tryCatch(() => transact(graph, () => run.updates.forEach(update => update.forward(graph))))
    if (applied.status === "failure") {return finish("failed", {logs: run.logs, message: `The edits could not be applied: ${messageOf(applied.error)}`})}
    workspace.saveGraph(graph)
    return finish("applied", {logs: run.logs, changes: diffLines(overview(project), overview(readProject(graphBytes(graph)))),
        details: describeUpdates(graph, run.updates), updates: Buffer.from(encodeUpdates(applied.value)).toString("base64")})
}

const undo = (workspace: Workspace): Nullable<RequestRecord> => {
    const target = workspace.undoTarget()
    if (!isDefined(target) || !isDefined(target.updates)) {return null}
    const graph = workspace.loadGraph()
    const before = overview(readProject(graphBytes(graph)))
    const finish = recorder(workspace, graph, {label: `Undo ${target.label}`, kind: "undo", target: target.id}, null)
    if (checksumOf(graph) !== target.checksum) {
        return finish("failed", {message: "The project changed outside these tools after that request, so undo cannot take it back safely"})
    }
    const updates = decodeUpdates(Buffer.from(target.updates, "base64"))
    const inverted = tryCatch(() => transact(graph, () => updates.toReversed().forEach(update => update.inverse(graph))))
    if (inverted.status === "failure") {return finish("failed", {message: `The request could not be taken back: ${messageOf(inverted.error)}`})}
    workspace.saveGraph(graph)
    return finish("applied", {changes: diffLines(before, overview(readProject(graphBytes(graph)))), details: describeUpdates(graph, inverted.value)})
}

export const runRequest = async (workspace: Workspace, script: string, label: string, options: ScriptOptions = {}): Promise<RequestRecord> => {
    const release = await workspace.lock()
    return request(workspace, script, label, options).finally(release)
}

export const undoRequest = async (workspace: Workspace): Promise<Nullable<RequestRecord>> => {
    const release = await workspace.lock()
    return Promise.resolve().then(() => undo(workspace)).finally(release)
}

export const formatRecord = (record: RequestRecord): string => {
    const lines = [`${record.kind === "undo" ? "Undo" : "Request"} ${record.id} "${record.label}": ${record.status}`]
    if (isDefined(record.message)) {lines.push(record.message)}
    if (record.changes.length > 0) {
        lines.push("Changes:", ...record.changes.slice(0, 80).map(line => `  ${line}`))
        if (record.changes.length > 80) {lines.push(`  ... ${record.changes.length - 80} more`)}
    }
    if (record.details !== "") {lines.push(`Changed values: ${record.details}`)}
    if (record.logs.length > 0) {lines.push("Output:", ...record.logs.slice(0, 200).map(line => `  ${line}`))}
    return lines.join("\n")
}
