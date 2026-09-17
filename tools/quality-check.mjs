// Does the picture ladder step down when the phone locks and back up when it
// unlocks — without flapping? (F-050)
//
//   node tools/quality-check.mjs
//
import ts from "typescript";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "quality-"));
for (const f of ["quality", "pixels"]) {
    fs.writeFileSync(path.join(TMP, `${f}.mjs`), ts.transpileModule(
        fs.readFileSync(path.join(ROOT, "src", `${f}.ts`), "utf8"),
        { compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.ESNext } }).outputText);
}
const { createQualityController } = await import(pathToFileURL(path.join(TMP, "quality.mjs")).href);
const { toGlassesLevels, expandBlocks } = await import(pathToFileURL(path.join(TMP, "pixels.mjs")).href);

/**
 * A link: how long a frame at each rung takes, or null for "times out".
 * Locked numbers are shaped on the measured sweep — full frames time out,
 * ~40% frames are slow-ish, the smallest are quick.
 */
const AWAKE = { full: 1700, lighter: 900, lightest: 500, minimal: 300 };
const LOCKED = { full: null, lighter: 3000, lightest: 600, minimal: 400 };

function play(ctl, link, frames) {
    const trace = [];
    let delivered = 0, deadMs = 0;
    for (let i = 0; i < frames; i++) {
        const rung = ctl.current.name;
        const ms = link[rung];
        const ok = ms != null;
        if (ok) delivered++; else deadMs += 8500;
        ctl.onResult(ok, ok ? ms : 8500);
        trace.push(rung[0]);
    }
    return { delivered, deadMs, trace: trace.join("") };
}

const checks = [];
const def = (name, fn) => checks.push({ name, fn });

def("awake: stays on full pictures", () => {
    const ctl = createQualityController();
    const r = play(ctl, AWAKE, 40);
    return { pass: /^f+$/.test(r.trace), detail: r.trace };
});

def("the phone locks: one failed frame, then pictures keep coming", () => {
    const ctl = createQualityController();
    play(ctl, AWAKE, 5);
    const r = play(ctl, LOCKED, 30);
    // At most the first frame is lost; everything after lands.
    return { pass: r.delivered >= 29, detail: `${r.delivered}/30 delivered locked, ${r.deadMs / 1000}s frozen — ${r.trace}` };
});

def("locked for a long time: probing up gets rarer, not constant", () => {
    // A locked link where the lighter rung is FAST, so the controller keeps
    // being tempted to try full pictures again. Each try costs a timeout, so the
    // wait between tries has to grow: 4, 8, 16, 32, then 64 frames.
    const TEMPTING = { full: null, lighter: 800, lightest: 500, minimal: 300 };
    const ctl = createQualityController();
    const r = play(ctl, TEMPTING, 300);
    const at = [...r.trace].map((c, i) => (c === "f" ? i : -1)).filter((i) => i >= 0);
    const gaps = at.slice(1).map((v, i) => v - at[i]);
    const growing = gaps.every((g, i) => i === 0 || g >= gaps[i - 1]);
    return { pass: at.length <= 8 && growing && r.delivered >= 290,
        detail: `${at.length} full-size attempts in 300 frames at ${at.join(",")}; ${r.delivered} delivered` };
});

def("a collapsed link: falls through to minimal pictures, which keep landing", () => {
    // The session behind the fourth rung: lightest took ~5s and failed half the
    // time. Only minimal frames are quick enough to get through.
    const COLLAPSED = { full: null, lighter: null, lightest: 9000, minimal: 1500 };
    const ctl = createQualityController();
    const r = play(ctl, COLLAPSED, 40);
    return { pass: ctl.current.name === "minimal" && r.delivered >= 36,
        detail: `${r.delivered}/40 delivered — ${r.trace}` };
});

def("unlocking: climbs back to full pictures", () => {
    const ctl = createQualityController();
    play(ctl, LOCKED, 40);
    const r = play(ctl, AWAKE, 40);
    return { pass: ctl.current.name === "full" && r.trace.endsWith("ffff"), detail: r.trace };
});

def("a slow success counts as trouble, before the host starts timing out", () => {
    const ctl = createQualityController();
    const change = ctl.onResult(true, 5200);
    return { pass: change?.to === "lighter" && /slow/.test(change.why), detail: JSON.stringify(change) };
});

def("fewer shades produce only levels the display has, and blocks repeat exactly", () => {
    const w = 64, h = 32, rgba = new Uint8ClampedArray(w * h * 4);
    for (let i = 0; i < w * h; i++) { const v = (i * 53) % 256; rgba[i * 4] = rgba[i * 4 + 1] = rgba[i * 4 + 2] = v; rgba[i * 4 + 3] = 255; }
    const four = new Set(toGlassesLevels(rgba, w, h, { shades: 4 }));
    const small = Uint8Array.from([1, 2, 3, 4]);
    const big = expandBlocks(small, 2, 2, 2);
    const expect = [1, 1, 2, 2, 1, 1, 2, 2, 3, 3, 4, 4, 3, 3, 4, 4];
    return {
        pass: [...four].every((v) => [0, 5, 10, 15].includes(v)) && four.size === 4 &&
              big.length === 16 && expect.every((v, i) => big[i] === v),
        detail: `4 shades -> {${[...four].sort((a, b) => a - b)}}; 2x2 -> 4x4 ${big.join("")}`,
    };
});

let bad = 0;
console.log("\n  Picture ladder (F-050)\n");
for (const c of checks) {
    let r;
    try { r = c.fn(); } catch (e) { r = { pass: false, detail: `threw: ${e.message}` }; }
    if (!r.pass) bad++;
    console.log(`  ${r.pass ? "ok  " : "FAIL"}  ${c.name}\n        ${r.detail}`);
}
console.log(`\n  ${checks.length - bad}/${checks.length} checks pass\n`);
fs.rmSync(TMP, { recursive: true, force: true });
process.exit(bad ? 1 : 0);
