// @ts-nocheck
//
// The BLE link to the glasses: one queue, one retry policy, one place where
// "the link is flaky" is handled.
//
// This exists as its own file because the link is the least reliable part of
// this product and was the hardest to reason about while it was scattered
// through the scene pipeline. Everything here is pure except the `send`
// functions handed to it, which is what lets `tools/ble-sim.mjs` drive it
// against a modelled link — latency, failures, throws, disconnects and a
// throttled background — without a phone or a pair of glasses.
//
// **The rules it enforces, each of which is a bug that happened:**
//
//  1. *One write at a time.* Concurrent writes corrupt the channel.
//  2. *An op's promise settles exactly once, whatever happens.* A send that
//     throws used to leave its caller awaiting forever, which stalled the whole
//     pipeline rather than dropping one frame.
//  3. *A failed send is not remembered as sent.* Subtitle de-duplication used
//     to record the text before the write, so a failure meant that line was
//     never retried and the glasses kept the previous one indefinitely.
//  4. *Work that is no longer wanted is dropped, not sent.* Pausing or seeking
//     used to leave queued frames to transmit into a screen that had moved on,
//     spending the slowest link in the system on stale pictures.
//  5. *The queue cannot grow without bound.* If the pipeline produces faster
//     than the link drains, the newest image wins and older ones are discarded
//     — a stale frame has no value, and a backlog delays the fresh one.

export const DEFAULTS = {
    /** Retries of one payload inside its own queue slot. */
    maxAttempts: 3,
    retryDelayMs: 350,
    /** Stop retrying past this, so a bad frame cannot starve the text channel. */
    retryBudgetMs: 5000,
    /** A single slow success is clamped before it feeds the pacing average. */
    durationCapMs: 4000,
    /** How many images may wait. Beyond this the oldest are dropped. */
    maxPendingImages: 1,
};

export function createBleTransport(opts = {}) {
    const cfg = { ...DEFAULTS, ...opts };
    const now = cfg.now || (() => Date.now());
    const sleep = cfg.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));

    /**
     * Where telemetry attaches. Null by default and called only through
     * `record`, so the production page pays one null check per operation and
     * nothing else — no allocation, no timestamps it will not use.
     *
     * What it receives is the only thing that can answer "why is this slow":
     * when an op was ENQUEUED against when it STARTED (queue wait) against when
     * it FINISHED (write duration), with the payload size and the link's own
     * account of itself alongside. Aggregates hide exactly the tail that hurts.
     */
    let sink = cfg.onEvent || null;
    const record = (e) => { if (sink) sink(e); };
    let seq = 0;

    let tail = Promise.resolve();
    let depth = 0;
    let generation = 0;

    const stats = {
        imageOk: 0, imageFail: 0, imageDropped: 0,
        textOk: 0, textFail: 0,
        attempts: 0, retries: 0,
        consecutiveImageFailures: 0,
        lastImageOkAt: 0,
    };

    /**
     * Run `fn` when the channel is free.
     *
     * Returns a promise for **this op only** — not for the tail of the queue,
     * which is what the previous version handed back. Awaiting the tail meant a
     * caller waited for everything queued after it as well, and could not tell
     * its own failure from someone else's.
     */
    function enqueue(fn, { generationAtEnqueue = generation, meta = null } = {}) {
        depth++;
        const id = ++seq;
        const enqueuedAt = sink ? now() : 0;
        const depthAtEnqueue = depth;
        let settle;
        const mine = new Promise((resolve) => { settle = resolve; });
        tail = tail.then(async () => {
            const startedAt = sink ? now() : 0;
            // Rule 4: the world moved on while this waited.
            if (generationAtEnqueue !== generation) {
                const r = { ok: false, reason: "superseded" };
                record({ id, ...meta, ...r, enqueuedAt, startedAt, endedAt: startedAt,
                    queuedMs: startedAt - enqueuedAt, durationMs: 0, depthAtEnqueue });
                settle(r);
                return;
            }
            let r;
            try {
                r = await fn();
            } catch (e) {
                // Rule 2: a throw is a result, not a lost promise.
                r = { ok: false, reason: "threw", error: String(e) };
            }
            if (sink) {
                const endedAt = now();
                record({ id, ...meta, ...r, enqueuedAt, startedAt, endedAt,
                    queuedMs: startedAt - enqueuedAt, durationMs: endedAt - startedAt,
                    depthAtEnqueue });
            }
            settle(r);
        }).finally(() => { depth--; });
        return mine;
    }

    /** Everything queued before this is no longer wanted (pause, seek, stop). */
    function abandonQueued() {
        generation++;
        return generation;
    }

    // --- images ---------------------------------------------------------

    // Rule 5: at most `maxPendingImages` waiting, newest wins.
    let pendingImages = [];

    async function sendImage(send, payload, meta = {}) {
        const gen = generation;
        pendingImages.push(meta);
        while (pendingImages.length > cfg.maxPendingImages) {
            pendingImages.shift();
            stats.imageDropped++;
        }
        const mineIsNewest = () => pendingImages[pendingImages.length - 1] === meta;

        const result = await enqueue(async () => {
            if (!mineIsNewest()) return { ok: false, reason: "superseded" };

            const started = now();
            let attempt = 0;
            const tried = [];
            while (attempt < cfg.maxAttempts) {
                attempt++;
                stats.attempts++;
                if (attempt > 1) stats.retries++;
                let ok = false;
                try {
                    ok = (await send(payload)) !== false;
                } catch (e) {
                    ok = false;
                }
                tried.push(ok ? "ok" : "fail");
                if (ok) {
                    const duration = Math.min(now() - started, cfg.durationCapMs);
                    return { ok: true, duration, attempts: attempt, tried };
                }
                // The budget is wall-clock, not a count: each failed attempt can
                // itself take seconds, and the text channel is behind this one.
                if (now() - started >= cfg.retryBudgetMs) break;
                if (attempt < cfg.maxAttempts) await sleep(cfg.retryDelayMs);
            }
            return { ok: false, reason: "failed", attempts: attempt, tried };
        }, { generationAtEnqueue: gen, meta: { kind: "image", bytes: meta?.bytes ?? null, tsMs: meta?.tsMs ?? null } });

        pendingImages = pendingImages.filter((m) => m !== meta);

        if (result.ok) {
            stats.imageOk++;
            stats.consecutiveImageFailures = 0;
            stats.lastImageOkAt = now();
        } else if (result.reason !== "superseded") {
            stats.imageFail++;
            stats.consecutiveImageFailures++;
        }
        return result;
    }

    // --- text -----------------------------------------------------------

    let lastText = null;

    /**
     * Rule 3: the de-duplication key is only updated once the write succeeded.
     * Recording it up front means a dropped line is never retried.
     */
    async function sendText(send, text) {
        const wanted = text || " ";
        if (wanted === lastText) return { ok: true, reason: "duplicate" };

        const result = await enqueue(async () => {
            try {
                const ok = (await send(wanted)) !== false;
                return ok ? { ok: true } : { ok: false, reason: "rejected" };
            } catch (e) {
                return { ok: false, reason: "threw", error: String(e) };
            }
        }, { meta: { kind: "text", bytes: wanted.length, chars: wanted.length } });

        if (result.ok) { lastText = wanted; stats.textOk++; }
        else if (result.reason !== "superseded") stats.textFail++;
        return result;
    }

    /** Forget what is on screen — after a disconnect, it is not what we think. */
    function forgetText() { lastText = null; }

    return {
        enqueue,
        abandonQueued,
        sendImage,
        sendText,
        forgetText,
        get depth() { return depth; },
        get generation() { return generation; },
        stats,
        config: cfg,
        /** Attach or detach telemetry at runtime. Null turns it fully off. */
        setEventSink(fn) { sink = fn || null; },
    };
}
