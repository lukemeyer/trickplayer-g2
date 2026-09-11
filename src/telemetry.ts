// @ts-nocheck
//
// Session telemetry for the BLE link, and the analysis that turns it into
// something you can act on.
//
// **Why this exists as a separate page rather than a flag.** The link is the
// part of this product that cannot be tested off the hardware — no emulator
// reproduces its timing, and the simulator says so itself. So the only way to
// optimise it is to measure a real session on real glasses and read the
// numbers afterwards. Doing that inside the production page would mean shipping
// the recording cost to every wearer for a measurement almost none of them
// will take.
//
// **What is recorded, and why each field earns its place.** One record per BLE
// operation, because averages hide the tail and the tail is what a wearer
// notices:
//
//   enqueuedAt / startedAt   the gap is QUEUE WAIT — the pipeline outrunning
//                            the link, which no amount of faster writing fixes
//   startedAt / endedAt      the WRITE itself
//   bytes                    so duration and failure can be read against size,
//                            which is the one dial the app fully controls
//   attempts / tried         whether a retry ever actually helps, or whether
//                            the budget is just latency spent on a dead frame
//   reason                   superseded is not a failure and must not be
//                            counted as one
//   link / foreground        the two states everything else has to be read
//                            against, since both change under the wearer

export const TELEMETRY_VERSION = 1;

export function createRecorder({ max = 20000, now = () => Date.now() } = {}) {
    const started = now();
    const events = [];
    const marks = [];
    let context = {};

    return {
        /** Ambient state stamped onto every subsequent record. */
        setContext(patch) { context = { ...context, ...patch }; },
        /** A named moment — play, pause, background, reconnect. */
        mark(name, detail = {}) {
            marks.push({ at: now() - started, name, ...detail });
        },
        event(e) {
            if (events.length >= max) events.shift();
            events.push({
                ...e,
                // Relative to session start: smaller, and no wall-clock in the
                // export to identify anyone.
                enqueuedAt: e.enqueuedAt - started,
                startedAt: e.startedAt - started,
                endedAt: e.endedAt - started,
                ...context,
            });
        },
        get count() { return events.length; },
        session(extra = {}) {
            return {
                version: TELEMETRY_VERSION,
                durationMs: now() - started,
                events,
                marks,
                ...extra,
            };
        },
    };
}

// ------------------------------------------------------------- statistics

const pct = (sorted, p) =>
    sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))] : 0;

function summarise(values) {
    const s = [...values].sort((a, b) => a - b);
    const sum = s.reduce((a, b) => a + b, 0);
    return {
        n: s.length,
        mean: s.length ? sum / s.length : 0,
        p50: pct(s, 50), p90: pct(s, 90), p99: pct(s, 99),
        min: s[0] ?? 0, max: s[s.length - 1] ?? 0,
    };
}

/**
 * Turn a session into findings.
 *
 * Deliberately opinionated: it does not dump statistics and leave you to stare
 * at them, it answers the questions that would change the code. Every section
 * exists because there is a decision behind it.
 */
export function analyse(session) {
    const ev = session.events || [];
    const images = ev.filter((e) => e.kind === "image");
    const texts = ev.filter((e) => e.kind === "text");
    const real = (xs) => xs.filter((e) => e.reason !== "superseded");
    const ok = (xs) => xs.filter((e) => e.ok);

    const out = { durationMs: session.durationMs, counts: {}, findings: [] };

    out.counts = {
        images: images.length,
        imagesSent: ok(images).length,
        imagesFailed: real(images).length - ok(images).length,
        imagesSuperseded: images.length - real(images).length,
        texts: texts.length,
        textsSent: ok(texts).length,
        textsFailed: real(texts).length - ok(texts).length,
    };

    // 1. Where the time goes. Queue wait and write duration are different
    //    problems with different fixes, and only separating them says which.
    out.imageWriteMs = summarise(ok(images).map((e) => e.durationMs));
    out.imageQueueMs = summarise(real(images).map((e) => e.queuedMs));
    out.textWriteMs = summarise(ok(texts).map((e) => e.durationMs));

    // 2. Does size matter? The app chooses the payload; if duration or failure
    //    climbs with bytes, shrinking the image is the cheapest available win.
    const buckets = new Map();
    for (const e of real(images)) {
        if (!e.bytes) continue;
        const k = Math.floor(e.bytes / 4096) * 4;      // 4 KB buckets
        const b = buckets.get(k) || { kb: k, n: 0, ok: 0, ms: [] };
        b.n++; if (e.ok) { b.ok++; b.ms.push(e.durationMs); }
        buckets.set(k, b);
    }
    out.bySize = [...buckets.values()].sort((a, b) => a.kb - b.kb).map((b) => ({
        kb: b.kb, n: b.n,
        successPct: b.n ? (100 * b.ok) / b.n : 0,
        writeMs: summarise(b.ms),
    }));

    // 3. Is retrying worth what it costs? A retry that almost never succeeds is
    //    latency spent on a frame that is already lost, and the budget should
    //    shrink. One that usually succeeds argues for a longer one.
    const attempted = real(images).filter((e) => (e.attempts ?? 1) > 0);
    const byAttempt = [1, 2, 3].map((n) => {
        const reached = attempted.filter((e) => (e.attempts ?? 1) >= n);
        const succeededHere = attempted.filter((e) => e.ok && e.attempts === n);
        return {
            attempt: n,
            reached: reached.length,
            succeeded: succeededHere.length,
            yieldPct: reached.length ? (100 * succeededHere.length) / reached.length : 0,
        };
    });
    out.retries = byAttempt;

    // 4. Backpressure. A queue that is never empty means the pipeline is
    //    producing faster than the link drains, and the answer is pacing, not
    //    a faster write.
    out.depthAtEnqueue = summarise(real(images).map((e) => e.depthAtEnqueue ?? 1));

    // 5. Foreground against background, which is where the reports come from.
    for (const state of ["foreground", "background"]) {
        const xs = real(images).filter((e) => e.foreground === (state === "foreground"));
        if (!xs.length) continue;
        out[state] = {
            n: xs.length,
            successPct: (100 * xs.filter((e) => e.ok).length) / xs.length,
            writeMs: summarise(xs.filter((e) => e.ok).map((e) => e.durationMs)),
        };
    }

    // 6. Stalls: the thing a wearer actually experiences. A run of failures is
    //    a frozen picture, and its LENGTH is the complaint.
    let run = 0, runStart = 0;
    const stalls = [];
    for (const e of real(images)) {
        if (!e.ok) { if (run === 0) runStart = e.startedAt; run++; }
        else if (run) { stalls.push({ failures: run, ms: e.endedAt - runStart }); run = 0; }
    }
    if (run) stalls.push({ failures: run, ms: -1, ongoing: true });
    out.stalls = stalls;
    out.longestStallMs = stalls.reduce((m, s) => Math.max(m, s.ms), 0);

    // --- findings -------------------------------------------------------
    const f = out.findings;
    const sent = out.counts.imagesSent;
    if (out.imageQueueMs.p90 > out.imageWriteMs.p50 && out.imageQueueMs.p90 > 500) {
        f.push(`Queue wait (p90 ${Math.round(out.imageQueueMs.p90)}ms) exceeds a typical write ` +
            `(${Math.round(out.imageWriteMs.p50)}ms): the pipeline is outrunning the link. ` +
            `Pace scenes off the measured write time rather than sending sooner.`);
    }
    if (out.bySize.length > 1) {
        const lo = out.bySize[0], hi = out.bySize[out.bySize.length - 1];
        if (hi.writeMs.p50 > lo.writeMs.p50 * 1.3) {
            f.push(`Write time scales with payload: ${lo.kb}KB takes ${Math.round(lo.writeMs.p50)}ms, ` +
                `${hi.kb}KB takes ${Math.round(hi.writeMs.p50)}ms. Shrinking the image buys time directly.`);
        }
        if (hi.successPct < lo.successPct - 10) {
            f.push(`Larger payloads fail more: ${lo.kb}KB succeeds ${lo.successPct.toFixed(0)}% ` +
                `against ${hi.successPct.toFixed(0)}% at ${hi.kb}KB.`);
        }
    }
    const r2 = out.retries[1], r3 = out.retries[2];
    if (r2 && r2.reached >= 5 && r2.yieldPct < 15) {
        f.push(`Second attempts rarely help (${r2.yieldPct.toFixed(0)}% of ${r2.reached}): the retry ` +
            `budget is mostly latency spent on frames already lost. Consider failing faster.`);
    } else if (r2 && r2.yieldPct > 40) {
        f.push(`Retries earn their keep (${r2.yieldPct.toFixed(0)}% of second attempts succeed) — ` +
            `a longer budget may raise delivery further.`);
    }
    if (out.background && out.foreground) {
        const factor = out.background.writeMs.p50 / Math.max(1, out.foreground.writeMs.p50);
        f.push(`Background writes take ${factor.toFixed(1)}x as long as foreground ` +
            `(${Math.round(out.foreground.writeMs.p50)}ms -> ${Math.round(out.background.writeMs.p50)}ms) ` +
            `and succeed ${out.background.successPct.toFixed(0)}% against ${out.foreground.successPct.toFixed(0)}%.`);
    }
    if (out.longestStallMs > 10000) {
        f.push(`Longest frozen picture ${(out.longestStallMs / 1000).toFixed(1)}s ` +
            `across ${out.stalls.length} stall(s) — this is what a wearer reports.`);
    }
    if (out.counts.imagesSuperseded > sent * 0.5 && sent > 0) {
        f.push(`${out.counts.imagesSuperseded} frames were dropped as stale against ${sent} sent: ` +
            `scenes are being produced far faster than they can be shown.`);
    }
    if (!f.length) f.push("Nothing stands out — the link kept up with the pipeline.");
    return out;
}

/** The report as plain text, so it can be copied out of a WebView. */
export function formatReport(session, a = analyse(session)) {
    const ms = (v) => `${Math.round(v)}ms`;
    const L = [];
    L.push(`Trickplayer BLE session — ${(a.durationMs / 60000).toFixed(1)} min`);
    L.push("=".repeat(58));
    if (session.device) L.push(`device      ${JSON.stringify(session.device)}`);
    L.push(`images      ${a.counts.imagesSent} sent, ${a.counts.imagesFailed} failed, ` +
        `${a.counts.imagesSuperseded} superseded`);
    L.push(`text        ${a.counts.textsSent} sent, ${a.counts.textsFailed} failed`);
    L.push("");
    L.push(`image write  n=${a.imageWriteMs.n}  p50 ${ms(a.imageWriteMs.p50)}  ` +
        `p90 ${ms(a.imageWriteMs.p90)}  p99 ${ms(a.imageWriteMs.p99)}  max ${ms(a.imageWriteMs.max)}`);
    L.push(`queue wait   p50 ${ms(a.imageQueueMs.p50)}  p90 ${ms(a.imageQueueMs.p90)}  ` +
        `max ${ms(a.imageQueueMs.max)}`);
    L.push(`text write   n=${a.textWriteMs.n}  p50 ${ms(a.textWriteMs.p50)}  p90 ${ms(a.textWriteMs.p90)}`);
    if (a.bySize.length) {
        L.push("");
        L.push("by payload size");
        for (const b of a.bySize) {
            L.push(`  ${String(b.kb).padStart(3)}KB  n=${String(b.n).padStart(4)}  ` +
                `ok ${b.successPct.toFixed(0).padStart(3)}%  p50 ${ms(b.writeMs.p50)}`);
        }
    }
    L.push("");
    L.push("retry yield");
    for (const r of a.retries) {
        L.push(`  attempt ${r.attempt}: reached ${r.reached}, succeeded ${r.succeeded} ` +
            `(${r.yieldPct.toFixed(0)}%)`);
    }
    if (a.foreground || a.background) {
        L.push("");
        for (const k of ["foreground", "background"]) {
            if (!a[k]) continue;
            L.push(`${k.padEnd(11)} n=${a[k].n}  ok ${a[k].successPct.toFixed(0)}%  ` +
                `p50 ${ms(a[k].writeMs.p50)}  p90 ${ms(a[k].writeMs.p90)}`);
        }
    }
    L.push("");
    L.push(`stalls      ${a.stalls.length}, longest ${(a.longestStallMs / 1000).toFixed(1)}s`);
    L.push("");
    L.push("FINDINGS");
    a.findings.forEach((x, i) => L.push(`  ${i + 1}. ${x}`));
    return L.join("\n");
}
