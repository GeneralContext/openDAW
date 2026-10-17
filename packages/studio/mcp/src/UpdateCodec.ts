import {ByteArrayInput, ByteArrayOutput} from "@opendaw/lib-std"
import {Update, Updates} from "@opendaw/lib-box"

// Uint8Array.slice is not enough: a Node Buffer's slice shares its pool.
export const copyBytes = (bytes: Uint8Array): ArrayBuffer =>
    bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer

export const encodeUpdates = (updates: ReadonlyArray<Update>): Uint8Array => {
    const output = ByteArrayOutput.create()
    output.writeInt(updates.length)
    updates.forEach(update => update.write(output))
    return new Uint8Array(output.toArrayBuffer())
}

export const decodeUpdates = (bytes: Uint8Array): ReadonlyArray<Update> =>
    Updates.decode(new ByteArrayInput(copyBytes(bytes)))
