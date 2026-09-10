// @ts-nocheck
const YIELD_EVERY_N_BLOCKS = 200;

function yieldToMain() {
    return new Promise((resolve) => setTimeout(resolve, 0));
}

// Cleaning rules — trickplayer-knowledge findings/F-011 and F-003:
//
//   * HTML tags are stripped. Real Plex sidecars are full of <i>…</i>, and
//     <font color=…> shows up too.
//   * ASS override blocks ({\an8} and friends) are stripped — they leak in
//     from converted tracks and are positioning directives, not dialogue.
//   * A cue with nothing left after cleaning is dropped, not kept as empty.
//   * The byte encoding is sniffed from the BOM, never assumed (F-035).
//
// This happens HERE, at parse time, rather than at display time. It used to
// happen downstream in main.ts's cleanSubText, which meant the parsed cue list
// still carried markup: the local preview rendered it as HTML (so <i> looked
// fine and {\an8} did not), and anything reasoning about cue text saw the
// tags. Cleaning once, at the boundary, is the shared rule.
//
// Lines within a cue are joined with "\n", not "<br>". The platform-neutral
// text is what the rule is about; turning it into markup is a rendering
// choice and belongs at the point of rendering.
//
// Parses in chunks with a yield back to the main thread every N blocks so a
// very large SRT file doesn't freeze the UI while it parses.
/**
 * Decode subtitle bytes, sniffing the byte-order mark.
 *
 * A real Plex server serves UTF-16 sidecars, labelled `text/html` with no
 * charset. Decoding blindly as UTF-8 — which is what this build did — yields a
 * string full of NULs, from which the parser extracts ZERO cues. Silently: the
 * fetch is a 200, the parse succeeds, and the glasses just never show
 * dialogue. See trickplayer-knowledge findings/F-035.
 *
 * Content-Type is deliberately not consulted; the bytes are the only honest
 * signal.
 */
export function decodeSubtitleBytes(buffer) {
    const b = new Uint8Array(buffer);
    if (b.length >= 2 && b[0] === 0xff && b[1] === 0xfe) {
        return new TextDecoder("utf-16le").decode(b.subarray(2));
    }
    if (b.length >= 2 && b[0] === 0xfe && b[1] === 0xff) {
        return new TextDecoder("utf-16be").decode(b.subarray(2));
    }
    if (b.length >= 3 && b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf) {
        return new TextDecoder().decode(b.subarray(3));
    }
    return new TextDecoder().decode(b);
}

export async function parseSubtitles(text, onProgress) {
    const subs = [];
    const cleanText = text
        .replace(/\r\n/g, "\n")
        .replace(/\r/g, "\n");
    const blocks = cleanText.split("\n\n");

    const timeRegex = /(\d{1,2})?:?(\d{2}):(\d{2})[,.](\d{3})/;
    const tagRegex = /<[^>]*>/g;
    const assOverrideRegex = /\{[^}]*\}/g;

    function cleanLine(line) {
        return line
            .replace(assOverrideRegex, "")
            .replace(tagRegex, "")
            .trim();
    }

    function timeToMs(timeStr) {
        if (!timeStr) return 0;
        const match = timeStr.trim().match(timeRegex);
        if (!match) return 0;
        const hours = match[1] ? parseInt(match[1], 10) : 0;
        const minutes = parseInt(match[2], 10);
        const seconds = parseInt(match[3], 10);
        const ms = parseInt(match[4], 10);
        return (hours * 3600 + minutes * 60 + seconds) * 1000 + ms;
    }

    for (let bi = 0; bi < blocks.length; bi++) {
        const block = blocks[bi];
        const lines = block.trim().split("\n");
        const timeLineIndex = lines.findIndex((l) =>
            l.includes("-->"),
        );
        if (timeLineIndex !== -1) {
            const timeLine = lines[timeLineIndex];
            const [startStr, endStr] = timeLine.split("-->");
            const textLines = lines.slice(timeLineIndex + 1);

            const startMs = timeToMs(startStr);
            const endMs = timeToMs(endStr);
            const subText = textLines
                .map(cleanLine)
                .filter((l) => l.length > 0)
                .join("\n");

            // Empty after cleaning => not a cue (F-003).
            if (subText) {
                subs.push({ startMs, endMs, text: subText });
            }
        }

        if (bi % YIELD_EVERY_N_BLOCKS === 0) {
            if (onProgress) onProgress(bi / blocks.length);
            await yieldToMain();
        }
    }
    if (onProgress) onProgress(1);
    return subs;
}
