// @ts-nocheck
//
// Cue layout — wrap a cue into lines and the lines into pages (F-002).
//
// The shared rule, from trickplayer-knowledge: no word is ever lost. Text that
// does not fit is wrapped, a word too wide for any line is hard-broken across
// lines, and lines that do not fit the screen go onto further pages — never
// clipped and never truncated to an ellipsis.
//
// The measurement is NOT part of the rule. Each platform measures its own
// screen, so the caller says what fits: the conformance runner by character
// count, the glasses by pixel width from the firmware's font metrics. Pure, so
// it runs headlessly under the conformance runner.

/**
 * Character-count measure, as the corpus cases are written. 0 means unlimited.
 */
export function fitsChars(maxChars) {
    return (line) => maxChars <= 0 || [...line].length <= maxChars;
}

/**
 * Greedy word wrap. The cue's own line breaks and runs of whitespace collapse:
 * wrapping is over words. Never returns an empty list.
 *
 * @param text  the cue text
 * @param fits  (line) => whether `line` fits on one line
 */
export function wrapCue(text, fits) {
    const words = String(text).split(/\s+/).filter(Boolean);
    const lines = [];
    let line = "";
    for (const word of words) {
        const joined = line ? `${line} ${word}` : word;
        if (fits(joined)) {
            line = joined;
            continue;
        }
        if (line) lines.push(line);
        line = "";
        if (fits(word)) {
            line = word;
            continue;
        }
        // Wider than a whole line: break it by character, keeping every one.
        let piece = "";
        for (const ch of word) {
            if (piece && !fits(piece + ch)) {
                lines.push(piece);
                piece = "";
            }
            piece += ch;
        }
        line = piece;
    }
    lines.push(line);
    return lines;
}

/**
 * Wrap, but treat the cue's own line breaks as breaks — the variant the
 * players use, as trickplayer-wearos does. An author's break usually separates
 * two speakers ("- Hi" / "- Hello"), and fusing them reads as one line of
 * dialogue. The G2 text container keeps newlines, so the break can be shown.
 */
export function wrapKeepingBreaks(text, fits) {
    return String(text).split("\n").filter((l) => l.trim()).flatMap((l) => wrapCue(l, fits));
}

/** Chunk lines into pages of `maxLines`. 0 means one unlimited page. */
export function paginate(lines, maxLines) {
    if (maxLines <= 0) return [lines];
    const pages = [];
    for (let i = 0; i < lines.length; i += maxLines) {
        pages.push(lines.slice(i, i + maxLines));
    }
    return pages.length ? pages : [[""]];
}

export function layoutCue(text, fits, maxLines) {
    const lines = wrapCue(text, fits);
    return { lines, pages: paginate(lines, maxLines) };
}
