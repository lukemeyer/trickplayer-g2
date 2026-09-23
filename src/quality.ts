// @ts-nocheck
//
// How much picture to send, decided by how the link is behaving (F-056).
//
// With the phone locked the Bluetooth link slows, and the glasses host gives
// up on a picture transfer after roughly eight seconds. Measured with a locked
// sweep: payloads up to ~8 KB landed in about half a second, ~10 KB took 3.7s,
// 14-18 KB mostly failed after 8-9s, 20 KB always failed. A normal frame is
// 8-19 KB on the air — right across that cliff. That is why the picture died
// the instant the phone locked while subtitles, a few hundred bytes, carried on.
//
// The app cannot see the phone lock (the host keeps the WebView "visible" and
// its timers run on time). It can see the CONSEQUENCE: a send that fails, or
// takes seconds. So this is a bitrate ladder driven by outcomes, not by a
// lock signal — which also means it helps with any other slow link, for free.
//
//   - a failure, or a success slower than `slowMs` (or the rung's own
//     `slowMs`, which is sooner on the top rung): drop one rung now.
//   - `probeAfter` fast successes in a row on a lower rung: try one rung up.
//   - that probe fails or is slow: drop back, and double how long to wait
//     before probing again (capped). A probe that holds resets the wait.
//
// Pure, so it can be tested without glasses (tools/quality-check.mjs).

/**
 * The rungs, sized from a model of the host that is exact to the byte.
 *
 * What the host does with a picture is now known rather than inferred
 * (trickplayer-lab, docs/METHOD.md): it decodes whatever we hand it, re-encodes
 * the container as a 4-bit BMP stored bottom row first, compresses that with
 * dart_lz4's fast engine, and sends it in 4 KB chunks, each acked before the
 * next. The lab ports that encoder and reproduces the host's output byte for
 * byte, and the air time fits 0.14 s + 0.084 s/KB + 0.044 s per chunk.
 *
 * Two things follow that the old rungs got wrong:
 *
 *  - The encoder's search step grows with every byte it fails to match, so it
 *    decides in the first ~200 bytes — the picture's BOTTOM ROW — whether to
 *    compress at all. A stretched frame whose bottom row is not flat went out
 *    whole, at 17.3 KB, however it was dithered or blocked: on busy frames the
 *    1x2 rung saved nothing. So every frame is now letterboxed at its own
 *    aspect with at least one black row at the bottom (see drawFramePlane in
 *    main.ts), and the blocked rungs compress as they were meant to.
 *  - Bayer 4x4 beats 2x2 at every rung: 1-5% more bytes for a clearly better
 *    picture, and much better worst frames.
 *
 * Predicted over the 44 non-black Tears of Steel frames, confirmed on hardware
 * on 7 of them to within 6 bytes:
 *
 *     rung      blocks   on the air   per frame   bSSIM (worst frame)
 *     full      1x1      13.1 KB      1.39 s      0.990 (0.987)
 *     lighter   1x2       5.7 KB      0.70 s      0.974 (0.960)
 *     lightest  2x2       5.0 KB      0.64 s      0.945 (0.919)
 *
 * Against the old shipping full rung (stretched, Bayer 2x2): 14.9 KB, 1.57 s,
 * 0.986 (0.922). The old 1x2 rung was 11.6 KB on average and 17.3 KB on busy
 * frames.
 *
 * Those figures are for a 2.4:1 film in a 256x128 container. The container is
 * now 256x144 (see GLASSES_IMAGE_HEIGHT in main.ts): the same film costs
 * 13.5 / 5.7 / 5.0 KB, and 16:9 material, now shown at 254x143 rather than
 * 225x127, costs 15.5 / 7.2 / 6.3 KB — which is part of why `full` gives up
 * sooner than the rest.
 *
 * The drop from `full` to `lighter` is taken sooner than the others (its own
 * `slowMs`). The lighter rung costs half the air for a small loss of picture,
 * so waiting for a full frame to crawl past 4 s before giving up on it bought
 * nothing. Full stays the top rung, and the ladder still climbs back to it.
 *
 * `palette` is a set of native levels rather than a count: perceptual 12 was
 * judged indistinguishable from sixteen levels blind on the glasses, and costs
 * 5-12% less. `blockX`/`blockY` are separate because the axes are different
 * mechanisms; see expandBlocks in pixels.ts. `dither: "bayer"` is the 4x4
 * ordered dither in pixels.ts.
 */
export const PICTURE_LADDER = [
    { name: "full", dither: "bayer", palette: "perceptual12", blockX: 1, blockY: 1, slowMs: 3000 },
    { name: "lighter", dither: "bayer", palette: "perceptual12", blockX: 1, blockY: 2 },
    { name: "lightest", dither: "bayer", palette: "perceptual12", blockX: 2, blockY: 2 },
];

export function createQualityController({
    ladder = PICTURE_LADDER,
    slowMs = 4000,
    fastMs = 2500,
    probeAfter = 4,
    maxProbeAfter = 64,
} = {}) {
    let index = 0;
    let successRun = 0;
    let waitBeforeProbe = probeAfter;
    let probing = false;
    /** A rung the wearer pinned in settings, or -1 to follow the link. */
    let pinned = -1;

    return {
        get current() { return ladder[pinned >= 0 ? pinned : index]; },
        /**
         * Nothing left to shrink: on the smallest rung, or pinned. A pinned
         * rung is the floor the wearer chose, so failures there have to reach
         * the image backoff exactly as they would at the bottom of the ladder.
         */
        get atLowest() { return pinned >= 0 || index === ladder.length - 1; },
        get index() { return pinned >= 0 ? pinned : index; },
        get pinned() { return pinned >= 0 ? ladder[pinned].name : null; },
        /** For harnesses: put the ladder on a named rung. */
        force(name) {
            const i = ladder.findIndex((r) => r.name === name);
            if (i >= 0) { index = i; successRun = 0; probing = false; }
            return ladder[index];
        },
        /**
         * Hold one rung whatever the link does, or pass null to follow it
         * again. Following resumes from the top: whatever the ladder had
         * learned before the pin is stale by the time anyone unpins.
         */
        pin(name) {
            const i = name == null ? -1 : ladder.findIndex((r) => r.name === name);
            pinned = i;
            if (i < 0) { index = 0; successRun = 0; probing = false; waitBeforeProbe = probeAfter; }
            return this.current;
        },

        /**
         * Feed one real frame's outcome.
         * @returns a change `{ from, to, why }` when the rung moved, else null.
         */
        onResult(ok, ms) {
            // Pinned: the wearer's choice outranks the link. Nothing moves.
            if (pinned >= 0) return null;
            const from = ladder[index].name;
            // A rung may be quicker to give up than the rest: see `full`.
            const bad = !ok || ms > (ladder[index].slowMs ?? slowMs);

            if (bad) {
                successRun = 0;
                if (probing) waitBeforeProbe = Math.min(waitBeforeProbe * 2, maxProbeAfter);
                probing = false;
                if (index < ladder.length - 1) {
                    index++;
                    return { from, to: ladder[index].name, why: ok ? `slow (${Math.round(ms)}ms)` : "failed" };
                }
                return null;
            }

            // A frame that LANDED counts towards climbing back, whether or not
            // it was quick. Requiring speed meant a link that was merely
            // mediocre could never recover: at the smallest rung sends took
            // 3.7s, never beat the 2.5s "fast" bar, and the picture stayed
            // coarse for the rest of the session with nothing failing.
            if (probing) { probing = false; if (ms <= fastMs) waitBeforeProbe = probeAfter; }
            successRun++;
            if (index > 0 && successRun >= waitBeforeProbe) {
                successRun = 0;
                probing = true;
                index--;
                return { from, to: ladder[index].name, why: `probe after ${waitBeforeProbe} good frames` };
            }
            return null;
        },
    };
}

/**
 * The settings choice, by the name the wearer sees, and the rung it pins.
 * `auto` follows the link.
 */
export const PICTURE_LEVELS = {
    auto: null,
    high: "full",
    standard: "lighter",
    low: "lightest",
};

/** A settings choice to a rung name, or null for "follow the link". */
export function resolvePictureLevel(choice) {
    return PICTURE_LEVELS[choice] ?? null;
}
