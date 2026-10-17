// Bundles the command line and the script worker for Node; `node build.mjs --distribution DIR` writes a
// self-contained copy (bundles, engine and device modules, the Script API declarations) with its source reference.
import {build} from "esbuild"
import {execFileSync} from "node:child_process"
import {createHash} from "node:crypto"
import {chmodSync, cpSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync} from "node:fs"
import {dirname, join, relative} from "node:path"
import {fileURLToPath} from "node:url"
import {parseArgs} from "node:util"

const root = dirname(fileURLToPath(import.meta.url))
const repository = join(root, "..", "..", "..")
const modules = join(repository, "node_modules")
export const entries = {
    "studio-mcp": join(root, "src/cli.ts"),
    "studio-mcp-worker": join(root, "src/ScriptWorker.ts"),
    "studio-mcp-verify": join(root, "src/VerifyCli.ts")
}

export const bundle = (names = Object.keys(entries), outdir = join(root, "dist")) => build({
    entryPoints: Object.fromEntries(names.map(name => [name, entries[name]])),
    outdir, bundle: true, platform: "node", format: "esm", target: "node22", outExtension: {".js": ".mjs"},
    sourcemap: "linked", logLevel: "warning", external: ["typescript", "esbuild"],
    // openDAW libraries announce themselves with console.debug when they load; command output stays clean.
    banner: {js: "import {createRequire as __createRequire} from 'node:module'; const require = __createRequire(import.meta.url); console.debug = () => {};"}
})

// Files the bundles read at runtime
const RUNTIME_FILES = [
    ["@opendaw/studio-core-wasm", ["package.json", "dist/wasm"]],
    ["@opendaw/nam-wasm", ["package.json", "dist/nam.wasm", "LICENSE"]],
    ["@opendaw/studio-scripting", ["package.json", "src/api.declaration.d.ts"]],
    ["soundfont2", ["package.json", "lib", "LICENSE"]],
    ["typescript", ["package.json", "lib", "LICENSE.txt"]]
]

const files = directory => readdirSync(directory).flatMap(name => {
    const path = join(directory, name)
    return statSync(path).isDirectory() ? files(path) : [path]
})

const git = (...args) => execFileSync("git", args, {cwd: repository, encoding: "utf8"}).trim()

const source = () => {
    const remote = git("remote", "get-url", "origin").replace(/\.git$/, "")
    return {repository: remote, commit: git("rev-parse", "HEAD"), clean: git("status", "--porcelain", "--untracked-files=no") === ""}
}

const distribute = async directory => {
    rmSync(directory, {recursive: true, force: true})
    const lib = join(directory, "lib")
    await bundle(Object.keys(entries), lib)
    for (const [name, paths] of RUNTIME_FILES) {
        const location = realpathSync(join(modules, name))
        paths.forEach(path => cpSync(join(location, path), join(lib, "node_modules", name, path), {recursive: true, dereference: true}))
    }
    // The command line locates the Script API declarations through the package entry, which must exist.
    mkdirSync(join(lib, "node_modules/@opendaw/studio-scripting/dist"), {recursive: true})
    writeFileSync(join(lib, "node_modules/@opendaw/studio-scripting/dist/index.js"), "export {}\n")
    mkdirSync(join(directory, "bin"))
    for (const name of ["studio-mcp", "studio-mcp-verify"]) {
        writeFileSync(join(directory, "bin", name), `#!/bin/sh
# See '${name} --help'.
exec node --disable-warning=ExperimentalWarning "$(dirname "$(readlink -f "$0")")/../lib/${name}.mjs" "$@"
`)
        chmodSync(join(directory, "bin", name), 0o755)
    }
    cpSync(join(repository, "LICENSE"), join(directory, "LICENSE"))
    const origin = source()
    writeFileSync(join(directory, "SOURCE.md"), `# Source

This is a build of openDAW's studio-mcp package (packages/studio/mcp), licensed under the GNU Affero General Public
License v3.0 or later (LICENSE). Its complete source, with openDAW's engine and devices, is at:

${origin.repository}/tree/${origin.commit}

Built with \`node build.mjs --distribution DIR\` in packages/studio/mcp, after \`npm ci\` and \`npx turbo run build
--filter=@opendaw/studio-mcp...\` at the repository root.${origin.clean ? "" : "\n\nThe working tree had uncommitted changes when this was built."}
`)
    const versions = Object.fromEntries(RUNTIME_FILES.map(([name]) =>
        [name, JSON.parse(readFileSync(join(lib, "node_modules", name, "package.json"), "utf8")).version]))
    const hashes = Object.fromEntries(files(directory).map(path =>
        [relative(directory, path), createHash("sha256").update(readFileSync(path)).digest("hex")]))
    writeFileSync(join(directory, "MANIFEST.json"), JSON.stringify({node: ">=22.13", source: origin, versions, files: hashes}, null, 2) + "\n")
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
    const {values} = parseArgs({options: {distribution: {type: "string"}}})
    if (values.distribution !== undefined) {await distribute(values.distribution)} else {await bundle()}
}
