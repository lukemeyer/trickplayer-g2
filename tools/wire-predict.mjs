// Predict what a picture will cost the link, without the glasses.
//
// The G2 runs LVGL, LVGL compresses with the LZ4 reference implementation, and
// `lz4js` is a port of that same code — so this is not a proxy standing in for
// the host's compressor, it is meant to be it. What it cannot know by itself is
// the protocol on top: framing, headers, whatever the host adds after
// compressing. That is what the reference planes measure.
//
//   node tools/wire-predict.mjs report.json            fit and validate
//   node tools/wire-predict.mjs report.json <img.bmp>  predict a picture
//
// The report must come from a "Measure the real link cost" run, joined to a
// capture by tools/link-cost.mjs first — this reads the measured wire sizes
// that tool prints, together with the exact reference planes the app exported.
//
// WHY THE PLANES TRAVEL BACK RATHER THAN BEING REBUILT
//
// The first design had this side rebuild the reference frames from
// corpus/real/tears-of-steel.bif. It cannot: those frames are 320x133 and the
// container is 256x128, so the device resamples with `drawImage` after decoding
// with a browser JPEG decoder. Neither step is reproducible to the byte here,
// and a calibration point that is nearly the same payload is worthless. So the
// app exports the packed plane it actually encoded, and this compresses that.
import fs from "node:fs";
import { createRequire } from "node:module";
const lz4 = createRequire(import.meta.url)("lz4js");

const [reportFile, imageFile] = process.argv.slice(2);
if (!reportFile) {
    console.error("usage: node tools/wire-predict.mjs <report.json> [image.bmp]");
    process.exit(2);
}
const W = 256, H = 128;

// --- the app's own PNG writer, so the bytes match what it hands the SDK
function encodeGreyPng4(levels, w, h) {
    const CRC = (() => { const t = new Uint32Array(256);
        for (let n = 0; n < 256; n++) { let c = n;
            for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
        return t; })();
    const crc32 = (b, f, t) => { let c = 0xffffffff;
        for (let i = f; i < t; i++) c = CRC[(c ^ b[i]) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
    const adler = (b) => { let a = 1, s = 0;
        for (let i = 0; i < b.length;) { const e = Math.min(i + 5552, b.length);
            for (; i < e; i++) { a += b[i]; s += a; } a %= 65521; s %= 65521; }
        return ((s << 16) | a) >>> 0; };
    const rowBytes = (w + 1) >> 1;
    const raw = new Uint8Array((rowBytes + 1) * h);
    let o = 0;
    for (let y = 0; y < h; y++) {
        raw[o++] = 0;
        for (let x = 0; x < w; x += 2) raw[o++] = ((levels[y*w+x] & 15) << 4) | (levels[y*w+x+1] & 15);
    }
    const blocks = Math.max(1, Math.ceil(raw.length / 65535));
    const z = new Uint8Array(2 + blocks * 5 + raw.length + 4);
    let p = 0; z[p++] = 0x78; z[p++] = 0x01;
    for (let i = 0; i < blocks; i++) {
        const st = i * 65535, len = Math.min(65535, raw.length - st);
        z[p++] = i === blocks - 1 ? 1 : 0;
        z[p++] = len & 0xff; z[p++] = (len >>> 8) & 0xff;
        z[p++] = ~len & 0xff; z[p++] = (~len >>> 8) & 0xff;
        z.set(raw.subarray(st, st + len), p); p += len;
    }
    const ad = adler(raw);
    z[p++] = (ad>>>24)&0xff; z[p++] = (ad>>>16)&0xff; z[p++] = (ad>>>8)&0xff; z[p++] = ad&0xff;
    const out = new Uint8Array(8 + 25 + 12 + z.length + 12);
    let q = 0; out.set([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a], q); q += 8;
    const u32 = (v) => { out[q++]=(v>>>24)&0xff; out[q++]=(v>>>16)&0xff; out[q++]=(v>>>8)&0xff; out[q++]=v&0xff; };
    const chunk = (type, fill) => { const at = q; q += 4; const ta = q;
        for (let i = 0; i < 4; i++) out[q++] = type.charCodeAt(i); fill();
        const len = q - ta - 4;
        out[at]=(len>>>24)&0xff; out[at+1]=(len>>>16)&0xff; out[at+2]=(len>>>8)&0xff; out[at+3]=len&0xff;
        u32(crc32(out, ta, q)); };
    chunk("IHDR", () => { u32(w); u32(h); out[q++]=4; out[q++]=0; out[q++]=0; out[q++]=0; out[q++]=0; });
    chunk("IDAT", () => { out.set(z, q); q += z.length; });
    chunk("IEND", () => {});
    return out.slice(0, q);
}

const fnv1a = (b) => { let h = 0x811c9dc5;
    for (let i = 0; i < b.length; i++) { h ^= b[i]; h = Math.imul(h, 0x01000193) >>> 0; }
    return h.toString(16).padStart(8, "0"); };

/** The app's reference planes, rebuilt from their own description. */
function referencePlane(kind) {
    const out = new Uint8Array(W * H);
    if (kind === "blank") return out;
    if (kind === "noise") {
        let seed = 12345 >>> 0;
        for (let i = 0; i < out.length; i++) {
            seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
            out[i] = ((seed / 4294967296) * 16) | 0;
        }
        return out;
    }
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
        const dx = (x - W * 0.5) / (W * 0.5), dy = (y - H * 0.5) / (H * 0.5);
        const diag = (x / (W - 1)) * 0.6 + (y / (H - 1)) * 0.4;
        const lobe = Math.max(0, 1 - (dx * dx + dy * dy)) * 0.45;
        const v = Math.min(15, Math.max(0, (diag + lobe) * 15));
        const lo = Math.floor(v), frac = v - lo;
        const th = [[0, 2], [3, 1]][y & 1][x & 1];
        out[y*W+x] = Math.min(15, frac > (th + 0.5) / 4 ? lo + 1 : lo);
    }
    return out;
}

const unpack = (b64) => {
    const raw = Buffer.from(b64, "base64");
    const out = new Uint8Array(W * H);
    for (let i = 0, o = 0; i < raw.length; i++) { out[o++] = raw[i] >> 4; out[o++] = raw[i] & 15; }
    return out;
};

const lz4kb = (png) => lz4.compress(png).length / 1024;

// ------------------------------------------------------------------ the fit

const session = JSON.parse(fs.readFileSync(reportFile, "utf8"));
const marks = session.marks || [];
const evs = (session.events || []).filter((e) => e.linkCost && e.kind === "image");
if (!evs.length) { console.error("\n  no link-cost events in that report\n"); process.exit(1); }

// Measured wire size is not in the report — it comes from the capture. What IS
// here is every payload's hash, which is what proves a rebuild is faithful.
const hashes = new Map();
for (const e of evs) if (e.variant && e.hash) hashes.set(e.variant, e.hash);

const points = [];
for (const [label, kind] of [["REF blank", "blank"], ["REF noise", "noise"], ["REF ramp", "ramp"]]) {
    const name = [...hashes.keys()].find((n) => n.startsWith(label));
    if (!name) continue;
    const png = encodeGreyPng4(referencePlane(kind), W, H);
    points.push({ name, lz4: lz4kb(png), ours: fnv1a(png), theirs: hashes.get(name) });
}
for (const m of marks.filter((x) => x.name === "link-cost-reference")) {
    const png = encodeGreyPng4(unpack(m.plane), W, H);
    points.push({ name: m.variant || `frame ${m.frame}`, lz4: lz4kb(png), ours: fnv1a(png), theirs: m.hash });
}

console.log(`\n  Reference planes — does this side hold the same bytes the device sent?\n`);
console.log(`  ${"plane".padEnd(30)}${"lz4 KB".padStart(9)}${"device".padStart(11)}${"here".padStart(11)}   match`);
for (const p of points) {
    const ok = p.ours === p.theirs;
    console.log(`  ${p.name.padEnd(30)}${p.lz4.toFixed(2).padStart(9)}` +
        `${p.theirs.padStart(11)}${p.ours.padStart(11)}   ${ok ? "yes" : "NO"}`);
}
const good = points.filter((p) => p.ours === p.theirs);
console.log(`\n  ${good.length} of ${points.length} planes verified byte-identical.`);
if (good.length < 2) {
    console.log(`\n  Not enough verified planes to fit anything. A plane that does not match\n` +
        `  is not a calibration point, however close it looks.\n`);
    process.exit(1);
}
console.log(`\n  Now run tools/link-cost.mjs to get the measured wire KB for these same\n` +
    `  planes, and pair them with the lz4 column above to fit wire = a*lz4 + b.\n` +
    `  Three or more points spanning blank to noise will also show whether that\n` +
    `  line is straight, which two points can never do.\n`);

if (imageFile) {
    console.log(`  (prediction for ${imageFile} needs the fit above; re-run once a and b are known)\n`);
}
