import {createInterface} from "node:readline"
import {isDefined} from "@opendaw/lib-std"
import {TOOLS} from "./Tools"
import {Workspace} from "./Workspace"

type JsonRpc = {jsonrpc: "2.0", id?: number | string, method: string, params?: Record<string, unknown>}

const SUPPORTED = ["2025-06-18", "2025-03-26", "2024-11-05"]

const INSTRUCTIONS = "Edit an openDAW project with the Script API. Start with status, make focused requests with run, and check each result."

const messageOf = (error: unknown): string => error instanceof Error ? error.message : String(error)

const respond = async (workspace: Workspace, {id, method, params = {}}: JsonRpc): Promise<Record<string, unknown>> => {
    if (method === "initialize") {
        const requested = typeof params.protocolVersion === "string" ? params.protocolVersion : ""
        return {id, result: {protocolVersion: SUPPORTED.includes(requested) ? requested : SUPPORTED[0],
            capabilities: {tools: {listChanged: false}}, serverInfo: {name: "opendaw-studio-mcp", version: "0.1.0"}, instructions: INSTRUCTIONS}}
    }
    if (method === "ping") {return {id, result: {}}}
    if (method === "tools/list") {return {id, result: {tools: TOOLS.map(({name, description, inputSchema}) => ({name, description, inputSchema}))}}}
    if (method !== "tools/call") {return {id, error: {code: -32601, message: `Method not found: ${method}`}}}
    const tool = TOOLS.find(candidate => candidate.name === params.name)
    if (!isDefined(tool)) {return {id, error: {code: -32602, message: `Unknown tool ${String(params.name)}`}}}
    const {text, isError} = await tool.call(workspace, (params.arguments ?? {}) as Record<string, unknown>)
        .then(result => ({text: result.text, isError: !result.ok}), (error: unknown) => ({text: messageOf(error), isError: true}))
    return {id, result: {content: [{type: "text", text}], isError}}
}

// MCP over stdio: newline-delimited JSON-RPC 2.0, one message at a time in arrival order.
export const serveMcp = (workspace: Workspace, input: NodeJS.ReadableStream = process.stdin,
                         output: NodeJS.WritableStream = process.stdout): Promise<void> => {
    const write = (message: Record<string, unknown>): void => {output.write(JSON.stringify({jsonrpc: "2.0", ...message}) + "\n")}
    const handle = async (message: JsonRpc): Promise<void> => {if (isDefined(message.id)) {write(await respond(workspace, message))}}
    let queue = Promise.resolve()
    const lines = createInterface({input})
    lines.on("line", line => {
        if (line.trim() === "") {return}
        queue = queue.then(() => handle(JSON.parse(line) as JsonRpc)).catch((error: unknown) =>
            write({id: null, error: {code: error instanceof SyntaxError ? -32700 : -32603, message: messageOf(error)}}))
    })
    return new Promise(resolve => lines.on("close", () => {queue.then(resolve)}))
}
