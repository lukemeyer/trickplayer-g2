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

/**
 * Is a stored session worth picking back up?
 *
 * The rule is "did it record anything at all", and it has to count MARKS as
 * well as events. Testing `events.length` alone throws away exactly the
 * sessions worth keeping: an outage is an ABSENCE of writes, so the session
 * that captured one has heartbeats and lifecycle marks and few or no events.
 * Resuming only the busy sessions loses every quiet failure — which is the
 * category this whole report was built to see.
 */
export function isResumable(prev) {
    return !!(prev && (prev.events?.length || prev.marks?.length));
}

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

    // 2b. THE LOCKED SWEEP, on its own. It exists to answer one question — is
    //     there a payload size below which pictures still land with the phone
    //     locked — so it gets finer buckets and is kept apart from the awake
    //     sweep it would otherwise be averaged with.
    out.lockedSweep = null;
    {
        const locked = real(images).filter((e) => e.sweep === "locked" && e.bytes);
        if (locked.length) {
            const lb = new Map();
            for (const e of locked) {
                const k = Math.floor(e.bytes / 2048) * 2;          // 2 KB buckets
                const b = lb.get(k) || { kb: k, n: 0, ok: 0, ms: [], failMs: [] };
                b.n++;
                if (e.ok) { b.ok++; b.ms.push(e.durationMs); } else b.failMs.push(e.durationMs);
                lb.set(k, b);
            }
            const rows = [...lb.values()].sort((a, b) => a.kb - b.kb).map((b) => ({
                kb: b.kb, n: b.n, successPct: (100 * b.ok) / b.n,
                writeMs: summarise(b.ms), failMs: summarise(b.failMs),
            }));
            // "Mostly delivered" and "mostly failed" — a 1-of-3 bucket is 33.3%,
            // which a <= 33 test quietly counted as neither.
            const landed = rows.filter((r) => r.successPct >= 66);
            const failed = rows.filter((r) => r.successPct < 50);
            out.lockedSweep = {
                rows,
                largestLandedKb: landed.length ? landed[landed.length - 1].kb : null,
                smallestFailedKb: failed.length ? failed[0].kb : null,
            };
        }
    }

    // 2c. BY PICTURE LEVEL. The ladder drops to lighter pictures when sends
    //     slow or fail (F-050); this is how to tell whether that worked —
    //     delivered at the lighter level, and how fast.
    out.byQuality = null;
    {
        const withQ = real(images).filter((e) => e.quality && !e.probe);
        if (withQ.some((e) => e.quality !== "full")) {
            // Every rung, or the section renders its header with no rows — which
            // is exactly what a session stuck on the newest rung looked like.
            const order = ["full", "lighter", "lightest", "minimal"];
            out.byQuality = order.map((q) => {
                const list = withQ.filter((e) => e.quality === q);
                return { quality: q, n: list.length,
                    okPct: list.length ? (100 * list.filter((e) => e.ok).length) / list.length : null,
                    writeMs: summarise(list.filter((e) => e.ok).map((e) => e.durationMs)) };
            }).filter((r) => r.n);
        }
    }

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
        // A sweep's failures are the sweep doing its job — it sends sizes chosen
        // to fail. Counted here, they reported "the picture stopped at 80s"
        // while nothing was playing.
        if (e.probe) continue;
        if (!e.ok) { if (run === 0) runStart = e.startedAt; run++; }
        else if (run) { stalls.push({ failures: run, ms: e.endedAt - runStart }); run = 0; }
    }
    // A stall still running when the session ends is measured to the END.
    // It used to be recorded as -1, so the one freeze that never recovered —
    // the worst there is, and the one the wearer gave up on — could never be
    // the longest: a session whose picture died for four minutes reported
    // "longest 0.0s". Same lesson as the gap detector, learned twice.
    if (run) {
        stalls.push({ failures: run, ms: Math.max(0, session.durationMs - runStart),
            ongoing: true, fromMs: runStart });
    }
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

    // 6e. WHY THE WRITES FAILED, in the device's own words.
    //
    //     A session came back reading "images 0 sent, 20 failed" and nothing
    //     else, and the cause had to be reasoned out from every write timing
    //     0ms. The SDK had answered with a reason on all twenty of them and the
    //     app was discarding it. Now it rides along on the record.
    //
    //     The distinction that matters: `imageException`, `imageToGray4Failed`
    //     and `imageSizeInvalid` come back BEFORE the radio is touched, so they
    //     cost no time and are not a link problem at all. `sendFailed` is a
    //     transmission that was attempted and lost.
    out.failureReasons = (() => {
        const failed = images.filter((e) => !e.ok && e.reason !== "superseded");
        const byReason = {};
        for (const e of failed) {
            const k = e.result || e.reason || "unknown";
            byReason[k] = (byReason[k] || 0) + 1;
        }
        const total = failed.length;
        return total ? { total, byReason, instantPct:
            (100 * failed.filter((e) => e.durationMs <= 1).length) / total } : null;
    })();

    // 6f. DO OUR OWN FRAMES LAND, when synthetic ones do?
    //
    //     The distinction that a whole beta session turned on. The sweep's
    //     payloads are made by the browser; a real frame is made by our
    //     encoder. If the synthetic ones land and the real ones do not, at
    //     comparable sizes, then it is not the link, not the size and not the
    //     pacing — it is the ENCODING, and no amount of tuning the first three
    //     will touch it.
    out.realVsProbe = (() => {
        const probes = real(images).filter((e) => e.probe);
        const frames = real(images).filter((e) => !e.probe);
        if (probes.length < 4 || frames.length < 3) return null;
        const rate = (a) => (100 * a.filter((e) => e.ok).length) / a.length;
        return {
            probeOkPct: rate(probes), probeN: probes.length,
            frameOkPct: rate(frames), frameN: frames.length,
            frameKb: frames[0]?.bytes ? frames[0].bytes / 1024 : 0,
            formats: [...new Set(frames.map((e) => e.format).filter(Boolean))],
        };
    })();

    // 6f. HOW LONG A FAILURE TAKES. The write-time table above is successes
    //     only, and failures turned out to be the interesting half: a session
    //     where no failure was ever retried meant every one had outlasted the
    //     five-second retry budget on its FIRST attempt. Instant, a few
    //     hundred ms, or many seconds are three different faults.
    out.failedWriteMs = summarise(images
        .filter((e) => !e.ok && e.reason !== "superseded" && !e.probe)
        .map((e) => e.durationMs));

    // 6g. ON THE HEAD OR NOT. The glasses report whether they are being worn,
    //     and a G2 taken off may well stop drawing. Split outcomes by it, so a
    //     freeze can be told apart from glasses lying on a table.
    out.byWearing = (() => {
        const split = { on: [], off: [] };
        for (const e of [...images, ...texts]) {
            if (e.probe || e.reason === "superseded") continue;
            if (e.wearing === true) split.on.push(e);
            else if (e.wearing === false) split.off.push(e);
        }
        if (!split.off.length) return null;
        const side = (list) => {
            const im = list.filter((e) => e.kind === "image");
            const tx = list.filter((e) => e.kind === "text");
            const pct = (l) => (l.length ? (100 * l.filter((e) => e.ok).length) / l.length : null);
            return { images: im.length, imageOkPct: pct(im), texts: tx.length, textOkPct: pct(tx) };
        };
        return { on: side(split.on), off: side(split.off) };
    })();

    // 6h. WAS ANDROID THROTTLING US? Measured from the heartbeat's lateness,
    //     because nothing else can say. The host keeps the WebView "visible"
    //     with the phone asleep — a session spent mostly with the screen off
    //     recorded every write as foreground — so `document.hidden` is blind
    //     to the one state every freeze so far has happened in.
    //
    //     A heartbeat reports the lateness of the interval that ENDS at it, so
    //     an operation belongs to the first heartbeat after it.
    const LATE_MS = 10000;
    const beats = (session.marks || []).filter((m) => m.name === "tick" && typeof m.lagMs === "number");
    out.throttling = null;
    if (beats.length >= 3) {
        const late = beats.filter((b) => b.lagMs > LATE_MS);
        const beatAfter = (at) => beats.find((b) => b.at >= at && b.at - at < 70000);
        const split = { throttled: [], onTime: [] };
        for (const e of [...images, ...texts]) {
            if (e.probe || e.reason === "superseded") continue;
            const b = beatAfter(e.startedAt);
            if (!b) continue;
            (b.lagMs > LATE_MS ? split.throttled : split.onTime).push(e);
        }
        const side = (list) => {
            const im = list.filter((e) => e.kind === "image");
            const tx = list.filter((e) => e.kind === "text");
            const pct = (l) => (l.length ? (100 * l.filter((e) => e.ok).length) / l.length : null);
            return { images: im.length, imageOkPct: pct(im), texts: tx.length, textOkPct: pct(tx) };
        };
        out.throttling = {
            lateBeats: late.length, beats: beats.length,
            maxLagMs: beats.reduce((m, b) => Math.max(m, b.lagMs), 0),
            firstLateAt: late[0]?.at ?? null,
            keepAlivePausedBeats: beats.filter((b) => b.keepAlive === "paused" && b.playing).length,
            throttled: side(split.throttled), onTime: side(split.onTime),
        };
    }

    // 6i. WHAT THE APP DID, in full. Pauses, resumes, what the host told it and
    //     what the wearer pressed, shown for the whole session — not only near
    //     gaps. A tester found the stream paused on waking the phone and the
    //     report could not show when, or why, it had stopped.
    const KEY_EVENTS = new Set([
        "host-foreground-exit", "host-foreground-enter", "app-paused", "app-resumed",
        "user-play", "user-pause", "phone-screen-off", "phone-screen-on",
        "image-backoff", "image-resumed", "page-rebuilt", "containers-repaired",
        "image-format-changed", "page-reloaded", "session-discarded",
        "picture-quality", "playback-ended", "playback-stopped",
        "glasses-tap", "glasses-double-tap", "glasses-exit-event", "app-cleanup",
    ]);
    out.keyEvents = (session.marks || []).filter((m) => KEY_EVENTS.has(m.name));

    // 6j. LINK SPEED OVER TIME. The slowdown that kills full pictures comes and
    //     goes — one locked sweep had 14-18 KB timing out, the next delivered
    //     20 KB in 1.3s — and the report cannot see the phone lock. What it CAN
    //     see is when sends got slow, minute by minute, and which picture level
    //     they were at. A slow patch shows up here whatever caused it.
    out.timeline = (() => {
        const MIN = 60000;
        const rows = new Map();
        const row = (k) => rows.get(k) ||
            rows.set(k, { minute: k, n: 0, ok: 0, ms: [], levels: new Set(), textMs: [], dropped: 0 }).get(k);
        for (const e of images) {
            if (e.probe) continue;
            const r = row(Math.floor(e.startedAt / MIN));
            // Dropped as stale: a newer frame overtook it in the queue. Worth
            // seeing per minute — seeking drops frames by design, a slow link
            // drops them as a symptom.
            if (e.reason === "superseded") { r.dropped++; continue; }
            r.n++;
            if (e.ok) { r.ok++; r.ms.push(e.durationMs); }
            if (e.quality) r.levels.add(e.quality);
        }
        // Subtitles on the same clock. A subtitle is a few hundred bytes, so if
        // subtitles slow down alongside the pictures the whole link slowed; if
        // they do not, it is something about pictures.
        for (const e of ok(texts)) {
            const r = rows.get(Math.floor(e.startedAt / MIN));
            if (r) r.textMs.push(e.durationMs);
        }
        return [...rows.values()].filter((r) => r.n || r.dropped).sort((a, b) => a.minute - b.minute).map((r) => ({
            minute: r.minute, n: r.n, okPct: r.n ? (100 * r.ok) / r.n : 0,
            writeMs: summarise(r.ms), levels: [...r.levels],
            textMs: summarise(r.textMs), dropped: r.dropped,
        }));
    })();

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
            // The longest wait any heartbeat in the span reported — the thing a
            // silence "while the app believed it was playing" was stuck behind.
            let stuck = null;
            for (const t of ticks) {
                if (t.at < a || t.at > b || !Array.isArray(t.doing)) continue;
                for (const d of t.doing) if (!stuck || d.ms > stuck.ms) stuck = d;
            }
            const backoff = ticks.some((t) => t.at >= a && t.at <= b && t.imageBackoffMs);
            // What the app believed by the END of the silence. A pipeline that
            // stalls keeps saying "playing"; an app that STOPPED says so, and
            // only the second one can be an unexplained stop.
            const within = ticks.filter((t) => t.at >= a && t.at <= b);
            const endedPlaying = within.length ? !!within[within.length - 1].playing : !!playing;
            gaps.push({ fromMs: a, toMs: b, ms: b - a, kind, playing: !!playing, endedPlaying,
                ...(stuck ? { stuck } : {}), ...(backoff ? { backoff: true } : {}),
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
        // Inside the silence, not on its edge: a reload at the very end is the
        // page coming back AFTER a silence it did not cause.
        const reloaded = allMarks.some(
            (m) => m.name === "page-reloaded" && m.at > fromMs + 2000 && m.at < toMs - 2000);
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

    // Ahead of everything about size and pacing, because if this is true then
    // every one of those numbers is describing payloads the app never sends.
    const rv = out.realVsProbe;
    if (rv && rv.probeOkPct >= 80 && rv.frameOkPct <= 20) {
        f.unshift(
            `The sweep's payloads land (${rv.probeOkPct.toFixed(0)}% of ${rv.probeN}) and the ` +
            `app's own frames do not (${rv.frameOkPct.toFixed(0)}% of ${rv.frameN}` +
            `${rv.frameKb ? ` at ${rv.frameKb.toFixed(0)}KB` : ""}). Both go to the same ` +
            `container over the same link, and the sweep covers sizes either side of the ` +
            `frame — so this is neither the link, the size, nor the pacing. It is how the ` +
            `frame is ENCODED` +
            (rv.formats.length ? ` (${rv.formats.join(", ")})` : "") +
            `. Run the format probe: it sends one picture encoded three ways and reports ` +
            `which the glasses accept.`,
        );
    }

    // Every image rejected, instantly, while text kept landing. That is not a
    // link and no amount of pacing or payload work touches it: the glasses have
    // no image container to put anything in.
    const fr = out.failureReasons;
    if (fr && fr.total >= 5 && out.counts.imagesSent === 0) {
        const named = Object.entries(fr.byReason).sort((a, b) => b[1] - a[1]);
        const local = ["imageException", "imageToGray4Failed", "imageSizeInvalid"];
        const instant = fr.instantPct > 80;
        const refused = named.some(([k]) => local.includes(k));
        f.unshift(
            `EVERY image failed (${fr.total}) and none succeeded, while text ` +
            `${ok(texts).length ? `kept landing (${ok(texts).length} sent)` : "was not tried"}. ` +
            `Reasons: ${named.map(([k, n]) => `${k} x${n}`).join(", ")}.` +
            (instant || refused
                ? ` These are refusals, not failed transmissions — ${instant
                    ? `${fr.instantPct.toFixed(0)}% took under a millisecond, so nothing was `
                    : "the SDK answers them before the radio is touched, so nothing was "}` +
                  `sent. The image CONTAINER is gone; the link is fine. Re-declare the ` +
                  `containers, and look at what tore them down — a navigation, a reload, or ` +
                  `the host ending the feature.`
                : ""),
        );
    }

    // The glasses' own "worn" flag is NOT evidence. A tester wore them for a
    // whole session while the host reported `isWearing: false` for most of it,
    // phone asleep — so a finding built on it would have blamed the headset for
    // a freeze that happened on someone's face. The split stays in the report
    // as a raw table; it is not used to explain anything.

    // Failures that line up with Android throttling the WebView — the phone
    // asleep — are the leading suspect, and this says whether they do.
    const th = out.throttling;
    if (th && th.throttled.images >= 3 && th.onTime.images >= 3 &&
        th.throttled.imageOkPct != null && th.onTime.imageOkPct != null) {
        const gapPct = th.onTime.imageOkPct - th.throttled.imageOkPct;
        f.push(gapPct > 30
            ? `Images fail while the phone is ASLEEP: ${th.throttled.imageOkPct.toFixed(0)}% delivered ` +
              `while Android was throttling the app (heartbeat up to ${Math.round(th.maxLagMs / 1000)}s late), ` +
              `against ${th.onTime.imageOkPct.toFixed(0)}% with timers on time. Text: ` +
              `${th.throttled.textOkPct == null ? "—" : th.throttled.textOkPct.toFixed(0) + "%"} vs ` +
              `${th.onTime.textOkPct == null ? "—" : th.onTime.textOkPct.toFixed(0) + "%"}.` +
              (th.keepAlivePausedBeats
                  ? ` The silent-audio keep-alive was PAUSED on ${th.keepAlivePausedBeats} heartbeat(s) while ` +
                    `playing, so the thing meant to stop the throttling was not running.`
                  : "")
            : `Throttling does not explain the failures: ${th.throttled.imageOkPct.toFixed(0)}% of images ` +
              `delivered while the phone was asleep, ${th.onTime.imageOkPct.toFixed(0)}% with it awake.`);
    } else if (th && th.lateBeats && th.onTime.images === 0 && th.throttled.images >= 3) {
        f.push(`Every measured write happened while Android was throttling the app (heartbeat up to ` +
            `${Math.round(th.maxLagMs / 1000)}s late) — there is no awake period to compare against.`);
    }

    // Paused by the host while the wearer was still watching.
    // Not the ones the app deliberately ignored: raising the contextual menu
    // hands the foreground back on the way out, and counting those said the app
    // "PAUSED 4x while playing" in a session where it had paused none.
    const hostExits = (out.keyEvents || []).filter(
        (m) => m.name === "host-foreground-exit" && m.wasPlaying && !m.ignored);
    const userPlays = (out.keyEvents || []).filter((m) => m.name === "user-play" && m.wasBackgroundPaused);
    if (hostExits.length) {
        f.push(`The glasses host told the app it had lost the foreground ${hostExits.length}x while playing, ` +
            `and each time the app PAUSED. ` +
            (userPlays.length
                ? `${userPlays.length} of those had to be resumed by hand. `
                : "") +
            `If this lines up with the phone sleeping rather than with leaving the app, pausing on it is ` +
            `wrong for a glasses app.`);
    }

    // What the locked sweep says about the throughput explanation — in all
    // three directions, since two of them rule it out.
    const ls = out.lockedSweep;
    if (ls && ls.rows.reduce((t, r) => t + r.n, 0) >= 6) {
        const all = ls.rows.reduce((t, r) => t + r.n, 0);
        const okAll = ls.rows.reduce((t, r) => t + (r.successPct / 100) * r.n, 0);
        if (ls.largestLandedKb != null && ls.smallestFailedKb != null &&
            ls.largestLandedKb < ls.smallestFailedKb) {
            // Buckets are 2 KB wide; when the delivered and failed ones touch,
            // "up to 20 KB delivered, from 20 KB failed" contradicted itself.
            const edge = ls.largestLandedKb + 2 === ls.smallestFailedKb
                ? `payloads under ${ls.smallestFailedKb}KB were mostly delivered and from ${ls.smallestFailedKb}KB mostly failed`
                : `payloads up to ${ls.largestLandedKb + 2}KB were mostly delivered and from ${ls.smallestFailedKb}KB mostly failed`;
            f.unshift(`WITH THE PHONE LOCKED, SMALL PICTURES STILL LAND: ${edge}. ` +
                `So the glasses app still takes pictures while locked; the larger ones did not finish in ` +
                `time. Smaller, more compressible pictures are what gets through.`);
        } else if (okAll / all <= 0.1) {
            f.unshift(`With the phone locked, even the SMALLEST payloads failed (${Math.round(100 * okAll / all)}% ` +
                `of ${all} delivered). This is not the link slowing down: the glasses app stops taking ` +
                `pictures at all while locked, and a smaller picture will not help.`);
        } else if (okAll / all >= 0.9) {
            const slowest = ls.rows.reduce((m, r) => Math.max(m, r.writeMs.p50 || 0), 0);
            const froze = out.stalls.some((st) => st.ongoing && st.failures >= 5);
            f.unshift(`The locked sweep delivered every size (${Math.round(100 * okAll / all)}% of ${all}, ` +
                `slowest p50 ${Math.round(slowest)}ms) — the link did NOT slow down during this sweep. ` +
                `Being locked does not by itself slow it; when it does slow, something else is also ` +
                `involved. ` +
                (froze
                    ? `Playback still froze this session, so compare the timeline below against the sweep.`
                    : `(If the phone was not actually locked during the sweep, this result says nothing ` +
                      `about locking.)`));
        }
    }

    // Did dropping to lighter pictures keep them coming?
    const bq = out.byQuality;
    const downs = (out.keyEvents || []).filter((m) => m.name === "picture-quality" &&
        ["lighter", "lightest"].includes(m.to) && !/probe/.test(m.why || ""));
    if (bq && downs.length) {
        const full = bq.find((q) => q.quality === "full");
        const light = bq.filter((q) => q.quality !== "full");
        const lightN = light.reduce((t, q) => t + q.n, 0);
        const lightOk = light.reduce((t, q) => t + (q.okPct / 100) * q.n, 0);
        // A verdict needs frames to base it on. One lighter frame, sent on a
        // link seconds from dropping, produced "even lighter pictures are not
        // getting through; it is not only the link slowing".
        const MIN_LIGHT = 5;
        // Whether subtitles slowed too is what separates "the whole link got
        // slower than pictures can shrink" from "something about pictures". The
        // old sentence asserted the second from picture numbers alone.
        const lighterVerdict = () => {
            const tl = out.timeline || [];
            const fullMin = tl.filter((r) => r.levels.length && r.levels.every((q) => q === "full") && r.textMs.n);
            const lightMin = tl.filter((r) => r.levels.some((q) => q !== "full") && r.textMs.n);
            if (!fullMin.length || !lightMin.length) {
                return "so even lighter pictures struggled; there are no subtitle timings to say whether the whole link slowed.";
            }
            const med = (xs) => { const v = [...xs].sort((a, b) => a - b); return v[v.length >> 1]; };
            const before = med(fullMin.map((r) => r.textMs.p50));
            const during = med(lightMin.map((r) => r.textMs.p50));
            const factor = during / Math.max(1, before);
            return factor >= 2
                ? `so even lighter pictures struggled — and subtitles slowed ${factor.toFixed(1)}x too ` +
                  `(${Math.round(before)}ms -> ${Math.round(during)}ms), so the whole link slowed further ` +
                  `than these pictures shrink. A smaller level would help.`
                : `so even lighter pictures struggled, while subtitles did NOT slow ` +
                  `(${Math.round(before)}ms -> ${Math.round(during)}ms). The link carries small writes fine — ` +
                  `this is about pictures specifically, and shrinking them further may not help.`;
        };
        f.push(`Pictures were made lighter ${downs.length}x when sends slowed or failed. At the lighter ` +
            `levels ${Math.round((100 * lightOk) / Math.max(1, lightN))}% of ${lightN} were delivered` +
            (full ? `, against ${full.okPct.toFixed(0)}% of ${full.n} at full` : "") +
            ` — ${lightN < MIN_LIGHT
                ? `too few lighter frames to say whether it helped (need ${MIN_LIGHT}).`
                : lightOk / lightN >= 0.8
                    ? "so the ladder is doing its job."
                    : lighterVerdict()}`);
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
        // Say what the difference could be only as far as this session's own
        // data allows. The old wording blamed "whatever else playback is doing
        // while the write is in flight" — in a session whose contention table
        // showed no write overlapping any other work at all.
        const c0 = out.contention;
        const noOverlap = c0 && c0.contended.n === 0;
        f.push(`Real frames cost ${y.ratio.toFixed(1)}x what the synthetic sweep predicts for their file size: ` +
            `${Math.round(y.actualMs)}ms against ${Math.round(y.predictedMs)}ms at ` +
            `${y.realKb.toFixed(0)}KB (${Math.round(y.fixedMs)}ms fixed + ${y.perKbMs.toFixed(0)}ms/KB). ` +
            (noOverlap
                ? `No real frame's write overlapped a fetch or a decode, so it is not other work in ` +
                  `flight. File size is not air size — the glasses app re-encodes and compresses each ` +
                  `picture (F-049) — so the likely difference is that real pictures compress worse ` +
                  `than sweep noise of the same file size. Unconfirmed; an adb capture would settle it.`
                : `The difference is not explained by file size; see the contention table for whether ` +
                  `other work was running during the writes.`));
    }
    if (out.bySize.length > 1) {
        const lo = out.bySize[0], hi = out.bySize[out.bySize.length - 1];
        // Suppressed when the synthetic comparison has just said the opposite.
        // Both readings are drawn from the same table, and a report that
        // recommends shrinking the image one line after explaining that
        // shrinking it would not help is worse than one that says less.
        // And a RATIO alone is not enough. On a fast link 4ms against 6ms is a
        // 1.5x "scaling" that no wearer could perceive and no change could
        // usefully exploit; the finding has to clear an absolute bar too, or
        // the report spends its first line on noise. 200ms is roughly the
        // point at which a saved write starts mattering against a scene
        // interval measured in seconds.
        const MATERIAL_MS = 200;
        // And the size axis only means anything if the app can actually move
        // along it. Real frames are a FIXED size by construction — an
        // uncompressed 4-bit PNG of fixed dimensions is the same length
        // whatever the picture — so every one of them lands in one bucket and
        // the spread belongs entirely to the synthetic sweep. Worse, the host
        // re-encodes whatever it is handed into its own buffer and compresses
        // that ([[F-049]]), so the bytes counted here are not the bytes
        // transmitted. "Shrink the image" is advice about a lever that is not
        // connected to anything.
        const realBuckets = new Set(real(images).filter((e) => !e.probe && e.bytes)
            .map((e) => Math.floor(e.bytes / 4096) * 4));
        const appCanMove = realBuckets.size > 1;
        if (appCanMove && !sizeIsALie && hi.writeMs.p50 > lo.writeMs.p50 * 1.3 &&
            hi.writeMs.p50 - lo.writeMs.p50 > MATERIAL_MS) {
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
    } else if (r2 && r2.reached >= 5 && r2.yieldPct > 40) {
        f.push(`Retries earn their keep (${r2.yieldPct.toFixed(0)}% of second attempts succeed) — ` +
            `a longer budget may raise delivery further.`);
    }
    if (out.background && out.foreground) {
        const factor = out.background.writeMs.p50 / Math.max(1, out.foreground.writeMs.p50);
        f.push(`Background writes take ${factor.toFixed(1)}x as long as foreground ` +
            `(${Math.round(out.foreground.writeMs.p50)}ms -> ${Math.round(out.background.writeMs.p50)}ms) ` +
            `and succeed ${out.background.successPct.toFixed(0)}% against ${out.foreground.successPct.toFixed(0)}%.`);
    }
    // The picture died and never came back, while text carried on. This is
    // the headline whenever it happens — above gaps, above everything — and it
    // says what recovery was attempted and what the host made of it, because
    // "did the app even try" was unanswerable from the old report.
    const dead = out.stalls.find((st) => st.ongoing && st.failures >= 5);
    const textAfter = dead
        ? ok(texts).filter((e) => e.startedAt >= dead.fromMs).length : 0;
    if (dead && sent > 0 && textAfter > 0) {
        const marks = (session.marks || []).filter((m) => m.at >= dead.fromMs);
        const cutOffAt = marks.find((m) => m.name === "page-reloaded")?.at ?? null;
        const rebuilds = marks.filter((m) => m.name === "page-rebuilt");
        const redeclares = marks.filter((m) => m.name === "containers-repaired");
        const formats = marks.filter((m) => m.name === "image-format-changed");
        const recovery = [];
        if (rebuilds.length) {
            const accepted = rebuilds.filter((m) => m.ok).length;
            recovery.push(`the page was rebuilt ${rebuilds.length}x ` +
                `(${accepted} accepted by the host${accepted ? ", and images still failed after" : ""})`);
        }
        if (redeclares.length) {
            const refused = redeclares.filter((m) => m.result !== 0).length;
            recovery.push(`containers were re-declared ${redeclares.length}x and refused ${refused}x — ` +
                `that is \`createStartUpPageContainer\`, which only works at launch, so none of those ` +
                `could have helped`);
        }
        const backoffs = marks.filter((m) => m.name === "image-backoff");
        if (backoffs.length) {
            recovery.push(`pictures were paused ${backoffs.length}x to let the glasses recover ` +
                `(longest ${Math.max(...backoffs.map((m) => m.ms)) / 1000}s) and still failed when retried`);
        }
        if (formats.length) {
            recovery.push(`the encoding was changed ${formats.length}x (to ` +
                `${formats[formats.length - 1].to}), which cannot fix a format that had already ` +
                `been delivering frames`);
        }
        f.unshift(
            `THE PICTURE STOPPED at ${(dead.fromMs / 1000).toFixed(0)}s and never came back: ` +
            `${dead.failures} image failures in a row over ${(dead.ms / 60000).toFixed(1)} min, ` +
            `after ${sent} frames had been delivered — while text kept landing ` +
            `(${textAfter} lines after the picture died). ` +
            (cutOffAt != null
                ? `The session was then cut off: the app was reloaded at ${Math.round(cutOffAt / 1000)}s, ` +
                  `which is what a dropped connection to the glasses looks like from here — so this may ` +
                  `have been the link failing, not only the picture path. `
                : `Subtitles kept landing to the end, so the link itself stayed up and this is the ` +
                  `picture path failing. `) +
            (recovery.length ? `Recovery: ${recovery.join("; ")}.` : `No recovery was attempted.`) +
            // Where the fault is NOT. With every heartbeat on time the app's
            // JavaScript was running normally, so a picture that takes seconds
            // to be refused has failed inside the glasses host, below anything
            // this app controls — which is the sentence a bug report to the
            // host's makers needs.
            (out.throttling && out.throttling.lateBeats === 0 && out.failedWriteMs?.n
                ? ` The app itself was running normally throughout (0 of ${out.throttling.beats} ` +
                  `heartbeats late), and each refusal took ${Math.round(out.failedWriteMs.p50 / 1000)}s ` +
                  `(p50) to come back — so the glasses host accepted each picture and failed to deliver ` +
                  `it. That is below this app.`
                : ""),
        );
    } else if (out.longestStallMs > 10000) {
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
        // Blame only the silences the app was supposed to be filling. A gap
        // while nothing is playing is someone choosing an episode, and calling
        // that "the pipeline stopping, and it is ours" both accuses the app of
        // a fault it does not have and pads the dead-time total that the
        // headline quotes.
        // A pause the app took ON PURPOSE (backoff) is not the pipeline
        // stopping; it said "it is ours" about exactly that once.
        // Split by what the app believed at the END of the silence, not by
        // whether any heartbeat in it said playing: the last heartbeat before a
        // stop still says playing, which filed a stop under "the pipeline
        // stopped" and a browse under it too.
        const ourIdle = idle.filter((g) => g.endedPlaying && !g.backoff);
        const pausedIdle = idle.filter((g) => g.endedPlaying && g.backoff);
        const benignIdle = idle.filter((g) => !g.endedPlaying);
        if (pausedIdle.length) {
            f.push(`${pausedIdle.length} silence(s) while playing were the app pausing pictures on purpose ` +
                `after repeated failures (backoff), not the pipeline stopping.`);
        }
        if (ourIdle.length) {
            f.splice((stopped.length ? 1 : 0) + (throttled.length ? 1 : 0) + 1, 0,
                `${ourIdle.length} of those: the page kept ticking and still sent nothing ` +
                `WHILE THE APP BELIEVED IT WAS PLAYING — that is the scene pipeline ` +
                `stopping, and it is ours.`);
        }
        // A silence with nothing playing is only harmless if something ASKED
        // playback to stop. A session froze on a wearer's face mid-episode and
        // this called it "browsing, or waiting to be told what to watch".
        const STOPPERS = new Set(["playback-stopped", "playback-ended", "app-paused", "user-pause",
            "glasses-tap", "glasses-double-tap", "glasses-exit-event", "app-cleanup",
            "host-foreground-exit", "session-discarded", "page-reloaded"]);
        // Any idle gap, not only the ones flagged "not playing": the last
        // heartbeat before a stop often still says playing, which put the
        // reported session in the other bucket.
        const beatsBefore = (session.marks || []).filter((m) => m.name === "tick");
        const unexplained = idle.filter((g) => {
            if (!sent || g.endedPlaying) return false;
            // Playback has to have BEEN running. A browse before anything was
            // played — with a preview frame or two on the glasses — was reported
            // as "PLAYBACK STOPPED at 5s and nothing says why".
            const wasPlaying = beatsBefore.some(
                (m) => m.playing && m.at > g.fromMs - 60000 && m.at <= g.fromMs + 2000);
            if (!wasPlaying) return false;
            return !(session.marks || []).some((m) =>
                STOPPERS.has(m.name) && m.at > g.fromMs - 30000 && m.at < g.fromMs + 10000);
        });
        for (const g of unexplained) {
            f.unshift(`PLAYBACK STOPPED at ${Math.round(g.fromMs / 1000)}s and nothing says why: ` +
                `no pause, no end of media, no glasses input, no host event in the 30s before it — ` +
                `and then ${Math.round(g.ms / 1000)}s of silence with the app no longer playing. ` +
                `Pictures had been landing normally until then, so this is playback stopping on its ` +
                `own, which is ours.`);
        }
        const explained = benignIdle.filter((g) => !unexplained.includes(g));
        if (explained.length) {
            const secs = explained.reduce((t, g) => t + g.ms, 0) / 1000;
            f.push(`${secs.toFixed(0)}s of that silence was the app sitting idle with nothing ` +
                `playing (${explained.length} of the gaps) — browsing, or waiting to be told ` +
                `what to watch. Not a fault; discount it before reading the rest.`);
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
    // A picture that died for good outranks every silence: the gap section
    // unshifts its own headline after this one was written, and a 42s pause
    // must not bury four minutes of no picture at all.
    const deadAt = f.findIndex((x) => x.startsWith("THE PICTURE STOPPED"));
    if (deadAt > 0) f.unshift(...f.splice(deadAt, 1));
    return out;
}

/** The report as plain text, so it can be copied out of a WebView. */
export function formatReport(session, a = analyse(session)) {
    const ms = (v) => `${Math.round(v)}ms`;
    const L = [];
    L.push(`Trickplayer BLE session — ${(a.durationMs / 60000).toFixed(1)} min`);
    L.push("=".repeat(58));
    if (session.truncated) {
        L.push("(this session spans a relaunch and its oldest records were dropped " +
            "to fit — the totals below cover what survived, not the whole run)");
    }
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
            // An all-failed bucket has no durations to average, and printing
            // the zero that falls out reads as "instant" — a different fault
            // entirely, and one this report has had to tell apart before.
            const t = b.writeMs.n ? `p50 ${ms(b.writeMs.p50)}` : "no successful write";
            L.push(`  ${String(b.kb).padStart(3)}KB  n=${String(b.n).padStart(4)}  ` +
                `ok ${b.successPct.toFixed(0).padStart(3)}%  ${t}`);
        }
    }
    if (a.byQuality) {
        L.push("");
        L.push("by picture level   (lighter/lightest are sent when the link slows — F-050)");
        for (const q of a.byQuality) {
            L.push(`  ${q.quality.padEnd(9)} n=${String(q.n).padStart(4)}  ` +
                `ok ${q.okPct == null ? "  —" : q.okPct.toFixed(0).padStart(3) + "%"}  ` +
                `${q.writeMs.n ? "p50 " + ms(q.writeMs.p50) : "none landed"}`);
        }
    }
    if (a.lockedSweep) {
        L.push("");
        L.push("LOCKED sweep by payload size   (PNG size; bigger = less compressible = more air time)");
        for (const b of a.lockedSweep.rows) {
            const t = b.writeMs.n ? `p50 ${ms(b.writeMs.p50)}` : "none landed";
            const f = b.failMs.n ? `  failures took p50 ${ms(b.failMs.p50)}` : "";
            L.push(`  ${String(b.kb).padStart(3)}KB  n=${String(b.n).padStart(3)}  ` +
                `ok ${b.successPct.toFixed(0).padStart(3)}%  ${t}${f}`);
        }
    }
    if (a.synthetic) {
        const y = a.synthetic;
        L.push("");
        L.push(`synthetic fit   ${Math.round(y.fixedMs)}ms fixed + ${y.perKbMs.toFixed(1)}ms/KB`);
        L.push(`real frames     ${y.realKb.toFixed(0)}KB -> ${Math.round(y.actualMs)}ms actual ` +
            `vs ${Math.round(y.predictedMs)}ms predicted  (${y.ratio.toFixed(2)}x)`);
    }
    if (a.failureReasons) {
        L.push("");
        L.push(`failed writes  ${a.failureReasons.total}  ` +
            `(${a.failureReasons.instantPct.toFixed(0)}% instant — refused, not sent)`);
        for (const [k, n] of Object.entries(a.failureReasons.byReason)
                .sort((x, y) => y[1] - x[1])) {
            L.push(`  ${String(k).padEnd(20)} x${n}`);
        }
    }
    if (a.failedWriteMs && a.failedWriteMs.n) {
        L.push(`failure took p50 ${ms(a.failedWriteMs.p50)}  p90 ${ms(a.failedWriteMs.p90)}  ` +
            `max ${ms(a.failedWriteMs.max)}`);
    }
    if (a.throttling) {
        const t = a.throttling;
        const fmt = (x) => `${x.images} images ${x.imageOkPct == null ? "—" : x.imageOkPct.toFixed(0) + "% ok"}, ` +
            `${x.texts} lines ${x.textOkPct == null ? "—" : x.textOkPct.toFixed(0) + "% ok"}`;
        L.push("");
        L.push(`timers      ${t.lateBeats}/${t.beats} heartbeats late (>10s), worst ${Math.round(t.maxLagMs / 1000)}s` +
            (t.firstLateAt != null ? `, first at ${Math.round(t.firstLateAt / 1000)}s` : ""));
        L.push(`  on time   ${fmt(t.onTime)}`);
        L.push(`  throttled ${fmt(t.throttled)}`);
        if (t.keepAlivePausedBeats) L.push(`  keep-alive audio paused on ${t.keepAlivePausedBeats} heartbeat(s) while playing`);
    }
    if (a.byWearing) {
        const w = a.byWearing;
        const fmt = (x) => `${x.images} images ${x.imageOkPct == null ? "—" : x.imageOkPct.toFixed(0) + "% ok"}, ` +
            `${x.texts} lines ${x.textOkPct == null ? "—" : x.textOkPct.toFixed(0) + "% ok"}`;
        L.push("");
        L.push(`reported worn      ${fmt(w.on)}`);
        L.push(`reported not worn  ${fmt(w.off)}   (the host's flag — seen wrong with the phone asleep)`);
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
        `longest ${(a.longestStallMs / 1000).toFixed(1)}s` +
        (a.stalls.some((st) => st.ongoing) ? "  — STILL FROZEN when the session ended" : ""));
    L.push(`gaps        ${a.gaps.length} (nothing sent at all), ` +
        `${(a.deadMs / 1000).toFixed(0)}s dead, longest ${(a.longestGapMs / 1000).toFixed(0)}s`);
    for (const g of a.gaps.slice(0, 8)) {
        L.push(`  ${(g.fromMs / 1000).toFixed(0).padStart(5)}s +${(g.ms / 1000).toFixed(0).padStart(4)}s  ` +
            `${g.kind}${g.playing ? ", app thought it was playing" : ""}${g.endedHere ? ", session ended here" : ""}` +
            (g.stuck ? `\n              stuck behind: ${g.stuck.what} (${(g.stuck.ms / 1000).toFixed(0)}s)` : "") +
            (g.backoff ? `\n              images deliberately paused (backoff)` : ""));
    }
    if (a.timeline && a.timeline.length > 1) {
        L.push("");
        L.push("picture sends by minute   (subs = subtitle send p50; ◀ marks a slow or failing minute)");
        for (const r of a.timeline) {
            const slow = r.okPct < 100 || (r.writeMs.n && r.writeMs.p50 > 4000);
            L.push(`  ${String(r.minute).padStart(3)}m  n=${String(r.n).padStart(3)}  ` +
                `ok ${r.okPct.toFixed(0).padStart(3)}%  ` +
                `${r.writeMs.n ? `p50 ${ms(r.writeMs.p50)}  max ${ms(r.writeMs.max)}` : "none landed"}` +
                `${r.textMs.n ? `  subs ${ms(r.textMs.p50)}` : ""}` +
                `${r.dropped ? `  dropped ${r.dropped}` : ""}` +
                `${r.levels.length && !(r.levels.length === 1 && r.levels[0] === "full") ? "  [" + r.levels.join(",") + "]" : ""}` +
                `${slow ? "  ◀" : ""}`);
        }
    }
    if (a.keyEvents && a.keyEvents.length) {
        L.push("");
        L.push("app events (whole session)");
        const shown = a.keyEvents.length > 30
            ? [...a.keyEvents.slice(0, 10), null, ...a.keyEvents.slice(-19)] : a.keyEvents;
        for (const m of shown) {
            if (!m) { L.push(`  … ${a.keyEvents.length - 29} more`); continue; }
            const { at, name, ...rest } = m;
            L.push(`  ${(at / 1000).toFixed(0).padStart(5)}s  ${name}` +
                `${Object.keys(rest).length ? "  " + JSON.stringify(rest).slice(0, 60) : ""}`);
        }
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
