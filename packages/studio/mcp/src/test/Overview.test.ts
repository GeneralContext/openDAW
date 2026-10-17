import {describe, expect, it} from "vitest"
import {diffLines, inspect, overview, readProject} from "../Overview"
import {fixtureBytes} from "./Fixture"

describe("Overview", () => {
    it("describes units, tracks, regions and notes with script paths", () => {
        const project = readProject(fixtureBytes(), "Fixture")
        const text = overview(project)
        expect(text).toContain(`instrument("Lead", "Vaporisateur"): Lead · Vaporisateur`)
        expect(text).toContain(`.regions[0] · "Motif" · 1.1.1 +1 bar · 8 notes C4-G4`)
        expect(inspect(project, `instrument("Lead").noteTracks[0].regions[0]`)).toContain("[7] 1.4.3")
        expect(inspect(project, `instrument("Lead", "Vaporisateur").instrument`)).toContain("cutoff")
        expect(inspect(project, `instrument("Nope")`)).toMatch(/Nothing at/)
    })

    it("diffs two overviews line by line", () => {
        expect(diffLines("a\nb\nc", "a\nB\nc\nd")).toEqual(["- b", "+ B", "+ d"])
    })
})
