// @ts-nocheck
//
// A PNG writer, because `canvas.toBlob` cost four seconds.
//
// Measured on a Pixel 10 Pro Fold, 256x128:
//
//     decode     p50   17ms
//     pixels     p50   17ms
//     encode     p50 4022ms   max 13018ms
//
// Four seconds for a 32,768-pixel image is not an encoder being slow; the
// same phase runs in about a millisecond in the desktop WebView. It is
// `toBlob` handing the work to the host and the completion callback coming
// back whenever the host gets round to it, on a phone that is also driving a
// BLE radio. Nothing in the app can make that callback arrive sooner — but
// nothing in the app needs it either. We already hold the exact bytes.
//
// **What PNG needs, and why this is cheap.** The format is a header, an
// `IHDR`, one or more `IDAT` chunks holding a zlib stream, and an `IEND`. The
// zlib stream is allowed to use STORED blocks — literal bytes with a length
// and its complement — so "compression" here is a copy, and the only
// arithmetic is two checksums. No Huffman tables, no match finding, no LZ77.
// The result is a few milliseconds of pure byte-shuffling on the main thread,
// which is worth far more than the compression it gives up: the payload over
// BLE is a fixed 16,384 bytes of 4-bit greyscale whatever we send (F-040), so
// the size of the PNG buys nothing on the link.
//
// **Bit depth 4 is not an optimisation, it is the exact format.** The display
// has 16 grey levels; a 4-bit greyscale PNG sample is defined to scale to
// `value * 255 / 15` — which is `value * 17`, the same STEP the dither
// quantises to. So the levels survive the round trip exactly, and the file is
// half the size of an 8-bit one for free.

const CRC_TABLE = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
        t[n] = c >>> 0;
    }
    return t;
})();

function crc32(bytes, from, to) {
    let c = 0xffffffff;
    for (let i = from; i < to; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
}

/** Adler-32 over the raw (pre-deflate) bytes, as zlib requires. */
function adler32(bytes) {
    let a = 1, b = 0;
    // 5552 is the largest run that cannot overflow the 32-bit accumulator,
    // which is what lets the modulo happen per block instead of per byte.
    for (let i = 0; i < bytes.length; ) {
        const end = Math.min(i + 5552, bytes.length);
        for (; i < end; i++) { a += bytes[i]; b += a; }
        a %= 65521; b %= 65521;
    }
    return ((b << 16) | a) >>> 0;
}

const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const MAX_STORED = 65535;

/**
 * Encode a level plane as a greyscale PNG.
 *
 * @param levels  w*h bytes, each 0..15 (the display's own levels).
 * @param bitDepth 4 (default, exact) or 8 — see `fallbackBitDepth` below.
 * @returns a Uint8Array holding a complete PNG file.
 */
export function encodeGreyPng(levels, w, h, bitDepth = 4) {
    if (bitDepth !== 4 && bitDepth !== 8) throw new Error(`bitDepth ${bitDepth} not supported`);
    if (levels.length !== w * h) throw new Error(`expected ${w * h} levels, got ${levels.length}`);

    // --- the raw scanlines: a filter byte (0 = None) then the row's samples.
    const rowBytes = bitDepth === 4 ? (w + 1) >> 1 : w;
    const raw = new Uint8Array((rowBytes + 1) * h);
    let o = 0;
    for (let y = 0; y < h; y++) {
        raw[o++] = 0;                       // filter: None
        const row = y * w;
        if (bitDepth === 4) {
            for (let x = 0; x < w; x += 2) {
                const hi = levels[row + x] & 15;
                // An odd width leaves the low nibble of the last byte unused,
                // which PNG allows and decoders ignore.
                const lo = x + 1 < w ? levels[row + x + 1] & 15 : 0;
                raw[o++] = (hi << 4) | lo;
            }
        } else {
            for (let x = 0; x < w; x++) raw[o++] = (levels[row + x] & 15) * 17;
        }
    }

    // --- the zlib stream: header, stored blocks, adler.
    const blocks = Math.max(1, Math.ceil(raw.length / MAX_STORED));
    const z = new Uint8Array(2 + blocks * 5 + raw.length + 4);
    let p = 0;
    z[p++] = 0x78; z[p++] = 0x01;           // CMF/FLG: deflate, 32K window, no dict
    for (let i = 0; i < blocks; i++) {
        const start = i * MAX_STORED;
        const len = Math.min(MAX_STORED, raw.length - start);
        z[p++] = i === blocks - 1 ? 1 : 0;   // BFINAL on the last, BTYPE 00 = stored
        z[p++] = len & 0xff; z[p++] = (len >>> 8) & 0xff;
        z[p++] = ~len & 0xff; z[p++] = (~len >>> 8) & 0xff;
        z.set(raw.subarray(start, start + len), p);
        p += len;
    }
    const ad = adler32(raw);
    z[p++] = (ad >>> 24) & 0xff; z[p++] = (ad >>> 16) & 0xff;
    z[p++] = (ad >>> 8) & 0xff; z[p++] = ad & 0xff;

    // --- the file.
    const out = new Uint8Array(8 + (12 + 13) + (12 + z.length) + 12);
    let q = 0;
    out.set(PNG_MAGIC, q); q += 8;

    const u32 = (v) => {
        out[q++] = (v >>> 24) & 0xff; out[q++] = (v >>> 16) & 0xff;
        out[q++] = (v >>> 8) & 0xff; out[q++] = v & 0xff;
    };
    const chunk = (type, fill) => {
        const lenAt = q; q += 4;
        const typeAt = q;
        for (let i = 0; i < 4; i++) out[q++] = type.charCodeAt(i);
        fill();
        const dataLen = q - typeAt - 4;
        // The length field covers the data only; the CRC covers type + data.
        out[lenAt] = (dataLen >>> 24) & 0xff; out[lenAt + 1] = (dataLen >>> 16) & 0xff;
        out[lenAt + 2] = (dataLen >>> 8) & 0xff; out[lenAt + 3] = dataLen & 0xff;
        u32(crc32(out, typeAt, q));
    };

    chunk("IHDR", () => {
        u32(w); u32(h);
        out[q++] = bitDepth;
        out[q++] = 0;                        // colour type 0: greyscale
        out[q++] = 0;                        // compression: deflate
        out[q++] = 0;                        // filter method 0
        out[q++] = 0;                        // interlace: none
    });
    chunk("IDAT", () => { out.set(z, q); q += z.length; });
    chunk("IEND", () => {});

    // A copy rather than a view: the buffer goes across a bridge that may read
    // `.buffer` rather than the view's own extent, and a view over a longer
    // buffer would silently send trailing bytes.
    return q === out.length ? out : out.slice(0, q);
}

/**
 * The depth to retreat to when the host cannot read the exact one.
 *
 * 4-bit greyscale is ordinary PNG and every mainstream decoder handles it, but
 * "every mainstream decoder" is a claim about someone else's build and this
 * one runs inside glasses firmware. The failure is detectable — the bridge
 * answers `imageException` or `imageToGray4Failed` rather than lying — so the
 * app tries the exact format, watches, and drops to 8-bit for the rest of the
 * session if it has to. Twice the bytes, still nothing like four seconds.
 */
export const fallbackBitDepth = 8;
