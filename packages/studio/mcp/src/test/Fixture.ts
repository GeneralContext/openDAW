import {mkdtempSync, rmSync} from "node:fs"
import {tmpdir} from "node:os"
import {join} from "node:path"
import {PPQN} from "@opendaw/lib-dsp"
import {ProjectSkeleton} from "@opendaw/studio-adapters"
import {ApiImpl, ProjectImpl, ScriptHostProtocol} from "@opendaw/studio-scripting"
import {Workspace} from "../Workspace"

const directories: Array<string> = []

// A Vaporisateur "Lead" with a one-bar region "Motif" of eight rising eighth notes from C4.
export const fixtureProject = (): ProjectImpl => {
    const project = new ApiImpl({} as ScriptHostProtocol).newProject("Fixture") as ProjectImpl
    const lead = project.addInstrumentUnit("Vaporisateur", {label: "Lead"})
    lead.noteTracks[0].addRegion({duration: PPQN.Bar, label: "Motif"}).addEvents(Array.from({length: 8}, (_, index) =>
        ({pitch: 60 + index, position: index * PPQN.SemiQuaver * 2, duration: PPQN.SemiQuaver})))
    return project
}

export const fixtureBytes = (): Uint8Array => new Uint8Array(fixtureProject().context.boxGraph.toArrayBuffer())

export const temporaryDirectory = (): string => {
    const directory = mkdtempSync(join(tmpdir(), "studio-mcp-"))
    directories.push(directory)
    return directory
}

export const fixtureWorkspace = (): Workspace => {
    const workspace = new Workspace(temporaryDirectory())
    workspace.create(ProjectSkeleton.encode(fixtureProject().context.boxGraph) as ArrayBuffer)
    return workspace
}

export const removeDirectories = (): void => directories.splice(0).forEach(directory => rmSync(directory, {recursive: true, force: true}))
