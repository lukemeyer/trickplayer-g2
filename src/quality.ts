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
//   - a failure, or a success slower than `slowMs`: drop one rung now.
//   - `probeAfter` fast successes in a row on a lower rung: try one rung up.
//   - that probe fails or is slow: drop back, and double how long to wait
//     before probing again (capped). A probe that holds resets the wait.
//
// Pure, so it can be tested without glasses (tools/quality-check.mjs).

/**
 * The rungs, timed on hardware rather than modelled.
 *
 * These used to reduce SHADES first — 16 down to 4 — on the reasoning that
 * fewer levels is less to send. Measured on a G2 over BLE, the same frame
 * five ways, that turned out to be the wrong first move:
 *
 *   Floyd-Steinberg, 16 shades   2697 ms   <- the old default
 *   Floyd-Steinberg,  4 shades   1333 ms   <- the old second rung
 *   Bayer 2x2,       16 shades   1117 ms
 *   Bayer 2x2, perceptual 12      820 ms
 *
 * The old second rung threw away twelve grey levels and was STILL slower than
 * keeping all sixteen with an ordered dither. Two pixels share a byte in the
 * packed plane, so a 2x2 pattern repeats at byte granularity and the host's
 * compressor eats it; error diffusion scatters bytes and gives it nothing.
 * So the dither comes first, the palette second, and resolution last.
 *
 * `palette` is a set of native levels rather than a count, because the eye
 * separates dark tones far better than bright ones and evenly spaced levels
 * spend them where they are least useful (see PALETTES in pixels.ts).
 *
 * `blockX`/`blockY` are separate for the same reason the palette is not a
 * count: the two axes are different mechanisms and cost different amounts.
 * See expandBlocks in pixels.ts.
 */
export const PICTURE_LADDER = [
    // TONE IS NO LONGER A RUNG. The ladder used to open with all sixteen even
    // levels and step down to perceptual 12, on the assumption that tone depth
    // was worth paying for. Judged blind on the glasses, three times, nobody
    // could tell them apart — and the same person in the same session decided
    // 8 of 9 comparisons between reduced-level candidates, so the test was
    // discriminating and simply found nothing here to discriminate.
    //
    // The difference is bounded by construction: perceptual 12 drops levels 4,
    // 6, 8 and 10, so a pixel either keeps its level exactly or moves by one
    // step, never more. Over 28 frames that is 23% of pixels, and after the
    // blur the eye applies to a dither it averages 0.06 of a step.
    //
    // Dropping the rung is worth 297ms a frame (1117 against 820, measured) on
    // EVERY frame while the link is healthy — which on this device is frame
    // rate, not load time. Sixteen levels is still offered by hand in settings
    // for anyone who wants it; it is just not what the ladder climbs to.
    //
    // So dither and palette are settled constants, and what remains varies
    // only by resolution.
    { name: "full", palette: "perceptual12", blockX: 1, blockY: 1 },      // 820 ms measured
    // Vertical only: 256x64 repeated down. Resolution is two levers, not one,
    // and they are worth different amounts. Over 28 real frames, deflated as
    // the host sees them:
    //
    //     1x1  5.05 KB       1x2  2.84 KB       2x2  1.91 KB
    //                        2x1  3.22 KB
    //
    // Repeating rows makes whole PNG scanlines byte-identical, which is a
    // single long match; repeating columns only doubles nibbles inside a byte.
    // So 1x2 captures most of a 2x2 block's saving while keeping every
    // horizontal pixel, and it still clears the locked-link cliff (F-056) with
    // room to spare — an estimated 5.9 KB against the 8 KB where transfers
    // start to slow.
    { name: "lighter", palette: "perceptual12", blockX: 1, blockY: 2 },
    // The floor was a 4x4 block — a 64x32 picture — from a locked session where
    // the rung above took 4.7s and landed 47% of the time. That rung was
    // Floyd-Steinberg at four even shades, which the same measurement puts at
    // ~9.1 KB: over the cliff, so something drastic was the only way under it.
    // The rung above is now ~2.8 KB, so this one no longer has to be. 2x4 is
    // within half a kilobyte of 4x4 and keeps twice the horizontal resolution,
    // which makes 4x4 dominated.
    { name: "lightest", palette: "perceptual12", blockX: 2, blockY: 4 },
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

    return {
        get current() { return ladder[index]; },
        /** On the smallest rung: nothing left to shrink. */
        get atLowest() { return index === ladder.length - 1; },
        get index() { return index; },
        /** For harnesses: put the ladder on a named rung. */
        force(name) {
            const i = ladder.findIndex((r) => r.name === name);
            if (i >= 0) { index = i; successRun = 0; probing = false; }
            return ladder[index];
        },

        /**
         * Feed one real frame's outcome.
         * @returns a change `{ from, to, why }` when the rung moved, else null.
         */
        onResult(ok, ms) {
            const from = ladder[index].name;
            const bad = !ok || ms > slowMs;

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
