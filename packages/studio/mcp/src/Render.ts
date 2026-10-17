import {readFile} from "node:fs/promises"
import {createRequire} from "node:module"
import {ByteArrayInput, isDefined, Nullable, Option, panic, tryCatch, UUID} from "@opendaw/lib-std"
import {AudioData, PPQN, ppqn, RenderQuantum, seconds, TimeBase, ValueEvent} from "@opendaw/lib-dsp"
import {BoxGraph, UpdateTask} from "@opendaw/lib-box"
import {
    ApparatDeviceBox,
    AudioFileBox,
    AudioRegionBox,
    BoxIO,
    MarkerBox,
    NoteRegionBox,
    SoundfontFileBox,
    SpielwerkDeviceBox,
    TimelineBox,
    ValueEventBox,
    ValueEventCollectionBox,
    ValueRegionBox,
    WerkstattDeviceBox
} from "@opendaw/studio-boxes"
import {
    EngineToClient,
    InterpolationFieldAdapter,
    ProjectSkeleton,
    ScriptCompiler,
    TempoGridCursor
} from "@opendaw/studio-adapters"
import type {SoundFont2} from "soundfont2"
import {EngineExports, takeReportMessage} from "../../core-wasm/src/engine-exports"
import {
    COMPOSITES,
    createEngineMemory,
    DEVICES,
    EFFECT_COMPOSITES
} from "../../core-wasm/src/engine-modules"
import {
    createWclapBridges,
    describeEngineTrap,
    drainResourceRequests,
    WasmEngineModules
} from "../../core-wasm/src/boot"
import {
    linkDevice,
    registerComposite,
    registerEffectComposite
} from "../../core-wasm/src/device-linker"
import {NamBridges} from "../../core-wasm/src/nam-bridge"
import {ScriptBridges, ScriptEngine} from "../../core-wasm/src/script-bridge"
import {serializeUpdateTasks} from "../../core-wasm/src/sync/serialize-update-tasks"
import {encodeWavChannels, WavBitDepth} from "./Wav"

export type SampleSource = (uuid: string) => Promise<Nullable<AudioData>>
export type SoundfontSource = (uuid: string) => Promise<Nullable<ArrayBuffer | Uint8Array>>

export type RenderOptions = {
    sampleRate?: number
    // Exact length; by default the span to toPpqn or to the last region, plus the tail
    seconds?: number
    tailSeconds?: number
    fromPpqn?: ppqn
    // The transport pauses here; notes release and effects ring out in the tail
    toPpqn?: ppqn
    samples?: SampleSource
    soundfonts?: SoundfontSource
    allowMissing?: boolean
    // Runs the JavaScript of Apparat, Werkstatt and Spielwerk devices in this process, not sandboxed
    runScripts?: boolean
}

export type Render = {
    sampleRate: number
    channels: [Float32Array, Float32Array]
    seconds: number
    peak: number
    rms: number
    missingSamples: ReadonlyArray<string>
    missingSoundfonts: ReadonlyArray<string>
    messages: ReadonlyArray<string>
}

export class MissingResourcesError extends Error {
    constructor(readonly samples: ReadonlyArray<string>, readonly soundfonts: ReadonlyArray<string>) {
        super([
            samples.length > 0 ? `missing samples (AudioFileBox): ${samples.join(", ")}` : "",
            soundfonts.length > 0 ? `missing soundfonts (SoundfontFileBox): ${soundfonts.join(", ")}` : ""
        ].filter(part => part.length > 0).join("; "))
        this.name = "MissingResourcesError"
    }
}

export const renderProject = async (projectGraphBytes: Uint8Array, options: RenderOptions = {}): Promise<Render> => {
    const sampleRate = options.sampleRate ?? 48_000
    if (!Number.isInteger(sampleRate) || sampleRate < 8_000 || sampleRate > 384_000) {
        return panic(`sampleRate must be an integer in [8000, 384000], got ${sampleRate}`)
    }
    const graph = decodeProject(projectGraphBytes)
    const {timelineBox} = ProjectSkeleton.findMandatoryBoxes(graph)
    const span = resolveSpan(graph, timelineBox, options)
    const scripts = collectScripts(graph)
    if (scripts.length > 0 && options.runScripts !== true) {
        return panic(`the project contains script devices (${scripts.map(({uuid}) => uuid).join(", ")}); ` +
            "pass runScripts: true to execute their JavaScript in this process")
    }
    const resources = await fetchResources(graph, options)
    if (!(options.allowMissing ?? false) && (resources.missingSamples.length > 0 || resources.missingSoundfonts.length > 0)) {
        throw new MissingResourcesError(resources.missingSamples, resources.missingSoundfonts)
    }
    limitTransport(graph, timelineBox, span)
    const {engine, memory, messages} = await startEngine(graph, resources, scripts, sampleRate)
    engine.set_pause_on_loop_disabled(isDefined(span.to) ? 1 : 0)
    if (span.from !== 0) {engine.set_position(span.from)}
    engine.play()
    const channels = renderFrames(engine, memory, Math.round(span.seconds * sampleRate))
    const {peak, rms} = measure(channels)
    return {
        sampleRate, channels, seconds: channels[0].length / sampleRate, peak, rms,
        missingSamples: resources.missingSamples, missingSoundfonts: resources.missingSoundfonts, messages
    }
}

export const encodeWav = (render: Render, bitDepth: WavBitDepth = 16): Uint8Array =>
    encodeWavChannels(render.sampleRate, render.channels, bitDepth)

export const createTempoMap = (timelineBox: TimelineBox): (position: ppqn) => seconds => {
    const bpm = timelineBox.bpm.getValue()
    const events = timelineBox.tempoTrack.enabled.getValue()
        ? timelineBox.tempoTrack.events.targetVertex
            .mapOr(vertex => vertex.box instanceof ValueEventCollectionBox ? readValueEvents(vertex.box) : [], [])
        : []
    if (events.length === 0) {return position => PPQN.pulsesToSeconds(position, bpm)}
    const cursor = new TempoGridCursor()
    return position => cursor.integrate(events, 0, position, bpm)
}

type Span = {from: ppqn, to: Nullable<ppqn>, seconds: seconds}

const resolveSpan = (graph: BoxGraph, timelineBox: TimelineBox, options: RenderOptions): Span => {
    const {seconds, fromPpqn, toPpqn} = options
    const tail = options.tailSeconds ?? 2.0
    const from = Math.round(fromPpqn ?? 0)
    const to = isDefined(toPpqn) ? Math.round(toPpqn) : null
    if (!Number.isFinite(from) || from < 0) {return panic(`fromPpqn must be >= 0, got ${fromPpqn}`)}
    if (isDefined(to) && !(to > from)) {return panic(`toPpqn (${toPpqn}) must be greater than fromPpqn (${from})`)}
    if (!Number.isFinite(tail) || tail < 0) {return panic(`tailSeconds must be >= 0, got ${tail}`)}
    if (isDefined(seconds)) {
        if (!Number.isFinite(seconds) || seconds < 0) {return panic(`seconds must be >= 0, got ${seconds}`)}
        return {from, to, seconds}
    }
    if (timelineBox.markerTrack.enabled.getValue()
        && graph.boxes().some(box => box instanceof MarkerBox && box.plays.getValue() !== 1)) {
        return panic("marker repeats (MarkerBox plays other than 1) change the playback length; pass `seconds`")
    }
    const toSeconds = createTempoMap(timelineBox)
    const end = isDefined(to) ? Option.wrap(toSeconds(to)) : contentEnd(graph, toSeconds)
    if (end.isEmpty()) {return panic("the project has no regions to derive a length from; pass `seconds`")}
    return {from, to, seconds: Math.max(0, end.unwrap() - toSeconds(from)) + tail}
}

const contentEnd = (graph: BoxGraph, toSeconds: (position: ppqn) => seconds): Option<seconds> => {
    let musical = Number.NEGATIVE_INFINITY
    let absolute = Number.NEGATIVE_INFINITY
    graph.boxes().forEach(box => {
        if (box instanceof NoteRegionBox || box instanceof ValueRegionBox) {
            musical = Math.max(musical, box.position.getValue() + box.duration.getValue())
        } else if (box instanceof AudioRegionBox) {
            if (box.timeBase.getValue() === TimeBase.Seconds) {
                absolute = Math.max(absolute, toSeconds(box.position.getValue()) + box.duration.getValue())
            } else {
                musical = Math.max(musical, box.position.getValue() + box.duration.getValue())
            }
        }
    })
    const end = Math.max(Number.isFinite(musical) ? toSeconds(musical) : musical, absolute)
    return Number.isFinite(end) ? Option.wrap(end) : Option.None
}

const readValueEvents = (collection: ValueEventCollectionBox): ReadonlyArray<ValueEvent> =>
    collection.events.pointerHub.incoming()
        .map(pointer => pointer.box)
        .filter((box): box is ValueEventBox => box instanceof ValueEventBox)
        .map((box): ValueEvent => ({
            type: "value-event",
            position: box.position.getValue(),
            index: box.index.getValue(),
            value: box.value.getValue(),
            interpolation: InterpolationFieldAdapter.read(box.interpolation)
        }))
        .sort(ValueEvent.Comparator)

const MAGIC_HEADER_OPEN = 0x4F50454E

const decodeProject = (bytes: Uint8Array): BoxGraph<BoxIO.TypeMap> => {
    const buffer = new Uint8Array(bytes).buffer
    if (bytes.byteLength >= 4 && new ByteArrayInput(buffer).readInt() === MAGIC_HEADER_OPEN) {
        return ProjectSkeleton.decode(buffer).boxGraph
    }
    const graph = new BoxGraph<BoxIO.TypeMap>(Option.wrap(BoxIO.create))
    graph.fromArrayBuffer(buffer, false)
    return graph
}

const SCRIPT_CONFIGS = [
    {type: ApparatDeviceBox, config: {headerTag: "apparat", registryName: "apparatProcessors", functionName: "apparat"}},
    {type: WerkstattDeviceBox, config: {headerTag: "werkstatt", registryName: "werkstattProcessors", functionName: "werkstatt"}},
    {type: SpielwerkDeviceBox, config: {headerTag: "spielwerk", registryName: "spielwerkProcessors", functionName: "spielwerk"}}
] as const

type Script = {uuid: string, code: string}

const collectScripts = (graph: BoxGraph): ReadonlyArray<Script> =>
    graph.boxes().flatMap(box => {
        const entry = SCRIPT_CONFIGS.find(({type}) => box instanceof type)
        if (!isDefined(entry)) {return []}
        const source = (box as ApparatDeviceBox | WerkstattDeviceBox | SpielwerkDeviceBox).code.getValue()
        const match = source.match(new RegExp(`^// @${entry.config.headerTag} (\\w+) (\\d+) (\\d+)\n`))
        if (!isDefined(match)) {return []}
        const uuid = UUID.toString(box.address.uuid)
        return [{uuid, code: ScriptCompiler.wrap(entry.config, uuid, parseInt(match[3]), source.slice(match[0].length))}]
    })

type Resources = {
    samples: ReadonlyMap<string, AudioData>
    soundfonts: ReadonlyMap<string, SoundFont2>
    missingSamples: ReadonlyArray<string>
    missingSoundfonts: ReadonlyArray<string>
}

const fetchResources = async (graph: BoxGraph, {samples, soundfonts}: RenderOptions): Promise<Resources> => {
    const uuidsOf = (type: typeof AudioFileBox | typeof SoundfontFileBox): ReadonlyArray<string> =>
        graph.boxes().filter(box => box instanceof type).map(box => UUID.toString(box.address.uuid))
    const fetchAll = async <T>(uuids: ReadonlyArray<string>,
                               source: Nullable<(uuid: string) => Promise<Nullable<T>>>): Promise<Map<string, T>> => {
        if (!isDefined(source)) {return new Map()}
        const entries = await Promise.all(uuids.map(async uuid => [uuid, await source(uuid)] as const))
        return new Map(entries.flatMap(([uuid, value]) => isDefined(value) ? [[uuid, value] as const] : []))
    }
    const sampleUuids = uuidsOf(AudioFileBox)
    const soundfontUuids = uuidsOf(SoundfontFileBox)
    const audio = await fetchAll(sampleUuids, samples ?? null)
    audio.forEach((data, uuid) => validateAudio(uuid, data))
    const files = await fetchAll(soundfontUuids, soundfonts ?? null)
    const parsed = new Map(Array.from(files, ([uuid, bytes]) =>
        [uuid, parseSoundfont(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes))] as const))
    return {
        samples: audio,
        soundfonts: parsed,
        missingSamples: sampleUuids.filter(uuid => !audio.has(uuid)),
        missingSoundfonts: soundfontUuids.filter(uuid => !parsed.has(uuid))
    }
}

const validateAudio = (uuid: string, {sampleRate, numberOfFrames, numberOfChannels, frames}: AudioData): void => {
    const valid = sampleRate > 0 && Number.isInteger(numberOfFrames) && numberOfFrames > 0
        && Number.isInteger(numberOfChannels) && numberOfChannels > 0 && frames.length >= numberOfChannels
        && frames.slice(0, numberOfChannels).every(channel => channel.length >= numberOfFrames)
    if (!valid) {
        panic(`sample ${uuid}: invalid AudioData (sampleRate ${sampleRate}, frames ${numberOfFrames}, channels ${numberOfChannels})`)
    }
}

const createClient = (resources: Resources, messages: Array<string>, failures: Array<unknown>): EngineToClient => {
    const lookup = <T>(map: ReadonlyMap<string, T>, kind: string, uuid: UUID.Bytes): Promise<T> => {
        const key = UUID.toString(uuid)
        const value = map.get(key)
        return isDefined(value) ? Promise.resolve(value) : Promise.reject(new Error(`${kind} ${key} is missing`))
    }
    const ignore = (): void => {}
    return {
        log: message => messages.push(message),
        error: reason => failures.push(reason),
        deviceMessage: (uuid, message) => messages.push(`device ${uuid}: ${message}`),
        fetchAudio: uuid => lookup(resources.samples, "sample", uuid),
        fetchSoundfont: uuid => lookup(resources.soundfonts, "soundfont", uuid),
        fetchNamWasm: () => loadNamWasm(),
        fetchWclapBundle: url => Promise.reject(new Error(`WCLAP plugins are not available in headless renders (${url})`)),
        wclapSend: ignore, wclapState: ignore, wclapParams: ignore, wclapParam: ignore, wclapHovered: ignore,
        wclapResizeGui: ignore, wclapRequestSave: ignore,
        wclapStatus: (uuid, {state, message}) => {if (state === "failed") {messages.push(`plugin ${uuid}: ${message}`)}},
        notifyClipSequenceChanges: ignore, switchMarkerState: ignore, recordingStarted: ignore, ready: ignore
    }
}

// The studio's export disables the loop; a range end pauses the transport there (pauseOnLoopDisabled).
const limitTransport = (graph: BoxGraph, timelineBox: TimelineBox, {from, to}: Span): void => {
    graph.beginTransaction()
    timelineBox.loopArea.enabled.setValue(false)
    if (isDefined(to)) {
        timelineBox.loopArea.from.setValue(from)
        timelineBox.loopArea.to.setValue(to)
    }
    graph.endTransaction()
}

type RunningEngine = {engine: EngineExports, memory: WebAssembly.Memory, messages: ReadonlyArray<string>}

const startEngine = async (graph: BoxGraph<BoxIO.TypeMap>, resources: Resources, scripts: ReadonlyArray<Script>,
                           sampleRate: number): Promise<RunningEngine> => {
    ;(globalThis as unknown as {sampleRate: number}).sampleRate = sampleRate
    scripts.forEach(({code}) => new Function(code)())
    const messages: Array<string> = []
    const failures: Array<unknown> = []
    const memory = createEngineMemory()
    const client = createClient(resources, messages, failures)
    const {engine, nam} = instantiateEngine(await loadModules(), memory, sampleRate, client)
    engine.set_metronome_enabled(0)
    applySnapshot(engine, memory, graph)
    if (engine.bind() !== 0) {return panic("the project has no TimelineBox")}
    await loadResources(engine, memory, client, sampleRate, failures)
    await nam.settle()
    if (failures.length > 0) {throw failures[0]}
    return {engine, memory, messages}
}

const ENGINE_TABLE_RESERVE = 512

// boot.ts `instantiateWasmEngine`, but keeping the NAM bridge so a render can wait for its lazy model load.
const instantiateEngine = (modules: WasmEngineModules, memory: WebAssembly.Memory, sampleRate: number,
                           client: EngineToClient): {engine: EngineExports, nam: NamBridges} => {
    const table = new WebAssembly.Table({initial: ENGINE_TABLE_RESERVE, element: "anyfunc"})
    const env = {memory, __indirect_function_table: table, host_perf_now: () => performance.now() * 1000.0}
    const engine = new WebAssembly.Instance(modules.engineModule, {env}).exports as unknown as EngineExports
    engine.init(sampleRate)
    const scripts = new ScriptBridges(memory, engine as unknown as ScriptEngine, sampleRate,
        (uuid, message) => client.deviceMessage(uuid, message))
    const nam = new NamBridges(memory, () => client.fetchNamWasm(), sampleRate)
    const imports = {...scripts.imports(), ...nam.imports(), ...createWclapBridges(memory, sampleRate, client).imports()}
    modules.deviceModules.forEach((deviceModule, index) =>
        linkDevice(engine, memory, table, deviceModule, modules.deviceBoxTypes[index], sampleRate, imports))
    modules.composites.forEach(composite => registerComposite(engine, memory, composite))
    modules.effectComposites.forEach(composite => registerEffectComposite(engine, memory, composite))
    return {engine, nam}
}

const applySnapshot = (engine: EngineExports, memory: WebAssembly.Memory, graph: BoxGraph<BoxIO.TypeMap>): void => {
    const tasks: Array<UpdateTask<BoxIO.TypeMap>> = graph.boxes().map(box =>
        ({type: "new", name: box.name as keyof BoxIO.TypeMap, uuid: box.address.uuid, buffer: box.toArrayBuffer()}))
    const bytes = new Uint8Array(serializeUpdateTasks(tasks))
    const pointer = engine.input_reserve(bytes.length)
    new Uint8Array(memory.buffer, pointer, bytes.length).set(bytes)
    if (engine.apply_updates(bytes.length) !== 0) {panic("the engine rejected the project snapshot")}
}

const loadResources = async (engine: EngineExports, memory: WebAssembly.Memory, client: EngineToClient,
                             sampleRate: number, failures: Array<unknown>): Promise<void> => {
    const pending = new Set<Promise<unknown>>()
    drainResourceRequests(engine, memory, client, pending, sampleRate,
        reason => failures.push(describeEngineTrap(engine, memory, reason)))
    if (pending.size === 0) {return}
    await Promise.all(pending)
    return loadResources(engine, memory, client, sampleRate, failures)
}

const renderFrames = (engine: EngineExports, memory: WebAssembly.Memory,
                      numberOfFrames: number): [Float32Array, Float32Array] => {
    const left = new Float32Array(numberOfFrames)
    const right = new Float32Array(numberOfFrames)
    for (let offset = 0; offset < numberOfFrames; offset += RenderQuantum) {
        const rendered = tryCatch(() => engine.render())
        if (rendered.status === "failure") {throw describeEngineTrap(engine, memory, rendered.error)}
        takeReportMessage(engine, memory).ifSome(message => panic(`engine: ${message}`))
        const count = Math.min(RenderQuantum, numberOfFrames - offset)
        const pointer = engine.output_ptr()
        const buffer = memory.buffer
        left.set(new Float32Array(buffer, pointer, count), offset)
        right.set(new Float32Array(buffer, pointer + RenderQuantum * Float32Array.BYTES_PER_ELEMENT, count), offset)
    }
    return [left, right]
}

const measure = (channels: ReadonlyArray<Float32Array>): {peak: number, rms: number} => {
    let peak = 0.0
    let energy = 0.0
    let count = 0
    channels.forEach(channel => {
        for (let index = 0; index < channel.length; index++) {
            const value = channel[index]
            const magnitude = Math.abs(value)
            if (magnitude > peak) {peak = magnitude}
            energy += value * value
        }
        count += channel.length
    })
    return {peak, rms: count === 0 ? 0.0 : Math.sqrt(energy / count)}
}

const requireModule = createRequire(import.meta.url)
const resolveModule = requireModule.resolve

// Loaded through CommonJS resolution: the package's "module" entry is a browser build that needs `window`.
const parseSoundfont = (bytes: Uint8Array): SoundFont2 =>
    new (requireModule("soundfont2") as typeof import("soundfont2")).SoundFont2(bytes)

let modules: Nullable<Promise<WasmEngineModules>> = null
let namWasm: Nullable<Promise<ArrayBuffer>> = null

const loadModules = (): Promise<WasmEngineModules> => modules ??= compileModules().catch(reason => {
    modules = null
    throw reason
})

const compileModules = async (): Promise<WasmEngineModules> => {
    const compile = async (url: string): Promise<WebAssembly.Module> =>
        WebAssembly.compile(await readFile(resolveModule(`@opendaw/studio-core-wasm${url}`)))
    const [engineModule, ...deviceModules] = await Promise.all(
        ["/wasm/engine.wasm", ...DEVICES.map(({url}) => url)].map(compile))
    return {
        engineModule, deviceModules, deviceBoxTypes: DEVICES.map(({boxType}) => boxType),
        composites: COMPOSITES, effectComposites: EFFECT_COMPOSITES
    }
}

const loadNamWasm = (): Promise<ArrayBuffer> => namWasm ??= readFile(resolveModule("@opendaw/nam-wasm/nam.wasm"))
    .then(bytes => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer)
