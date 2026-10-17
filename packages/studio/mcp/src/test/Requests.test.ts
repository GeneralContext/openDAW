import {afterAll, describe, expect, it} from "vitest"
import {readFileSync} from "node:fs"
import {join} from "node:path"
import {ProjectSkeleton} from "@opendaw/studio-adapters"
import {checksumOf, runRequest, undoRequest} from "../Requests"
import {status} from "../Tools"
import {decodeWav} from "../Wav"
import {fixtureWorkspace, removeDirectories} from "./Fixture"

afterAll(removeDirectories)

const KEYS = `project.bpm = 132
const keys = project.addInstrumentUnit("Vaporisateur", {label: "Keys"})
keys.noteTracks[0].addRegion({duration: PPQN.Bar}).addEvents([60, 64, 67].map(pitch => ({pitch, duration: PPQN.Quarter})))
console.log("units", project.audioUnits.length)`

describe("Requests", () => {
    it("applies a request to project.od as one step and records it", async () => {
        const workspace = fixtureWorkspace()
        const record = await runRequest(workspace, KEYS, "Keys")
        expect(record.status).toBe("applied")
        expect(record.logs).toEqual(["units 3"])
        expect(record.changes.some(line => line.startsWith(`+ instrument("Keys", "Vaporisateur")`))).toBe(true)
        expect(record.details).toMatch(/\+3 NoteEventBox/)
        const text = status(workspace)
        expect(text).toContain("132 BPM")
        expect(text).toContain(`${record.id}  applied   Keys`)
        expect(readFileSync(join(workspace.requestsDirectory, `0001-${record.id}.ts`), "utf8")).toBe(KEYS)
    })

    it("changes nothing when a script does not type-check, fails or only reads", async () => {
        const workspace = fixtureWorkspace()
        const before = readFileSync(workspace.projectPath)
        const invalid = await runRequest(workspace, "project.bmp = 3", "Typo")
        expect(invalid.status).toBe("invalid")
        expect(invalid.message).toMatch(/^line 1:9 .*bmp/)
        const failed = await runRequest(workspace, `project.bpm = 90\nunit("Nope").volume = 1`, "Missing unit")
        expect(failed.status).toBe("failed")
        expect(failed.message).toMatch(/^line 2: No unit labelled "Nope"/)
        const reading = await runRequest(workspace, `console.log(project.audioUnits.length)`, "Count")
        expect(reading.status).toBe("unchanged")
        expect(reading.logs).toEqual(["2"])
        expect(readFileSync(workspace.projectPath).equals(before)).toBe(true)
        expect(workspace.records().map(record => record.status)).toEqual(["invalid", "failed", "unchanged"])
        expect(await undoRequest(workspace)).toBeNull()
    })

    it("undoes requests newest first, back to the same project", async () => {
        const workspace = fixtureWorkspace()
        const checksum = () => checksumOf(workspace.loadGraph())
        const original = checksum()
        const tempo = await runRequest(workspace, `project.bpm = 100\nproject.addMarker({position: PPQN.Bar, label: "B"})`, "Tempo")
        const afterTempo = checksum()
        const mix = await runRequest(workspace, `const lead = instrument("Lead", "Vaporisateur")
lead.volume = -9
lead.addAudioEffect("Delay", {feedback: 0.4})
lead.noteTracks[0].regions[0].remove()
project.addAuxUnit({label: "Verb"}).addAudioEffect("DattorroReverb")`, "Mix")
        expect(mix.status).toBe("applied")
        expect(status(workspace)).not.toContain(`"Motif"`)
        const first = await undoRequest(workspace)
        expect(first?.status).toBe("applied")
        expect(first?.target).toBe(mix.id)
        expect(checksum()).toBe(afterTempo)
        const second = await undoRequest(workspace)
        expect(second?.target).toBe(tempo.id)
        expect(checksum()).toBe(original)
        expect(status(workspace)).toContain(`"Motif"`)
        expect(await undoRequest(workspace)).toBeNull()
    })

    it("undoes a request that changes a pointer of a box it creates", async () => {
        const workspace = fixtureWorkspace()
        const original = checksumOf(workspace.loadGraph())
        const record = await runRequest(workspace, `const trigger = project.addInstrumentUnit("Playfield", {label: "Trigger"})
trigger.output = null
instrument("Lead", "Vaporisateur").addAudioEffect("Compressor").sideChain = trigger`, "Sidechain")
        expect(record.status).toBe("applied")
        const undo = await undoRequest(workspace)
        expect(undo?.message ?? null).toBeNull()
        expect(checksumOf(workspace.loadGraph())).toBe(original)
    })

    it("refuses to undo a request after the project changed outside the tools", async () => {
        const workspace = fixtureWorkspace()
        await runRequest(workspace, `project.bpm = 100`, "Tempo")
        const graph = workspace.loadGraph()
        graph.beginTransaction()
        ProjectSkeleton.findMandatoryBoxes(graph).timelineBox.bpm.setValue(140)
        graph.endTransaction()
        workspace.saveGraph(graph)
        const refused = await undoRequest(workspace)
        expect(refused?.status).toBe("failed")
        expect(refused?.message).toMatch(/changed outside these tools/)
        expect(status(workspace)).toContain("140 BPM")
    })

    it("applies concurrent requests one after the other, so both land", async () => {
        const workspace = fixtureWorkspace()
        const records = await Promise.all([
            runRequest(workspace, `project.addInstrumentUnit("Nano", {label: "Keys"})`, "Keys"),
            runRequest(workspace, `project.addAuxUnit({label: "Verb"})`, "Verb")])
        expect(records.map(record => record.status)).toEqual(["applied", "applied"])
        const text = status(workspace)
        expect(text).toContain(`instrument("Keys", "Nano")`)
        expect(text).toContain(`unit("Verb")`)
    })

    it("keeps samples that a request adds, and renders a mixdown into renders/", async () => {
        const workspace = fixtureWorkspace()
        const sample = await runRequest(workspace, `const audio = AudioData.create(48000, 4800, 1)
audio.frames[0].fill(0.25)
await openDAW.addSample(audio, "Click")
console.log((await openDAW.listSamples()).map(each => each.name).join(","))`, "Sample")
        expect(sample.logs).toEqual(["Click"])
        const [entry] = workspace.samples()
        expect(workspace.loadSample(entry.uuid)?.frames[0][100]).toBeCloseTo(0.25, 5)
        const mixdown = await runRequest(workspace, `const audio = await project.mixdown()
console.log(audio.numberOfChannels, audio.sampleRate)
await openDAW.saveFile(WavFile.encodeFloats(audio), "motif.wav", "audio/wav")`, "Mixdown", {timeoutMs: 60_000})
        expect(mixdown.message).toBeNull()
        expect(mixdown.logs).toEqual(["2 48000"])
        const wav = decodeWav(readFileSync(join(workspace.rendersDirectory, "motif.wav")))
        expect(wav.numberOfFrames).toBeGreaterThan(48_000 * 2)
        expect(wav.frames[0].reduce((peak, value) => Math.max(peak, Math.abs(value)), 0)).toBeGreaterThan(0.01)
    }, 60_000)
})
