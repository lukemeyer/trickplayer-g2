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

def("a gap that spans a page reload is not blamed on the pipeline", async () => {
    // The session survives a reload on purpose, so a wearer whose WebView is
    // discarded keeps their measurements. The cost is that the quiet minute
    // between "the page went away" and "something is playing again" reads as
    // the pipeline stalling — and a false one of those buries the real ones.
    //
    // A stepped clock rather than the scaled one the link cases use: gap
    // detection compares against an absolute threshold, and there is no link
    // here to pace against.
    const build = (withReload) => {
        let clock = 1_700_000_000_000;
        const rec = createRecorder({ now: () => clock });
        const put = () => {
            rec.event({
                id: 0, kind: "image", ok: true, enqueuedAt: clock, startedAt: clock,
                endedAt: clock + 1200, queuedMs: 0, durationMs: 1200,
                depthAtEnqueue: 1, bytes: 15000,
            });
            clock += 6000;
        };
        for (let i = 0; i < 6; i++) put();
        // 90 quiet seconds, with the heartbeat ticking throughout.
        for (let i = 0; i < 18; i++) {
            rec.tick({ playing: true });
            clock += 5000;
            if (withReload && i === 8) rec.mark("page-reloaded", { priorMs: 60000 });
        }
        for (let i = 0; i < 6; i++) put();
        return analyse(rec.session());
    };

    const plain = build(false);
    const reloaded = build(true);
    const kinds = (a) => a.gaps.map((g) => g.kind).join(",");

    return {
        pass: kinds(plain).includes("pipeline idle") &&
              kinds(reloaded).includes("session restarted") &&
              !kinds(reloaded).includes("pipeline idle") &&
              reloaded.findings.some((x) => /spans a page RELOAD/.test(x)) &&
              !reloaded.findings.some((x) => /and it is ours/.test(x)),
        detail: `without a reload: [${kinds(plain)}] — with one: [${kinds(reloaded)}]`,
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

def("it names WHICH work is underneath the slow writes", async () => {
    // A fetch under a write and a decode under a write have opposite remedies:
    // the decode is free to move, the prefetch is what hides the network. The
    // report has to say which one it saw, or the advice is a coin toss.
    const build = (culprit) => {
        const rec = createRecorder();
        const put = (kind, startedAt, durationMs, extra = {}) => rec.event({
            id: 0, kind, ok: true, enqueuedAt: startedAt, startedAt,
            endedAt: startedAt + durationMs, queuedMs: 0, durationMs,
            depthAtEnqueue: 1, ...extra,
        });
        for (let i = 0; i < 16; i++) {
            const t = i * 8000;
            // Half the writes have the culprit running underneath and are slow.
            const busy = i % 2 === 0;
            put("image", t, busy ? 2400 : 900, { bytes: 15000 });
            if (busy) put(culprit, t + 100, 1200, { frameIndex: i, cached: false });
            else {
                // the other kind still happens, but clear of the write
                const other = culprit === "fetch" ? "prepare" : "fetch";
                put(other, t + 3000, 300, { frameIndex: i, cached: false });
            }
        }
        return analyse(rec.session());
    };

    const byPrepare = build("prepare");
    const byFetch = build("fetch");
    const says = (a, re) => a.findings.some((x) => re.test(x));

    const ok =
        says(byPrepare, /overlap that costs most is a DECODE/) &&
        says(byPrepare, /free to move/) &&
        says(byFetch, /overlap that costs most is a FETCH/) &&
        says(byFetch, /prefetch is what hides the network/) &&
        // and never both stories at once
        !says(byPrepare, /is a FETCH/) && !says(byFetch, /is a DECODE/);

    const line = byPrepare.findings.find((x) => /overlap that costs most/.test(x)) || "MISSED";
    return { pass: ok, detail: line.slice(0, 140) };
});

def("it names which phase of prepare is the expensive one", async () => {
    // The point of splitting prepare into decode/pixels/encode: a 4-second
    // prepare used to produce the advice "chase it", which is not an address.
    // Two sessions with the SAME total prepare cost, differing only in which
    // phase owns it, must produce two different instructions.
    const build = (owner) => {
        const rec = createRecorder();
        const put = (kind, startedAt, durationMs, extra = {}) => rec.event({
            id: 0, kind, ok: true, enqueuedAt: startedAt, startedAt,
            endedAt: startedAt + durationMs, queuedMs: 0, durationMs,
            depthAtEnqueue: 1, ...extra,
        });
        for (let i = 0; i < 10; i++) {
            put("image", i * 6000, 1650, { bytes: 14000 });
            const total = i === 3 ? 4040 : 52;
            put("prepare", i * 6000 - 200, total, { frameIndex: i });
            // The owner takes 90% of it; the other two split the rest.
            const big = Math.round(total * 0.9), small = Math.round(total * 0.05);
            let t = i * 6000 - 200;
            for (const name of ["decode", "pixels", "encode"]) {
                const d = name === owner ? big : small;
                put(name, t, d, { frameIndex: i });
                t += d;
            }
        }
        return analyse(rec.session());
    };

    const byDecode = build("decode");
    const byEncode = build("encode");
    const byPixels = build("pixels");
    const says = (a, re) => a.findings.some((x) => re.test(x));

    const ok =
        says(byDecode, /decode is the expensive phase/) &&
        says(byEncode, /encode is the expensive phase/) &&
        says(byPixels, /pixels is the expensive phase/) &&
        // and each names a DIFFERENT remedy, which is the whole point
        says(byDecode, /createImageBitmap/) &&
        says(byEncode, /PNG handed to the bridge/) &&
        says(byPixels, /main thread being taken away/) &&
        byDecode.phases.decode.p90 > byDecode.phases.encode.p90 &&
        byEncode.phases.encode.p90 > byEncode.phases.decode.p90;

    const line = byDecode.findings.find((x) => /expensive phase/.test(x)) || "MISSED";
    return { pass: ok, detail: line.slice(0, 140) };
});

def("the report shows the phase split under prepare", async () => {
    const rec = createRecorder();
    const put = (kind, startedAt, durationMs, extra = {}) => rec.event({
        id: 0, kind, ok: true, enqueuedAt: startedAt, startedAt,
        endedAt: startedAt + durationMs, queuedMs: 0, durationMs,
        depthAtEnqueue: 1, ...extra,
    });
    for (let i = 0; i < 8; i++) {
        put("image", i * 6000, 1400, { bytes: 14000 });
        put("prepare", i * 6000 - 300, 120, { frameIndex: i });
        put("decode", i * 6000 - 300, 90, { frameIndex: i });
        put("pixels", i * 6000 - 210, 1, { frameIndex: i });
        put("encode", i * 6000 - 209, 29, { frameIndex: i });
    }
    const text = formatReport(rec.session());
    const has = (n) => new RegExp(`^\\s+${n}\\s+n=8`, "m").test(text);
    return {
        pass: has("decode") && has("pixels") && has("encode"),
        detail: text.split("\n").filter((l) => /decode|pixels|encode/.test(l)).join(" / ").slice(0, 140),
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
