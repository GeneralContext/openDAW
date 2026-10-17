import {afterAll, beforeAll, describe, expect, it} from "vitest"
import {execFile} from "node:child_process"
import {existsSync, readFileSync, writeFileSync} from "node:fs"
import {join} from "node:path"
import {fileURLToPath, pathToFileURL} from "node:url"
import {ProjectSkeleton} from "@opendaw/studio-adapters"
import {runRequest, undoRequest} from "../Requests"
import {describeProject, readStart, verifyWorkspace} from "../Verify"
import {Workspace} from "../Workspace"
import {fixtureProject, removeDirectories, temporaryDirectory} from "./Fixture"

const root = fileURLToPath(new URL("../../", import.meta.url))

beforeAll(async () => {
    const {bundle} = await import(pathToFileURL(join(root, "build.mjs")).href) as {bundle(names: ReadonlyArray<string>): Promise<unknown>}
    await bundle(["studio-mcp-worker", "studio-mcp-verify"])
}, 120_000)

afterAll(removeDirectories)

const task = (): {start: string, workspace: Workspace} => {
    const start = join(temporaryDirectory(), "start.od")
    writeFileSync(start, new Uint8Array(ProjectSkeleton.encode(fixtureProject().context.boxGraph)))
    const workspace = new Workspace(join(temporaryDirectory(), "song"))
    workspace.create(readStart(start))
    return {start, workspace}
}

const BASS = `const bass = project.addInstrumentUnit("Nano", {label: "Bass"})
bass.noteTracks[0].addRegion({duration: PPQN.Bar}).addEvents([36, 43].map((pitch, index) => ({pitch, position: index * PPQN.Quarter * 2, duration: PPQN.Quarter})))`

describe("Verify", () => {
    it("makes the project again from the start, with requests and undos", async () => {
        const {start, workspace} = task()
        await runRequest(workspace, BASS, "Bass")
        await runRequest(workspace, `project.bpm = 90`, "Tempo")
        await runRequest(workspace, `project.bmp = 3`, "Typo")
        await undoRequest(workspace)
        const {verification, graph} = verifyWorkspace(workspace, readStart(start))
        expect(verification).toMatchObject({status: "valid", records: 4, requests: 2, undos: 1, violations: []})
        const project = describeProject(graph!)
        expect(project.bpm).toBe(120)
        expect(project.parts.map(part => [part.label, part.notes.length])).toEqual([["Lead", 8], ["Bass", 2]])
        expect(project.parts[1].notes[1]).toMatchObject({pitch: 43, time: 1, position: 1920})
    })

    it("refuses a workspace that does not start from the task's project", async () => {
        const {workspace} = task()
        const other = task()
        await runRequest(workspace, `project.bpm = 90`, "Tempo")
        expect(verifyWorkspace(workspace, readStart(other.start)).verification.reason).toMatch(/cannot be applied again|do not start from the task's project/)
        const fresh = task()
        expect(verifyWorkspace(fresh.workspace, readStart(other.start)).verification.reason).toMatch(/project\.od is not the project/)
    })

    it("refuses a project changed outside the tools, and edits changed in the history", async () => {
        const {start, workspace} = task()
        await runRequest(workspace, `project.bpm = 90`, "Tempo")
        const graph = workspace.loadGraph()
        graph.beginTransaction()
        ProjectSkeleton.findMandatoryBoxes(graph).timelineBox.bpm.setValue(140)
        graph.endTransaction()
        workspace.saveGraph(graph)
        expect(verifyWorkspace(workspace, readStart(start)).verification.reason).toMatch(/changed outside the tools/)
        const second = task()
        const record = await runRequest(second.workspace, `project.bpm = 90`, "Tempo")
        const path = join(second.workspace.requestsDirectory, `0001-${record.id}.json`)
        writeFileSync(path, JSON.stringify({...record, updates: Buffer.from([0, 0, 0, 0]).toString("base64")}))
        expect(verifyWorkspace(second.workspace, readStart(second.start)).verification.reason).toMatch(/is not the one it recorded|project\.od/)
    })

    it("reports policy violations", async () => {
        const {start, workspace} = task()
        const policy = await runRequest(workspace, `project.addInstrumentUnit("Apparat", {label: "Code"})
const audio = AudioData.create(48000, 4800, 1)
const sample = await openDAW.addSample(audio, "Click")
const drums = project.addInstrumentUnit("Playfield", {label: "Drums"})
drums.instrument.addSample(sample, {note: 36})
drums.addAudioTrack().addRegion(sample, {duration: PPQN.Bar})`, "Policy")
        expect(policy.status).toBe("applied")
        const {verification} = verifyWorkspace(workspace, readStart(start), {allowedSamples: [], allowAudioTracks: false})
        expect(verification.status).toBe("invalid")
        expect(verification.violations.join("\n")).toMatch(/1 script device\(s\)[\s\S]*1 audio track\(s\) are not allowed \(Drums\)[\s\S]*is not one of the supplied samples/)
    })

    it("writes the verifier's files from the command line", async () => {
        const {start, workspace} = task()
        await runRequest(workspace, BASS, "Bass")
        const out = temporaryDirectory()
        const verify = (...args: ReadonlyArray<string>): Promise<{code: number, stdout: string}> => new Promise(resolve => {
            execFile(process.execPath, ["--disable-warning=ExperimentalWarning", join(root, "dist", "studio-mcp-verify.mjs"),
                "--dir", workspace.directory, "--start", start, "--out", out, ...args],
            (error, stdout) => resolve({code: typeof error?.code === "number" ? error.code : 0, stdout}))
        })
        const valid = await verify("--render", "--samples", "")
        expect(valid).toEqual({code: 0, stdout: "valid: 1 requests, 0 undos; rendered\n"})
        expect(JSON.parse(readFileSync(join(out, "render.json"), "utf8"))).toMatchObject({status: "rendered", file: "final.wav"})
        expect(existsSync(join(out, "final.wav"))).toBe(true)
        expect(JSON.parse(readFileSync(join(out, "project.json"), "utf8")).parts).toHaveLength(2)
        writeFileSync(workspace.projectPath, readFileSync(start))
        const invalid = await verify("--render")
        expect(invalid.code).toBe(2)
        expect(existsSync(join(out, "final.wav"))).toBe(false)
        expect(JSON.parse(readFileSync(join(out, "verification.json"), "utf8")).status).toBe("invalid")
    }, 60_000)
})
