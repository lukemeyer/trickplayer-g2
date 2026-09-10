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
// This build previously walked EVERY frame on a timer. About 81% of them are
// byte-identical to one already shown, so it spent the slowest link of the
// three platforms re-sending pictures the wearer had just seen.

export const MIN_USABLE_SCENES = 8;
export const BLANK_THRESHOLD_PCT = 15;

/** Median frame length. Mean of the two middle values when even (F-034). */
export function medianLength(frames) {
    if (!frames.length) return 0;
    const sorted = frames.map((f) => f.length).slice().sort((a, b) => a - b);
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
        if (frames[i].length === frames[rep].length) dup[i] = true;
        else rep = i;
    }
    return dup;
}

/**
 * @param frames  [{ timestampMs, offset, length }] in file order
 * @param cues    [{ startMs, endMs, text }]
 * @returns [{ frameIndex, startMs, endMs }]
 */
export function buildSceneList(frames, cues, durationMs, opts = {}) {
    if (!frames.length) return [];
    const blankPct = opts.blankThresholdPct ?? BLANK_THRESHOLD_PCT;
    const minUsable = opts.minUsableScenes ?? MIN_USABLE_SCENES;
    const skipSilent = opts.skipSilent !== false;

    const blankFloor = (blankPct / 100) * medianLength(frames);
    const duplicate = lengthRunDuplicates(frames);

    const all = frames.map((_, i) => i);
    const target = Math.min(minUsable, all.length);
    const notBlank = all.filter((i) => frames[i].length >= blankFloor);
    let kept = notBlank.filter((i) => !duplicate[i]);
    // Neither filter may gut a static or oddly-encoded episode.
    if (kept.length < target) kept = notBlank;
    if (kept.length < target) kept = all;

    let built = kept.map((frameIndex, n) => ({
        frameIndex,
        startMs: frames[frameIndex].timestampMs,
        endMs: n + 1 < kept.length ? frames[kept[n + 1]].timestampMs : durationMs,
    }));

    if (skipSilent && cues && cues.length) {
        const withCues = built.filter((sc) =>
            cues.some((c) => c.startMs >= sc.startMs && c.startMs < sc.endMs));
        if (withCues.length >= target) built = withCues;
    }

    return built;
}
