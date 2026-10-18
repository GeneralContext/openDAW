import {mkdirSync, rmSync, writeFileSync} from "node:fs"
import {join} from "node:path"
import {parseArgs} from "node:util"
import {isDefined, panic} from "@opendaw/lib-std"
import {encodeWav, renderProject} from "./Render"
import {graphBytes} from "./Requests"
import {describeProject, Policy, readStart, sampleIndex, sampleLoader, verifyWorkspace} from "./Verify"
import {Workspace} from "./Workspace"

const USAGE = `studio-mcp-verify: grade a studio-mcp workspace for a benchmark task

  studio-mcp-verify --start FILE.od --out DIR [--render] [--allow-scripts | --run-scripts] [--no-audio-tracks]
                    [--samples UUID,... | --sample-dir DIR]

Applies the workspace's requests again from the task's starting project (FILE.od), checks that each one makes the
project it recorded and that project.od is the result, checks the policy, and writes verification.json,
project.json and, with --render, final.wav and render.json to DIR. --allow-scripts accepts script devices but never
runs their code, so such a project is graded but not rendered. --run-scripts also accepts them, and the render runs
their JavaScript in this process: give it a user that cannot read the task's hidden files. --no-audio-tracks refuses
audio tracks. --samples
lists the samples a project may use; --sample-dir gives them as files (index.json and WAVs, as in a workspace)
that the render plays.

Options: --dir DIR selects the workspace (default: $OPENDAW_WORKSPACE or the current directory).
Exit codes: 2 when the workspace is invalid (a measured outcome), 1 when the tool fails.`

const {values} = parseArgs({
    options: {
        dir: {type: "string"}, start: {type: "string"}, out: {type: "string"}, render: {type: "boolean"},
        "allow-scripts": {type: "boolean"}, "run-scripts": {type: "boolean"}, "no-audio-tracks": {type: "boolean"},
        samples: {type: "string"},
        "sample-dir": {type: "string"}, help: {type: "boolean", short: "h"}
    }
})

const OUTPUTS = ["verification.json", "project.json", "render.json", "final.wav"]

const writeJson = (path: string, value: unknown): void => writeFileSync(path, JSON.stringify(value, null, 2) + "\n")

const main = async (): Promise<{text: string, code: number}> => {
    if (values.help === true) {return {text: USAGE, code: 0}}
    const out = values.out ?? panic("--out is required")
    const start = values.start ?? panic("--start is required")
    const sampleDirectory = values["sample-dir"]
    if (isDefined(values.samples) && isDefined(sampleDirectory)) {return panic("Use --samples or --sample-dir, not both")}
    const runScripts = values["run-scripts"] === true
    mkdirSync(out, {recursive: true})
    OUTPUTS.forEach(file => rmSync(join(out, file), {force: true}))
    const policy: Policy = {
        allowScriptDevices: values["allow-scripts"] === true || runScripts,
        allowAudioTracks: values["no-audio-tracks"] !== true,
        allowedSamples: isDefined(sampleDirectory) ? sampleIndex(sampleDirectory).map(sample => sample.uuid)
            : isDefined(values.samples) ? values.samples.split(",").filter(uuid => uuid !== "") : undefined
    }
    const {verification, graph} = verifyWorkspace(Workspace.locate(values.dir), readStart(start), policy)
    writeJson(join(out, "verification.json"), verification)
    if (!isDefined(graph)) {return {text: `invalid: ${verification.reason}`, code: 2}}
    if (verification.violations.length > 0) {return {text: `invalid: ${verification.violations.join("; ")}`, code: 2}}
    writeJson(join(out, "project.json"), describeProject(graph))
    const summary = `valid: ${verification.requests} requests, ${verification.undos} undos`
    if (values.render !== true) {return {text: summary, code: 0}}
    // Scoring uses project.json, so a project that cannot render is still graded
    const samples = isDefined(sampleDirectory) ? sampleLoader(sampleDirectory) : async () => null
    const rendered = await renderProject(graphBytes(graph), {samples, allowMissing: false, runScripts})
        .then(render => ({status: "rendered", file: "final.wav", seconds: render.seconds, bytes: encodeWav(render, 24)}),
            (error: unknown) => ({status: "not rendered", reason: error instanceof Error ? error.message : String(error), bytes: null}))
    if (isDefined(rendered.bytes)) {writeFileSync(join(out, "final.wav"), rendered.bytes)}
    writeJson(join(out, "render.json"), {...rendered, bytes: undefined})
    return {text: `${summary}; ${rendered.status}`, code: 0}
}

main().then(({text, code}) => {
    process.stdout.write(`${text}\n`)
    process.exit(code)
}, (error: unknown) => {
    process.stderr.write(`studio-mcp-verify: ${error instanceof Error ? error.message : String(error)}\n`)
    process.exit(1)
})
