import {readFileSync} from "node:fs"
import {parseArgs} from "node:util"
import {isDefined, Optional, panic} from "@opendaw/lib-std"
import {ProjectSkeleton} from "@opendaw/studio-adapters"
import {serveMcp} from "./Mcp"
import {status, TOOLS, ToolResult} from "./Tools"
import {copyBytes} from "./UpdateCodec"
import {Workspace} from "./Workspace"

const USAGE = `studio-mcp: edit an openDAW project with the Script API, from a shell or as an MCP server

  studio-mcp init [--from project.od]       create a workspace with a new project, or a copy of one
  studio-mcp status                         the project overview and the last requests
  studio-mcp read PATH                      details of one object, e.g. 'instrument("Lead").noteTracks[0].regions[0]';
                                            'read requests' lists all requests
  studio-mcp run FILE.ts [--label TEXT]     run a request script (- for stdin, or -e CODE)
  studio-mcp undo                           take back the newest applied request
  studio-mcp render [--name N] [--from-bar A] [--to-bar B] [--seconds S] [--stems]
                                            render WAV files with openDAW's engine
  studio-mcp docs [QUERY]                   the guide, or Script API declarations matching QUERY
  studio-mcp serve                          the same tools over MCP (stdio)

The workspace holds project.od (the project, which the studio opens), requests/, renders/ and samples/.
Options: --dir DIR selects it (default: $OPENDAW_WORKSPACE or the current directory).
Exit codes: 1 when the tool fails, 3 when a request was not applied.`

const {values, positionals} = parseArgs({
    allowPositionals: true,
    options: {
        dir: {type: "string"}, from: {type: "string"}, label: {type: "string"}, e: {type: "string"}, name: {type: "string"},
        "from-bar": {type: "string"}, "to-bar": {type: "string"}, seconds: {type: "string"}, stems: {type: "boolean"},
        help: {type: "boolean", short: "h"}
    }
})

const workspace = Workspace.locate(values.dir)
const [command, ...rest] = positionals

const number = (value: Optional<string>): Optional<number> => isDefined(value) ? Number(value) : undefined

const labelOf = (script: string): string => values.label ?? /^\s*\/\/\s*(.+)$/m.exec(script)?.[1]?.trim() ?? "request"

const startingProject = (): ArrayBuffer => isDefined(values.from)
    ? ProjectSkeleton.encode(ProjectSkeleton.decode(copyBytes(readFileSync(values.from))).boxGraph) as ArrayBuffer
    : ProjectSkeleton.encode(ProjectSkeleton.empty({createOutputMaximizer: false, createDefaultUser: true}).boxGraph) as ArrayBuffer

const argumentsOf = (name: string): Record<string, unknown> => {
    if (name === "read") {return {path: rest.join(" ")}}
    if (name === "docs") {return {query: rest.join(" ")}}
    if (name === "run") {
        const script = values.e ?? readFileSync(rest[0] === "-" || !isDefined(rest[0]) ? 0 : rest[0], "utf8")
        return {script, label: labelOf(script)}
    }
    if (name === "render") {
        return {name: values.name, fromBar: number(values["from-bar"]), toBar: number(values["to-bar"]),
            seconds: number(values.seconds), stems: values.stems}
    }
    return {}
}

const main = async (): Promise<ToolResult> => {
    if (values.help === true || !isDefined(command)) {return {text: USAGE, ok: true}}
    if (command === "init") {
        workspace.create(startingProject())
        return {text: `Created a workspace in ${workspace.directory}\n\n${status(workspace)}`, ok: true}
    }
    if (command === "serve") {
        await serveMcp(workspace)
        return {text: "", ok: true}
    }
    const tool = TOOLS.find(candidate => candidate.name === command)
    if (!isDefined(tool)) {return panic(`Unknown command '${command}'. Run 'studio-mcp --help' for the commands.`)}
    return tool.call(workspace, argumentsOf(command))
}

main().then(({text, ok}) => {
    if (text !== "") {process.stdout.write(text.endsWith("\n") ? text : `${text}\n`)}
    process.exit(ok ? 0 : 3)
}, (error: unknown) => {
    process.stderr.write(`studio-mcp: ${error instanceof Error ? error.message : String(error)}\n`)
    process.exit(1)
})
