import {existsSync, readFileSync} from "node:fs"
import {join} from "node:path"
import {Exec, int, isDefined, Nullable, Optional, panic, tryCatch, UUID} from "@opendaw/lib-std"
import {AudioData} from "@opendaw/lib-dsp"
import {BoxGraph, Update} from "@opendaw/lib-box"
import {ApparatDeviceBox, AudioFileBox, BoxIO, SpielwerkDeviceBox, WerkstattDeviceBox} from "@opendaw/studio-boxes"
import {ProjectSkeleton} from "@opendaw/studio-adapters"
import {InstrumentAudioUnit, NoteEvent, NoteRegion, Playfield, ProjectImpl} from "@opendaw/studio-scripting"
import {readProject} from "./Overview"
import {createTempoMap} from "./Render"
import {checksumOf, graphBytes} from "./Requests"
import {copyBytes, decodeUpdates} from "./UpdateCodec"
import {decodeWav} from "./Wav"
import {RequestRecord, SampleEntry, Workspace} from "./Workspace"

// For graders of benchmark tasks: the project a workspace's requests make from the task's starting project.

export type Policy = {
    // Script devices run user code when rendered
    allowScriptDevices?: boolean
    // Sample uuids the project may use; undefined allows any
    allowedSamples?: ReadonlyArray<string>
    // false refuses audio tracks; note and automation tracks stay allowed
    allowAudioTracks?: boolean
    maxNotes?: int
    maxSeconds?: number
}

// start and checksum: the project checksums before the first and after the last request
export type Verification = {
    status: "valid" | "invalid"
    reason: Nullable<string>
    start: string
    checksum: Nullable<string>
    records: int
    requests: int
    undos: int
    violations: ReadonlyArray<string>
}

// time and duration in seconds; position in PPQN; sample: the uuid a Playfield pad plays, null when no pad answers
export type NoteRecord = {time: number, duration: number, position: number, pitch: int, velocity: number, sample?: Nullable<string>}
export type PartRecord = {label: string, instrument: string, muted: boolean, volume: number, notes: ReadonlyArray<NoteRecord>}
export type MarkerRecord = {time: number, position: number, label: string}
// tempoEvents and signatureEvents count the enabled changes; 0 means fixed
export type ProjectRecord = {bpm: number, timeSignature: [int, int], tempoEvents: int, signatureEvents: int,
    markers: ReadonlyArray<MarkerRecord>, parts: ReadonlyArray<PartRecord>}

const messageOf = (error: unknown): string => error instanceof Error ? error.message : String(error)

const transaction = (graph: BoxGraph, procedure: Exec): void => {
    graph.beginTransaction()
    const result = tryCatch(() => {
        procedure()
        graph.endTransaction()
    })
    if (result.status === "success") {return}
    if (graph.inTransaction()) {graph.abortTransaction()}
    return panic(result.error)
}

const replay = (graph: BoxGraph, record: RequestRecord, applied: Map<string, ReadonlyArray<Update>>): void => {
    if (record.kind === "request") {
        const updates = decodeUpdates(Buffer.from(record.updates ?? panic("it has no edits"), "base64"))
        transaction(graph, () => updates.forEach(update => update.forward(graph)))
        applied.set(record.id, updates)
        return
    }
    const target = record.target ?? ""
    const updates = applied.get(target) ?? panic(`it takes back ${target}, which is not an applied request`)
    transaction(graph, () => updates.toReversed().forEach(update => update.inverse(graph)))
    applied.delete(target)
}

// Applies the applied requests and undos again from the starting project; the saved project and snapshots are not used
export const verifyWorkspace = (workspace: Workspace, start: ArrayBuffer, policy: Policy = {}):
    {verification: Verification, graph: Nullable<BoxGraph<BoxIO.TypeMap>>} => {
    const graph = ProjectSkeleton.decode(start).boxGraph
    const empty = {start: checksumOf(graph), checksum: null, records: 0, requests: 0, undos: 0, violations: []}
    const invalid = (reason: string) => ({verification: {...empty, status: "invalid" as const, reason}, graph: null})
    if (!workspace.exists) {return invalid("The workspace has no project")}
    const read = tryCatch(() => workspace.records())
    if (read.status === "failure") {return invalid(`The requests cannot be read: ${messageOf(read.error)}`)}
    const records = read.value.filter(record => record.status === "applied")
    const applied = new Map<string, ReadonlyArray<Update>>()
    for (const record of records) {
        const step = tryCatch(() => replay(graph, record, applied))
        if (step.status === "failure") {return invalid(`Request ${record.id} cannot be applied again: ${messageOf(step.error)}`)}
        if (checksumOf(graph) !== record.checksum) {
            return invalid(`The project after request ${record.id} is not the one it recorded: it changed outside the tools, or the requests do not start from the task's project`)
        }
    }
    const checksum = checksumOf(graph)
    const saved = tryCatch(() => checksumOf(workspace.loadGraph()))
    if (saved.status === "failure" || saved.value !== checksum) {
        return invalid("project.od is not the project its requests make: it changed outside the tools")
    }
    const found = violations(graph, policy)
    const verification: Verification = {
        status: found.length === 0 ? "valid" : "invalid", reason: found.length === 0 ? null : "The project breaks the task policy",
        start: empty.start, checksum, records: read.value.length,
        requests: records.filter(record => record.kind === "request").length,
        undos: records.filter(record => record.kind === "undo").length, violations: found
    }
    return {verification, graph}
}

const violations = (graph: BoxGraph<BoxIO.TypeMap>, {allowScriptDevices = false, allowedSamples, allowAudioTracks = true,
    maxNotes = 20_000, maxSeconds = 600}: Policy): ReadonlyArray<string> => {
    const found: Array<string> = []
    const project = readProject(graphBytes(graph)) as ProjectImpl
    const {notes, seconds} = extent(project)
    if (notes > maxNotes) {found.push(`the project plays ${notes} notes; the limit is ${maxNotes}`)}
    if (seconds > maxSeconds) {found.push(`the project lasts ${Math.round(seconds)} s; the limit is ${maxSeconds} s`)}
    const scripts = graph.boxes().filter(box =>
        box instanceof ApparatDeviceBox || box instanceof WerkstattDeviceBox || box instanceof SpielwerkDeviceBox)
    if (!allowScriptDevices && scripts.length > 0) {found.push(`${scripts.length} script device(s) are not allowed`)}
    if (!allowAudioTracks) {
        const labels = project.audioUnits.flatMap(unit => unit.tracks.filter(track => track.type === "audio").map(() => unit.label))
        if (labels.length > 0) {found.push(`${labels.length} audio track(s) are not allowed (${Array.from(new Set(labels)).join(", ")})`)}
    }
    if (isDefined(allowedSamples)) {
        const allowed = new Set(allowedSamples)
        graph.boxes().filter((box): box is AudioFileBox => box instanceof AudioFileBox)
            .map(box => UUID.toString(box.address.uuid))
            .filter(uuid => !allowed.has(uuid))
            .forEach(uuid => found.push(`sample ${uuid} is not one of the supplied samples`))
    }
    return found
}

// Notes played (loops counted, nothing expanded) and where the last region ends
const extent = (project: ProjectImpl): {notes: number, seconds: number} => {
    const {timelineBox} = ProjectSkeleton.findMandatoryBoxes(project.context.skeleton.boxGraph)
    const seconds = createTempoMap(timelineBox)
    let notes = 0
    let end = 0
    project.audioUnits.forEach(unit => unit.tracks.forEach(track => track.regions.forEach(region => {
        end = Math.max(end, region.complete)
        const events = (region as unknown as {events?: ReadonlyArray<unknown>}).events
        if (track.type !== "notes" || !isDefined(events)) {return}
        const cycle = (region as unknown as NoteRegion).loopDuration
        notes += events.length * Math.ceil(region.duration / Math.max(1, cycle > 0 ? cycle : region.duration))
    })))
    return {notes, seconds: seconds(end)}
}

// The audible notes of every instrument unit in seconds: loops expanded, muted content left out
export const describeProject = (graph: BoxGraph<BoxIO.TypeMap>): ProjectRecord => {
    const project = readProject(graphBytes(graph)) as ProjectImpl
    const {timelineBox} = ProjectSkeleton.findMandatoryBoxes(project.context.skeleton.boxGraph)
    const seconds = createTempoMap(timelineBox)
    const parts = project.instrumentUnits.map((unit): PartRecord => {
        const notes: Array<NoteRecord> = []
        const pad = padSample(unit)
        unit.noteTracks.filter(track => track.enabled).forEach(track => track.regions.forEach(region => {
            const noteRegion = region as unknown as NoteRegion
            if (noteRegion.mute) {return}
            expand(noteRegion).forEach(({start, event}) => notes.push({
                time: seconds(start), duration: seconds(start + event.duration) - seconds(start), position: start,
                pitch: event.pitch, velocity: event.velocity, ...(isDefined(pad) ? {sample: pad(event.pitch)} : {})
            }))
        }))
        return {label: unit.label, instrument: unit.instrument.key, muted: unit.mute, volume: unit.volume,
            notes: notes.toSorted((first, second) => first.time - second.time || first.pitch - second.pitch)}
    })
    const {numerator, denominator} = project.timeSignature
    const markers = project.markers.map(({position, label}) => ({time: seconds(position), position, label}))
    return {bpm: project.bpm, timeSignature: [numerator, denominator],
        tempoEvents: project.tempoTrack.enabled ? project.tempoTrack.events.length : 0,
        signatureEvents: project.signatureTrack.enabled ? project.signatureTrack.events.length : 0, markers, parts}
}

const padSample = (unit: InstrumentAudioUnit): Optional<(pitch: int) => Nullable<string>> => {
    if (unit.instrument.key !== "Playfield") {return undefined}
    const playfield = unit.instrument as Playfield
    return pitch => {
        const slot = playfield.slot(pitch)
        return isDefined(slot) && slot.enabled && !slot.mute ? slot.sample.uuid : null
    }
}

// Note starts in PPQN for one region, repeating the loop cycle over the region's length
const expand = (region: NoteRegion): ReadonlyArray<{start: number, event: NoteEvent}> => {
    const {position, duration, loopDuration, loopOffset} = region
    const end = position + duration
    const cycle = loopDuration > 0 ? loopDuration : duration
    const result: Array<{start: number, event: NoteEvent}> = []
    for (let cycleStart = position - loopOffset; cycleStart < end; cycleStart += cycle) {
        region.events.forEach(event => {
            const start = cycleStart + event.position
            if (event.position < cycle && start >= position && start < end) {result.push({start, event})}
        })
    }
    return result
}

// A sample directory as in a workspace: index.json and the WAV files it names
export const sampleIndex = (directory: string): ReadonlyArray<SampleEntry> => {
    const path = join(directory, "index.json")
    return existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) as ReadonlyArray<SampleEntry> : []
}

export const sampleLoader = (directory: string) => async (uuid: string): Promise<Nullable<AudioData>> => {
    const entry = sampleIndex(directory).find(sample => sample.uuid === uuid)
    return isDefined(entry) ? decodeWav(readFileSync(join(directory, entry.file))) : null
}

export const readStart = (path: string): ArrayBuffer => copyBytes(readFileSync(path))
