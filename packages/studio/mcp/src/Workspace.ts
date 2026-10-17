import {existsSync, linkSync, mkdirSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync} from "node:fs"
import {join, resolve} from "node:path"
import {Exec, int, isDefined, Nullable, Optional, panic, tryCatch, UUID} from "@opendaw/lib-std"
import {AudioData} from "@opendaw/lib-dsp"
import {BoxGraph} from "@opendaw/lib-box"
import {BoxIO} from "@opendaw/studio-boxes"
import {ProjectSkeleton} from "@opendaw/studio-adapters"
import type {Sample} from "@opendaw/studio-scripting"
import {copyBytes} from "./UpdateCodec"
import {decodeWav, encodeWavChannels} from "./Wav"

export type RequestStatus = "applied" | "unchanged" | "invalid" | "failed" | "timeout"

// checksum: the project's checksum after the record; updates: what undo inverts (base64)
export type RequestRecord = {
    id: string
    label: string
    kind: "request" | "undo"
    target: Nullable<string>
    status: RequestStatus
    changes: ReadonlyArray<string>
    details: string
    logs: ReadonlyArray<string>
    message: Nullable<string>
    updates: Nullable<string>
    checksum: string
    startedAt: string
    finishedAt: string
}

export type SampleEntry = Sample & {file: string}

const LOCK_WAIT_MS = 120_000

const turns = new Map<string, Promise<void>>()

export class Workspace {
    static locate(directory: Optional<string>): Workspace {
        return new Workspace(resolve(directory ?? process.env.OPENDAW_WORKSPACE ?? "."))
    }

    readonly directory: string

    constructor(directory: string) {this.directory = directory}

    get projectPath(): string {return join(this.directory, "project.od")}
    get exists(): boolean {return existsSync(this.projectPath)}
    get requestsDirectory(): string {return join(this.directory, "requests")}
    get rendersDirectory(): string {return this.#ensure("renders")}
    get samplesDirectory(): string {return this.#ensure("samples")}

    create(project: ArrayBuffer): void {
        if (this.exists) {return panic(`${this.directory} already holds a project`)}
        mkdirSync(this.directory, {recursive: true})
        this.#writeProject(project)
    }

    loadGraph(): BoxGraph<BoxIO.TypeMap> {
        if (!this.exists) {return panic(`No project in ${this.directory}. Run 'studio-mcp init' first.`)}
        return ProjectSkeleton.decode(copyBytes(readFileSync(this.projectPath))).boxGraph
    }

    saveGraph(graph: BoxGraph): void {this.#writeProject(ProjectSkeleton.encode(graph) as ArrayBuffer)}

    records(): ReadonlyArray<RequestRecord> {
        if (!existsSync(this.requestsDirectory)) {return []}
        return readdirSync(this.requestsDirectory).filter(name => name.endsWith(".json"))
            .toSorted((first, second) => parseInt(first, 10) - parseInt(second, 10))
            .map(name => JSON.parse(readFileSync(join(this.requestsDirectory, name), "utf8")) as RequestRecord)
    }

    saveRecord(record: RequestRecord, script: Nullable<string>): int {
        const directory = this.#ensure("requests")
        const number = readdirSync(directory).filter(name => name.endsWith(".json")).length + 1
        const stem = `${String(number).padStart(4, "0")}-${record.id}`
        if (isDefined(script)) {writeFileSync(join(directory, `${stem}.ts`), script)}
        writeFileSync(join(directory, `${stem}.json`), JSON.stringify(record, null, 2) + "\n")
        return number
    }

    // The newest applied request that no applied undo took back.
    undoTarget(): Nullable<RequestRecord> {
        const stack: Array<RequestRecord> = []
        this.records().filter(record => record.status === "applied").forEach(record => {
            const index = stack.findIndex(each => each.id === record.target)
            if (record.kind === "request") {stack.push(record)} else if (index >= 0) {stack.splice(index, 1)}
        })
        return stack.at(-1) ?? null
    }

    samples(): ReadonlyArray<SampleEntry> {
        const path = join(this.samplesDirectory, "index.json")
        return existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) as ReadonlyArray<SampleEntry> : []
    }

    listSamples(): ReadonlyArray<Sample> {
        return this.samples().map(({uuid, name, duration, bpm, sample_rate}) => ({uuid, name, duration, bpm, sample_rate}))
    }

    addSample(data: AudioData, name: string): Sample {
        const sample: Sample = {uuid: UUID.toString(UUID.generate()), name, duration: data.numberOfFrames / data.sampleRate, bpm: 0, sample_rate: data.sampleRate}
        const entry: SampleEntry = {...sample, file: `${sample.uuid}.wav`}
        writeFileSync(join(this.samplesDirectory, entry.file), encodeWavChannels(data.sampleRate, data.frames, 32))
        writeFileSync(join(this.samplesDirectory, "index.json"), JSON.stringify([...this.samples(), entry], null, 2) + "\n")
        return sample
    }

    loadSample(uuid: string): Nullable<AudioData> {
        const entry = this.samples().find(sample => sample.uuid === uuid)
        return isDefined(entry) ? decodeWav(readFileSync(join(this.samplesDirectory, entry.file))) : null
    }

    // One change at a time: later callers in this process queue, other processes wait for the lock file.
    async lock(): Promise<Exec> {
        const previous = turns.get(this.directory) ?? Promise.resolve()
        const turn = Promise.withResolvers<void>()
        turns.set(this.directory, previous.then(() => turn.promise))
        await previous
        mkdirSync(this.directory, {recursive: true})
        const path = join(this.directory, ".lock")
        const deadline = Date.now() + LOCK_WAIT_MS
        while (!this.#tryLock(path)) {
            if (Date.now() > deadline) {
                turn.resolve()
                return panic(`${path} is held by another process (pid ${readFileSync(path, "utf8")})`)
            }
            await new Promise(resolve => setTimeout(resolve, 100))
        }
        const removeFile = () => {if (existsSync(path) && readFileSync(path, "utf8") === String(process.pid)) {unlinkSync(path)}}
        process.once("exit", removeFile)
        return () => {
            process.off("exit", removeFile)
            removeFile()
            turn.resolve()
        }
    }

    // A lock file of this process is stale: its own changes queue before they reach the file.
    #tryLock(path: string): boolean {
        const temporary = `${path}.${process.pid}`
        writeFileSync(temporary, String(process.pid))
        const taken = tryCatch(() => linkSync(temporary, path))
        unlinkSync(temporary)
        if (taken.status === "success") {return true}
        const owner = tryCatch(() => Number(readFileSync(path, "utf8")))
        if (owner.status === "success" && owner.value !== process.pid && isAlive(owner.value)) {return false}
        tryCatch(() => unlinkSync(path))
        return false
    }

    #writeProject(project: ArrayBuffer): void {
        const temporary = `${this.projectPath}.${process.pid}.tmp`
        writeFileSync(temporary, new Uint8Array(project))
        renameSync(temporary, this.projectPath)
    }

    #ensure(name: string): string {
        const path = join(this.directory, name)
        mkdirSync(path, {recursive: true})
        return path
    }
}

// A process that exited but was never collected (a zombie, common in containers) does not hold the lock.
const isAlive = (pid: int): boolean => {
    if (!Number.isInteger(pid) || pid <= 0) {return false}
    const probe = tryCatch(() => process.kill(pid, 0))
    if (probe.status === "failure" && (probe.error as {code?: string}).code !== "EPERM") {return false}
    const stat = tryCatch(() => readFileSync(`/proc/${pid}/stat`, "utf8"))
    if (stat.status === "failure") {return true}
    return !["Z", "X"].includes(stat.value.slice(stat.value.lastIndexOf(")") + 2, stat.value.lastIndexOf(")") + 3))
}
