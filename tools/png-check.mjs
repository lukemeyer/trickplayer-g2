// Does the hand-written PNG writer produce a real PNG?
//
// Hand-rolling a container format is the kind of thing that works on the
// machine that wrote it and fails on the one that reads it, so nothing here
// checks the encoder against itself. Every assertion goes through an
// INDEPENDENT implementation: Node's zlib inflates the stream this writes, and
// Node's own crc32 recomputes every chunk checksum. If the two agree, the file
// is a PNG by someone else's definition, not by mine.
//
//   node tools/png-check.mjs
//
import ts from "typescript";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import zlib from "node:zlib";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "pngcheck-"));

async function load(name) {
    const src = fs.readFileSync(path.join(ROOT, "src", name), "utf8");
    const js = ts.transpileModule(src, {
        compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.ESNext },
    }).outputText;
    const out = path.join(TMP, name.replace(/\.ts$/, ".mjs"));
    fs.writeFileSync(out, js);
    return import(pathToFileURL(out).href);
}

const { encodeGreyPng } = await load("png.ts");
const { toGlassesLevels } = await load("pixels.ts");

/** Parse a PNG the way a decoder would, verifying as it goes. */
function parsePng(bytes) {
    const b = Buffer.from(bytes);
    const magic = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
    for (let i = 0; i < 8; i++) {
        if (b[i] !== magic[i]) throw new Error(`bad signature at byte ${i}`);
    }
    let p = 8;
    const chunks = [];
    const idat = [];
    let ihdr = null;
    while (p < b.length) {
        const len = b.readUInt32BE(p);
        const type = b.toString("ascii", p + 4, p + 8);
        const data = b.subarray(p + 8, p + 8 + len);
        const stated = b.readUInt32BE(p + 8 + len);
        const actual = zlib.crc32(b.subarray(p + 4, p + 8 + len));
        if (stated !== actual) {
            throw new Error(`${type} CRC ${stated.toString(16)} != ${actual.toString(16)}`);
        }
        chunks.push(type);
        if (type === "IHDR") {
            ihdr = {
                width: data.readUInt32BE(0), height: data.readUInt32BE(4),
                bitDepth: data[8], colorType: data[9],
                compression: data[10], filter: data[11], interlace: data[12],
            };
        }
        if (type === "IDAT") idat.push(data);
        p += 12 + len;
    }
    if (p !== b.length) throw new Error(`trailing bytes: stopped at ${p} of ${b.length}`);
    // zlib, not mine: if the stored blocks or the adler are wrong this throws.
    const raw = zlib.inflateSync(Buffer.concat(idat));
    return { ihdr, chunks, raw };
}

/** Read the samples back out of the inflated scanlines. */
function samplesOf({ ihdr, raw }) {
    const { width: w, height: h, bitDepth } = ihdr;
    const rowBytes = bitDepth === 4 ? (w + 1) >> 1 : w;
    const out = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) {
        const at = y * (rowBytes + 1);
        if (raw[at] !== 0) throw new Error(`row ${y} uses filter ${raw[at]}, expected None`);
        for (let x = 0; x < w; x++) {
            const byte = raw[at + 1 + (bitDepth === 4 ? x >> 1 : x)];
            out[y * w + x] = bitDepth === 4
                ? (x & 1 ? byte & 15 : byte >> 4)
                : byte / 17;
        }
    }
    return out;
}

const checks = [];
const def = (name, fn) => checks.push({ name, fn });

const randomLevels = (n, seed = 7) => {
    let s = seed;
    const out = new Uint8Array(n);
    for (let i = 0; i < n; i++) { s = (s * 1103515245 + 12345) & 0x7fffffff; out[i] = s % 16; }
    return out;
};

def("a 4-bit file is a PNG, and zlib can read it", () => {
    const w = 256, h = 128;
    const levels = randomLevels(w * h);
    const p = parsePng(encodeGreyPng(levels, w, h, 4));
    const back = samplesOf(p);
    let wrong = 0;
    for (let i = 0; i < levels.length; i++) if (back[i] !== levels[i]) wrong++;
    return {
        pass: wrong === 0 && p.ihdr.bitDepth === 4 && p.ihdr.colorType === 0 &&
              p.chunks.join(",") === "IHDR,IDAT,IEND",
        detail: `${p.ihdr.width}x${p.ihdr.height} depth ${p.ihdr.bitDepth} ` +
            `grey, chunks [${p.chunks.join(" ")}], ${wrong} pixel(s) wrong`,
    };
});

def("an 8-bit file round-trips the same levels", () => {
    const w = 256, h = 128;
    const levels = randomLevels(w * h, 99);
    const back = samplesOf(parsePng(encodeGreyPng(levels, w, h, 8)));
    let wrong = 0;
    for (let i = 0; i < levels.length; i++) if (back[i] !== levels[i]) wrong++;
    return { pass: wrong === 0, detail: `${wrong} pixel(s) wrong of ${levels.length}` };
});

def("a stream longer than one stored block is still valid", () => {
    // A stored deflate block caps at 65,535 bytes. At 8 bits the shipping
    // frame's scanlines run to 33KB and fit in one; make it need three, since
    // an off-by-one in the block loop would pass every single-block test.
    const w = 512, h = 400;                      // 8-bit raw: 205,200 bytes
    const levels = randomLevels(w * h, 3);
    const png = encodeGreyPng(levels, w, h, 8);
    const p = parsePng(png);
    const back = samplesOf(p);
    let wrong = 0;
    for (let i = 0; i < levels.length; i++) if (back[i] !== levels[i]) wrong++;
    return {
        pass: wrong === 0 && p.raw.length > 3 * 65535,
        detail: `${(p.raw.length / 1024).toFixed(0)}KB raw across ${Math.ceil(p.raw.length / 65535)} ` +
            `stored block(s), ${wrong} wrong`,
    };
});

def("an odd width does not lose its last column", () => {
    // 4-bit packing puts two pixels in a byte; an odd width leaves half a byte
    // spare, and getting that wrong drops or duplicates a column.
    const w = 257, h = 5;
    const levels = randomLevels(w * h, 11);
    const back = samplesOf(parsePng(encodeGreyPng(levels, w, h, 4)));
    let wrong = 0;
    for (let i = 0; i < levels.length; i++) if (back[i] !== levels[i]) wrong++;
    return { pass: wrong === 0, detail: `${w}x${h}, ${wrong} pixel(s) wrong` };
});

def("a corrupted byte is caught, so the checks are not vacuous", () => {
    // If parsePng accepted anything, every case above would pass for free.
    const png = encodeGreyPng(randomLevels(64 * 8), 64, 8, 4);
    const bent = Uint8Array.from(png);
    bent[40] ^= 0xff;
    let threw = "";
    try { parsePng(bent); } catch (e) { threw = e.message; }
    return { pass: !!threw, detail: threw || "ACCEPTED A CORRUPTED FILE" };
});

def("it encodes a frame in about a millisecond", () => {
    const w = 256, h = 128;
    const rgba = new Uint8ClampedArray(w * h * 4);
    for (let i = 0; i < w * h; i++) {
        const v = (i * 37) % 256;
        rgba[i * 4] = v; rgba[i * 4 + 1] = (v * 3) % 256; rgba[i * 4 + 2] = 255 - v;
        rgba[i * 4 + 3] = 255;
    }
    const levels = toGlassesLevels(rgba, w, h, {});
    const runs = 200, t = [];
    let bytes = 0;
    for (let i = 0; i < runs; i++) {
        const t0 = performance.now();
        bytes = encodeGreyPng(levels, w, h, 4).length;
        t.push(performance.now() - t0);
    }
    t.sort((a, b) => a - b);
    const p50 = t[runs >> 1], p90 = t[Math.floor(runs * 0.9)];
    return {
        pass: p90 < 20,
        detail: `p50 ${p50.toFixed(2)}ms  p90 ${p90.toFixed(2)}ms  ` +
            `-> ${(bytes / 1024).toFixed(1)}KB  (the phone's toBlob: 4022ms)`,
    };
});

let bad = 0;
console.log("\n  PNG writer — verified against zlib and Node's own crc32\n");
for (const c of checks) {
    let r;
    try { r = c.fn(); } catch (e) { r = { pass: false, detail: `threw: ${e.message}` }; }
    if (!r.pass) bad++;
    console.log(`  ${r.pass ? "ok  " : "FAIL"}  ${c.name}\n        ${r.detail}`);
}
console.log(`\n  ${checks.length - bad}/${checks.length} checks pass\n`);
fs.rmSync(TMP, { recursive: true, force: true });
process.exit(bad ? 1 : 0);
