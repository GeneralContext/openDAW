import {afterAll, describe, expect, it} from "vitest"
import {PassThrough} from "node:stream"
import {serveMcp} from "../Mcp"
import {Workspace} from "../Workspace"
import {fixtureWorkspace, removeDirectories} from "./Fixture"

afterAll(removeDirectories)

type Reply = {id: number, result?: {tools?: ReadonlyArray<{name: string}>, content?: ReadonlyArray<{text: string}>, isError?: boolean,
    protocolVersion?: string}, error?: {code: number, message: string}}

const exchange = async (workspace: Workspace, messages: ReadonlyArray<object>): Promise<ReadonlyArray<Reply>> => {
    const input = new PassThrough()
    const output = new PassThrough()
    const chunks: Array<string> = []
    output.on("data", chunk => chunks.push(String(chunk)))
    const served = serveMcp(workspace, input, output)
    messages.forEach(message => input.write(JSON.stringify(message) + "\n"))
    input.end()
    await served
    return chunks.join("").split("\n").filter(line => line !== "").map(line => JSON.parse(line) as Reply)
}

const call = (id: number, name: string, args: Record<string, unknown> = {}) =>
    ({jsonrpc: "2.0", id, method: "tools/call", params: {name, arguments: args}})

describe("MCP server", () => {
    it("serves the tools over newline-delimited JSON-RPC and marks unapplied requests as errors", async () => {
        const workspace = fixtureWorkspace()
        const replies = await exchange(workspace, [
            {jsonrpc: "2.0", id: 1, method: "initialize", params: {protocolVersion: "2025-06-18", capabilities: {}, clientInfo: {name: "test", version: "1"}}},
            {jsonrpc: "2.0", method: "notifications/initialized"},
            {jsonrpc: "2.0", id: 2, method: "tools/list"},
            call(3, "run", {script: `project.bpm = 100\nproject.addInstrumentUnit("Nano", {label: "Keys"})`, label: "Keys"}),
            call(4, "run", {script: "project.bmp = 3", label: "Typo"}),
            call(5, "status"),
            call(6, "undo"),
            call(7, "read", {path: "requests"}),
            call(8, "nope"),
            {jsonrpc: "2.0", id: 9, method: "resources/list"}
        ])
        expect(replies.map(reply => reply.id)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9])
        expect(replies[0].result?.protocolVersion).toBe("2025-06-18")
        expect(replies[1].result?.tools?.map(tool => tool.name)).toEqual(["status", "read", "run", "undo", "render", "docs"])
        expect(replies[2].result?.isError).toBe(false)
        expect(replies[3].result?.isError).toBe(true)
        expect(replies[3].result?.content?.[0].text).toMatch(/invalid\nline 1:9/)
        expect(replies[4].result?.content?.[0].text).toContain(`instrument("Keys", "Nano")`)
        expect(replies[5].result?.content?.[0].text).toMatch(/^Undo .* "Undo Keys": applied/)
        expect(replies[6].result?.content?.[0].text.split("\n")).toHaveLength(3)
        expect(replies[7].error?.code).toBe(-32602)
        expect(replies[8].error?.code).toBe(-32601)
    })
})
