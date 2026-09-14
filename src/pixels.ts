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
                const newVal = clampLevel(Math.round(oldVal / STEP)) * STEP;
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
                const newVal = clampLevel(Math.round(oldVal / STEP)) * STEP;
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
    } else if (dither === "bayer") {
        for (let y = 0; y < h; y++) {
            for (let x = 0; x < w; x++) {
                const idx = y * w + x;
                const oldVal = gray[idx];
                const level = Math.floor(oldVal / STEP);
                const remainder = (oldVal % STEP) / STEP;
                const threshold = (BAYER_4X4[y & 3][x & 3] + 0.5) / 16;
                gray[idx] = Math.min(255, (remainder > threshold ? level + 1 : level) * STEP);
            }
        }
    } else {
        for (let i = 0; i < n; i++) {
            gray[i] = clampLevel(Math.round(gray[i] / STEP)) * STEP;
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

/** Every value the glasses can show, for assertions. */
export const GLASSES_LEVELS = Array.from({ length: 16 }, (_, i) => i * STEP);
