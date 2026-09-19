// @ts-nocheck
//
// How much picture to send, decided by how the link is behaving (F-050).
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
 */
export const PICTURE_LADDER = [
    { name: "full", shades: 16, block: 1 },                       // 1117 ms measured
    { name: "lighter", palette: "perceptual12", block: 1 },       //  820 ms measured
    { name: "lightest", palette: "perceptual12", block: 2 },      // half resolution as well
    // Added after a locked session where even "lightest" took 4.7s and landed
    // only 47% of the time. It is crude — a 64x32 picture — and it is also a
    // test: if frames this small are still slow, picture size is not what
    // limits a locked link, and shrinking further is pointless.
    { name: "minimal", palette: "perceptual12", block: 4 },
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
