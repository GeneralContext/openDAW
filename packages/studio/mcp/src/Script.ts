import {existsSync, readFileSync} from "node:fs"
import {createRequire, stripTypeScriptTypes} from "node:module"
import {dirname, join} from "node:path"
import {fileURLToPath, pathToFileURL} from "node:url"
import {Worker} from "node:worker_threads"
import ts from "typescript"
import {int, isDefined, Nullable, Optional, tryCatch} from "@opendaw/lib-std"
import {AudioData} from "@opendaw/lib-dsp"
import {Update} from "@opendaw/lib-box"
import type {MixdownOptions, Sample} from "@opendaw/studio-scripting"
import type {ScriptJob, ScriptOutcome, ServiceReply, WorkerMessage} from "./ScriptWorker"
import {decodeUpdates} from "./UpdateCodec"

export type Diagnostic = {line: int, column: int, message: string}

export type ScriptServices = {
    addSample(data: AudioData, name: string): Promise<Sample>
    listSamples(): Promise<ReadonlyArray<Sample>>
    renderMixdown(project: ArrayBufferLike, options: MixdownOptions): Promise<AudioData>
    saveFile(data: ArrayBuffer, fileName: string, mimeType: string): Promise<string>
}

export type ScriptRun =
    | {status: "ok", updates: ReadonlyArray<Update>, logs: ReadonlyArray<string>}
    | {status: "invalid", diagnostics: ReadonlyArray<Diagnostic>}
    | {status: "failed", message: string, line: Nullable<int>, logs: ReadonlyArray<string>}
    | {status: "timeout", logs: ReadonlyArray<string>}

export type ScriptOptions = {timeoutMs?: int, typeCheck?: boolean, sampleRate?: int}

const scriptingSource = join(dirname(createRequire(import.meta.url).resolve("@opendaw/studio-scripting")), "..", "src")

const REQUEST_GLOBALS = `
/** Output shown in the request's result. */
declare const console: {log(...values: ReadonlyArray<unknown>): void, info(...values: ReadonlyArray<unknown>): void,
    warn(...values: ReadonlyArray<unknown>): void, error(...values: ReadonlyArray<unknown>): void}
/** The open project. Every change a request makes is applied as one undoable request. */
declare const project: Project
/**
 * The instrument unit with this label, as shown in the overview. Give the instrument type to get its
 * parameters typed, for example instrument("Lead", "Vaporisateur").instrument.cutoff. Throws if there is none.
 */
declare function instrument<K extends keyof Instruments = keyof Instruments>(label: string, key?: K): InstrumentAudioUnit<K>
/** Any unit with this label (instrument, aux, group, or output). Throws if there is none. */
declare function unit(label: string): AnyAudioUnit
`

// Requests run in Node with the full language, so they are checked against ES2022, not the editor's subset.
const DECLARATIONS: ReadonlyArray<[string, string]> = [
    ["/api.declaration.d.ts", readFileSync(join(scriptingSource, "api.declaration.d.ts"), "utf8")],
    ["/request-globals.d.ts", REQUEST_GLOBALS]
]

export const API_DECLARATION = DECLARATIONS[0][1]

const OPTIONS: ts.CompilerOptions = {
    lib: ["lib.es2022.d.ts"], strict: true, noEmit: true, target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext,
    moduleDetection: ts.ModuleDetectionKind.Force, types: []
}

const LIBRARY_DIRECTORY = dirname(ts.getDefaultLibFilePath(OPTIONS))

// Top-level return, await and for await: a request runs as the body of an async function.
const IGNORED = new Set([1108, 1375, 1431])

const libraries = new Map(DECLARATIONS.map(([name, text]) =>
    [name, ts.createSourceFile(name, text, ts.ScriptTarget.ES2022, true)] as const))

const standardLibrary = new Map<string, ts.SourceFile>()

const libraryFile = (name: string): Optional<ts.SourceFile> => {
    const path = join(LIBRARY_DIRECTORY, name.replace(/^\//, ""))
    if (!name.startsWith("/lib.") || !existsSync(path)) {return undefined}
    const parsed = standardLibrary.get(name) ?? ts.createSourceFile(name, readFileSync(path, "utf8"), ts.ScriptTarget.ES2022, true)
    standardLibrary.set(name, parsed)
    return parsed
}

export const checkScript = (source: string): ReadonlyArray<Diagnostic> => {
    const request = ts.createSourceFile("/request.ts", source, ts.ScriptTarget.ES2022, true)
    const files = new Map<string, ts.SourceFile>([...libraries, ["/request.ts", request]])
    const host: ts.CompilerHost = {
        getSourceFile: name => files.get(name) ?? libraryFile(name),
        getDefaultLibFileName: () => "/lib.es2022.d.ts",
        writeFile: () => {},
        getCurrentDirectory: () => "/",
        getCanonicalFileName: name => name,
        useCaseSensitiveFileNames: () => true,
        getNewLine: () => "\n",
        fileExists: name => files.has(name) || isDefined(libraryFile(name)),
        readFile: name => (files.get(name) ?? libraryFile(name))?.text
    }
    const program = ts.createProgram(Array.from(files.keys()), OPTIONS, host)
    return [...program.getSyntacticDiagnostics(request), ...program.getSemanticDiagnostics(request)]
        .filter(diagnostic => !IGNORED.has(diagnostic.code))
        .map(diagnostic => {
            const {line, character} = request.getLineAndCharacterOfPosition(diagnostic.start ?? 0)
            return {line: line + 1, column: character + 1, message: ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n")}
        })
}

let bundled: Nullable<Promise<URL>> = null

// Next to the bundled command line the worker bundle exists; from source it is built once.
const workerBundle = (): Promise<URL> => {
    const sibling = new URL("./studio-mcp-worker.mjs", import.meta.url)
    if (import.meta.url.endsWith(".mjs") && existsSync(fileURLToPath(sibling))) {return Promise.resolve(sibling)}
    const root = join(dirname(fileURLToPath(import.meta.url)), "..")
    bundled ??= import(pathToFileURL(join(root, "build.mjs")).href)
        .then((module: {bundle(names: ReadonlyArray<string>): Promise<unknown>}) => module.bundle(["studio-mcp-worker"]))
        .then(() => pathToFileURL(join(root, "dist", "studio-mcp-worker.mjs")))
    return bundled
}

// Keeps every line and column, so runtime errors point at the agent's own lines.
const toJavaScript = (source: string): string => {
    const stripped = tryCatch(() => stripTypeScriptTypes(source, {mode: "strip"}))
    return stripped.status === "success" ? stripped.value
        : ts.transpileModule(source, {compilerOptions: {target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext}}).outputText
}

export const runScript = async (source: string, graph: Uint8Array, name: string, services: Partial<ScriptServices>,
                                {timeoutMs = 30_000, typeCheck = true, sampleRate = 48_000}: ScriptOptions = {}): Promise<ScriptRun> => {
    if (typeCheck) {
        const diagnostics = checkScript(source)
        if (diagnostics.length > 0) {return {status: "invalid", diagnostics}}
    }
    const job: ScriptJob = {code: toJavaScript(source), graph, name, sampleRate}
    const worker = new Worker(await workerBundle(), {workerData: job, resourceLimits: {maxOldGenerationSizeMb: 2048}})
    return new Promise<ScriptRun>(resolve => {
        let settled = false
        const finish = (run: ScriptRun) => {
            if (settled) {return}
            settled = true
            clearTimeout(timer)
            void worker.terminate()
            resolve(run)
        }
        const timer = setTimeout(() => finish({status: "timeout", logs: []}), timeoutMs)
        worker.on("message", (message: WorkerMessage) => {
            if (message.type === "done") {return finish(fromOutcome(message))}
            const service = services[message.method] as Optional<(...args: ReadonlyArray<unknown>) => Promise<unknown>>
            const reply = (value: Omit<ServiceReply, "type" | "id">) => worker.postMessage({type: "reply", id: message.id, ...value})
            if (!isDefined(service)) {return reply({error: `${message.method} is not available here`})}
            service(...message.args).then(value => reply({value}),
                (error: unknown) => reply({error: error instanceof Error ? error.message : String(error)}))
        })
        worker.on("error", (error: Error) => finish({status: "failed", message: error.message, line: null, logs: []}))
        worker.on("exit", code => finish({status: "failed", message: `The script worker stopped (exit code ${code})`, line: null, logs: []}))
    })
}

const fromOutcome = ({updates, logs, error}: ScriptOutcome): ScriptRun =>
    isDefined(error) ? {status: "failed", message: error.message, line: error.line, logs}
        : {status: "ok", updates: decodeUpdates(updates), logs}
