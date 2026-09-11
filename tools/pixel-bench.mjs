// What preparing a frame SHOULD cost, measured without a browser.
//
// A hardware session reported `prepare` at 4040ms p90 against a 1650ms write,
// which would make preparing a frame the most expensive thing the app does. But
// that measurement covered an image decode, this arithmetic, a PNG encode AND
// any time the main thread spent elsewhere. Establishing the arithmetic's real
// cost is what makes the rest attributable — if this is a millisecond, then 4
// seconds was never computation.
//
//   node tools/pixel-bench.mjs
//
import ts from "typescript";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "px-"));
const js = ts.transpileModule(fs.readFileSync(path.join(ROOT, "src/pixels.ts"), "utf8"), {
    compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.ESNext },
}).outputText;
fs.writeFileSync(path.join(TMP, "pixels.mjs"), js);
const { toGlassesGrey, GLASSES_LEVELS } = await import(
    pathToFileURL(path.join(TMP, "pixels.mjs")).href
);

const W = 256, H = 128;

/** Something frame-shaped: gradients, edges and noise, not flat grey. */
function frame(seed = 1) {
    const d = new Uint8ClampedArray(W * H * 4);
    let s = seed;
    const rnd = () => ((s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
    for (let y = 0; y < H; y++) {
        for (let x = 0; x < W; x++) {
            const o = (y * W + x) * 4;
            const edge = x > W / 2 ? 40 : 0;
            const v = (x / W) * 180 + (y / H) * 40 + edge + rnd() * 30;
            d[o] = v; d[o + 1] = v * 0.95; d[o + 2] = v * 0.9; d[o + 3] = 255;
        }
    }
    return d;
}

function bench(label, opts, runs = 300) {
    const src = frame(7);
    toGlassesGrey(src.slice(), W, H, opts);            // warm
    const times = [];
    for (let i = 0; i < runs; i++) {
        const d = src.slice();
        const t = process.hrtime.bigint();
        toGlassesGrey(d, W, H, opts);
        times.push(Number(process.hrtime.bigint() - t) / 1e6);
    }
    times.sort((a, b) => a - b);
    const p = (q) => times[Math.floor((q / 100) * times.length)];
    console.log(`  ${label.padEnd(18)} p50 ${p(50).toFixed(2)}ms   p90 ${p(90).toFixed(2)}ms   ` +
        `p99 ${p(99).toFixed(2)}ms   max ${times[times.length - 1].toFixed(2)}ms`);
    return p(50);
}

console.log(`\n  Pixel pipeline, ${W}x${H} (${(W * H).toLocaleString()} px), 300 runs each\n`);
const fs50 = bench("floyd-steinberg", { dither: "floyd-steinberg" });
bench("atkinson", { dither: "atkinson" });
bench("bayer", { dither: "bayer" });
bench("threshold", { dither: "threshold" });
bench("+ tone controls", { dither: "floyd-steinberg", brightness: 20, contrast: 30, gamma: 1.4 });

// Correctness: the glasses show 16 levels and nothing else, and a dither must
// not invent values outside them.
const out = toGlassesGrey(frame(3), W, H, { dither: "floyd-steinberg" });
const seen = new Set();
for (let i = 0; i < out.length; i += 4) seen.add(out[i]);
const stray = [...seen].filter((v) => !GLASSES_LEVELS.includes(v));
console.log(`\n  levels produced: ${seen.size} of 16` +
    (stray.length ? `  STRAY: ${stray.join(",")}` : "  (all valid)"));

// --- equivalence with the code this replaced ---------------------------
//
// Transcribed from the inline version in main.ts, deliberately verbatim rather
// than tidied: the point is to prove the extraction changed nothing a wearer
// could see, not to write it well twice.
function reference(data, w, h, { brightness = 0, contrast = 0, gamma = 1, dither = "floyd-steinberg" } = {}) {
    const gray = new Float32Array(w * h);
    const contrastFactor = (259 * (contrast + 255)) / (255 * (259 - contrast));
    for (let i = 0; i < w * h; i++) {
        const r = data[i * 4], g = data[i * 4 + 1], b = data[i * 4 + 2];
        let v = 0.299 * r + 0.587 * g + 0.114 * b;
        v += brightness;
        v = contrastFactor * (v - 128) + 128;
        if (gamma !== 1.0) v = 255 * Math.pow(Math.max(0, v) / 255, 1 / gamma);
        gray[i] = Math.max(0, Math.min(255, v));
    }
    if (dither === "floyd-steinberg") {
        for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
            const idx = y * w + x, oldVal = gray[idx];
            let level = Math.round(oldVal / 17);
            if (level < 0) level = 0;
            if (level > 15) level = 15;
            const newVal = level * 17;
            gray[idx] = newVal;
            const err = oldVal - newVal;
            if (x + 1 < w) gray[idx + 1] += (err * 7) / 16;
            if (y + 1 < h) {
                if (x - 1 >= 0) gray[idx + w - 1] += (err * 3) / 16;
                gray[idx + w] += (err * 5) / 16;
                if (x + 1 < w) gray[idx + w + 1] += (err * 1) / 16;
            }
        }
    } else if (dither === "atkinson") {
        for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
            const idx = y * w + x, oldVal = gray[idx];
            let level = Math.round(oldVal / 17);
            if (level < 0) level = 0;
            if (level > 15) level = 15;
            const newVal = level * 17;
            gray[idx] = newVal;
            const errPart = (oldVal - newVal) / 8;
            if (x + 1 < w) gray[idx + 1] += errPart;
            if (x + 2 < w) gray[idx + 2] += errPart;
            if (y + 1 < h) {
                if (x - 1 >= 0) gray[idx + w - 1] += errPart;
                gray[idx + w] += errPart;
                if (x + 1 < w) gray[idx + w + 1] += errPart;
            }
            if (y + 2 < h) gray[idx + 2 * w] += errPart;
        }
    } else {
        for (let i = 0; i < w * h; i++) {
            let level = Math.round(gray[i] / 17);
            if (level < 0) level = 0;
            if (level > 15) level = 15;
            gray[i] = level * 17;
        }
    }
    for (let i = 0; i < w * h; i++) {
        const val = Math.min(255, Math.max(0, Math.round(gray[i])));
        data[i * 4] = val; data[i * 4 + 1] = val; data[i * 4 + 2] = val; data[i * 4 + 3] = 255;
    }
    return data;
}

let mismatches = 0;
for (const opts of [
    { dither: "floyd-steinberg" },
    { dither: "atkinson" },
    { dither: "threshold" },
    { dither: "floyd-steinberg", brightness: 25, contrast: -40, gamma: 1.6 },
    { dither: "atkinson", brightness: -30, contrast: 60, gamma: 0.8 },
]) {
    for (const seed of [1, 42, 997]) {
        const a = toGlassesGrey(frame(seed), W, H, opts);
        const b = reference(frame(seed), W, H, opts);
        for (let i = 0; i < a.length; i++) {
            if (a[i] !== b[i]) { mismatches++; break; }
        }
    }
}
console.log(`  equivalence with the previous inline code: ` +
    (mismatches ? `${mismatches} MISMATCH(ES)` : "byte-identical across 15 cases"));

console.log(`\n  A ${fs50.toFixed(2)}ms median means a 4,040ms 'prepare' was ` +
    `${Math.round(4040 / fs50).toLocaleString()}x this work —\n  so it was not the arithmetic. ` +
    `It was decode, encode, or the main thread being busy elsewhere.\n`);
fs.rmSync(TMP, { recursive: true, force: true });
