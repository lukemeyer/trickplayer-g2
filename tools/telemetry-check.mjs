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

def("it tells throttled timers apart from a dead page", async () => {
    // The case a real session got wrong: the heartbeat stopped because Android
    // throttled setInterval, while link callbacks kept arriving throughout. The
    // report called it "the page stopped". The page was fine; its timers were
    // not, which is why a timer-driven pipeline sent nothing.
    const t0 = Date.now();
    const vnow = () => t0 + (Date.now() - t0) * SCALE;
    const rec = createRecorder({ now: vnow });
    const t = createBleTransport({ sleep: wait, now: vnow, onEvent: (e) => rec.event(e) });
    const link = makeLink({ imageMs: 400 });
    const beat = setInterval(() => rec.tick({ playing: true }), ms(2000));
    for (let i = 0; i < 4; i++) {
        t.sendImage(() => link.write("image", 16384), { d: i }, { bytes: 16384 });
        await wait(3000);
    }
    // Heartbeat dies; the host keeps reporting link state, as it really did.
    clearInterval(beat);
    const links = setInterval(() => rec.mark("link", { connectType: "connected" }), ms(6000));
    await wait(60000);
    clearInterval(links);
    await wait(2000);
    const a = analyse(rec.session());
    const g = a.gaps[0];
    return {
        pass: !!g && g.kind === "timers throttled" &&
              a.findings.some((x) => /timers were not firing/.test(x)),
        detail: `${a.gaps.length} gap(s), first is "${g?.kind}" — ` +
            `"${a.findings.find((x) => /timers|PAGE stopped/.test(x))?.slice(0, 80)}"`,
    };
});

def("it separates what the payload costs from what playback costs", async () => {
    // Rebuilt from a real hardware session: a synthetic sweep that is cleanly
    // linear in size, and real frames at a size in the middle of that range
    // costing more than twice what the line predicts. The report used to answer
    // "shrink the image", which the sweep itself shows would barely help.
    const rec = createRecorder();
    const ev = (bytes, durationMs, probe) => rec.event({
        id: 0, kind: "image", ok: true, bytes, probe,
        enqueuedAt: 0, startedAt: 0, endedAt: durationMs,
        queuedMs: 0, durationMs, depthAtEnqueue: 1,
    });
    // 240ms fixed + ~37ms/KB, as measured.
    for (const [kb, ms] of [[0, 240], [4, 457], [12, 841], [28, 1380], [44, 1856]]) {
        for (let i = 0; i < 4; i++) ev(kb * 1024, ms, true);
    }
    // Real 16KB frames at 1923ms — 2.3x what that line predicts.
    for (let i = 0; i < 23; i++) ev(16 * 1024, 1923, false);

    const a = analyse(rec.session());
    const hit = a.findings.find((x) => /what their SIZE explains/.test(x));
    // And it must NOT also tell you to shrink the image in the next breath.
    const contradiction = a.findings.find((x) => /Shrinking the image buys time directly/.test(x));
    return {
        pass: !!hit && !contradiction &&
              a.synthetic.ratio > 2 && a.synthetic.perKbMs > 20 && a.synthetic.perKbMs < 60,
        detail: hit
            ? `fit ${Math.round(a.synthetic.fixedMs)}ms + ${a.synthetic.perKbMs.toFixed(0)}ms/KB, ` +
              `ratio ${a.synthetic.ratio.toFixed(2)}x`
            : a.findings.join(" | ").slice(0, 120),
    };
});

def("it measures contention, and stays quiet when there is none", async () => {
    const build = (slowWhenBusy) => {
        const rec = createRecorder();
        const put = (kind, startedAt, durationMs, extra = {}) => rec.event({
            id: 0, kind, ok: true, enqueuedAt: startedAt, startedAt,
            endedAt: startedAt + durationMs, queuedMs: 0, durationMs,
            depthAtEnqueue: 1, ...extra,
        });
        for (let i = 0; i < 10; i++) {
            const t = i * 6000;
            // Half the writes have a fetch and a decode running underneath.
            const busy = i % 2 === 0;
            put("image", t, busy && slowWhenBusy ? 1900 : 800, { bytes: 16384 });
            if (busy) {
                put("fetch", t + 100, 500, { frameIndex: i, cached: false });
                put("prepare", t + 650, 300, { frameIndex: i });
            }
        }
        return analyse(rec.session());
    };

    const slow = build(true);
    const even = build(false);
    const slowHit = slow.findings.find((x) => /SCHEDULING problem/.test(x));
    const evenHit = even.findings.find((x) => /Concurrent prep costs little/.test(x));
    return {
        pass: !!slowHit && !!evenHit &&
              slow.contention.contendedPct > 40 && slow.contention.contendedPct < 60,
        detail: slowHit
            ? `contended ${Math.round(slow.contention.contended.p50)}ms vs ` +
              `${Math.round(slow.contention.clear.p50)}ms clear, ` +
              `${slow.contention.contendedPct.toFixed(0)}% contended; ` +
              `and the even case says "${evenHit ? "costs little" : "MISSED"}"`
            : slow.findings.join(" | ").slice(0, 130),
    };
});

def("it flags a decode slow enough to block the pipeline", async () => {
    // From a real session: prepare p90 of 4040ms against a ~1650ms write. That
    // is not a cost beside the write, it is the pipeline stopped.
    const rec = createRecorder();
    const put = (kind, startedAt, durationMs, extra = {}) => rec.event({
        id: 0, kind, ok: true, enqueuedAt: startedAt, startedAt,
        endedAt: startedAt + durationMs, queuedMs: 0, durationMs,
        depthAtEnqueue: 1, ...extra,
    });
    for (let i = 0; i < 10; i++) {
        put("image", i * 6000, 1650, { bytes: 14000 });
        put("prepare", i * 6000 - 200, i === 3 ? 4040 : 52, { frameIndex: i });
    }
    const a = analyse(rec.session());
    const hit = a.findings.find((x) => /stalls the pipeline outright/.test(x));
    return { pass: !!hit, detail: hit ? hit.slice(0, 120) : a.findings.join(" | ").slice(0, 120) };
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
