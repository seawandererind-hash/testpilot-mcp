import { inflateRawSync } from 'node:zlib';

/**
 * A small ZIP reader (stored and deflate entries, no zip64) for Playwright trace
 * files. It reads the central directory, so entries written with data descriptors
 * work too.
 */
export interface ZipReader {
    names: string[];
    read(name: string): Buffer | undefined;
}

const MAX_ENTRY = 64 * 1024 * 1024;

export function readZip(zip: Buffer): ZipReader {
    // The end-of-central-directory record sits in the last 22 + 65535 bytes.
    let end = -1;
    for (let i = zip.length - 22; i >= Math.max(0, zip.length - 22 - 0xffff); i--) {
        if (zip.readUInt32LE(i) === 0x06054b50) {
            end = i;
            break;
        }
    }
    if (end < 0) throw new Error('This file is not a ZIP archive (no central directory found).');
    const count = zip.readUInt16LE(end + 10);
    let offset = zip.readUInt32LE(end + 16);
    const entries = new Map<string, { method: number; size: number; compressed: number; local: number }>();
    for (let n = 0; n < count; n++) {
        if (offset + 46 > zip.length || zip.readUInt32LE(offset) !== 0x02014b50) throw new Error('The ZIP central directory is damaged.');
        const method = zip.readUInt16LE(offset + 10);
        const compressed = zip.readUInt32LE(offset + 20);
        const size = zip.readUInt32LE(offset + 24);
        const nameLen = zip.readUInt16LE(offset + 28);
        const extraLen = zip.readUInt16LE(offset + 30);
        const commentLen = zip.readUInt16LE(offset + 32);
        const local = zip.readUInt32LE(offset + 42);
        const name = zip.toString('utf8', offset + 46, offset + 46 + nameLen);
        entries.set(name, { method, size, compressed, local });
        offset += 46 + nameLen + extraLen + commentLen;
    }
    return {
        names: [...entries.keys()],
        read(name) {
            const e = entries.get(name);
            if (!e) return undefined;
            if (e.size > MAX_ENTRY) throw new Error(`${name} in the ZIP is too large to read.`);
            if (zip.readUInt32LE(e.local) !== 0x04034b50) throw new Error(`The ZIP entry ${name} is damaged.`);
            const start = e.local + 30 + zip.readUInt16LE(e.local + 26) + zip.readUInt16LE(e.local + 28);
            const body = zip.subarray(start, start + e.compressed);
            if (e.method === 0) return Buffer.from(body);
            if (e.method === 8) return inflateRawSync(body);
            throw new Error(`The ZIP entry ${name} uses an unsupported compression method (${e.method}).`);
        }
    };
}
