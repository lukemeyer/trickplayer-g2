// @ts-nocheck
//
// Scene selection — which frames are worth showing, decided ONCE from the
// parsed index and the cue list. No network, no decode, no DOM, so the
// conformance runner can exercise the shipping code headlessly.
//
// The policy, per trickplayer-knowledge findings:
//
//   F-001  Bin by the SOURCE'S OWN frame timings, not a clock. Every surviving
//          frame is its own scene, so scenes follow the content's real cuts. A
//          scene's window runs to the NEXT KEPT frame, so the time of a skipped
//          duplicate folds into the scene that replaces it and its cues come
//          with it rather than belonging to no scene at all.
//
//   F-036  Duplicates are judged by DECLARED LENGTH alone. Hashing the bytes
//          costs a full-track read (measured: 1815 of 1815 frames, 10.48 MB,
//          10.2 s) which is exactly what range-fetching exists to avoid. The
//          length heuristic found 99.7% of duplicates across three real
//          episodes with one false positive in 6,149 frames.
//
//   F-007  Near-blank frames are judged by compressed byte length against the
//          episode's own median.
//
//   F-009  Floor the filters: a repetitive player beats an empty one.
//
//   F-010  A cue belongs to the window it STARTS in.
//
// Consumes the seam's frame shape — { tsMs, sizeHint, locator } — and reads
// ONLY tsMs and sizeHint. `locator` is the provider's business: a byte range on
// Plex, a sheet and grid cell on a tile-sheet source. See SEAM.md §4.
//
// This build previously walked EVERY frame on a timer. About 81% of them are
// byte-identical to one already shown, so it spent the slowest link of the
// three platforms re-sending pictures the wearer had just seen.

export const MIN_USABLE_SCENES = 8;
export const BLANK_THRESHOLD_PCT = 15;

/** Median size hint. Mean of the two middle values when even (F-034). */
export function medianLength(frames) {
    const sorted = frames
        .map((f) => f.sizeHint)
        .filter((n) => typeof n === "number")
        .sort((a, b) => a - b);
    if (!sorted.length) return 0;
    const mid = sorted.length >> 1;
    return sorted.length % 2 === 0
        ? (sorted[mid - 1] + sorted[mid]) / 2
        : sorted[mid];
}

/**
 * Byte-identical-to-an-earlier-frame, from declared length alone.
 *
 * Each frame is compared to the current run's REPRESENTATIVE, not to its
 * immediate neighbour, so a run survives a frame that merely happens to match
 * the one before it.
 */
export function lengthRunDuplicates(frames) {
    const dup = new Array(frames.length).fill(false);
    let rep = 0;
    for (let i = 1; i < frames.length; i++) {
        const a = frames[i].sizeHint, b = frames[rep].sizeHint;
        if (typeof a === "number" && a === b) dup[i] = true;
        else rep = i;
    }
    return dup;
}

/**
 * @param frames  [{ tsMs, sizeHint, locator }] in file order
 * @param cues    [{ startMs, endMs, text }]
 * @returns [{ frameIndex, startMs, endMs }]
 */
export function buildSceneList(frames, cues, durationMs, opts = {}) {
    if (!frames.length) return [];
    const blankPct = opts.blankThresholdPct ?? BLANK_THRESHOLD_PCT;
    const minUsable = opts.minUsableScenes ?? MIN_USABLE_SCENES;
    const skipSilent = opts.skipSilent !== false;
    // From the provider's capabilities. False means this source has no
    // per-frame byte lengths — a tile-sheet source has none, because a
    // thumbnail is a crop and not a file. Blank filtering and duplicate
    // detection both read that length, so both are SKIPPED, not faked.
    //
    // Decided once, here, rather than by each filter separately noticing a
    // missing hint and disagreeing about what "unavailable" means (SEAM.md §4).
    const hasSizes = opts.hasFrameSizeHints !== false;

    const all = frames.map((_, i) => i);
    const target = Math.min(minUsable, all.length);
    let kept = all;

    if (hasSizes) {
        const blankFloor = (blankPct / 100) * medianLength(frames);
        const duplicate = lengthRunDuplicates(frames);
        const notBlank = all.filter((i) => frames[i].sizeHint >= blankFloor);
        kept = notBlank.filter((i) => !duplicate[i]);
        // Neither filter may gut a static or oddly-encoded episode.
        if (kept.length < target) kept = notBlank;
        if (kept.length < target) kept = all;
    }

    let built = kept.map((frameIndex, n) => ({
        frameIndex,
        startMs: frames[frameIndex].tsMs,
        endMs: n + 1 < kept.length ? frames[kept[n + 1]].tsMs : durationMs,
    }));

    if (skipSilent && cues && cues.length) {
        const withCues = built.filter((sc) =>
            cues.some((c) => c.startMs >= sc.startMs && c.startMs < sc.endMs));
        if (withCues.length >= target) built = withCues;
    }

    return built;
}
