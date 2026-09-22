// Does the picture ladder step down when the phone locks and back up when it
// unlocks — without flapping? (F-056)
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
const { createQualityController, PICTURE_LADDER } = await import(pathToFileURL(path.join(TMP, "quality.mjs")).href);
const { toGlassesLevels, expandBlocks, PALETTES } = await import(pathToFileURL(path.join(TMP, "pixels.mjs")).href);

/**
 * A link: how long a frame at each rung takes, or null for "times out".
 * Locked numbers are shaped on the measured sweep — full frames time out,
 * ~40% frames are slow-ish, the smallest are quick.
 */
const AWAKE = { full: 1700, lighter: 900, lightest: 500 };
const LOCKED = { full: null, lighter: 3000, lightest: 600 };

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

def("the phone locks: pictures keep coming, at the cost of rare probes", () => {
    const ctl = createQualityController();
    play(ctl, AWAKE, 5);
    const r = play(ctl, LOCKED, 30);
    // The first frame is lost dropping down, and climbing back is tried now
    // and then — each attempt costing one frame. That cost is the price of
    // ever recovering: a rung whose sends are merely mediocre (3.7s on
    // hardware) used to pin the picture coarse for the rest of the session.
    const lost = 30 - r.delivered;
    return { pass: r.delivered >= 26 && lost <= 4,
        detail: `${r.delivered}/30 delivered locked, ${lost} spent probing — ${r.trace}` };
});

def("locked for a long time: probing up gets rarer, not constant", () => {
    // A locked link where the lighter rung is FAST, so the controller keeps
    // being tempted to try full pictures again. Each try costs a timeout, so the
    // wait between tries has to grow: 4, 8, 16, 32, then 64 frames.
    const TEMPTING = { full: null, lighter: 800, lightest: 500 };
    const ctl = createQualityController();
    const r = play(ctl, TEMPTING, 300);
    const at = [...r.trace].map((c, i) => (c === "f" ? i : -1)).filter((i) => i >= 0);
    const gaps = at.slice(1).map((v, i) => v - at[i]);
    const growing = gaps.every((g, i) => i === 0 || g >= gaps[i - 1]);
    return { pass: at.length <= 8 && growing && r.delivered >= 290,
        detail: `${at.length} full-size attempts in 300 frames at ${at.join(",")}; ${r.delivered} delivered` };
});

def("a collapsed link: falls through to the smallest picture, which keeps landing", () => {
    // The session behind the bottom rung: full-size frames never landed and the
    // rung above crawled at ~9s. Only the smallest are quick enough to be
    // worth sending — but a probe back up still DELIVERS, slowly, which is why
    // almost every frame arrives even though the link is in trouble.
    const COLLAPSED = { full: null, lighter: 9000, lightest: 1500 };
    const ctl = createQualityController();
    const r = play(ctl, COLLAPSED, 40);
    return { pass: ctl.current.name === "lightest" && r.delivered >= 36,
        detail: `${r.delivered}/40 delivered — ${r.trace}` };
});

def("a queue wait after resuming does not cost a picture level", () => {
    // Reported: "after pausing, then playing, the quality was often lower".
    // Resuming fires a one-shot update and the pipeline together, so the first
    // frame waits behind the other — ~4s of wall clock for a ~2s write. The
    // ladder is fed the WRITE time, and the first sample after a resume is
    // skipped entirely; here that is the caller's job, so this asserts the
    // rule the caller implements: a 2s write after a 4.5s wall clock must not
    // move the rung.
    const ctl = createQualityController();
    const noChange = ctl.onResult(true, 1950);        // the write, not the wait
    const wouldHaveDropped = createQualityController().onResult(true, 4500);
    return {
        pass: noChange === null && wouldHaveDropped?.to === "lighter",
        detail: `write time keeps full; wall clock would have dropped to ${wouldHaveDropped?.to}`,
    };
});

def("a merely mediocre link still climbs back", () => {
    // The reported session: every send landed, none of them fast, and the
    // picture stayed at the smallest rung for the rest of the session because
    // nothing ever counted as "fast enough to try again".
    const MEDIOCRE = { full: 3700, lighter: 3600, lightest: 3500 };
    const ctl = createQualityController();
    ctl.force("lightest");
    const r = play(ctl, MEDIOCRE, 40);
    return { pass: ctl.current.name === "full" && r.delivered === 40,
        detail: `ended at ${ctl.current.name} with every frame delivered — ${r.trace}` };
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

def("the two block axes expand independently, and the ladder uses both", () => {
    // 1x2 is the rung that keeps every horizontal pixel and repeats rows,
    // which is where most of a block's saving comes from. Getting the axes
    // the wrong way round would silently halve the wrong dimension.
    const small = Uint8Array.from([1, 2, 3, 4]);      // 2x2
    const rows = expandBlocks(small, 2, 2, 1, 2);     // -> 2x4, each row twice
    const cols = expandBlocks(small, 2, 2, 2, 1);     // -> 4x2, each pixel twice across
    const wantRows = [1, 2, 1, 2, 3, 4, 3, 4];
    const wantCols = [1, 1, 2, 2, 3, 3, 4, 4];
    // A rung names its axes; nothing may fall back to a square silently.
    const named = PICTURE_LADDER.every((r) => r.blockX >= 1 && r.blockY >= 1);
    const anisotropic = PICTURE_LADDER.some((r) => r.blockX !== r.blockY);
    return {
        pass: wantRows.every((v, i) => rows[i] === v) &&
              wantCols.every((v, i) => cols[i] === v) && named && anisotropic,
        detail: `rows ${rows.join("")} cols ${cols.join("")}; ladder ` +
            PICTURE_LADDER.map((r) => `${r.name} ${r.blockX}x${r.blockY}`).join(", "),
    };
});

def("the brightness ceiling caps every dither, and 15 changes nothing", () => {
    // The panel's top level is uncomfortable on real optics, so the encoder can
    // be told to stop short of it. Two things have to hold: nothing may ever be
    // emitted above the cap by ANY path — ordered dithers round up, which is
    // exactly how a naive cap leaks — and the cap switched off must leave the
    // shipping output untouched, because it sits in the tone loop that every
    // frame goes through.
    const w = 64, h = 32, rgba = new Uint8ClampedArray(w * h * 4);
    for (let i = 0; i < w * h; i++) {
        // A full sweep including pure white, which is the value that leaks.
        const v = Math.round((i / (w * h - 1)) * 255);
        rgba[i * 4] = rgba[i * 4 + 1] = rgba[i * 4 + 2] = v; rgba[i * 4 + 3] = 255;
    }
    const paths = [
        { dither: "floyd-steinberg" },
        { dither: "atkinson" },
        { dither: "bayer" },
        { dither: "bayer2x2" },
        { dither: "threshold" },
        { dither: "bayer2x2", palette: PALETTES.perceptual12 },
        { dither: "floyd-steinberg", shades: 4 },
    ];
    let leaked = null, changed = null, everCapped = false;
    for (const base of paths) {
        const off = toGlassesLevels(rgba, w, h, base);
        const same = toGlassesLevels(rgba, w, h, { ...base, ceiling: 15 });
        if (!off.every((v, i) => v === same[i])) changed ??= JSON.stringify(base);
        for (const c of [14, 13, 11, 8, 0]) {
            const lv = toGlassesLevels(rgba, w, h, { ...base, ceiling: c });
            const max = Math.max(...lv);
            if (max > c) leaked ??= `${JSON.stringify(base)} ceiling ${c} emitted ${max}`;
            if (max === c) everCapped = true;
        }
    }
    return {
        pass: !leaked && !changed && everCapped,
        detail: leaked ? `leaked: ${leaked}`
            : changed ? `ceiling 15 altered ${changed}`
            : `${paths.length} paths capped cleanly, ceiling 15 byte-identical`,
    };
});

let bad = 0;
console.log("\n  Picture ladder (F-056)\n");
for (const c of checks) {
    let r;
    try { r = c.fn(); } catch (e) { r = { pass: false, detail: `threw: ${e.message}` }; }
    if (!r.pass) bad++;
    console.log(`  ${r.pass ? "ok  " : "FAIL"}  ${c.name}\n        ${r.detail}`);
}
console.log(`\n  ${checks.length - bad}/${checks.length} checks pass\n`);
fs.rmSync(TMP, { recursive: true, force: true });
process.exit(bad ? 1 : 0);
