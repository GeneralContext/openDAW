import {int, isDefined, Nullable, Option, Optional, tryCatch} from "@opendaw/lib-std"
import {BoxGraph} from "@opendaw/lib-box"
import {PPQN} from "@opendaw/lib-dsp"
import {BoxIO, ProjectMetaBox} from "@opendaw/studio-boxes"
import {ProjectSkeleton} from "@opendaw/studio-adapters"
import {
    AnyAudioUnit,
    AnyTrack,
    NoteEvent,
    Project,
    ProjectImpl,
    Region,
    ScriptHostProtocol
} from "@opendaw/studio-scripting"
import {copyBytes} from "./UpdateCodec"

const NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"]

export const pitchName = (pitch: int): string => `${NAMES[pitch % 12]}${Math.floor(pitch / 12) - 1}`

// The Script API facades agent scripts use; the project's own name wins.
export const readProject = (graphBytes: Uint8Array, name: string = "Project"): Project => {
    const graph = new BoxGraph<BoxIO.TypeMap>(Option.wrap(BoxIO.create))
    graph.fromArrayBuffer(copyBytes(graphBytes))
    const meta = graph.boxes().find((box): box is ProjectMetaBox => box instanceof ProjectMetaBox)
    const title = meta?.projectName.getValue() || name
    return new ProjectImpl({} as ScriptHostProtocol, ProjectSkeleton.decode(ProjectSkeleton.encode(graph)), title)
}

const decibels = (value: number): string => `${value >= 0 ? "+" : ""}${value.toFixed(1)} dB`
const pan = (value: number): string => Math.abs(value) < 0.005 ? "C" : `${value < 0 ? "L" : "R"}${Math.round(Math.abs(value) * 100)}`

export const formatPosition = (project: Project, position: number): string => {
    const {numerator, denominator} = project.timeSignature
    const beat = PPQN.Quarter * 4 / denominator
    const bar = beat * numerator
    const bars = Math.floor(position / bar)
    const beats = Math.floor((position - bars * bar) / beat)
    const rest = position - bars * bar - beats * beat
    const sixteenths = rest / PPQN.SemiQuaver
    const sixteenth = Number.isInteger(sixteenths) ? `${sixteenths + 1}` : `${Math.floor(sixteenths) + 1}+${rest % PPQN.SemiQuaver}t`
    return `${bars + 1}.${beats + 1}.${sixteenth}`
}

export const formatLength = (project: Project, duration: number): string => {
    const {numerator, denominator} = project.timeSignature
    const bar = PPQN.Quarter * 4 / denominator * numerator
    if (duration % bar === 0) {return `${duration / bar} bar${duration === bar ? "" : "s"}`}
    if (duration % PPQN.Quarter === 0) {return `${duration / PPQN.Quarter} beat${duration === PPQN.Quarter ? "" : "s"}`}
    if (duration % PPQN.SemiQuaver === 0) {return `${duration / PPQN.SemiQuaver}/16`}
    return `${duration} ticks`
}

const unitLine = (unit: AnyAudioUnit): string => {
    const parts = [unit.label || "(unnamed)"]
    if (unit.kind === "instrument") {parts.push(unit.instrument.key)} else {parts.push(unit.kind)}
    parts.push(`vol ${decibels(unit.volume)}`, `pan ${pan(unit.panning)}`)
    if (unit.mute) {parts.push("muted")}
    if (unit.solo) {parts.push("solo")}
    if (unit.audioEffects.length > 0) {parts.push(`fx ${unit.audioEffects.map(effect => effect.key).join(" > ")}`)}
    if (unit.midiEffects.length > 0) {parts.push(`midi fx ${unit.midiEffects.map(effect => effect.key).join(" > ")}`)}
    if (unit.kind !== "output") {parts.push(`-> ${unit.output?.label || (isDefined(unit.output) ? unit.output.kind : "unplugged")}`)}
    return parts.join(" · ")
}

const unitPath = (unit: AnyAudioUnit): string => unit.kind === "output" ? "project.output"
    : unit.kind === "instrument" ? `instrument(${JSON.stringify(unit.label)}, ${JSON.stringify(unit.instrument.key)})`
        : `unit(${JSON.stringify(unit.label)})`

const trackName = (track: AnyTrack): string => track.type === "notes" ? "notes" : track.type === "audio" ? "audio" : "automation"

const regionLine = (project: Project, track: AnyTrack, region: Region, index: int): string => {
    const parts = [`regions[${index}]`, region.label ? `"${region.label}"` : "(unlabelled)",
        `${formatPosition(project, region.position)} +${formatLength(project, region.duration)}`]
    if (region.mute) {parts.push("muted")}
    if (track.type === "notes") {
        const events = (region as unknown as {events: ReadonlyArray<NoteEvent>}).events
        const pitches = events.map(event => event.pitch)
        parts.push(events.length === 0 ? "empty" : `${events.length} notes ${pitchName(Math.min(...pitches))}-${pitchName(Math.max(...pitches))}`)
    } else if (track.type === "value") {
        parts.push(`${(region as unknown as {events: ReadonlyArray<unknown>}).events.length} points`)
    } else {
        parts.push(`sample "${(region as unknown as {sample: {name: string}}).sample.name}"`)
    }
    return parts.join(" · ")
}

// Equal projects give equal text, so two overviews diff cleanly.
export const overview = (project: Project, header: Nullable<string> = null): string => {
    const lines: Array<string> = []
    const {numerator, denominator} = project.timeSignature
    const end = Math.max(0, ...project.audioUnits.flatMap(unit => unit.tracks.flatMap(track => track.regions.map(region => region.complete))))
    const seconds = end / PPQN.Quarter * 60 / project.bpm
    lines.push(`Project "${project.name}" · ${project.bpm} BPM · ${numerator}/${denominator} · content ${formatLength(project, end)} (${seconds.toFixed(1)} s)${isDefined(header) ? ` · ${header}` : ""}`)
    project.audioUnits.forEach(unit => {
        lines.push(`${unitPath(unit)}: ${unitLine(unit)}`)
        unit.tracks.forEach((track, trackIndex) => {
            const regions = track.regions
            if (regions.length === 0 && track.clips.length === 0) {return}
            const owner = unit.kind === "instrument" && track.type === "notes" ? `noteTracks[${unit.noteTracks.indexOf(track as never)}]`
                : track.type === "audio" ? `audioTracks[${unit.audioTracks.indexOf(track as never)}]`
                    : `tracks[${trackIndex}]`
            lines.push(`  .${owner} (${trackName(track)}${track.enabled ? "" : ", disabled"})`)
            regions.forEach((region, index) => lines.push(`    .${regionLine(project, track, region, index)}`))
            if (track.clips.length > 0) {lines.push(`    ${track.clips.length} launcher clip(s)`)}
        })
    })
    if (project.markers.length > 0) {
        lines.push(`markers: ${project.markers.map(marker => `${formatPosition(project, marker.position)} "${marker.label}"`).join(", ")}`)
    }
    return lines.join("\n")
}

export const diffLines = (before: string, after: string): ReadonlyArray<string> => {
    const left = before.split("\n")
    const right = after.split("\n")
    const lengths = Array.from({length: left.length + 1}, () => new Array<number>(right.length + 1).fill(0))
    for (let row = left.length - 1; row >= 0; row--) {
        for (let column = right.length - 1; column >= 0; column--) {
            lengths[row][column] = left[row] === right[column] ? lengths[row + 1][column + 1] + 1
                : Math.max(lengths[row + 1][column], lengths[row][column + 1])
        }
    }
    const changes: Array<string> = []
    let row = 0
    let column = 0
    while (row < left.length || column < right.length) {
        if (row < left.length && column < right.length && left[row] === right[column]) {
            row++
            column++
        } else if (row < left.length && (column === right.length || lengths[row + 1][column] >= lengths[row][column + 1])) {
            changes.push(`- ${left[row++]}`)
        } else {
            changes.push(`+ ${right[column++]}`)
        }
    }
    return changes
}

// Script API facades are the *Impl classes; raw boxes and other internals are not shown.
const isFacade = (value: unknown): value is object => typeof value === "object" && isDefined(value) && !Array.isArray(value)
    && !ArrayBuffer.isView(value) && (value.constructor?.name.endsWith("Impl") || value.constructor === Object)

const properties = (facade: object): ReadonlyArray<[string, unknown]> => {
    const names = new Set<string>()
    for (let prototype = Object.getPrototypeOf(facade); isDefined(prototype) && prototype !== Object.prototype; prototype = Object.getPrototypeOf(prototype)) {
        Object.entries(Object.getOwnPropertyDescriptors(prototype)).forEach(([name, descriptor]) => {
            if (isDefined(descriptor.get) && !name.startsWith("#")) {names.add(name)}
        })
    }
    Object.keys(facade).forEach(name => names.add(name))
    const skipped = new Set(["audioUnit", "owner", "project", "target", "context", "output", "playfield", "box", "attached"])
    return Array.from(names).filter(name => !skipped.has(name))
        .map(name => [name, tryCatch(() => (facade as Record<string, unknown>)[name])] as const)
        .filter(([, read]) => read.status === "success" && typeof read.value !== "function")
        .map(([name, read]) => [name, read.status === "success" ? read.value : null])
}

const describeValue = (value: unknown, depth: int, indent: string): string => {
    if (Array.isArray(value)) {
        if (value.length === 0) {return "[]"}
        if (depth <= 0 || !isFacade(value[0])) {return `[${value.map(item => describeValue(item, 0, "")).join(", ")}]`}
        return value.map((item, index) => `\n${indent}  [${index}]${describeValue(item, depth - 1, indent + "    ")}`).join("")
    }
    if (typeof value === "object" && isDefined(value) && !isFacade(value)) {return `(${(value as object).constructor.name})`}
    if (isFacade(value)) {
        if (depth <= 0) {return "{…}"}
        return properties(value).map(([name, inner]) => `\n${indent}${name}: ${describeValue(inner, depth - 1, indent + "  ")}`).join("")
    }
    if (typeof value === "number") {return Number.isInteger(value) ? String(value) : String(Math.round(value * 1e4) / 1e4)}
    return typeof value === "string" ? JSON.stringify(value) : String(value)
}

export const inspect = (project: Project, path: string): string => {
    const target = resolve(project, path)
    if (!isDefined(target)) {return `Nothing at ${path}. Run the overview to see the available paths.`}
    if (isFacade(target) && Array.isArray((target as {events?: unknown}).events)
        && isDefined(((target as {events: ReadonlyArray<unknown>}).events[0] as Optional<NoteEvent>)?.pitch)) {
        const region = target as Region & {events: ReadonlyArray<NoteEvent>}
        const header = `${path}: "${region.label}" at ${formatPosition(project, region.position)} +${formatLength(project, region.duration)}, ${region.events.length} notes`
        const rows = region.events.map((event, index) =>
            `  [${index}] ${formatPosition(project, event.position).padEnd(8)} +${formatLength(project, event.duration).padEnd(8)} ${pitchName(event.pitch).padEnd(4)} (${event.pitch}) vel ${event.velocity.toFixed(2)}`)
        return [header, "  [i] position  length    pitch      velocity", ...rows].join("\n")
    }
    return `${path}:${describeValue(target, 3, "  ")}`
}

const resolve = (project: Project, path: string): unknown => {
    const tokens = path.trim().replace(/^project\b\.?/, "")
        .match(/(?:instrument|unit)\(\s*(?:"[^"]*"|'[^']*')\s*(?:,\s*(?:"[^"]*"|'[^']*')\s*)?\)|[A-Za-z_$][\w$]*|\[\s*\d+\s*\]/g) ?? []
    let current: unknown = project
    for (const token of tokens) {
        if (!isDefined(current)) {return null}
        const call = /^(instrument|unit)\(\s*["']([^"']*)["']/.exec(token)
        if (isDefined(call)) {
            current = project.findAudioUnit(call[2])
        } else if (token.startsWith("[")) {
            current = (current as ReadonlyArray<unknown>)[Number(token.slice(1, -1).trim())]
        } else {
            current = (current as Record<string, unknown>)[token]
        }
    }
    return current
}
