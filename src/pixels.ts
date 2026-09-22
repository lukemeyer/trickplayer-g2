// @ts-nocheck
//
// The pixel half of preparing a frame: greyscale, tone, and dither to the 16
// levels the glasses actually show.
//
// **Extracted so it can be timed without a browser.** A hardware session
// reported `prepare` reaching 4040ms at p90 against a 1650ms write, which would
// make the decode the most expensive thing in the pipeline — but `prepare`
// measured a whole promise, covering an image decode, this arithmetic and a PNG
// encode, plus any time the main thread spent doing something else entirely.
// Those are four different problems and the measurement could not tell them
// apart.
//
// This part is pure: ImageData in, ImageData out, no canvas, no DOM. So it can
// be benchmarked in Node (`npm run pixel-bench`) to establish what it SHOULD
// cost, which is what makes the remainder attributable.

/** Ordered dither matrix, normalised at point of use. */
const BAYER_4X4 = [
    [0, 8, 2, 10],
    [12, 4, 14, 6],
    [3, 11, 1, 9],
    [15, 7, 13, 5],
];

/**
 * The 2x2 matrix, which matters for a reason that is not about how it looks.
 *
 * Two pixels share one byte in the 4-bit packed plane, so a pattern with a
 * two-pixel horizontal period repeats at BYTE granularity — the same byte over
 * and over across a smooth region. Error diffusion scatters values and leaves
 * the host's compressor almost nothing to match. The wire payload is what the
 * link spends its time on (F-049), so this is a transport choice before it is
 * a picture one.
 */
const BAYER_2X2 = [
    [0, 2],
    [3, 1],
];

/**
 * Level sets that are not evenly spaced.
 *
 * The display's 16 levels are linear in signal and vision is not: the eye
 * separates two dark tones far better than two bright ones. Dropping to four
 * EVENLY spaced levels therefore spends them where they are least useful and
 * throws away the shadow detail a night scene is made of. The same count,
 * distributed unevenly, keeps the shadows and gives up highlight steps nobody
 * can see.
 *
 * Offered, not chosen. Nothing selects these until they have been measured on
 * hardware — which is what `probeDithers` is for.
 */
export const PALETTES = {
    /** Eight levels, weighted towards the shadows. */
    perceptual8: [0, 1, 3, 5, 7, 9, 12, 15],
    /** Twelve, thinning midtones where neighbouring steps are hardest to tell apart. */
    perceptual12: [0, 1, 2, 3, 5, 7, 9, 11, 12, 13, 14, 15],
};

/** Nearest palette value — what the error-diffusion dithers quantise to. */
function nearestInPalette(palVals, v) {
    let best = palVals[0];
    let bestDist = Math.abs(v - best);
    for (let i = 1; i < palVals.length; i++) {
        const d = Math.abs(v - palVals[i]);
        if (d < bestDist) { bestDist = d; best = palVals[i]; }
    }
    return best;
}

/**
 * Which of two bracketing palette values an ordered threshold picks.
 *
 * The threshold is a position BETWEEN neighbouring levels, so with an uneven
 * palette one threshold spans a wide interval in the highlights and a narrow
 * one in the shadows. That is the point of an uneven palette, not a side
 * effect of it.
 */
function orderedInPalette(palVals, v, threshold) {
    let i = 0;
    while (i < palVals.length - 1 && v > palVals[i + 1]) i++;
    const lo = palVals[i];
    const hi = i + 1 < palVals.length ? palVals[i + 1] : lo;
    const span = (hi - lo) || 1;
    return (v - lo) / span > threshold ? hi : lo;
}

/** The display has 16 grey levels; 255/15 = 17 per step. */
const STEP = 17;
const LEVELS = 15;

const clampLevel = (v) => (v < 0 ? 0 : v > LEVELS ? LEVELS : v);

/**
 * Luminance, tone controls, then quantisation with the chosen dither.
 *
 * Produces the QUANTISED PLANE — one value per pixel, already snapped to a
 * multiple of STEP. Everything downstream wants that plane rather than an RGBA
 * buffer: the encoder writes it straight out, and writing it back into RGBA
 * only to read it again was work nobody needed.
 *
 * @param data  RGBA bytes, read only.
 * @returns Float32Array of w*h quantised values in 0..255.
 */
function quantisePlane(data, w, h, opts = {}) {
    const brightness = opts.brightness ?? 0;
    const contrast = opts.contrast ?? 0;
    const gamma = opts.gamma ?? 1;
    const dither = opts.dither ?? "floyd-steinberg";

    // How many grey levels to quantise to. 16 is everything the display can
    // show; fewer makes a frame far more compressible, and the host compresses
    // what it sends — which, with the phone locked and the link slowed, is the
    // difference between a picture landing and timing out (F-056). The levels
    // chosen are always a subset of the display's 16, evenly spaced.
    const shades = opts.shades ?? 16;
    const step = 255 / (shades - 1);
    const top = shades - 1;
    // An explicit palette overrides the even spacing. Absent — which is every
    // shipping path — nothing below behaves differently from before.
    const palVals = opts.palette ? opts.palette.map((k) => k * STEP) : null;
    const quant = palVals
        ? (v) => nearestInPalette(palVals, v)
        : (v) => {
            let k = Math.round(v / step);
            k = k < 0 ? 0 : k > top ? top : k;
            return k * step;
        };

    const n = w * h;
    const gray = new Float32Array(n);
    const contrastFactor = (259 * (contrast + 255)) / (255 * (259 - contrast));
    const applyGamma = gamma !== 1;
    const invGamma = 1 / gamma;

    for (let i = 0; i < n; i++) {
        const o = i << 2;
        let v = 0.299 * data[o] + 0.587 * data[o + 1] + 0.114 * data[o + 2];
        v += brightness;
        v = contrastFactor * (v - 128) + 128;
        if (applyGamma) v = 255 * Math.pow(v < 0 ? 0 : v / 255, invGamma);
        gray[i] = v < 0 ? 0 : v > 255 ? 255 : v;
    }

    if (dither === "floyd-steinberg") {
        for (let y = 0; y < h; y++) {
            for (let x = 0; x < w; x++) {
                const idx = y * w + x;
                const oldVal = gray[idx];
                const newVal = quant(oldVal);
                gray[idx] = newVal;
                const err = oldVal - newVal;
                if (x + 1 < w) gray[idx + 1] += (err * 7) / 16;
                if (y + 1 < h) {
                    if (x > 0) gray[idx + w - 1] += (err * 3) / 16;
                    gray[idx + w] += (err * 5) / 16;
                    if (x + 1 < w) gray[idx + w + 1] += err / 16;
                }
            }
        }
    } else if (dither === "atkinson") {
        for (let y = 0; y < h; y++) {
            for (let x = 0; x < w; x++) {
                const idx = y * w + x;
                const oldVal = gray[idx];
                const newVal = quant(oldVal);
                gray[idx] = newVal;
                // Atkinson spreads only 3/4 of the error, which is why it looks
                // sparser and holds edges better than Floyd-Steinberg.
                const err = (oldVal - newVal) / 8;
                if (x + 1 < w) gray[idx + 1] += err;
                if (x + 2 < w) gray[idx + 2] += err;
                if (y + 1 < h) {
                    if (x > 0) gray[idx + w - 1] += err;
                    gray[idx + w] += err;
                    if (x + 1 < w) gray[idx + w + 1] += err;
                }
                if (y + 2 < h) gray[idx + 2 * w] += err;
            }
        }
    } else if (dither === "bayer" || dither === "bayer2x2") {
        const two = dither === "bayer2x2";
        const matrix = two ? BAYER_2X2 : BAYER_4X4;
        const mask = two ? 1 : 3;
        const scale = two ? 4 : 16;
        for (let y = 0; y < h; y++) {
            for (let x = 0; x < w; x++) {
                const idx = y * w + x;
                const oldVal = gray[idx];
                const threshold = (matrix[y & mask][x & mask] + 0.5) / scale;
                if (palVals) {
                    gray[idx] = orderedInPalette(palVals, oldVal, threshold);
                    continue;
                }
                const level = Math.floor(oldVal / step);
                const remainder = (oldVal % step) / step;
                gray[idx] = Math.min(255, Math.min(top, remainder > threshold ? level + 1 : level) * step);
            }
        }
    } else {
        for (let i = 0; i < n; i++) {
            gray[i] = quant(gray[i]);
        }
    }

    return gray;
}

/**
 * The plane as LEVELS — 0..15, one byte per pixel.
 *
 * This is the form the glasses actually display and the form the PNG encoder
 * writes, so it is the one the pipeline carries. `level * 17` recovers the
 * 0..255 value, which is exactly how a 4-bit greyscale PNG is defined to scale
 * its samples, so nothing is approximated anywhere along the way.
 */
export function toGlassesLevels(data, w, h, opts = {}) {
    const gray = quantisePlane(data, w, h, opts);
    const out = new Uint8Array(w * h);
    for (let i = 0; i < out.length; i++) {
        out[i] = clampLevel(Math.round(gray[i] / STEP));
    }
    return out;
}

/**
 * The plane written back into the RGBA buffer it came from.
 *
 * Kept because it is what `tools/pixel-bench.mjs` proves byte-identical to the
 * code this replaced, and that proof is the reason any of this can be trusted.
 * The shipping path uses `toGlassesLevels`.
 *
 * @param data  RGBA bytes, modified in place.
 * @returns the same buffer, for chaining.
 */
export function toGlassesGrey(data, w, h, opts = {}) {
    const gray = quantisePlane(data, w, h, opts);
    const n = w * h;
    for (let i = 0; i < n; i++) {
        let v = Math.round(gray[i]);
        v = v < 0 ? 0 : v > 255 ? 255 : v;
        const o = i << 2;
        data[o] = data[o + 1] = data[o + 2] = v;
        data[o + 3] = 255;
    }
    return data;
}

/**
 * Repeat each pixel of a small level plane into a `bx` x `by` rectangle.
 *
 * The cheapest large reduction in what a frame costs to send: a picture drawn
 * at lower resolution and repeated has runs the host's compressor collapses,
 * and it still fills the same 256x128 container, so nothing about the page
 * changes.
 *
 * **The two axes are not the same lever, and they were measured apart.** A
 * vertical repeat makes consecutive PNG scanlines byte-identical, which is a
 * whole-row match for any LZ77-family compressor. A horizontal repeat makes
 * each packed byte a doubled nibble, which only shortens the alphabet. Over 28
 * real frames the vertical half is worth more than the horizontal one:
 *
 *     1x1  5.05 KB      1x2  2.84 KB  (rows)      2x2  1.91 KB
 *                       2x1  3.22 KB  (columns)
 *
 * So halving vertically alone gets most of the way to a 2x2 block while
 * keeping every horizontal pixel, which is why the ladder is anisotropic.
 */
export function expandBlocks(small, sw, sh, bx, by = bx) {
    if (bx === 1 && by === 1) return small;
    const w = sw * bx, h = sh * by;
    const out = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) {
        const row = ((y / by) | 0) * sw;
        for (let x = 0; x < w; x++) out[y * w + x] = small[row + ((x / bx) | 0)];
    }
    return out;
}

/** Every value the glasses can show, for assertions. */
export const GLASSES_LEVELS = Array.from({ length: 16 }, (_, i) => i * STEP);
