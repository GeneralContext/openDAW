import {afterAll, beforeAll, describe, expect, it} from "vitest"
import {execFile} from "node:child_process"
import {existsSync, writeFileSync} from "node:fs"
import {join} from "node:path"
import {fileURLToPath, pathToFileURL} from "node:url"
import {ProjectSkeleton} from "@opendaw/studio-adapters"
import {fixtureProject, removeDirectories, temporaryDirectory} from "./Fixture"

const root = fileURLToPath(new URL("../../", import.meta.url))
const bundle = join(root, "dist", "studio-mcp.mjs")

beforeAll(async () => {
    const {bundle: build} = await import(pathToFileURL(join(root, "build.mjs")).href) as {bundle(names: ReadonlyArray<string>): Promise<unknown>}
    await build(["studio-mcp", "studio-mcp-worker"])
}, 120_000)

afterAll(removeDirectories)

type Result = {code: number, stdout: string, stderr: string}

const cli = (directory: string, ...args: ReadonlyArray<string>): Promise<Result> => new Promise(resolve => {
    execFile(process.execPath, ["--disable-warning=ExperimentalWarning", bundle, "--dir", directory, ...args],
        (error, stdout, stderr) => resolve({code: typeof error?.code === "number" ? error.code : 0, stdout, stderr}))
})

describe("Command line", () => {
    it("creates a workspace from a project file, applies requests and undoes them", async () => {
        const directory = temporaryDirectory()
        const source = join(temporaryDirectory(), "fixture.od")
        writeFileSync(source, new Uint8Array(ProjectSkeleton.encode(fixtureProject().context.boxGraph)))
        const workspace = join(directory, "song")
        expect((await cli(workspace, "init", "--from", source)).stdout).toContain(`instrument("Lead", "Vaporisateur")`)
        expect((await cli(workspace, "init")).code).toBe(1)
        const script = join(directory, "tempo.ts")
        writeFileSync(script, "// Faster\nproject.bpm = 150\n")
        const applied = await cli(workspace, "run", script)
        expect(applied.code).toBe(0)
        expect(applied.stdout).toMatch(/"Faster": applied/)
        const invalid = await cli(workspace, "run", "-e", "project.bmp = 3")
        expect(invalid.code).toBe(3)
        expect(invalid.stdout).toMatch(/invalid\nline 1:9/)
        expect((await cli(workspace, "status")).stdout).toContain("150 BPM")
        expect((await cli(workspace, "undo")).stdout).toMatch(/"Undo Faster": applied/)
        expect((await cli(workspace, "status")).stdout).toContain("120 BPM")
        expect((await cli(workspace, "undo")).code).toBe(3)
        expect((await cli(workspace, "nope")).stderr).toMatch(/Unknown command 'nope'/)
    }, 60_000)

    it("applies requests from two processes at once one after the other", async () => {
        const workspace = temporaryDirectory()
        await cli(workspace, "init")
        const results = await Promise.all([
            cli(workspace, "run", "-e", `project.addInstrumentUnit("Nano", {label: "Keys"})`, "--label", "Keys"),
            cli(workspace, "run", "-e", `project.addAuxUnit({label: "Verb"})`, "--label", "Verb")])
        expect(results.map(result => result.code)).toEqual([0, 0])
        const text = (await cli(workspace, "status")).stdout
        expect(text).toContain(`instrument("Keys", "Nano")`)
        expect(text).toContain(`unit("Verb")`)
        expect(existsSync(join(workspace, ".lock"))).toBe(false)
    }, 60_000)

    it("renders the mix and one stem per instrument", async () => {
        const directory = temporaryDirectory()
        const source = join(directory, "fixture.od")
        writeFileSync(source, new Uint8Array(ProjectSkeleton.encode(fixtureProject().context.boxGraph)))
        const workspace = join(directory, "song")
        await cli(workspace, "init", "--from", source)
        expect((await cli(workspace, "render", "stems")).stderr).toMatch(/'render' takes no argument 'stems'; options start with --/)
        const rendered = await cli(workspace, "render", "--name", "take", "--stems")
        expect(rendered.code).toBe(0)
        expect(rendered.stdout).toMatch(/take\.wav: 4\.00 s, 48000 Hz stereo, peak -?\d/)
        expect(existsSync(join(workspace, "renders", "take.Lead.wav"))).toBe(true)
    }, 60_000)

    it("renders the workspace's script devices", async () => {
        const directory = temporaryDirectory()
        const workspace = join(directory, "song")
        await cli(workspace, "init")
        const request = join(directory, "tone.ts")
        writeFileSync(request, `project.addInstrumentUnit("Apparat", {label: "Tone"}).instrument.code = \`class Processor {
    phase = 0
    process(output, block) {
        for (let i = block.s0; i < block.s1; i++) {
            output[0][i] += 0.2 * Math.sin(this.phase)
            output[1][i] += 0.2 * Math.sin(this.phase)
            this.phase += 0.05
        }
    }
}\``)
        expect((await cli(workspace, "run", request)).code).toBe(0)
        const rendered = await cli(workspace, "render", "--seconds", "1")
        expect(rendered.code).toBe(0)
        expect(rendered.stdout).toMatch(/1\.00 s, 48000 Hz stereo, peak -1[34]\.\d dBFS/)
    }, 60_000)
})
