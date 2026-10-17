import {afterAll, describe, expect, it} from "vitest"
import {docs, EXAMPLES, GUIDE} from "../Guide"
import {runRequest} from "../Requests"
import {checkScript} from "../Script"
import {status} from "../Tools"
import {fixtureWorkspace, removeDirectories} from "./Fixture"

afterAll(removeDirectories)

describe("Guide", () => {
    it("has examples that type-check and apply as one request", async () => {
        expect(GUIDE).toContain(EXAMPLES.split("\n")[1].trim())
        expect(checkScript(EXAMPLES)).toEqual([])
        const workspace = fixtureWorkspace()
        const record = await runRequest(workspace, EXAMPLES, "Guide examples")
        expect(record.message).toBeNull()
        expect(record.status).toBe("applied")
        const text = status(workspace)
        expect(text).toContain("124 BPM · 3/4")
        expect(text).toContain(`unit("Verb")`)
        expect(text).toContain("fx Delay")
    })

    it("finds declarations and members", () => {
        expect(docs("Vaporisateur")).toMatch(/interface Vaporisateur extends Instrument/)
        expect(docs("addRegion")).toMatch(/in NoteTrack:/)
        expect(docs("addInstrumentUnit")).toMatch(/^in Project:/)
        expect(docs("zzzz")).toMatch(/Nothing in the Script API/)
    })
})
