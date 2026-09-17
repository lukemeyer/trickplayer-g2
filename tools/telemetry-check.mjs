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
const { createRecorder, analyse, formatReport, isResumable } = await load("telemetry.ts");

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
    const link = makeLink({ imageMs: 400, sizeCost: 0.4 });
    link.bytesFor = (i) => 4096 + (i % 6) * 8192;
    const s = await session({ link, frames: 48, gap: 6000 });
    const a = analyse(s);
    const hit = a.findings.find((x) => /scales with payload/.test(x));
    return { pass: !!hit, detail: hit || a.findings.join(" | ") };
});

def("it stays quiet about payload size when the difference is trivial", async () => {
    // Caught in a real report: on a fast link, 4ms against 6ms is a 1.5x
    // "scaling" that led the findings with "shrinking the image buys time
    // directly". True as a ratio, worthless as advice — a scene interval is
    // measured in seconds. A ratio without an absolute bar is noise dressed up
    // as a recommendation, and it costs the report its first line.
    const link = makeLink({ imageMs: 400, sizeCost: 0.004 });
    link.bytesFor = (i) => 4096 + (i % 6) * 8192;
    const a = analyse(await session({ link, frames: 48, gap: 6000 }));
    const hit = a.findings.find((x) => /scales with payload/.test(x));
    const lo = a.bySize[0], hi = a.bySize[a.bySize.length - 1];
    return {
        pass: !hit,
        detail: hit
            ? `REPORTED: ${hit.slice(0, 90)}`
            : `quiet about a ${Math.round(lo.writeMs.p50)}ms -> ${Math.round(hi.writeMs.p50)}ms spread`,
    };
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
    const hit = a.findings.find((x) => /what the synthetic sweep predicts for their file size/.test(x));
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

def("it does not blame the app for sitting idle when nothing is playing", async () => {
    // From a real session: a 50s gap while the wearer picked an episode was
    // reported as "the scene pipeline stopping, and it is ours". Choosing what
    // to watch is not a fault, and counting it inflates the dead-time headline.
    const build = (playing, marked = true) => {
        let clock = 1_700_000_000_000;
        const rec = createRecorder({ now: () => clock });
        const put = () => {
            rec.event({ id: 0, kind: "image", ok: true, enqueuedAt: clock, startedAt: clock,
                endedAt: clock + 1200, queuedMs: 0, durationMs: 1200, depthAtEnqueue: 1, bytes: 16600 });
            clock += 5000;
        };
        for (let i = 0; i < 4; i++) put();
        // Leaving the item to browse marks itself; an idle stretch nobody asked
        // for does not, and that is a different thing entirely.
        if (!playing && marked) rec.mark("playback-stopped", { by: "left the item" });
        for (let i = 0; i < 12; i++) { rec.tick({ playing }); clock += 5000; }
        for (let i = 0; i < 4; i++) put();
        return analyse(rec.session());
    };
    const idle = build(false), stalled = build(true);
    const ours = (a) => a.findings.some((x) => /and it is ours/.test(x));
    return {
        pass: !ours(idle) && ours(stalled) &&
              idle.findings.some((x) => /sitting idle with nothing playing/.test(x)),
        detail: `not playing: ${ours(idle) ? "BLAMED" : "excused"}; ` +
                `playing: ${ours(stalled) ? "blamed" : "MISSED"}`,
    };
});

def("one lucky retry is not evidence that retries pay", async () => {
    // "Retries earn their keep (100% of second attempts succeed)" — from a
    // single retry. The pessimistic branch already required five samples; the
    // optimistic one required none, so noise could only ever argue one way.
    let clock = 1_700_000_000_000;
    const rec = createRecorder({ now: () => clock });
    for (let i = 0; i < 20; i++) {
        rec.event({ id: 0, kind: "image", ok: true, enqueuedAt: clock, startedAt: clock,
            endedAt: clock + 900, queuedMs: 0, durationMs: 900, depthAtEnqueue: 1,
            bytes: 16600, attempts: i === 7 ? 2 : 1 });
        clock += 4000;
    }
    const a = analyse(rec.session());
    return {
        pass: !a.findings.some((x) => /Retries earn their keep/.test(x)),
        detail: a.findings.some((x) => /Retries earn their keep/.test(x))
            ? "CLAIMED from a single retry"
            : `quiet about ${a.retries[1].reached} second attempt(s)`,
    };
});

def("a session of pure silence is still worth resuming", async () => {
    // The rule that decides whether a stored session survives a relaunch. It
    // used to be `events.length`, and that is backwards: a freeze is an ABSENCE
    // of writes, so the session that captured one has heartbeats and lifecycle
    // marks and no events at all. Under the old rule the app threw it away on
    // the way back up — losing the recording of the outage and keeping only
    // the sessions where nothing was wrong.
    let clock = 1_700_000_000_000;
    const quiet = createRecorder({ now: () => clock });
    for (let i = 0; i < 12; i++) { quiet.tick({ playing: true }); clock += 5000; }
    quiet.mark("pagehide");

    const busy = createRecorder({ now: () => clock });
    busy.event({ id: 0, kind: "image", ok: true, enqueuedAt: clock, startedAt: clock,
        endedAt: clock + 1200, queuedMs: 0, durationMs: 1200, depthAtEnqueue: 1 });

    const empty = createRecorder({ now: () => clock });

    // And resuming must CONTINUE the clock, not restart it — the silence
    // BETWEEN the two halves is the thing being measured, and a recorder that
    // starts from zero puts the outage in the crack between two sessions where
    // no gap detector can see it.
    const prior = quiet.session();
    let c2 = clock;                                   // the relaunch happens here
    const after = createRecorder({ now: () => c2, resume: prior });
    c2 += 60000;                                      // a minute passes after it
    const continued = after.session().durationMs >= prior.durationMs + 60000;

    return {
        pass: isResumable(prior) && isResumable(busy.session()) &&
              !isResumable(empty.session()) && !isResumable(null) && continued,
        detail: `silent session (${prior.marks.length} marks, ${prior.events.length} events): ` +
            `${isResumable(prior) ? "kept" : "DISCARDED"}; empty: ` +
            `${isResumable(empty.session()) ? "WRONGLY KEPT" : "dropped"}; ` +
            `${(prior.durationMs / 1000).toFixed(0)}s + 60s across the relaunch reads as ` +
            `${(after.session().durationMs / 1000).toFixed(0)}s`,
    };
});

def("it blames the ENCODING when only our own frames fail", async () => {
    // The beta session this comes from: the sweep landed at 0, 4, 12, 28 and
    // 44 KB while every real 16 KB frame failed with `sendFailed`. The report
    // led with "shrinking the image buys time directly" — advice about a
    // payload the app never sends, on a link that was working.
    let clock = 1_700_000_000_000;
    const rec = createRecorder({ now: () => clock });
    const img = (ok, bytes, extra) => {
        rec.event({
            id: 0, kind: "image", ok, enqueuedAt: clock, startedAt: clock,
            endedAt: clock + (ok ? 800 : 1500), queuedMs: 0,
            durationMs: ok ? 800 : 1500, depthAtEnqueue: 1, bytes,
            ...(ok ? {} : { reason: "failed", result: "sendFailed" }), ...extra,
        });
        clock += 3000;
    };
    // The sweep: every size lands.
    for (const kb of [0, 4, 12, 28, 44]) {
        for (let n = 0; n < 4; n++) img(true, kb * 1024 + 100, { probe: true });
    }
    // The app's own frames: none do.
    for (let n = 0; n < 5; n++) img(false, 16600, { format: "grey4" });

    const a = analyse(rec.session());
    const hit = a.findings.find((x) => /It is how the frame is ENCODED/.test(x));
    const text = formatReport(rec.session(), a);
    return {
        pass: !!hit && a.findings[0] === hit && /grey4/.test(hit) &&
              // and the all-failed bucket must not claim a 0ms write
              /16KB.*no successful write/.test(text) &&
              !/16KB.*p50 0ms/.test(text),
        detail: hit ? hit.slice(0, 150) : a.findings.join(" | ").slice(0, 150),
    };
});

def("a silence while playing names what the engine was stuck behind", async () => {
    // A hardware report: "60s, app thought it was playing" — and nothing to say
    // whether that was a write the glasses never answered, a fetch, or a sleep.
    let clock = 1_700_000_000_000;
    const rec = createRecorder({ now: () => clock });
    const img = () => { rec.event({ id: 0, kind: "image", ok: true, enqueuedAt: clock, startedAt: clock,
        endedAt: clock + 1500, queuedMs: 0, durationMs: 1500, depthAtEnqueue: 1, bytes: 16600 }); clock += 5000; };
    for (let i = 0; i < 3; i++) img();
    for (let i = 0; i < 12; i++) {
        rec.tick({ playing: true, doing: [{ what: "glasses answering an image", ms: 5000 * (i + 1) }] });
        clock += 5000;
    }
    for (let i = 0; i < 3; i++) img();
    const a = analyse(rec.session());
    const g = a.gaps.find((x) => x.playing);
    const text = formatReport(rec.session(), a);
    return {
        pass: g?.stuck?.what === "glasses answering an image" && g.stuck.ms === 60000 &&
              /stuck behind: glasses answering an image \(60s\)/.test(text),
        detail: g?.stuck ? `stuck behind ${g.stuck.what} for ${g.stuck.ms / 1000}s` : "NO CAUSE",
    };
});

def("lighter pictures are reported by level, and whether they kept coming", async () => {
    // F-050: full frames time out locked, the ladder drops, lighter ones land.
    let clock = 1_700_000_000_000;
    const rec = createRecorder({ now: () => clock });
    const img = (quality, ok, ms) => {
        rec.event({ id: 0, kind: "image", ok, enqueuedAt: clock, startedAt: clock, endedAt: clock + ms,
            queuedMs: 0, durationMs: ms, depthAtEnqueue: 1, bytes: 16600, quality,
            ...(ok ? {} : { reason: "failed", result: "sendFailed" }) });
        clock += 5000;
    };
    for (let i = 0; i < 10; i++) img("full", true, 1700);
    img("full", false, 8500);
    rec.mark("picture-quality", { from: "full", to: "lighter", why: "failed" });
    for (let i = 0; i < 20; i++) img("lighter", true, 900);
    const a = analyse(rec.session());
    const text = formatReport(rec.session(), a);
    const hit = a.findings.find((x) => /made lighter/.test(x)) || "";
    return {
        pass: /100% of 20 were delivered/.test(hit) && /doing its job/.test(hit) &&
              /by picture level/.test(text) && /lighter\s+n=\s*20\s+ok 100%/.test(text),
        detail: hit.slice(0, 130) || "MISSED",
    };
});

def("the 'connection lost' session: no sweep blamed, no verdicts from one frame", async () => {
    // A locked sweep with 18-20 KB failures, then two real frames failing on a
    // dying link, then the app reloaded. The report said the picture "stopped
    // at 80s" (the sweep), "not a disconnect" (it was), "up to 20KB delivered
    // and from 20KB failed", and judged the picture ladder from ONE frame.
    let clock = 1_700_000_000_000;
    const rec = createRecorder({ now: () => clock });
    const ev = (o) => rec.event({ id: 0, queuedMs: 0, depthAtEnqueue: 1, enqueuedAt: clock,
        startedAt: clock, endedAt: clock + o.durationMs, ...o });
    const txt = () => ev({ kind: "text", ok: true, durationMs: 120 });
    for (const [kb, oks] of [[2, 3], [8, 3], [14, 3], [18, 2], [20, 0]]) {
        for (let n = 0; n < 3; n++) {
            const ok = n < oks;
            ev({ kind: "image", ok, durationMs: ok ? 900 : 12000, bytes: kb * 1024 + 50,
                probe: true, sweep: "locked", ...(ok ? {} : { reason: "failed", result: "sendFailed" }) });
            txt(); clock += ok ? 2500 : 14000;
            rec.tick({ playing: false, lagMs: 5 });
        }
    }
    for (const [q, to] of [["full", "lighter"], ["lighter", "lightest"]]) {
        ev({ kind: "image", ok: false, durationMs: 11000, bytes: 16600, quality: q,
            reason: "failed", result: "sendFailed" });
        rec.mark("picture-quality", { from: q, to, why: "failed" });
        txt(); clock += 30000; rec.tick({ playing: true, lagMs: 5 });
    }
    rec.mark("page-reloaded", { discarded: false });
    const a = analyse(rec.session());
    const all = a.findings.join(" || ");

    // And the same cut-off applied to a genuine long picture death.
    let c2 = 1_700_000_000_000;
    const r2 = createRecorder({ now: () => c2 });
    const e2 = (ok) => r2.event({ id: 0, kind: "image", ok, queuedMs: 0, depthAtEnqueue: 1,
        enqueuedAt: c2, startedAt: c2, endedAt: c2 + 1500, durationMs: 1500, bytes: 16600,
        ...(ok ? {} : { reason: "failed", result: "sendFailed" }) });
    const t2 = () => r2.event({ id: 0, kind: "text", ok: true, queuedMs: 0, depthAtEnqueue: 1,
        enqueuedAt: c2, startedAt: c2 + 100, endedAt: c2 + 200, durationMs: 100 });
    for (let i = 0; i < 6; i++) { e2(true); t2(); c2 += 10000; }
    for (let i = 0; i < 6; i++) { e2(false); t2(); c2 += 10000; }
    r2.mark("page-reloaded", {});
    const lead2 = analyse(r2.session()).findings[0] || "";

    return {
        pass: !/THE PICTURE STOPPED at 80s/.test(all) &&
              !a.stalls.some((st) => st.failures > 2) &&
              /under 20KB were mostly delivered and from 20KB mostly failed/.test(all) &&
              /too few lighter frames to say/.test(all) && !/even lighter pictures are not/.test(all) &&
              /cut off/.test(lead2) && !/link itself stayed up/.test(lead2),
        detail: `stalls ${JSON.stringify(a.stalls.map((st) => st.failures))}; ` +
            `${(all.match(/under 20KB[^.]*/) || ["NO THRESHOLD"])[0]}; ` +
            `${/too few lighter/.test(all) ? "ladder: too few to judge" : "LADDER JUDGED"}; ` +
            `${/cut off/.test(lead2) ? "cut-off named" : "CUT-OFF MISSED"}`,
    };
});

def("browsing before anything is played is not 'playback stopped'", async () => {
    // Three minutes of browsing, with a preview frame or two reaching the
    // glasses, then playback starts and runs clean. The report led with
    // "PLAYBACK STOPPED at 5s and nothing says why" — while the wearer was
    // choosing an episode and nothing had played yet.
    let clock = 1_700_000_000_000;
    const rec = createRecorder({ now: () => clock });
    const img = () => rec.event({ id: 0, kind: "image", ok: true, enqueuedAt: clock,
        startedAt: clock, endedAt: clock + 1400, queuedMs: 0, durationMs: 1400,
        depthAtEnqueue: 1, bytes: 16600 });
    for (let i = 0; i < 3; i++) { img(); clock += 1500; }     // preview frames, not playing
    for (let i = 0; i < 8; i++) { rec.tick({ playing: false, lagMs: 4 }); clock += 5000; }
    for (let i = 0; i < 30; i++) {                             // then real playback
        img(); clock += 5000; rec.tick({ playing: true, lagMs: 4 });
    }
    const a = analyse(rec.session());
    return {
        pass: !a.findings.some((x) => /PLAYBACK STOPPED/.test(x)) &&
              a.findings.some((x) => /sitting idle with nothing playing/.test(x)),
        detail: a.findings.some((x) => /PLAYBACK STOPPED/.test(x))
            ? `FALSE POSITIVE: ${a.findings.find((x) => /PLAYBACK STOPPED/.test(x)).slice(0, 90)}`
            : "browsing gap treated as browsing",
    };
});

def("playback stopping with nothing to explain it is called out, not excused", async () => {
    // The session that exposed this: 12 minutes of perfect delivery with the
    // phone locked, then playback stopped mid-episode on a wearer's face. No
    // pause, no end of media, no host event — because a tap on the glasses took
    // an unmarked branch. The report called it "browsing".
    const build = (marks) => {
        let clock = 1_700_000_000_000;
        const rec = createRecorder({ now: () => clock });
        for (let i = 0; i < 20; i++) {
            rec.event({ id: 0, kind: "image", ok: true, enqueuedAt: clock, startedAt: clock,
                endedAt: clock + 1900, queuedMs: 0, durationMs: 1900, depthAtEnqueue: 1, bytes: 16600 });
            clock += 5000; rec.tick({ playing: true, lagMs: 4 });
        }
        for (const m of marks) rec.mark(m.name, m.detail || {});
        for (let i = 0; i < 20; i++) { rec.tick({ playing: false, lagMs: 4 }); clock += 5000; }
        return analyse(rec.session());
    };
    const silent = build([]);
    const tapped = build([{ name: "glasses-tap", detail: { wasPlaying: true, to: "paused" } }]);
    const lead = (a) => a.findings[0] || "";
    return {
        pass: /PLAYBACK STOPPED at 100s and nothing says why/.test(lead(silent)) &&
              /which is ours/.test(lead(silent)) &&
              !silent.findings.some((x) => /browsing/.test(x)) &&
              !tapped.findings.some((x) => /PLAYBACK STOPPED/.test(x)) &&
              tapped.findings.some((x) => /browsing/.test(x)),
        detail: `unmarked: ${/PLAYBACK STOPPED/.test(lead(silent)) ? "flagged" : "MISSED"}; ` +
            `after a glasses tap: ${tapped.findings.some((x) => /PLAYBACK STOPPED/.test(x)) ? "WRONGLY FLAGGED" : "excused"}`,
    };
});

def("menu overlays are not counted as the host pausing the app", async () => {
    // A session using the glasses menu four times was told "the host told the
    // app it had lost the foreground 4x while playing, and each time the app
    // PAUSED" — when the app had ignored all four on purpose, which the mark
    // itself says.
    let clock = 1_700_000_000_000;
    const rec = createRecorder({ now: () => clock });
    for (let i = 0; i < 10; i++) {
        rec.event({ id: 0, kind: "image", ok: true, enqueuedAt: clock, startedAt: clock,
            endedAt: clock + 1900, queuedMs: 0, durationMs: 1900, depthAtEnqueue: 1, bytes: 16600 });
        clock += 5000; rec.tick({ playing: true, lagMs: 3 });
    }
    const ignored = analyse((() => {
        for (let i = 0; i < 4; i++) rec.mark("host-foreground-exit", { wasPlaying: true, ignored: "menu overlay" });
        return rec.session();
    })());
    const real = analyse((() => {
        rec.mark("host-foreground-exit", { wasPlaying: true });
        return rec.session();
    })());
    const said = (a) => a.findings.some((x) => /lost the foreground/.test(x));
    return {
        pass: !said(ignored) && said(real),
        detail: `4 ignored -> ${said(ignored) ? "WRONGLY BLAMED" : "quiet"}; a real one -> ${said(real) ? "reported" : "MISSED"}`,
    };
});

def("the 12:03 lock session: the verdict comes from subtitles, and backoff is not blamed", async () => {
    // 14 minutes of full pictures, then the lock: lightest pictures ~50% at
    // ~4.7s, a backoff pause while playing. Run twice — subtitles slowing with
    // the pictures (the whole link slowed), and subtitles unaffected (it is
    // pictures specifically) — the report must say different things.
    const build = (subsSlow) => {
        let clock = 1_700_000_000_000;
        const rec = createRecorder({ now: () => clock });
        const img = (ok, ms, quality) => rec.event({ id: 0, kind: "image", ok, queuedMs: 0,
            depthAtEnqueue: 1, enqueuedAt: clock, startedAt: clock, endedAt: clock + ms,
            durationMs: ms, bytes: 16600, quality, ...(ok ? {} : { reason: "failed", result: "sendFailed" }) });
        const txt = (ms) => rec.event({ id: 0, kind: "text", ok: true, queuedMs: 0, depthAtEnqueue: 1,
            enqueuedAt: clock + 50, startedAt: clock + 50, endedAt: clock + 50 + ms, durationMs: ms });
        for (let i = 0; i < 60; i++) {                       // 5 minutes, full
            img(true, 2200, "full"); txt(120); clock += 5000; rec.tick({ playing: true, lagMs: 3 });
        }
        rec.mark("picture-quality", { from: "full", to: "lighter", why: "failed" });
        rec.mark("picture-quality", { from: "lighter", to: "lightest", why: "slow (7437ms)" });
        for (let i = 0; i < 40; i++) {                       // after the lock
            img(i % 2 === 0, i % 2 === 0 ? 4700 : 8200, "lightest");
            txt(subsSlow ? 900 : 125);
            clock += 12000; rec.tick({ playing: true, lagMs: 3 });
        }
        for (let i = 0; i < 6; i++) { clock += 5000; rec.tick({ playing: true, lagMs: 3, imageBackoffMs: 15000 }); }
        img(true, 4500, "lightest"); txt(subsSlow ? 900 : 125);
        return analyse(rec.session());
    };
    const slowLink = build(true), picturesOnly = build(false);
    const say = (a, re) => a.findings.some((x) => re.test(x));
    return {
        pass: say(slowLink, /subtitles slowed [\d.]+x too/) && say(slowLink, /A smaller level would help/) &&
              say(picturesOnly, /subtitles did NOT slow/) &&
              !say(slowLink, /it is not only the link slowing/) &&
              !say(slowLink, /and it is ours/) && say(slowLink, /pausing pictures on purpose/),
        detail: (slowLink.findings.find((x) => /made lighter/.test(x)) || "MISSED").slice(90, 230),
    };
});

def("a slow patch shows up in the minute-by-minute timeline", async () => {
    // The link slowdown is intermittent and the report cannot see a lock, so
    // the timeline has to show WHEN sends got slow, and at which picture level.
    let clock = 1_700_000_000_000;
    const rec = createRecorder({ now: () => clock });
    const img = (ok, ms, quality) => {
        rec.event({ id: 0, kind: "image", ok, enqueuedAt: clock, startedAt: clock, endedAt: clock + ms,
            queuedMs: 0, durationMs: ms, depthAtEnqueue: 1, bytes: 16600, quality,
            ...(ok ? {} : { reason: "failed", result: "sendFailed" }) });
        clock += 10000;
    };
    for (let i = 0; i < 6; i++) img(true, 1800, "full");       // minute 0
    img(false, 8500, "full");                                   // minute 1: slow patch
    for (let i = 0; i < 5; i++) img(true, 900, "lighter");
    for (let i = 0; i < 6; i++) img(true, 1800, "full");       // minute 2
    const a = analyse(rec.session());
    const text = formatReport(rec.session(), a);
    const lines = text.split("\n").filter((l) => /^\s+\d+m\s+n=/.test(l));
    return {
        pass: lines.length === 3 && /◀/.test(lines[1]) && /lighter/.test(lines[1]) &&
              !/◀/.test(lines[0]) && !/◀/.test(lines[2]),
        detail: lines.map((l) => l.trim()).join(" | "),
    };
});

def("the locked sweep says which of three answers it found", async () => {
    // Throughput explanation: small payloads land locked, large ones time out.
    // The sweep must be able to confirm it AND to rule it out both ways.
    const build = (landsBelowKb) => {
        let clock = 1_700_000_000_000;
        const rec = createRecorder({ now: () => clock });
        for (const kb of [1, 3, 6, 9, 13, 17, 22]) {
            for (let n = 0; n < 3; n++) {
                const ok = kb < landsBelowKb;
                rec.event({ id: 0, kind: "image", ok, enqueuedAt: clock, startedAt: clock,
                    endedAt: clock + (ok ? 300 + kb * 60 : 9000), queuedMs: 0,
                    durationMs: ok ? 300 + kb * 60 : 9000, depthAtEnqueue: 1,
                    bytes: kb * 1024 + 100, probe: true, sweep: "locked",
                    ...(ok ? {} : { reason: "failed", result: "sendFailed" }) });
                clock += ok ? 2000 : 10000;
            }
        }
        return analyse(rec.session());
    };
    const threshold = build(10), none = build(0), all = build(100);
    const lead = (a) => a.findings[0] || "";
    const text = formatReport({ events: [], marks: [], durationMs: 0 }, threshold);
    return {
        pass: /SMALL PICTURES STILL LAND: payloads up to 10KB were mostly delivered and from 12KB mostly failed/.test(lead(threshold)) &&
              /even the SMALLEST payloads failed/.test(lead(none)) &&
              /locked sweep delivered every size/.test(lead(all)) && /did NOT slow down/.test(lead(all)) &&
              /LOCKED sweep by payload size/.test(text) && /failures took p50 9000ms/.test(text),
        detail: lead(threshold).slice(0, 120),
    };
});

def("a frozen picture with the app running normally is placed below the app", async () => {
    // The session that settled it: glasses worn, phone asleep, every heartbeat
    // on time, subtitles all delivered — and each picture refused after 8-14s.
    // The report must say the app was fine and the host is where it failed.
    let clock = 1_700_000_000_000;
    const rec = createRecorder({ now: () => clock });
    const both = (ok) => {
        rec.event({ id: 0, kind: "image", ok, enqueuedAt: clock, startedAt: clock,
            endedAt: clock + (ok ? 1500 : 8000), queuedMs: 0, durationMs: ok ? 1500 : 8000,
            depthAtEnqueue: 1, bytes: 16600, ...(ok ? {} : { reason: "failed", result: "sendFailed" }) });
        rec.event({ id: 0, kind: "text", ok: true, enqueuedAt: clock + 100, startedAt: clock + 100,
            endedAt: clock + 220, queuedMs: 0, durationMs: 120, depthAtEnqueue: 1 });
    };
    for (let i = 0; i < 12; i++) { both(true); clock += 5000; rec.tick({ playing: true, lagMs: 3 }); }
    for (let i = 0; i < 8; i++) { both(false); clock += 10000; rec.tick({ playing: true, lagMs: 4 }); }
    const a = analyse(rec.session());
    const text = formatReport(rec.session(), a);
    const lead = a.findings[0] || "";
    return {
        pass: lead.startsWith("THE PICTURE STOPPED") && /below this app/.test(lead) &&
              /8s \(p50\)/.test(lead),
        detail: lead.slice(lead.indexOf("The app itself"), lead.indexOf("The app itself") + 120),
    };
});

def("the glasses' worn flag is not used to blame the headset", async () => {
    // A tester wore the glasses for a whole session while the host reported
    // isWearing:false for most of it, phone asleep. A finding built on that flag
    // would have blamed the headset for a freeze on someone's face.
    let clock = 1_700_000_000_000;
    const rec = createRecorder({ now: () => clock });
    for (let i = 0; i < 20; i++) {
        const wearing = i < 10;
        rec.setContext({ wearing });
        rec.event({ id: 0, kind: "image", ok: wearing, enqueuedAt: clock, startedAt: clock,
            endedAt: clock + 6000, queuedMs: 0, durationMs: 6000, depthAtEnqueue: 1, bytes: 16600,
            ...(wearing ? {} : { reason: "failed", result: "sendFailed" }) });
        clock += 8000;
    }
    const a = analyse(rec.session());
    const text = formatReport(rec.session(), a);
    return {
        pass: !a.findings.some((x) => /head|headset/i.test(x)) && /reported not worn/.test(text) &&
              a.failedWriteMs.p50 === 6000,
        detail: a.findings.some((x) => /head|headset/i.test(x)) ? "BLAMED THE HEADSET" :
            "table kept, no attribution; failure took p50 6000ms",
    };
});

def("image failures that line up with the phone asleep are called out", async () => {
    // The shape of the sessions that froze: fine while timers ran on time, then
    // Android throttling the WebView (heartbeat a minute late) and images
    // failing while text trickled through. document.hidden never changed.
    const build = (asleepFails) => {
        let clock = 1_700_000_000_000;
        const rec = createRecorder({ now: () => clock });
        const both = (ok) => {
            rec.event({ id: 0, kind: "image", ok, enqueuedAt: clock, startedAt: clock,
                endedAt: clock + 2000, queuedMs: 0, durationMs: 2000, depthAtEnqueue: 1, bytes: 16600,
                ...(ok ? {} : { reason: "failed", result: "sendFailed" }) });
            rec.event({ id: 0, kind: "text", ok: true, enqueuedAt: clock + 100, startedAt: clock + 100,
                endedAt: clock + 220, queuedMs: 0, durationMs: 120, depthAtEnqueue: 1 });
        };
        for (let i = 0; i < 10; i++) {                         // awake
            both(true); clock += 5000; rec.tick({ playing: true, lagMs: 20, keepAlive: "playing" });
        }
        rec.mark("host-foreground-exit", { wasPlaying: true });
        for (let i = 0; i < 8; i++) {                          // asleep
            both(!asleepFails); clock += 60000;
            rec.tick({ playing: true, lagMs: 55000, keepAlive: "paused" });
        }
        rec.mark("user-play", { wasBackgroundPaused: true });
        return analyse(rec.session());
    };
    const asleep = build(true), fine = build(false);
    const text = formatReport({ events: [], marks: [], durationMs: 0 }, asleep);
    const hit = asleep.findings.find((x) => /phone is ASLEEP/.test(x)) || "";
    return {
        pass: /0% delivered/.test(hit) && /keep-alive was PAUSED/.test(hit) &&
              fine.findings.some((x) => /Throttling does not explain/.test(x)) &&
              asleep.findings.some((x) => /lost the foreground 1x while playing/.test(x) && /resumed by hand/.test(x)) &&
              /app events \(whole session\)/.test(text) && /host-foreground-exit/.test(text),
        detail: hit ? hit.slice(0, 140) : asleep.findings.join(" | ").slice(0, 140),
    };
});

def("a picture that dies for good leads the report, measured to the end", async () => {
    // The session that prompted this: ten minutes of frames, then every image
    // `sendFailed` until the end while text kept landing. The old report said
    // "stalls 1, longest 0.0s" — the ongoing stall was recorded as -1 — and led
    // with a 42s gap instead. The re-declarations it attempted all answered 1.
    let clock = 1_700_000_000_000;
    const rec = createRecorder({ now: () => clock });
    const img = (ok) => rec.event({ id: 0, kind: "image", ok, enqueuedAt: clock,
        startedAt: clock, endedAt: clock + 2000, queuedMs: 0, durationMs: 2000,
        depthAtEnqueue: 1, bytes: 16600, ...(ok ? {} : { reason: "failed", result: "sendFailed" }) });
    const txt = () => rec.event({ id: 0, kind: "text", ok: true, enqueuedAt: clock + 100,
        startedAt: clock + 100, endedAt: clock + 220, queuedMs: 0, durationMs: 120, depthAtEnqueue: 1 });

    for (let i = 0; i < 60; i++) { img(true); txt(); rec.tick({ playing: true }); clock += 10000; }
    for (let i = 0; i < 30; i++) {
        img(false); txt(); rec.tick({ playing: true });
        if (i % 6 === 0) rec.mark("containers-repaired", { result: 1, dead: "image", afterFailures: i + 2 });
        clock += 8000;
    }
    const a = analyse(rec.session());
    const text = formatReport(rec.session(), a);
    const lead = a.findings[0] || "";
    return {
        pass: lead.startsWith("THE PICTURE STOPPED") &&
              /30 image failures in a row/.test(lead) &&
              /refused 5x/.test(lead) && /only works at launch/.test(lead) &&
              a.longestStallMs > 200000 &&
              /STILL FROZEN/.test(text),
        detail: `longest ${(a.longestStallMs / 1000).toFixed(0)}s; lead: ${lead.slice(0, 110)}`,
    };
});

def("it explains a dead image container instead of blaming the link", async () => {
    // The exact session a beta sent back: 0 images sent, 20 failed, every
    // write timing 0ms, text landing throughout. The old report said only
    // "second attempts rarely help — consider failing faster", which is advice
    // about a link that was working perfectly.
    // A stepped clock, so the recorder's own idea of "now" agrees with the
    // timestamps on the events. With raw offsets against the wall clock the
    // session looks decades long and the gap detector invents an outage that
    // then leads the findings — which would make the assertion below pass or
    // fail for reasons that have nothing to do with what is being tested.
    let clock = 1_700_000_000_000;
    const rec = createRecorder({ now: () => clock });
    for (let i = 0; i < 20; i++) {
        // Refused before the radio: no time passes, and the SDK says why.
        rec.event({
            id: 0, kind: "image", ok: false, enqueuedAt: clock, startedAt: clock,
            endedAt: clock, queuedMs: 0, durationMs: 0, depthAtEnqueue: 1,
            bytes: 16000, reason: "failed", result: "imageException",
        });
        rec.event({
            id: 0, kind: "text", ok: true, enqueuedAt: clock + 100,
            startedAt: clock + 100, endedAt: clock + 469,
            queuedMs: 0, durationMs: 369, depthAtEnqueue: 1,
        });
        clock += 3000;
    }
    const a = analyse(rec.session());
    const hit = a.findings.find((x) => /image CONTAINER is gone/.test(x));
    const text = formatReport(rec.session(), a);
    return {
        pass: !!hit && /imageException x20/.test(hit) && /text kept landing/.test(hit) &&
              // and it must LEAD, not sit under advice about retry budgets
              a.findings[0] === hit &&
              /imageException\s+x20/.test(text),
        detail: hit ? hit.slice(0, 150) : a.findings.join(" | ").slice(0, 150),
    };
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
