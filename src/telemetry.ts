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

export function createRecorder({ max = 20000, now = () => Date.now(), resume = null } = {}) {
    // A session CONTINUES across a reload rather than starting again.
    //
    // The phone sleeping can discard the page, and the old design started a
    // fresh recorder on the way back — so the very event worth measuring became
    // two disjoint sessions with the interesting part falling in the crack
    // between them. Now the clock keeps running and the reload is a mark, which
    // makes the outage a GAP inside one timeline.
    const priorMs = resume?.durationMs || 0;
    const wall = now();
    const at = () => wall - priorMs;         // virtual session start
    const started = at();
    const events = resume?.events ? [...resume.events] : [];
    const marks = resume?.marks ? [...resume.marks] : [];
    let context = {};

    return {
        /** Ambient state stamped onto every subsequent record. */
        setContext(patch) { context = { ...context, ...patch }; },
        /** A named moment — play, pause, background, reconnect. */
        mark(name, detail = {}) {
            marks.push({ at: now() - started, name, ...detail });
        },
        /**
         * Proof of life.
         *
         * The whole point: an operation record says something HAPPENED, and the
         * complaint being chased is that nothing did. A tick every few seconds
         * turns silence into evidence — a span with no ticks is a page that was
         * not running, a span with ticks but no images is a pipeline that
         * stopped while the page was fine, and those are different bugs.
         */
        tick(state = {}) {
            marks.push({ at: now() - started, name: "tick", ...state });
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

    // 6b. SYNTHETIC against REAL, at the same size.
    //
    //     The sweep sends payloads the app never would, back to back, with
    //     nothing else happening. Playback sends real frames while it is also
    //     fetching, decoding and dithering the next one. If the two disagree at
    //     comparable sizes then payload size is NOT what costs the time, and
    //     shrinking the image — the obvious optimisation, and the one this
    //     report kept recommending — would buy far less than the size curve
    //     promises.
    const probes = ok(images).filter((e) => e.probe);
    const realFrames = ok(images).filter((e) => !e.probe && e.bytes);
    if (probes.length >= 3 && realFrames.length >= 3) {
        // Fit ms = fixed + perKb*KB over the synthetic points, then ask what it
        // predicts for the size the real frames actually are.
        const pts = probes.map((e) => [e.bytes / 1024, e.durationMs]);
        const n = pts.length;
        const sx = pts.reduce((t, p) => t + p[0], 0);
        const sy = pts.reduce((t, p) => t + p[1], 0);
        const sxx = pts.reduce((t, p) => t + p[0] * p[0], 0);
        const sxy = pts.reduce((t, p) => t + p[0] * p[1], 0);
        const denom = n * sxx - sx * sx;
        if (denom !== 0) {
            const perKb = (n * sxy - sx * sy) / denom;
            const fixed = (sy - perKb * sx) / n;
            const realKb = realFrames.reduce((t, e) => t + e.bytes, 0) / realFrames.length / 1024;
            const predicted = fixed + perKb * realKb;
            const actual = summarise(realFrames.map((e) => e.durationMs)).p50;
            out.synthetic = {
                fixedMs: fixed, perKbMs: perKb,
                realKb, predictedMs: predicted, actualMs: actual,
                ratio: predicted > 0 ? actual / predicted : 0,
            };
        }
    }

    // 6c. CONTENTION — does a write slow down when prep runs underneath it?
    //
    //     The pipeline prefetches the NEXT scene's frame while the current one
    //     is on screen, so a fetch and a decode routinely overlap a write in
    //     flight. Whether that costs anything is measurable rather than
    //     arguable: split the writes by whether work overlapped them, and
    //     compare. If the busy ones are slower, the 2.3x gap between real
    //     frames and synthetic payloads has its explanation, and the fix is
    //     scheduling rather than smaller images.
    const work = ev.filter((e) => e.kind === "fetch" || e.kind === "prepare");
    out.fetchMs = summarise(work.filter((e) => e.kind === "fetch" && e.ok).map((e) => e.durationMs));
    out.prepareMs = summarise(work.filter((e) => e.kind === "prepare" && e.ok).map((e) => e.durationMs));
    out.fetchCachedPct = (() => {
        const f = work.filter((e) => e.kind === "fetch");
        return f.length ? (100 * f.filter((e) => e.cached).length) / f.length : 0;
    })();

    // 6d. WHAT INSIDE `prepare` IS EXPENSIVE
    //
    //     `prepare` is three different jobs wearing one number: decode the
    //     provider's JPEG, run the pixel arithmetic, encode a PNG for the
    //     bridge. A session reported it at 4040ms p90 and the report could say
    //     nothing more useful than "chase it" — because a slow decode, slow
    //     arithmetic and a slow encode have three different fixes.
    //
    //     `tools/pixel-bench.mjs` pins the middle one at ~0.5ms for this frame
    //     size, off-hardware, so if `pixels` shows up large here the phone is
    //     not doing arithmetic slowly, it is being interrupted. That makes the
    //     phase split diagnostic rather than merely descriptive.
    const PHASES = ["decode", "pixels", "encode"];
    out.phases = null;
    {
        const per = {};
        let any = 0;
        for (const name of PHASES) {
            const d = ev.filter((e) => e.kind === name && e.ok).map((e) => e.durationMs);
            per[name] = summarise(d);
            any += d.length;
        }
        if (any) out.phases = per;
    }

    if (work.length >= 4 && ok(images).length >= 4) {
        // Split by WHICH work overlapped, not just whether any did. A fetch and
        // a decode contend for different things — the radio and the network on
        // one side, the main thread on the other — and they have opposite
        // fixes: you can delay a decode without losing anything, while delaying
        // a fetch is giving up the prefetch that hides the network entirely.
        // Lumping them is the same mistake `prepare` made one level down
        // ([[F-046]]): a number spanning two fixes cannot choose between them.
        const overlapOf = (kind, a0, a1) =>
            work.reduce((t, w) => t + (w.kind === kind
                ? Math.max(0, Math.min(a1, w.endedAt) - Math.max(a0, w.startedAt)) : 0), 0);

        const withWork = [], alone = [];
        const byKind = { fetch: [], prepare: [], both: [] };
        for (const w of ok(images)) {
            const bar = 0.1 * w.durationMs;
            const f = overlapOf("fetch", w.startedAt, w.endedAt) > bar;
            const p = overlapOf("prepare", w.startedAt, w.endedAt) > bar;
            if (f || p) {
                withWork.push(w.durationMs);
                byKind[f && p ? "both" : f ? "fetch" : "prepare"].push(w.durationMs);
            } else {
                alone.push(w.durationMs);
            }
        }
        out.contention = {
            contended: summarise(withWork),
            clear: summarise(alone),
            contendedPct: (100 * withWork.length) / ok(images).length,
            byKind: {
                fetch: summarise(byKind.fetch),
                prepare: summarise(byKind.prepare),
                both: summarise(byKind.both),
            },
        };
    }

    // 7. GAPS — the thing the first version of this report could not see.
    //
    //    An operation record is proof something happened; a frozen stream is
    //    the absence of them, which no aggregate over the records can show. So
    //    the timeline is walked instead, and every span where nothing was sent
    //    is classified by whether the page was still ticking:
    //
    //      page stopped   no ticks either — the WebView was frozen, discarded
    //                     or killed. Nothing in the app can be blamed for it,
    //                     and nothing in the app noticed.
    //      pipeline idle  ticks continued, and the app said it was PLAYING, and
    //                     still nothing was sent. That is ours.
    const allMarks = session.marks || [];
    const ticks = allMarks.filter((m) => m.name === "tick");
    // Anything that is NOT our own timer is independent proof the page was
    // running: a link callback, a lifecycle event. This distinction was learned
    // the hard way — a session was reported as "the page stopped, no heartbeat"
    // while link callbacks arrived every few seconds throughout it. The page
    // was fine. `setInterval` was throttled, which is what Android does to a
    // backgrounded WebView, and is ALSO what stalls a timer-driven pipeline.
    const proofOfLife = allMarks.filter((m) => m.name !== "tick");

    const GAP_MS = 15000;      // several scene intervals: not a slow frame
    const gaps = [];

    /**
     * Break a silence into spans by what the page was doing during it.
     *
     * One silence is not necessarily one problem: the reported case was the
     * pipeline stopping first and the phone freezing the page some time later,
     * which is two bugs end to end and reads as one if the span is not split
     * where the heartbeat stops.
     */
    const closeGap = (fromMs, toMs, endedHere = false) => {
        if (toMs - fromMs <= GAP_MS) return;
        const inside = ticks.filter((t) => t.at > fromMs + 2000 && t.at < toMs - 2000);
        const alive = proofOfLife.filter((m) => m.at > fromMs + 2000 && m.at < toMs - 2000);
        const add = (a, b, kind, playing) => {
            if (b - a <= GAP_MS) return;
            gaps.push({ fromMs: a, toMs: b, ms: b - a, kind, playing: !!playing,
                ...(endedHere && b === toMs ? { endedHere: true } : {}) });
        };
        if (!inside.length) {
            // No heartbeat, but other events still arriving: the page is alive
            // and its TIMERS are not. That is the diagnosis that matters,
            // because the scene pipeline is timer-driven — it is why nothing
            // was sent, and it is a different fix from a dead page.
            add(fromMs, toMs, alive.length ? "timers throttled" : "page stopped", false);
            return;
        }
        const first = inside[0].at, last = inside[inside.length - 1].at;
        // Before the heartbeat resumed, and after it stopped, the page was not
        // running. Between them it was, and sent nothing anyway.
        const deadOr = (a, b) =>
            proofOfLife.some((m) => m.at > a + 2000 && m.at < b - 2000)
                ? "timers throttled" : "page stopped";
        add(fromMs, first, deadOr(fromMs, first), false);
        // Unless the page was RELOADED in the middle of it. The session
        // survives a reload on purpose — a wearer whose WebView is discarded
        // and restored should not lose their measurements — and the cost is
        // that the quiet minute between "the page went away" and "something
        // was playing again" reads as the pipeline stalling. It is not ours,
        // and mislabelling it as ours buries the gaps that are.
        const reloaded = allMarks.some(
            (m) => m.name === "page-reloaded" && m.at >= fromMs && m.at <= toMs);
        add(first, last, reloaded ? "session restarted" : "pipeline idle",
            !reloaded && inside.some((t) => t.playing));
        add(last, toMs, deadOr(last, toMs), false);
    };

    const ops = ev.map((e) => e.startedAt).sort((a, b) => a - b);
    let lastOp = 0;
    for (const at of ops) {
        closeGap(lastOp, at);
        lastOp = at;
    }
    // A session that ends mid-silence is the most important gap of all — it is
    // what the wearer was looking at when they gave up.
    closeGap(lastOp, session.durationMs, true);

    out.gaps = gaps;
    out.longestGapMs = gaps.reduce((m, g) => Math.max(m, g.ms), 0);
    out.deadMs = gaps.reduce((t, g) => t + g.ms, 0);
    out.lifecycle = (session.marks || []).filter((m) => m.name !== "tick");

    // --- findings -------------------------------------------------------
    const f = out.findings;
    const sent = out.counts.imagesSent;
    if (out.imageQueueMs.p90 > out.imageWriteMs.p50 && out.imageQueueMs.p90 > 500) {
        f.push(`Queue wait (p90 ${Math.round(out.imageQueueMs.p90)}ms) exceeds a typical write ` +
            `(${Math.round(out.imageWriteMs.p50)}ms): the pipeline is outrunning the link. ` +
            `Pace scenes off the measured write time rather than sending sooner.`);
    }
    // Preparing a frame is supposed to be cheap next to sending it. When it is
    // not, it is not a cost hiding beside the write — it BLOCKS the pipeline,
    // because the next frame cannot start until the decode finishes.
    if (out.prepareMs.n >= 5 && out.prepareMs.p90 > 1000 &&
        out.prepareMs.p90 > 0.5 * Math.max(1, out.imageWriteMs.p50)) {
        f.push(`Preparing a frame reached ${Math.round(out.prepareMs.p90)}ms at p90 ` +
            `(median ${Math.round(out.prepareMs.p50)}ms) against a ` +
            `${Math.round(out.imageWriteMs.p50)}ms write. Decode and dither run on the main ` +
            `thread, so a tail like that stalls the pipeline outright — worth chasing before ` +
            `the link.`);

        // And say WHICH phase, when the session recorded them. A bare
        // instruction to "chase the decode" was the weakest line in this
        // report; the phase split turns it into an address.
        const ph = out.phases;
        if (ph) {
            const named = PHASES
                .filter((k) => ph[k].n >= 3)
                .sort((a, b) => ph[b].p90 - ph[a].p90);
            const worst = named[0];
            if (worst) {
                const share = named.reduce((t, k) => t + ph[k].p90, 0);
                f.push(`Inside that, ${worst} is the expensive phase: p90 ${Math.round(ph[worst].p90)}ms ` +
                    `of ${Math.round(share)}ms across ${named.join(" + ")}. ` +
                    (worst === "pixels"
                        ? `The arithmetic itself benchmarks at well under a millisecond for this ` +
                          `frame size, so time spent there is the main thread being taken away, ` +
                          `not the loop being slow — look at what else runs during a scene.`
                        : worst === "decode"
                        ? `Decoding is the provider's JPEG. It already runs off-thread via ` +
                          `createImageBitmap where the WebView supports it; if it is still slow, ` +
                          `the frames themselves are larger than the link needs.`
                        : `Encoding is the PNG handed to the bridge. A cheaper encoding, or ` +
                          `handing raw bytes across, removes it outright.`));
            }
        }
    }

    const c = out.contention;
    if (c && c.contended.n >= 3 && c.clear.n >= 3) {
        const factor = c.contended.p50 / Math.max(1, c.clear.p50);
        if (factor > 1.3) {
            f.push(`Writes that had a fetch or a decode running underneath them take ` +
                `${factor.toFixed(1)}x as long: ${Math.round(c.contended.p50)}ms against ` +
                `${Math.round(c.clear.p50)}ms when the write had the device to itself, and ` +
                `${c.contendedPct.toFixed(0)}% of writes were contended. This is a SCHEDULING ` +
                `problem, and it is worth more than any payload reduction.`);

            // WHICH kind, because the two have opposite remedies.
            const k = c.byKind;
            if (k) {
                const named = ["prepare", "fetch", "both"]
                    .filter((n) => k[n].n >= 3)
                    .sort((a, b) => k[b].p50 - k[a].p50);
                const worst = named[0];
                if (worst && k[worst].p50 > c.clear.p50 * 1.3) {
                    f.push(worst === "prepare"
                        ? `The overlap that costs most is a DECODE running under the write ` +
                          `(${Math.round(k.prepare.p50)}ms vs ${Math.round(c.clear.p50)}ms clear). ` +
                          `That one is free to move: hold the next frame's prep until the current ` +
                          `write completes and nothing is lost but a little idle time.`
                        : worst === "fetch"
                        ? `The overlap that costs most is a FETCH running under the write ` +
                          `(${Math.round(k.fetch.p50)}ms vs ${Math.round(c.clear.p50)}ms clear). ` +
                          `Be careful here — the prefetch is what hides the network, so serialising ` +
                          `it trades one stall for another. Fetch earlier rather than later.`
                        : `The expensive case is a fetch AND a decode under the same write ` +
                          `(${Math.round(k.both.p50)}ms vs ${Math.round(c.clear.p50)}ms clear), so ` +
                          `it is the pile-up rather than either one. Stagger them: the decode can ` +
                          `wait for the write, the fetch should start sooner.`);
                }
            }
        } else {
            f.push(`Concurrent prep costs little: contended writes ${Math.round(c.contended.p50)}ms ` +
                `against ${Math.round(c.clear.p50)}ms clear. The time is in the link itself, so ` +
                `look at the payload and the pacing rather than the scheduling.`);
        }
    }
    // A ratio on top of trivial numbers is noise, and a report that fires on
    // noise gets ignored when it matters. The gap has to be worth acting on.
    const sizeIsALie = out.synthetic && out.synthetic.ratio > 1.5 &&
        out.synthetic.actualMs - out.synthetic.predictedMs > 150;
    if (sizeIsALie) {
        const y = out.synthetic;
        f.push(`Real frames cost ${y.ratio.toFixed(1)}x what their SIZE explains: ` +
            `${Math.round(y.actualMs)}ms against ${Math.round(y.predictedMs)}ms predicted at ` +
            `${y.realKb.toFixed(0)}KB by the synthetic sweep (${Math.round(y.fixedMs)}ms fixed + ` +
            `${y.perKbMs.toFixed(0)}ms/KB). The difference is NOT the payload — it is whatever ` +
            `else playback is doing while the write is in flight, so shrinking the image would ` +
            `buy roughly ${y.perKbMs.toFixed(0)}ms per KB saved and no more.`);
    }
    if (out.bySize.length > 1) {
        const lo = out.bySize[0], hi = out.bySize[out.bySize.length - 1];
        // Suppressed when the synthetic comparison has just said the opposite.
        // Both readings are drawn from the same table, and a report that
        // recommends shrinking the image one line after explaining that
        // shrinking it would not help is worse than one that says less.
        if (!sizeIsALie && hi.writeMs.p50 > lo.writeMs.p50 * 1.3) {
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
    // Gaps first, because a stream that stopped is a bigger complaint than a
    // stream that was slow, and the old report ranked it below nothing at all.
    if (out.gaps.length) {
        const dead = (out.deadMs / 1000).toFixed(0);
        const share = ((100 * out.deadMs) / Math.max(1, out.durationMs)).toFixed(0);
        f.unshift(`NOTHING WAS SENT for ${dead}s of this session (${share}% of it), ` +
            `across ${out.gaps.length} gap(s), longest ${(out.longestGapMs / 1000).toFixed(0)}s.`);
        const throttled = out.gaps.filter((g) => g.kind === "timers throttled");
        if (throttled.length) {
            f.splice(1, 0, `${throttled.length} of those: the page was ALIVE — other events kept ` +
                `arriving — but its timers were not firing. Android throttles timers in a ` +
                `backgrounded WebView, and the scene pipeline is timer-driven, so this is why ` +
                `nothing was sent.`);
        }
        const stopped = out.gaps.filter((g) => g.kind === "page stopped");
        const idle = out.gaps.filter((g) => g.kind === "pipeline idle");
        if (stopped.length) {
            f.splice(throttled.length ? 2 : 1, 0, `${stopped.length} of those: the PAGE stopped running — no heartbeat ` +
                `either, so the WebView was frozen, discarded or killed. Recovering from that is ` +
                `a resume path, not a transport fix.`);
        }
        if (idle.length) {
            f.splice((stopped.length ? 1 : 0) + (throttled.length ? 1 : 0) + 1, 0,
                `${idle.length} of those: the page kept ticking and still sent nothing` +
                `${idle.some((g) => g.playing) ? " WHILE THE APP BELIEVED IT WAS PLAYING" : ""} — ` +
                `that is the scene pipeline stopping, and it is ours.`);
        }
        // Said last, because it is the one kind of silence nobody needs to act
        // on — and unsaid, it inflates every other number in this section.
        const restarted = out.gaps.filter((g) => g.kind === "session restarted");
        if (restarted.length) {
            const restartMs = restarted.reduce((t, g) => t + g.ms, 0);
            f.push(`${(restartMs / 1000).toFixed(0)}s of that silence spans a page RELOAD ` +
                `(${restarted.length} of the gaps). The session deliberately survives a reload, ` +
                `so the quiet between the page going away and something playing again is counted ` +
                `but is not a fault — discount it before reading the rest.`);
        }
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
    if (a.synthetic) {
        const y = a.synthetic;
        L.push("");
        L.push(`synthetic fit   ${Math.round(y.fixedMs)}ms fixed + ${y.perKbMs.toFixed(1)}ms/KB`);
        L.push(`real frames     ${y.realKb.toFixed(0)}KB -> ${Math.round(y.actualMs)}ms actual ` +
            `vs ${Math.round(y.predictedMs)}ms predicted  (${y.ratio.toFixed(2)}x)`);
    }
    if (a.fetchMs.n || a.prepareMs.n) {
        L.push("");
        L.push(`fetch        n=${a.fetchMs.n}  p50 ${ms(a.fetchMs.p50)}  p90 ${ms(a.fetchMs.p90)}  ` +
            `${a.fetchCachedPct.toFixed(0)}% already cached`);
        L.push(`prepare      n=${a.prepareMs.n}  p50 ${ms(a.prepareMs.p50)}  p90 ${ms(a.prepareMs.p90)}`);
        if (a.phases) {
            for (const name of ["decode", "pixels", "encode"]) {
                const ph = a.phases[name];
                if (!ph.n) continue;
                L.push(`  ${name.padEnd(9)}  n=${ph.n}  p50 ${ms(ph.p50)}  p90 ${ms(ph.p90)}  max ${ms(ph.max)}`);
            }
        }
    }
    if (a.contention) {
        L.push(`write alone  n=${a.contention.clear.n}  p50 ${ms(a.contention.clear.p50)}`);
        L.push(`write busy   n=${a.contention.contended.n}  p50 ${ms(a.contention.contended.p50)}  ` +
            `(${a.contention.contendedPct.toFixed(0)}% of writes)`);
        if (a.contention.byKind) {
            for (const name of ["fetch", "prepare", "both"]) {
                const k = a.contention.byKind[name];
                if (!k.n) continue;
                L.push(`  under ${name.padEnd(8)} n=${k.n}  p50 ${ms(k.p50)}  p90 ${ms(k.p90)}`);
            }
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
    L.push(`stalls      ${a.stalls.length} (consecutive failures), ` +
        `longest ${(a.longestStallMs / 1000).toFixed(1)}s`);
    L.push(`gaps        ${a.gaps.length} (nothing sent at all), ` +
        `${(a.deadMs / 1000).toFixed(0)}s dead, longest ${(a.longestGapMs / 1000).toFixed(0)}s`);
    for (const g of a.gaps.slice(0, 8)) {
        L.push(`  ${(g.fromMs / 1000).toFixed(0).padStart(5)}s +${(g.ms / 1000).toFixed(0).padStart(4)}s  ` +
            `${g.kind}${g.playing ? ", app thought it was playing" : ""}${g.endedHere ? ", session ended here" : ""}`);
    }
    if (a.lifecycle.length) {
        L.push("");
        // Around the GAPS, not the last N. The previous version truncated to
        // the tail and cut off the beginning of every outage, which is the end
        // that says what started it.
        const near = a.gaps.length
            ? a.lifecycle.filter((m) =>
                  a.gaps.some((g) => m.at > g.fromMs - 30000 && m.at < g.toMs + 30000))
            : a.lifecycle;
        L.push(a.gaps.length ? "lifecycle around the gaps" : "lifecycle");
        for (const m of (near.length ? near : a.lifecycle).slice(0, 16)) {
            const { at, name, ...rest } = m;
            L.push(`  ${(at / 1000).toFixed(0).padStart(5)}s  ${name}` +
                `${Object.keys(rest).length ? "  " + JSON.stringify(rest).slice(0, 70) : ""}`);
        }
    }
    L.push("");
    L.push("FINDINGS");
    a.findings.forEach((x, i) => L.push(`  ${i + 1}. ${x}`));
    return L.join("\n");
}
