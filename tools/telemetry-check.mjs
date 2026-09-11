// Does the report find what is actually wrong?
//
// The analyser is only worth deploying if it names a problem that is really
// there and stays quiet when nothing is. So: drive the shipping transport
// against links with a KNOWN defect, run the real recorder and the real
// analyser over the result, and assert the finding appears.
//
//   node tools/telemetry-check.mjs
//
import ts from "typescript";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "tlm-"));
async function load(name) {
    const js = ts.transpileModule(fs.readFileSync(path.join(ROOT, "src", name), "utf8"), {
        compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.ESNext },
    }).outputText;
    const out = path.join(TMP, name.replace(/\.ts$/, ".mjs"));
    fs.writeFileSync(out, js);
    return import(pathToFileURL(out).href);
}
const { createBleTransport } = await load("bletransport.ts");
const { createRecorder, analyse, formatReport } = await load("telemetry.ts");

const SCALE = 50;
const ms = (r) => Math.max(1, Math.round(r / SCALE));
const wait = (r) => new Promise((res) => setTimeout(res, ms(r)));

/** Drive a session and hand back what the page would export. */
async function session({ frames = 40, link, gap = 4000, context = {} }) {
    const rec = createRecorder();
    const t = createBleTransport({ sleep: wait, onEvent: (e) => rec.event(e) });
    rec.setContext({ foreground: true, ...context });
    for (let i = 0; i < frames; i++) {
        const bytes = link.bytesFor ? link.bytesFor(i) : 16384;
        t.sendImage(() => link.write("image", bytes), { imageData: bytes },
            { bytes, tsMs: i * 10000 });
        t.sendText(() => link.write("text"), `cue ${i}`);
        await wait(gap);
    }
    for (let i = 0; i < 60 && t.depth > 0; i++) await wait(2000);
    return rec.session();
}

function makeLink(opts = {}) {
    const cfg = { imageMs: 2200, textMs: 120, failRate: 0, sizeCost: 0, seed: 7, ...opts };
    let seed = cfg.seed;
    const rand = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
    return {
        bytesFor: cfg.bytesFor,
        async write(kind, bytes = 0) {
            const base = kind === "image" ? cfg.imageMs + bytes * cfg.sizeCost : cfg.textMs;
            await wait(base);
            const fail = kind === "image"
                ? cfg.failRate + (cfg.failRateSize ? bytes * cfg.failRateSize : 0)
                : 0;
            return rand() >= fail;
        },
    };
}

const checks = [];
const def = (name, fn) => checks.push({ name, fn });

def("a healthy session produces no alarm", async () => {
    const s = await session({ link: makeLink(), frames: 25, gap: 5000 });
    const a = analyse(s);
    return { pass: a.findings.length === 1 && /Nothing stands out/.test(a.findings[0]),
        detail: a.findings[0] };
});

def("it spots the pipeline outrunning the link", async () => {
    // Scenes produced every 1s, writes taking 3s: queue wait must dominate.
    const s = await session({ link: makeLink({ imageMs: 3000 }), frames: 25, gap: 1000 });
    const a = analyse(s);
    // Either diagnosis is correct, and which one appears depends on
    // maxPendingImages: with a bound of 1 the backlog shows up as SUPERSEDED
    // frames rather than queue wait, because the transport drops them instead
    // of letting them queue. Raise the bound and the queue-wait finding is the
    // one that fires.
    const hit = a.findings.find((x) => /outrunning the link|dropped as stale/.test(x));
    return { pass: !!hit, detail: hit || a.findings.join(" | ") };
});

def("it spots write time scaling with payload size", async () => {
    const link = makeLink({ imageMs: 400, sizeCost: 0.12 });
    link.bytesFor = (i) => 4096 + (i % 6) * 8192;
    const s = await session({ link, frames: 48, gap: 6000 });
    const a = analyse(s);
    const hit = a.findings.find((x) => /scales with payload/.test(x));
    return { pass: !!hit, detail: hit || a.findings.join(" | ") };
});

def("it spots larger payloads failing more often", async () => {
    const link = makeLink({ imageMs: 600, failRateSize: 0.000035 });
    link.bytesFor = (i) => (i % 2 ? 4096 : 24576);
    const s = await session({ link, frames: 60, gap: 6000 });
    const a = analyse(s);
    const hit = a.findings.find((x) => /fail more/.test(x));
    return { pass: !!hit, detail: hit || a.findings.join(" | ") };
});

def("it spots retries that never pay", async () => {
    // Every attempt fails: reaching attempt 2 never helps.
    const s = await session({ link: makeLink({ failRate: 1, imageMs: 600 }), frames: 20, gap: 6000 });
    const a = analyse(s);
    const hit = a.findings.find((x) => /rarely help/.test(x));
    return { pass: !!hit, detail: hit || a.findings.join(" | ") };
});

def("it measures a stall the way a wearer would describe it", async () => {
    let n = 0;
    const link = { async write(kind) { await wait(600); return kind !== "image" || ++n > 12; } };
    const s = await session({ link, frames: 20, gap: 5000 });
    const a = analyse(s);
    return { pass: a.stalls.length >= 1 && a.longestStallMs > 0,
        detail: `${a.stalls.length} stall(s), longest ${(a.longestStallMs / 1000).toFixed(1)}s ` +
            `(${a.stalls[0]?.failures} consecutive failures)` };
});

def("it sees a freeze — the outage that sends NOTHING", async () => {
    // The failure the first version of this report could not see: not failed
    // sends, but an absence of them. A page that keeps ticking while the
    // pipeline is stopped, and one that stops ticking altogether, are
    // different bugs and have to read differently.
    // This check runs on a VIRTUAL clock. Everything else here compresses time
    // by SCALE to keep the suite fast, which is harmless while assertions are
    // relative — but gap detection compares against an absolute threshold, so
    // the recorder has to be told the same lie about how long things took.
    const t0 = Date.now();
    const vnow = () => t0 + (Date.now() - t0) * SCALE;
    const rec = createRecorder({ now: vnow });
    const t = createBleTransport({ sleep: wait, now: vnow, onEvent: (e) => rec.event(e) });
    const link = makeLink({ imageMs: 400 });
    const beat = setInterval(() => rec.tick({ playing: true }), ms(2000));
    for (let i = 0; i < 6; i++) {
        t.sendImage(() => link.write("image", 16384), { d: i }, { bytes: 16384 });
        await wait(3000);
    }
    // Pipeline stops; the page is still alive and still thinks it is playing.
    await wait(40000);
    clearInterval(beat);
    // And then the page itself stops — no ticks at all.
    await wait(40000);
    const a = analyse(rec.session());
    const kinds = a.gaps.map((g) => g.kind);
    return {
        pass: a.gaps.length >= 2 && kinds.includes("pipeline idle") &&
              kinds.includes("page stopped") && /NOTHING WAS SENT/.test(a.findings[0]),
        detail: `${a.gaps.length} gap(s) [${kinds.join(", ")}], ` +
            `${(a.deadMs / 1000).toFixed(0)}s dead — "${a.findings[0]?.slice(0, 70)}"`,
    };
});

def("the report renders and carries its findings", async () => {
    const s = await session({ link: makeLink({ imageMs: 3000 }), frames: 20, gap: 1000 });
    const text = formatReport(s);
    return { pass: text.includes("FINDINGS") && text.includes("image write") && text.length > 400,
        detail: `${text.split("\n").length} lines, ${s.events.length} events recorded` };
});

let bad = 0;
console.log("\n  Telemetry analysis — does the report find planted defects?\n");
for (const c of checks) {
    let r;
    try { r = await c.fn(); } catch (e) { r = { pass: false, detail: `threw: ${e.message}` }; }
    if (!r.pass) bad++;
    console.log(`  ${r.pass ? "ok  " : "FAIL"}  ${c.name}\n        ${String(r.detail).slice(0, 150)}`);
}
console.log(`\n  ${checks.length - bad}/${checks.length} checks pass\n`);
fs.rmSync(TMP, { recursive: true, force: true });
process.exit(bad ? 1 : 0);
