import {panic} from "@opendaw/lib-std"
import {AudioData, WavFile} from "@opendaw/lib-dsp"

export type WavBitDepth = 16 | 24 | 32

const FORMAT_EXTENSIBLE = 0xFFFE
const CHUNK_FMT = 0x20746d66

// Integer formats clip at ±1.
export const encodeWavChannels = (sampleRate: number, channels: ReadonlyArray<Float32Array>,
                                  bitDepth: WavBitDepth = 16): Uint8Array => {
    if (channels.length === 0) {return panic("encodeWav: no channels")}
    const length = channels[0].length
    if (channels.some(channel => channel.length !== length)) {return panic("encodeWav: channels differ in length")}
    if (bitDepth === 24) {return encodeInts24(sampleRate, channels, length)}
    const audio = {sampleRate, length, numberOfChannels: channels.length, getChannelData: (index: number) => channels[index]}
    if (bitDepth === 16) {return new Uint8Array(WavFile.encodeInts16(audio))}
    if (bitDepth === 32) {return new Uint8Array(WavFile.encodeFloats(audio))}
    return panic(`encodeWav: unsupported bit depth ${bitDepth}`)
}

export const decodeWav = (bytes: ArrayBuffer | Uint8Array): AudioData => {
    const buffer = new Uint8Array(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)).buffer
    const view = new DataView(buffer)
    for (let offset = 12; offset + 8 <= view.byteLength; offset += 8 + ((view.getUint32(offset + 4, true) + 1) & ~1)) {
        if (view.getUint32(offset, true) !== CHUNK_FMT) {continue}
        if (view.getUint16(offset + 8, true) === FORMAT_EXTENSIBLE && view.getUint32(offset + 4, true) >= 26) {
            view.setUint16(offset + 8, view.getUint16(offset + 32, true), true)
        }
        break
    }
    return WavFile.decodeFloats(buffer)
}

const encodeInts24 = (sampleRate: number, channels: ReadonlyArray<Float32Array>, length: number): Uint8Array => {
    const numberOfChannels = channels.length
    const blockAlign = numberOfChannels * 3
    const dataSize = length * blockAlign
    const bytes = new Uint8Array(44 + dataSize)
    const view = new DataView(bytes.buffer)
    view.setUint32(0, 0x46464952, true)
    view.setUint32(4, 36 + dataSize, true)
    view.setUint32(8, 0x45564157, true)
    view.setUint32(12, CHUNK_FMT, true)
    view.setUint32(16, 16, true)
    view.setUint16(20, 1, true)
    view.setUint16(22, numberOfChannels, true)
    view.setUint32(24, sampleRate, true)
    view.setUint32(28, sampleRate * blockAlign, true)
    view.setUint16(32, blockAlign, true)
    view.setUint16(34, 24, true)
    view.setUint32(36, 0x61746164, true)
    view.setUint32(40, dataSize, true)
    let write = 44
    for (let frame = 0; frame < length; frame++) {
        for (let channel = 0; channel < numberOfChannels; channel++) {
            const sample = channels[channel][frame]
            const value = Math.round((sample < -1 ? -1 : sample > 1 ? 1 : sample) * 0x7FFFFF)
            bytes[write++] = value & 0xFF
            bytes[write++] = (value >> 8) & 0xFF
            bytes[write++] = (value >> 16) & 0xFF
        }
    }
    return bytes
}
