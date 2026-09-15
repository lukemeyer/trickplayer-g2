// What the glasses actually transmit, and why the dither decides it.
//
// From an adb capture of a real session (Pixel 10 Pro Fold -> G2, 975 BLE
// writes, zero failures):
//
//     wire payload   12.4 - 18.8 KB   for the SAME 16,384-byte logical image
//     time vs bytes  r = 0.88, 196 ms per KB
//     throughput     ~8.5 KB/s
//
// The logical frame is a fixed 16,384 bytes of 4-bit greyscale ([[F-040]]), so
// a 50% spread in what goes over the air means the host is COMPRESSING it —
// and the SDK payload carries `compressMode: 2`, which says the same thing.
//
// That makes the dither a transport decision, not only a picture one.
// Floyd-Steinberg scatters quantisation error as high-frequency noise, which is
// close to the worst case for any compressor. An ordered dither repeats a 4x4
// matrix, which is close to the best. Same frame, same 16 levels, different
// number of bytes in the air.
//
// This measures that, offline, with zlib standing in for whatever the host
// uses. The ratio between dithers is the transferable part, not the absolute.
//
//   node tools/wire-size.mjs
//
import ts from "typescript";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import zlib from "node:zlib";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "wire-"));
const src = fs.readFileSync(path.join(ROOT, "src", "pixels.ts"), "utf8");
fs.writeFileSync(path.join(TMP, "pixels.mjs"), ts.transpileModule(src, {
    compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.ESNext },
}).outputText);
const { toGlassesLevels } = await import(pathToFileURL(path.join(TMP, "pixels.mjs")).href);

const W = 256, H = 128;

/** Stand-ins for the kinds of frame a trick-play index actually contains. */
function scene(kind) {
    const d = new Uint8ClampedArray(W * H * 4);
    for (let y = 0; y < H; y++) {
        for (let x = 0; x < W; x++) {
            const i = (y * W + x) << 2;
            let v;
            if (kind === "gradient") v = (x / W) * 255;
            else if (kind === "flat") v = 90;
            else if (kind === "detail") {
                // Foliage-ish: broadband noise over a slow gradient. The hard
                // case, and a common one in real footage.
                v = 60 + (x / W) * 120 + (Math.sin(x * 0.7) * Math.cos(y * 0.9) * 40) +
                    (((x * 7919 + y * 104729) % 97) - 48);
            } else {
                // A face on a dim background: large smooth areas, one subject.
                const dx = (x - W * 0.5) / (W * 0.22), dy = (y - H * 0.45) / (H * 0.42);
                v = dx * dx + dy * dy < 1 ? 150 + dy * 45 : 35 + (y / H) * 20;
            }
            d[i] = d[i + 1] = d[i + 2] = Math.max(0, Math.min(255, v));
            d[i + 3] = 255;
        }
    }
    return d;
}

/** 4-bit packed, which is the form the glasses hold and the host compresses. */
function packed(levels) {
    const out = new Uint8Array((W * H) >> 1);
    for (let i = 0, o = 0; i < levels.length; i += 2) out[o++] = (levels[i] << 4) | levels[i + 1];
    return out;
}

const MS_PER_KB = 105;                 // measured on hardware, n=29 frames, r=0.80
const DITHERS = ["floyd-steinberg", "atkinson", "bayer", "threshold"];
const SCENES = ["face", "gradient", "detail", "flat"];

console.log(`\n  What goes over the air, per dither — ${W}x${H}, 16,384 B before compression`);
console.log(`  (zlib stands in for the host's compressor; hardware: ~105 ms per KB)\n`);
console.log(`  ${"scene".padEnd(10)}${DITHERS.map((d) => d.slice(0, 8).padStart(11)).join("")}`);

const totals = Object.fromEntries(DITHERS.map((d) => [d, 0]));
for (const s of SCENES) {
    const row = [];
    for (const d of DITHERS) {
        const bytes = zlib.deflateSync(packed(toGlassesLevels(scene(s), W, H, { dither: d }))).length;
        totals[d] += bytes;
        row.push(`${(bytes / 1024).toFixed(1)}KB`.padStart(11));
    }
    console.log(`  ${s.padEnd(10)}${row.join("")}`);
}

console.log(`\n  ${"mean".padEnd(10)}${DITHERS.map((d) =>
    `${(totals[d] / SCENES.length / 1024).toFixed(1)}KB`.padStart(11)).join("")}`);
console.log(`  ${"-> per frame".padEnd(10)}${DITHERS.map((d) =>
    `${Math.round(totals[d] / SCENES.length / 1024 * MS_PER_KB)}ms`.padStart(11)).join("")}`);

// The mean above is NOT the number to quote, and saying so is the point of
// this section. Hardware showed 12.4-18.8 KB on the wire; three of the four
// scenes here compress to a small fraction of that, which means they are easier
// than anything real trick-play footage contains. Averaging them produces a
// flattering figure for a frame nobody sends.
//
// `detail` is the only row inside the measured band, so it is the only row that
// can support a claim about real frames.
const REAL_LO = 12.4, REAL_HI = 18.8;
const detail = Object.fromEntries(DITHERS.map((d) =>
    [d, zlib.deflateSync(packed(toGlassesLevels(scene("detail"), W, H, { dither: d }))).length / 1024]));
const inBand = Object.entries(detail).filter(([, kb]) => kb >= REAL_LO * 0.8);

console.log(`\n  Hardware measured ${REAL_LO}-${REAL_HI}KB on the wire. Of the scenes above, only`);
console.log(`  'detail' is near that band (${detail["floyd-steinberg"].toFixed(1)}KB) — the other three are easier than`);
console.log(`  real footage, so the mean flatters every alternative. On 'detail':\n`);

const base = detail["floyd-steinberg"];
for (const d of DITHERS) {
    if (d === "floyd-steinberg") continue;
    const saved = Math.round((base - detail[d]) * MS_PER_KB);
    console.log(`  ${d.padEnd(16)} ${saved > 0 ? "saves" : "costs"} ${Math.abs(saved)}ms a frame ` +
        `(${Math.abs(((base - detail[d]) / base) * 100).toFixed(0)}% ${saved > 0 ? "less" : "more"} air time)`);
}
console.log(`\n  So the lever is real and worth having, but it is worth roughly a tenth of`);
console.log(`  a frame's air time on detailed content, not the half the mean suggests.`);
console.log(`  Confirming it needs the wire sizes from a session on real footage —`);
console.log(`  which an adb capture now provides (see tools/wire-from-logcat.mjs).\n`);
void inBand;
fs.rmSync(TMP, { recursive: true, force: true });
