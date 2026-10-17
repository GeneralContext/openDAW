import {int, isDefined, Optional} from "@opendaw/lib-std"
import {API_DECLARATION} from "./Script"

// The tests run these as one request, so every example in the guide type-checks and works.
export const EXAMPLES = `// a bass line on a new instrument
const bass = project.addInstrumentUnit("Vaporisateur", {label: "Bass", volume: -6})
bass.instrument.cutoff = 900
bass.noteTracks[0].addRegion({position: 0, duration: PPQN.Bar * 4, label: "Bass A"})
    .addEvents([36, 36, 43, 41].map((pitch, index) => ({pitch, position: index * PPQN.Bar, duration: PPQN.Quarter * 3})))

// edit existing notes
const region = instrument("Lead", "Vaporisateur").noteTracks[0].regions[0]
region.events.filter(note => note.pitch > 72).forEach(note => note.velocity *= 0.7)

// mixer and effects
const lead = instrument("Lead", "Vaporisateur")
lead.volume = -8
lead.addAudioEffect("Delay", {feedback: 0.35, wet: -12})
const verb = project.addAuxUnit({label: "Verb"})
verb.addAudioEffect("DattorroReverb")
lead.addSend(verb, {amount: -10})

// automation
const lane = lead.addValueTrack(lead.instrument, "cutoff")
lane.addRegion({duration: PPQN.Bar * 4}).addEvents([{position: 0, value: 0.2}, {position: PPQN.Bar * 4, value: 0.9}])

// tempo, signature, markers
project.bpm = 124
project.timeSignature = {numerator: 3, denominator: 4}
project.addMarker({position: PPQN.Bar * 8, label: "Chorus"})`

const indent = (text: string): string => text.split("\n").map(line => line === "" ? "" : `  ${line}`).join("\n")

export const GUIDE = `# Working with the DAW

The project is an openDAW project. You change it with requests: short TypeScript scripts written against the
openDAW Script API. A request runs on a copy of the project; when it ends, all its edits are applied together
as one undoable step. A script that only reads (for example with console.log) changes nothing.

Globals in a request:
  project                      the open project (Project)
  instrument(label, type?)     an instrument unit by label; give the type for typed parameters,
                               e.g. instrument("Bass", "Vaporisateur").instrument.cutoff = 800
  unit(label)                  any unit by label (aux, group, instrument); project.output is the master
  PPQN                         time units: PPQN.Quarter = 960, PPQN.Bar = 3840 in 4/4, PPQN.SemiQuaver = 240
  console.log(...)             output shown in the result
  midiToHz, dbToGain, gainToDb, Chord, Interpolation, AudioData, ... (see 'docs globals')

Positions are in PPQN ticks from the start of the song (regions) or from the start of a region (notes).
The overview writes positions as bar.beat.sixteenth, starting at 1.1.1. Pitches are MIDI numbers (60 = C4).
Volumes are in dB. Labels identify units; the overview prints the exact path to every object.

Examples
${indent(EXAMPLES)}

Samples: 'await openDAW.listSamples()' lists the workspace's samples (samples/index.json and its WAV files), and
'instrument.addSample(sample, {note: 36})' gives one to a pad of a Playfield. A request may use top-level await.

Automation values are normalized from 0 to 1 over the parameter's range, with the parameter's own mapping:
the Vaporisateur cutoff is exponential from 20 Hz to 20 kHz, so 0.5 is about 630 Hz.

Instruments: Vaporisateur (subtractive synth), Nano (sampler), Playfield (drum pads), Tape (audio),
Soundfont, Neon, Tubular (FM), Cubed (303-style), MIDIOutput, Apparat (script), InstrumentComposite.
openDAW's engine does not implement the Vaporisateur's noise generator: its noise settings make no sound.
Audio effects include Delay, Reverb, DattorroReverb, Compressor, Gate, Maximizer, Revamp (EQ), Crusher, Fold,
StereoTool, Tidal, Waveshaper, Vocoder, Convolver. Use 'docs <name>' for parameters and ranges.

Tools: status (the overview and your last requests), read PATH (details; a region shows its notes with names
and bar.beat positions; 'read requests' lists all requests), run (one request), render (WAV files in renders/;
stems adds one per instrument, each through the output's effects), undo (takes back the newest applied request;
undo again for the one before), and docs QUERY. A request can also render with 'await project.mixdown()' and
write files to renders/ with 'openDAW.saveFile(...)'.

Workflow: read the overview, make one focused request, read the change summary, render and listen or analyse,
then refine.`

type Block = {name: string, text: string}

const blocks = ((): ReadonlyArray<Block> => {
    const lines = API_DECLARATION.split("\n")
    const result: Array<Block> = []
    let start = 0
    for (let index = 0; index < lines.length; index++) {
        const line = lines[index]
        const declaration = /^(?:export )?(?:declare )?(?:interface|type|class|enum|namespace|const|function) ([A-Za-z_$][\w$]*)/.exec(line)
        if (!isDefined(declaration)) {
            if (line.trim() === "") {start = index + 1}
            continue
        }
        let end = index
        if (line.trimEnd().endsWith("{")) {
            let depth = 0
            for (end = index; end < lines.length; end++) {
                depth += (lines[end].match(/\{/g) ?? []).length - (lines[end].match(/\}/g) ?? []).length
                if (depth <= 0) {break}
            }
        }
        result.push({name: declaration[1], text: lines.slice(start, end + 1).join("\n").trim()})
        start = end + 1
        index = end
    }
    return result
})()

const MAX_LINES = 160

const clip = (text: string): string => {
    const lines = text.split("\n")
    return lines.length <= MAX_LINES ? text : [...lines.slice(0, MAX_LINES), `... (${lines.length - MAX_LINES} more lines)`].join("\n")
}

type Hit = {block: string, rank: int, text: string}

// An exact name ranks first, then names that contain the query, then members that only mention it.
const members = (block: Block, wanted: string, query: RegExp): ReadonlyArray<Hit> => {
    const found: Array<Hit> = []
    let comment: Array<string> = []
    for (const line of block.text.split("\n")) {
        const trimmed = line.trim()
        if (trimmed.startsWith("/**") || trimmed.startsWith("*")) {
            comment.push(line)
            continue
        }
        const name = /^(?:readonly\s+)?([A-Za-z_$][\w$]*)/.exec(trimmed)?.[1] ?? ""
        const rank = name.toLowerCase() === wanted.toLowerCase() ? 0 : query.test(name) ? 1
            : query.test(trimmed) || comment.some(text => query.test(text)) ? 2 : -1
        if (rank >= 0) {found.push({block: block.name, rank, text: [...comment, line].join("\n")})}
        comment = []
    }
    return found
}

export const docs = (query: Optional<string>): string => {
    if (!isDefined(query) || query.trim() === "") {return GUIDE}
    const wanted = query.trim()
    if (wanted === "globals") {
        return clip(blocks.filter(block => !/^[A-Z]/.test(block.name) || /^(PPQN|AudioData|Chord|Interpolation|WavFile|FFT)$/.test(block.name))
            .map(block => block.text).join("\n\n"))
    }
    const exact = blocks.find(block => block.name.toLowerCase() === wanted.toLowerCase())
    if (isDefined(exact)) {return clip(exact.text)}
    const pattern = new RegExp(wanted.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i")
    const named = blocks.filter(block => pattern.test(block.name))
    if (named.length === 1) {return clip(named[0].text)}
    const names = named.map(block => block.name)
    const hits = blocks.flatMap(block => members(block, wanted, pattern))
        .toSorted((first, second) => first.rank - second.rank).slice(0, 40)
        .map(hit => `in ${hit.block}:\n${hit.text}`)
    if (names.length === 0 && hits.length === 0) {return `Nothing in the Script API matches "${wanted}". Try 'docs' for the guide.`}
    return clip([names.length > 0 ? `Declarations: ${names.join(", ")}` : "", ...hits].filter(text => text !== "").join("\n\n"))
}
