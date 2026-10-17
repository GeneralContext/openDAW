import {parentPort, workerData} from "node:worker_threads"
import {isDefined, Nullable, Option, panic} from "@opendaw/lib-std"
import {AudioData} from "@opendaw/lib-dsp"
import {BoxGraph, Update} from "@opendaw/lib-box"
import {BoxIO} from "@opendaw/studio-boxes"
import {ProjectSkeleton} from "@opendaw/studio-adapters"
import {
    AnyAudioUnit,
    Api,
    ApiImpl,
    InstrumentAudioUnit,
    MixdownOptions,
    Project,
    ProjectImpl,
    Sample,
    ScriptGlobals,
    ScriptHostProtocol
} from "@opendaw/studio-scripting"
import {copyBytes, encodeUpdates} from "./UpdateCodec"

export type ScriptJob = {code: string, graph: Uint8Array, name: string, sampleRate: number}
export type ServiceCall = {type: "call", id: number, method: "addSample" | "listSamples" | "renderMixdown" | "saveFile", args: ReadonlyArray<unknown>}
// updates: the script's edits as native updates with the values they replaced
export type ScriptOutcome = {type: "done", updates: Uint8Array, logs: ReadonlyArray<string>, error: Nullable<{message: string, line: Nullable<number>}>}
export type WorkerMessage = ServiceCall | ScriptOutcome
export type ServiceReply = {type: "reply", id: number, value?: unknown, error?: string}

const NONE = new Uint8Array(0)

// The agent's code starts after the function signature, its opening brace and the inner scope.
const FUNCTION_HEADER_LINES = 3

const port = parentPort ?? panic("The script worker must run in a worker thread")
const job = workerData as ScriptJob
const logs: Array<string> = []
const recorded: Array<Update> = []
const pending = new Map<number, {resolve(value: unknown): void, reject(error: Error): void}>()
let callId = 0

port.on("message", (reply: ServiceReply) => {
    const waiting = pending.get(reply.id)
    if (!isDefined(waiting)) {return}
    pending.delete(reply.id)
    if (isDefined(reply.error)) {waiting.reject(new Error(reply.error))} else {waiting.resolve(reply.value)}
})

const call = <T>(method: ServiceCall["method"], ...args: ReadonlyArray<unknown>): Promise<T> =>
    new Promise<T>((resolve, reject) => {
        const id = ++callId
        pending.set(id, {resolve: value => resolve(value as T), reject})
        port.postMessage({type: "call", id, method, args} satisfies ServiceCall)
    })

const format = (value: unknown): string => typeof value === "string" ? value
    : value instanceof Error ? value.message
        : JSON.stringify(value, (_key, inner) => typeof inner === "bigint" ? String(inner) : inner) ?? String(value)

const scriptConsole = {
    log: (...values: ReadonlyArray<unknown>) => logs.push(values.map(format).join(" ")),
    info: (...values: ReadonlyArray<unknown>) => logs.push(values.map(format).join(" ")),
    warn: (...values: ReadonlyArray<unknown>) => logs.push("warning: " + values.map(format).join(" ")),
    error: (...values: ReadonlyArray<unknown>) => logs.push("error: " + values.map(format).join(" ")),
    debug: () => {}
}

const host: ScriptHostProtocol = {
    openProject: () => panic("A request edits the open project. Use `project` instead of openDAW.newProject()."),
    applyUpdates: () => {},
    hasProject: async () => true,
    fetchProject: async () => {
        const graph = new BoxGraph<BoxIO.TypeMap>(Option.wrap(BoxIO.create))
        graph.fromArrayBuffer(copyBytes(job.graph))
        return {buffer: ProjectSkeleton.encode(graph) as ArrayBuffer, name: job.name}
    },
    showInfo: async (headline, message) => {logs.push(`${headline}: ${message}`)},
    addSample: (data: AudioData, name: string) => call<Sample>("addSample", data, name),
    listSamples: () => call<ReadonlyArray<Sample>>("listSamples"),
    renderMixdown: (buffer: ArrayBufferLike, options: MixdownOptions) => call<AudioData>("renderMixdown", buffer, options),
    saveFile: (buffer: ArrayBuffer, fileName: string, mimeType: string) => call<void>("saveFile", buffer, fileName, mimeType)
}

const errorLine = (error: unknown): Nullable<number> => {
    const match = /request\.ts:(\d+)/.exec(error instanceof Error ? error.stack ?? "" : "")
    return isDefined(match) ? Number(match[1]) - FUNCTION_HEADER_LINES : null
}

const record = (graph: BoxGraph): void => {
    let current: Array<Update> = []
    graph.subscribeTransaction({
        onBeginTransaction: () => {current = []},
        onEndTransaction: rolledBack => {
            if (!rolledBack) {recorded.push(...current)}
            current = []
        }
    })
    graph.subscribeToAllUpdatesImmediate({onUpdate: update => {current.push(update)}})
}

const run = async (): Promise<ScriptOutcome> => {
    const api = new ApiImpl(host)
    const project = await api.getProject() as ProjectImpl
    record(project.context.boxGraph)
    Object.defineProperty(project, "openInStudio", {value: () => project.validate()})
    const scriptApi: Api = {
        newProject: name => api.newProject(name),
        hasProject: () => api.hasProject(),
        showInfo: (headline, message) => api.showInfo(headline, message),
        getProject: async (): Promise<Project> => project,
        addSample: (data, name) => api.addSample(data, name),
        listSamples: () => api.listSamples(),
        saveFile: (data, fileName, mimeType) => api.saveFile(data, fileName, mimeType)
    }
    const unit = (label: string): AnyAudioUnit => project.findAudioUnit(label)
        ?? panic(`No unit labelled "${label}". Units: ${project.audioUnits.map(each => JSON.stringify(each.label)).join(", ")}`)
    const instrument = (label: string, key?: string): InstrumentAudioUnit => {
        const found = unit(label)
        if (found.kind !== "instrument") {return panic(`"${label}" is a ${found.kind} unit, not an instrument`)}
        if (isDefined(key) && found.instrument.key !== key) {return panic(`"${label}" plays ${found.instrument.key}, not ${key}`)}
        return found
    }
    const globals: Record<string, unknown> = {...ScriptGlobals.create(scriptApi, {sampleRate: job.sampleRate, baseFrequency: 440}),
        project, console: scriptConsole, unit, instrument}
    const names = Object.keys(globals)
    const AsyncFunction = (async () => {}).constructor as new (...args: ReadonlyArray<string>) => (...values: ReadonlyArray<unknown>) => Promise<unknown>
    const body = `return (async () => {\n${job.code.replace(/^\s*export\s*\{\s*\};?/m, "")}\n})()\n//# sourceURL=request.ts`
    const failure = await new AsyncFunction(...names, body)(...names.map(name => globals[name]))
        .then(() => null, (error: unknown) => error)
    if (isDefined(failure)) {return {type: "done", updates: NONE, logs, error: {message: format(failure), line: errorLine(failure)}}}
    const invalid = await Promise.resolve().then(() => project.validate()).then(() => null, (error: unknown) => error)
    if (isDefined(invalid)) {return {type: "done", updates: NONE, logs, error: {message: format(invalid), line: null}}}
    return {type: "done", updates: encodeUpdates(recorded), logs, error: null}
}

run().then(outcome => port.postMessage(outcome satisfies ScriptOutcome),
    (error: unknown) => port.postMessage({type: "done", updates: NONE, logs,
        error: {message: format(error), line: errorLine(error)}} satisfies ScriptOutcome))
