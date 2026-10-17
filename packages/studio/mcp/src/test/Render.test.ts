import {afterAll, describe, expect, it} from "vitest"
import {mkdtempSync, readFileSync, rmSync, writeFileSync} from "node:fs"
import {tmpdir} from "node:os"
import * as path from "node:path"
import {Interpolation, PPQN, WavFile} from "@opendaw/lib-dsp"
import {UUID} from "@opendaw/lib-std"
import {ProjectSkeleton} from "@opendaw/studio-adapters"
import {NeuralAmpDeviceBox, NeuralAmpModelBox} from "@opendaw/studio-boxes"
import {ApiImpl, ProjectImpl, Sample, ScriptHostProtocol} from "@opendaw/studio-scripting"
import {encodeWav, MissingResourcesError, Render, renderProject, SampleSource} from "../Render"
import {decodeWav, encodeWavChannels} from "../Wav"

const RATE = 48_000
const DIRECTORY = mkdtempSync(path.join(tmpdir(), "studio-mcp-render-"))
const EIGHTH = PPQN.SemiQuaver * 2
const HALF = PPQN.Quarter * 2

const newProject = (bpm: number): ProjectImpl => {
    const project = new ApiImpl({} as ScriptHostProtocol).newProject("Test") as ProjectImpl
    project.bpm = bpm
    return project
}

const bytesOf = (project: ProjectImpl): Uint8Array => new Uint8Array(project.context.boxGraph.toArrayBuffer())

const firstAbove = (render: Render, threshold: number): number => {
    const [left, right] = render.channels
    for (let index = 0; index < left.length; index++) {
        if (Math.abs(left[index]) > threshold || Math.abs(right[index]) > threshold) {return index}
    }
    return -1
}

const peakIn = (render: Render, fromSeconds: number, toSeconds: number): number => {
    const from = Math.round(fromSeconds * render.sampleRate)
    const to = Math.min(render.channels[0].length, Math.round(toSeconds * render.sampleRate))
    let peak = 0
    render.channels.forEach(channel => {
        for (let index = from; index < to; index++) {peak = Math.max(peak, Math.abs(channel[index]))}
    })
    return peak
}

const frequencyIn = (render: Render, fromSeconds: number, toSeconds: number): number => {
    const [left] = render.channels
    let crossings = 0
    for (let index = Math.round(fromSeconds * render.sampleRate) + 1; index < Math.round(toSeconds * render.sampleRate); index++) {
        if (left[index - 1] < 0 && left[index] >= 0) {crossings++}
    }
    return crossings / (toSeconds - fromSeconds)
}

const sameBits = (a: Render, b: Render): boolean =>
    a.channels.every((channel, index) => Buffer.from(channel.buffer).equals(Buffer.from(b.channels[index].buffer)))

const sineSample = (frequency: number, sampleRate: number, seconds: number) => {
    const uuid = UUID.toString(UUID.generate())
    const pcm = new Float32Array(Math.round(sampleRate * seconds))
        .map((_, index) => 0.5 * Math.sin(2 * Math.PI * frequency * index / sampleRate))
    writeFileSync(path.join(DIRECTORY, `${uuid}.wav`), encodeWavChannels(sampleRate, [pcm], 16))
    const sample: Sample = {uuid, name: "sine", duration: seconds, bpm: 0, sample_rate: sampleRate}
    const samples: SampleSource = async requested => requested === uuid
        ? decodeWav(readFileSync(path.join(DIRECTORY, `${requested}.wav`)))
        : null
    return {sample, samples}
}

const leadProject = (bpm: number, position: number = PPQN.Bar): ProjectImpl => {
    const project = newProject(bpm)
    const lead = project.addInstrumentUnit("Vaporisateur", {label: "Lead"})
    lead.noteTracks[0].addRegion({position, duration: PPQN.Bar}).addEvents([{pitch: 60, duration: PPQN.Quarter}])
    return project
}

const bandProject = (bars: number, sample: Sample): ProjectImpl => {
    const project = newProject(120)
    const loop = {duration: PPQN.Bar * bars, loopDuration: PPQN.Bar}
    const lead = project.addInstrumentUnit("Vaporisateur", {label: "Lead", volume: -6})
    lead.addAudioEffect("Delay", {feedback: 0.4})
    lead.addAudioEffect("Reverb")
    lead.noteTracks[0].addRegion(loop).addEvents([60, 64, 67, 72, 67, 64, 62, 59]
        .map((pitch, index) => ({pitch, position: index * EIGHTH, duration: EIGHTH})))
    const bass = project.addInstrumentUnit("Neon", {label: "Bass", volume: -6})
    bass.addAudioEffect("Crusher")
    bass.noteTracks[0].addRegion(loop).addEvents([36, 36, 43, 41]
        .map((pitch, index) => ({pitch, position: index * PPQN.Quarter, duration: EIGHTH})))
    const pad = project.addInstrumentUnit("Tubular", {label: "Pad", volume: -12})
    pad.addAudioEffect("DattorroReverb")
    pad.noteTracks[0].addRegion(loop).addEvents([48, 55, 64].map(pitch => ({pitch, duration: PPQN.Bar})))
    const drums = project.addInstrumentUnit("Playfield", {label: "Drums", volume: -6})
    drums.instrument.addSample(sample, {note: 36})
    drums.addAudioEffect("Compressor")
    drums.noteTracks[0].addRegion(loop).addEvents([0, 1, 2, 3]
        .map(beat => ({pitch: 36, position: beat * PPQN.Quarter, duration: PPQN.SemiQuaver, chance: 70})))
    return project
}

// A minimal SoundFont 2 file: one preset, one instrument zone, one looped mono sample.
const soundfontFile = (pcm: Int16Array, sampleRate: number, rootKey: number): Uint8Array => {
    const ascii = (text: string, length: number): Uint8Array => {
        const bytes = new Uint8Array(length)
        for (let index = 0; index < Math.min(text.length, length); index++) {bytes[index] = text.charCodeAt(index)}
        return bytes
    }
    const record = (size: number, write: (view: DataView, bytes: Uint8Array) => void): Uint8Array => {
        const bytes = new Uint8Array(size)
        write(new DataView(bytes.buffer), bytes)
        return bytes
    }
    const concat = (parts: ReadonlyArray<Uint8Array>): Uint8Array => {
        const result = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0))
        let offset = 0
        parts.forEach(part => {
            result.set(part, offset)
            offset += part.length
        })
        return result
    }
    const chunk = (id: string, ...parts: ReadonlyArray<Uint8Array>): Uint8Array => {
        const body = concat(parts)
        return concat([ascii(id, 4), record(4, view => view.setUint32(0, body.length, true)), body,
            new Uint8Array(body.length & 1)])
    }
    const list = (type: string, ...chunks: ReadonlyArray<Uint8Array>): Uint8Array => chunk("LIST", ascii(type, 4), ...chunks)
    const preset = (name: string, bag: number) => record(38, (view, bytes) => {bytes.set(ascii(name, 20)); view.setUint16(24, bag, true)})
    const bag = (generator: number) => record(4, view => view.setUint16(0, generator, true))
    const generator = (operator: number, amount: number) =>
        record(4, view => {view.setUint16(0, operator, true); view.setInt16(2, amount, true)})
    const instrument = (name: string, bagIndex: number) => record(22, (view, bytes) => {bytes.set(ascii(name, 20)); view.setUint16(20, bagIndex, true)})
    const header = (name: string, end: number) => record(46, (view, bytes) => {
        bytes.set(ascii(name, 20))
        view.setUint32(24, end, true)
        view.setUint32(32, end, true)
        view.setUint32(36, end > 0 ? sampleRate : 0, true)
        bytes[40] = end > 0 ? rootKey : 0
        view.setUint16(44, end > 0 ? 1 : 0, true)
    })
    const samples = concat([new Uint8Array(pcm.buffer.slice(0)), new Uint8Array(46 * 2)])
    const body = concat([ascii("sfbk", 4),
        list("INFO", chunk("ifil", record(4, view => {view.setUint16(0, 2, true); view.setUint16(2, 1, true)})),
            chunk("isng", ascii("EMU8000", 8)), chunk("INAM", ascii("Test", 6))),
        list("sdta", chunk("smpl", samples)),
        list("pdta",
            chunk("phdr", preset("Sine", 0), preset("EOP", 1)),
            chunk("pbag", bag(0), bag(1)),
            chunk("pmod", new Uint8Array(10)),
            chunk("pgen", generator(41, 0), generator(0, 0)),
            chunk("inst", instrument("Sine", 0), instrument("EOI", 1)),
            chunk("ibag", bag(0), bag(2)),
            chunk("imod", new Uint8Array(10)),
            chunk("igen", generator(54, 1), generator(53, 0), generator(0, 0)),
            chunk("shdr", header("Sine", pcm.length), header("EOS", 0)))])
    return concat([ascii("RIFF", 4), record(4, view => view.setUint32(0, body.length, true)), body])
}

afterAll(() => rmSync(DIRECTORY, {recursive: true, force: true}))

describe("renderProject", () => {
    it("plays a Vaporisateur note in its time window and is silent before it", async () => {
        const render = await renderProject(bytesOf(leadProject(120)))
        expect(render.sampleRate).toBe(RATE)
        expect(peakIn(render, 0, 2)).toBe(0)
        const onset = firstAbove(render, 1e-4)
        expect(onset).toBeGreaterThanOrEqual(2 * RATE)
        expect(onset).toBeLessThan(2 * RATE + RATE / 200)
        expect(peakIn(render, 2, 2.5)).toBeGreaterThan(0.1)
        expect(peakIn(render, 3.5, render.seconds)).toBeLessThan(peakIn(render, 2, 2.5) / 100)
        expect(render.peak).toBeGreaterThan(0.1)
        expect(render.rms).toBeGreaterThan(0)
        expect(render.channels.every(channel => channel.every(Number.isFinite))).toBe(true)
    }, 60_000)

    it("derives the length from tempo, range and tail", async () => {
        const at120 = await renderProject(bytesOf(leadProject(120)))
        expect(at120.seconds).toBe(6)
        expect(at120.channels[0].length).toBe(6 * RATE)
        expect(at120.channels[1].length).toBe(6 * RATE)
        const at90 = await renderProject(bytesOf(leadProject(90)), {tailSeconds: 0})
        expect(at90.channels[0].length).toBe(Math.round(16 / 3 * RATE))
        expect(firstAbove(at90, 1e-4)).toBeGreaterThanOrEqual(Math.round(8 / 3 * RATE))
        expect(firstAbove(at90, 1e-4)).toBeLessThan(Math.round(8 / 3 * RATE) + RATE / 200)
        const explicit = await renderProject(bytesOf(leadProject(120)), {seconds: 1.234})
        expect(explicit.channels[0].length).toBe(Math.round(1.234 * RATE))
        const at44 = await renderProject(bytesOf(leadProject(120)), {sampleRate: 44_100})
        expect(at44.channels[0].length).toBe(6 * 44_100)
        expect(firstAbove(at44, 1e-4)).toBeLessThan(2 * 44_100 + 44_100 / 200)
    }, 60_000)

    it("follows tempo automation", async () => {
        const project = leadProject(120)
        project.tempoTrack.addEvent({position: 0, bpm: 60, interpolation: Interpolation.None})
        const render = await renderProject(bytesOf(project))
        expect(render.seconds).toBe(10)
        expect(peakIn(render, 0, 4)).toBe(0)
        expect(firstAbove(render, 1e-4)).toBeLessThan(4 * RATE + RATE / 200)
    }, 60_000)

    it("starts at fromPpqn and pauses at toPpqn", async () => {
        const project = newProject(120)
        const lead = project.addInstrumentUnit("Vaporisateur", {label: "Lead"})
        lead.noteTracks[0].addRegion({position: PPQN.Bar, duration: PPQN.Bar}).addEvents([{pitch: 60, duration: PPQN.Bar}])
        lead.noteTracks[0].addRegion({position: PPQN.Bar * 3, duration: PPQN.Bar}).addEvents([{pitch: 72, duration: PPQN.Bar}])
        const bytes = bytesOf(project)
        const range = await renderProject(bytes, {fromPpqn: PPQN.Bar, toPpqn: PPQN.Bar + HALF, tailSeconds: 5})
        const whole = await renderProject(bytes, {fromPpqn: PPQN.Bar})
        expect(range.seconds).toBe(6)
        expect(firstAbove(range, 1e-4)).toBeLessThan(RATE / 200)
        expect(peakIn(range, 0.5, 0.9)).toBeGreaterThan(0.1)
        expect(peakIn(range, 2, 6)).toBeLessThan(peakIn(range, 0.5, 0.9) / 100)
        expect(whole.seconds).toBe(8)
        expect(peakIn(whole, 1.5, 2)).toBeGreaterThan(0.1)
        expect(peakIn(whole, 4, 4.5)).toBeGreaterThan(0.1)
    }, 60_000)

    it("renders the same bytes bit-identically, with no state carried between renders", async () => {
        const {sample, samples} = sineSample(220, RATE, 0.25)
        const band = bytesOf(bandProject(2, sample))
        const first = await renderProject(band, {samples})
        const other = await renderProject(bytesOf(leadProject(100)))
        const second = await renderProject(band, {samples})
        const concurrent = await Promise.all([renderProject(band, {samples}), renderProject(band, {samples})])
        expect(first.peak).toBeGreaterThan(0.1)
        expect(other.peak).toBeGreaterThan(0.1)
        expect([second, ...concurrent].every(render => sameBits(first, render))).toBe(true)
    }, 60_000)

    it("accepts ProjectSkeleton.encode bytes and rejects invalid requests", async () => {
        const project = leadProject(120)
        const raw = await renderProject(bytesOf(project))
        const encoded = await renderProject(new Uint8Array(ProjectSkeleton.encode(project.context.boxGraph)))
        expect(sameBits(raw, encoded)).toBe(true)
        const bytes = bytesOf(project)
        await expect(renderProject(bytes, {toPpqn: 0})).rejects.toThrow("toPpqn")
        await expect(renderProject(bytes, {sampleRate: 1000})).rejects.toThrow("sampleRate")
        await expect(renderProject(bytes, {seconds: -1})).rejects.toThrow("seconds")
        await expect(renderProject(bytesOf(newProject(120)))).rejects.toThrow("pass `seconds`")
        expect((await renderProject(bytesOf(newProject(120)), {seconds: 0.5})).channels[0].length).toBe(RATE / 2)
        project.addMarker({position: 0, plays: 2})
        project.addMarker({position: PPQN.Bar})
        await expect(renderProject(bytesOf(project))).rejects.toThrow("marker repeats")
        expect((await renderProject(bytesOf(project), {seconds: 1})).seconds).toBe(1)
    }, 60_000)

    it("reports missing samples instead of substituting them", async () => {
        const {sample, samples} = sineSample(440, RATE, 1)
        const project = newProject(120)
        project.addInstrumentUnit("Tape", {label: "Tape"}).audioTracks[0].addRegion(sample, {position: 0})
        const bytes = bytesOf(project)
        await expect(renderProject(bytes)).rejects.toThrow(sample.uuid)
        await expect(renderProject(bytes)).rejects.toBeInstanceOf(MissingResourcesError)
        const failure = await renderProject(bytes, {samples: async () => null}).catch((error: unknown) => error)
        expect(failure).toBeInstanceOf(MissingResourcesError)
        expect((failure as MissingResourcesError).samples).toEqual([sample.uuid])
        const silent = await renderProject(bytes, {allowMissing: true})
        expect(silent.missingSamples).toEqual([sample.uuid])
        expect(silent.peak).toBe(0)
        const real = await renderProject(bytes, {samples})
        expect(real.missingSamples).toEqual([])
        expect(real.peak).toBeGreaterThan(0.4)
    }, 60_000)

    it("plays a real sample on a Tape region and a Playfield slot at its own sample rate", async () => {
        const {sample, samples} = sineSample(440, 44_100, 1)
        const project = newProject(120)
        project.addInstrumentUnit("Tape", {label: "Tape"}).audioTracks[0].addRegion(sample, {position: PPQN.Bar})
        const render = await renderProject(bytesOf(project), {samples})
        expect(render.seconds).toBe(5)
        expect(peakIn(render, 0, 2)).toBe(0)
        expect(firstAbove(render, 1e-3)).toBeLessThan(2 * RATE + RATE / 1000)
        expect(peakIn(render, 2.1, 2.9)).toBeCloseTo(0.5, 2)
        expect(frequencyIn(render, 2.2, 2.8)).toBeCloseTo(440, -1)
        expect(peakIn(render, 3.01, 5)).toBe(0)
        const drums = newProject(120)
        const playfield = drums.addInstrumentUnit("Playfield", {label: "Drums"})
        playfield.instrument.addSample(sample, {note: 60})
        playfield.noteTracks[0].addRegion({duration: PPQN.Bar}).addEvents([{pitch: 60, duration: HALF}])
        const slot = await renderProject(bytesOf(drums), {samples})
        expect(peakIn(slot, 0.1, 0.5)).toBeGreaterThan(0.1)
        expect(frequencyIn(slot, 0.1, 0.5)).toBeCloseTo(440, -1)
    }, 60_000)

    it("plays a soundfont from its .sf2 bytes", async () => {
        const length = 4800
        const pcm = new Int16Array(length).map((_, index) => Math.round(16000 * Math.sin(2 * Math.PI * 10 * index / length)))
        const uuid = UUID.toString(UUID.generate())
        const project = newProject(120)
        const unit = project.addInstrumentUnit("Soundfont", {label: "Keys"})
        unit.instrument.file = {uuid, name: "sine.sf2"}
        unit.noteTracks[0].addRegion({duration: PPQN.Bar}).addEvents([{pitch: 81, duration: PPQN.Bar}])
        const bytes = bytesOf(project)
        await expect(renderProject(bytes)).rejects.toThrow(uuid)
        const render = await renderProject(bytes, {soundfonts: async requested => requested === uuid ? soundfontFile(pcm, RATE, 69) : null})
        expect(render.missingSoundfonts).toEqual([])
        expect(peakIn(render, 0.2, 1.5)).toBeGreaterThan(0.05)
        expect(frequencyIn(render, 0.5, 1.5)).toBeCloseTo(200, -1)
    }, 60_000)

    it("waits for the NeuralAmp model before the first quantum", async () => {
        const model = readFileSync(new URL("../../../core-wasm/test/assets/wavenet.nam", import.meta.url), "utf8")
        const amped = async (mix: number): Promise<Render> => {
            const project = leadProject(120, 0)
            const amp = project.instrumentUnits[0].addAudioEffect("NeuralAmp", {mix})
            const graph = project.context.boxGraph
            graph.beginTransaction()
            const modelBox = NeuralAmpModelBox.create(graph, UUID.generate(), box => box.model.setValue(model))
            graph.findBox<NeuralAmpDeviceBox>(UUID.parse(amp.uuid)).unwrap("NeuralAmp box").model.refer(modelBox)
            graph.endTransaction()
            return renderProject(bytesOf(project), {seconds: 0.25})
        }
        const [wet, dry] = await Promise.all([amped(1), amped(0)])
        const [wetLeft] = wet.channels
        const [dryLeft] = dry.channels
        const earlyDifference = Array.from({length: 10 * 128}, (_, index) => Math.abs(wetLeft[index] - dryLeft[index]))
        expect(dry.peak).toBeGreaterThan(0.1)
        expect(wet.channels.every(channel => channel.every(Number.isFinite))).toBe(true)
        expect(Math.max(...earlyDifference)).toBeGreaterThan(0.01)
    }, 60_000)

    it("runs script devices only when allowed", async () => {
        const project = newProject(120)
        const unit = project.addInstrumentUnit("Apparat", {label: "Script"})
        unit.instrument.code = `class Processor {
            phase = 0
            process(output, block) {
                for (let i = block.s0; i < block.s1; i++) {
                    output[0][i] += 0.2 * Math.sin(this.phase)
                    output[1][i] += 0.2 * Math.sin(this.phase)
                    this.phase += 0.05
                }
            }
        }`
        const bytes = bytesOf(project)
        await expect(renderProject(bytes, {seconds: 1})).rejects.toThrow("runScripts")
        const render = await renderProject(bytes, {seconds: 1, runScripts: true})
        expect(render.peak).toBeCloseTo(0.2, 2)
    }, 60_000)

    it("renders 30 s of four instruments faster than real time", async () => {
        const {sample, samples} = sineSample(110, RATE, 0.2)
        const bytes = bytesOf(bandProject(14, sample))
        const start = performance.now()
        const render = await renderProject(bytes, {samples})
        const elapsed = (performance.now() - start) / 1000
        console.log(`30 s band render: ${(elapsed * 1000).toFixed(0)} ms, ${(render.seconds / elapsed).toFixed(1)}x real time`)
        expect(render.seconds).toBe(30)
        expect(render.peak).toBeGreaterThan(0.1)
        expect(render.seconds / elapsed).toBeGreaterThan(1)
    }, 120_000)
})

describe("encodeWav", () => {
    const render: Render = {
        sampleRate: 44_100,
        channels: [new Float32Array([0, 0.5, -0.5, 1, -1, 0.25, 1.5]), new Float32Array([0.1, -0.1, 0.2, -0.2, 0.3, -0.3, -2])],
        seconds: 7 / 44_100, peak: 2, rms: 0, missingSamples: [], missingSoundfonts: [], messages: []
    }
    const cases = [{bitDepth: 16, format: 1, tolerance: 1 / 32767}, {bitDepth: 24, format: 1, tolerance: 1 / 8388607},
        {bitDepth: 32, format: 3, tolerance: 0}] as const
    cases.forEach(({bitDepth, format, tolerance}) => it(`writes a parseable ${bitDepth}-bit file`, () => {
        const bytes = encodeWav(render, bitDepth)
        const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
        const text = (offset: number) => String.fromCharCode(...bytes.subarray(offset, offset + 4))
        const blockAlign = 2 * bitDepth / 8
        expect([text(0), text(8), text(12), text(36)]).toEqual(["RIFF", "WAVE", "fmt ", "data"])
        expect(view.getUint32(4, true)).toBe(bytes.length - 8)
        expect(view.getUint16(20, true)).toBe(format)
        expect(view.getUint16(22, true)).toBe(2)
        expect(view.getUint32(24, true)).toBe(44_100)
        expect(view.getUint32(28, true)).toBe(44_100 * blockAlign)
        expect(view.getUint16(32, true)).toBe(blockAlign)
        expect(view.getUint16(34, true)).toBe(bitDepth)
        expect(view.getUint32(40, true)).toBe(7 * blockAlign)
        expect(bytes.length).toBe(44 + 7 * blockAlign)
        const decoded = decodeWav(Buffer.from(bytes))
        expect([decoded.sampleRate, decoded.numberOfChannels, decoded.numberOfFrames]).toEqual([44_100, 2, 7])
        render.channels.forEach((channel, index) => channel.forEach((value, frame) => {
            const expected = bitDepth === 32 ? value : Math.max(-1, Math.min(1, value))
            expect(Math.abs(decoded.frames[index][frame] - expected)).toBeLessThanOrEqual(tolerance + 1e-9)
        }))
    }))
    it("decodes WAVE_FORMAT_EXTENSIBLE headers", () => {
        const plain = new Uint8Array(WavFile.encodeInts16({sampleRate: 22_050, numberOfFrames: 3, numberOfChannels: 1,
            frames: [new Float32Array(new SharedArrayBuffer(12)).fill(0.5)]}))
        const extensible = new Uint8Array(plain.length + 24)
        const view = new DataView(extensible.buffer)
        extensible.set(plain.subarray(0, 36))
        view.setUint32(4, extensible.length - 8, true)
        view.setUint32(16, 40, true)
        view.setUint16(20, 0xFFFE, true)
        view.setUint16(36, 22, true)
        view.setUint16(38, 16, true)
        view.setUint16(44, 1, true)
        extensible.set(plain.subarray(36), 60)
        const decoded = decodeWav(extensible)
        expect([decoded.sampleRate, decoded.numberOfChannels, decoded.numberOfFrames]).toEqual([22_050, 1, 3])
        expect(decoded.frames[0][2]).toBeCloseTo(0.5, 4)
    })
})
