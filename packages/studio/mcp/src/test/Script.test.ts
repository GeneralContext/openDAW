import {describe, expect, it} from "vitest"
import {Option} from "@opendaw/lib-std"
import {BoxGraph} from "@opendaw/lib-box"
import {BoxIO, NoteEventBox} from "@opendaw/studio-boxes"
import {checkScript, runScript} from "../Script"
import {copyBytes} from "../UpdateCodec"
import {fixtureBytes} from "./Fixture"

const graphOf = (bytes: Uint8Array): BoxGraph => {
    const graph = new BoxGraph<BoxIO.TypeMap>(Option.wrap(BoxIO.create))
    graph.fromArrayBuffer(copyBytes(bytes))
    return graph
}

describe("Scripts", () => {
    it("reports type errors with lines before running anything", () => {
        const diagnostics = checkScript(`project.bpm = 128\nconst lead = project.findAudioUnit("Lead")\nlead.volme = -3\n`)
        expect(diagnostics.map(diagnostic => diagnostic.line)).toContain(3)
        expect(diagnostics.some(diagnostic => /volme/.test(diagnostic.message))).toBe(true)
        expect(checkScript(`project.bpm = 128\nproject.addInstrumentUnit("Nano", {label: "Keys"})\n`)).toEqual([])
        expect(checkScript(`const pitches = Array.from({length: 4}, (_, index) => 60 + index)\nconsole.log(new Map([[1, 2]]).size, pitches.at(-1))\n`)).toEqual([])
    })

    it("accepts top-level await", async () => {
        const script = `const samples = await openDAW.listSamples()\nfor await (const sample of samples) {console.log(sample.name)}\n`
        expect(checkScript(script)).toEqual([])
        const run = await runScript(script, fixtureBytes(), "Fixture", {listSamples: async () =>
            [{uuid: "11111111-2222-3333-4444-555555555555", name: "Kick", duration: 1, bpm: 0, sample_rate: 48000}]})
        expect(run.status).toBe("ok")
        if (run.status === "ok") {expect(run.logs).toEqual(["Kick"])}
    })

    it("returns the native edits of a script without changing the source project", async () => {
        const bytes = fixtureBytes()
        const run = await runScript(`
            project.bpm = 132
            const keys = project.addInstrumentUnit("Vaporisateur", {label: "Keys", volume: -6})
            keys.noteTracks[0].addRegion({position: PPQN.Bar, duration: PPQN.Bar, label: "Chords"})
                .addEvents([60, 64, 67].map(pitch => ({pitch, duration: PPQN.Quarter})))
            console.log("units", project.audioUnits.length)
        `, bytes, "Fixture", {})
        expect(run.status).toBe("ok")
        if (run.status !== "ok") {return}
        expect(run.logs).toEqual(["units 3"])
        const graph = graphOf(bytes)
        const notes = () => graph.boxes().filter(box => box instanceof NoteEventBox).length
        expect(notes()).toBe(8)
        graph.beginTransaction()
        run.updates.forEach(update => update.forward(graph))
        graph.endTransaction()
        expect(notes()).toBe(11)
        expect(graphOf(bytes).boxes().filter(box => box instanceof NoteEventBox).length).toBe(8)
    })

    it("reports runtime errors with the agent's line number", async () => {
        const run = await runScript(`const a = 1\nconst unit = project.findAudioUnit("Nope")\nunit!.volume = 3\n`, fixtureBytes(), "Fixture", {},
            {typeCheck: false})
        expect(run.status).toBe("failed")
        if (run.status === "failed") {expect(run.line).toBe(3)}
    })

    it("stops a script that does not finish", async () => {
        const run = await runScript(`while (true) {}`, fixtureBytes(), "Fixture", {}, {timeoutMs: 1500, typeCheck: false})
        expect(run.status).toBe("timeout")
    })

    it("reports a service the host does not offer", async () => {
        const run = await runScript(`await openDAW.listSamples()`, fixtureBytes(), "Fixture", {})
        expect(run.status).toBe("failed")
        if (run.status === "failed") {expect(run.message).toMatch(/listSamples is not available/)}
    })
})
