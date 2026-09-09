// @ts-nocheck
//
// Trick-play index parsing, split into two layers:
//
//   parseTimelineIndex(buffer)  pure, synchronous, no DOM. Structure only.
//   parseTimeline(buffer, cb)   the browser layer: adds a Blob and an object
//                               URL per frame, yielding so a large index does
//                               not freeze the UI.
//
// The split exists so the parser can be exercised headlessly against the
// shared conformance corpus (see KNOWLEDGE.md) — `Blob` and
// `URL.createObjectURL` do not exist under Node, and previously they were
// entangled with the parsing, so none of it could be tested off-device.
//
// KNOWN DIVERGENCE from the shared rules — trickplayer-knowledge/PLAN.md §3,
// scheduled as Phase 2 item 11. Both are deliberately left in place here so
// the conformance runner reports them rather than hiding them:
//
//   1. The timestamp multiplier at byte 16 is ignored and 1000 is hardcoded.
//      Real Plex output writes 0 there, which per the BIF spec means "use the
//      1000 ms default" — so this is right by luck, and wrong against any
//      file that states a real multiplier.
//   2. The last frame's length is taken from the buffer's byte length rather
//      than from the sentinel index entry. That is only correct when the whole
//      file has been downloaded, which is itself the thing Phase 2 changes.

const YIELD_EVERY_N_FRAMES = 40;

function yieldToMain() {
    return new Promise((resolve) => setTimeout(resolve, 0));
}

/**
 * Parse the index into plain frame records. No DOM, no I/O, no allocation
 * per frame beyond the record itself.
 *
 * @param {ArrayBuffer} buffer  the index region, or the whole file
 * @returns {{multiplierMs:number, frameCount:number,
 *            frames:{tsMs:number, offset:number, length:number}[]}}
 */
export function parseTimelineIndex(buffer) {
    const view = new DataView(buffer);
    const count = view.getUint32(12, true);

    // See KNOWN DIVERGENCE 1 above.
    const multiplierMs = 1000;

    const frames = [];
    let offset = 64;
    for (let i = 0; i < count; i++) {
        const tsMs = view.getUint32(offset, true) * multiplierMs;
        const start = view.getUint32(offset + 4, true);
        // See KNOWN DIVERGENCE 2 above: the sentinel entry at index `count`
        // holds EOF and is what should terminate the last frame.
        const end =
            i === count - 1
                ? buffer.byteLength
                : view.getUint32(offset + 12, true);
        frames.push({ tsMs, offset: start, length: end - start });
        offset += 8;
    }

    return { multiplierMs, frameCount: count, frames };
}

/**
 * Browser layer: the same frames, each carrying a Blob and an object URL the
 * player can hand straight to an <img> or to the glasses pipeline.
 *
 * Yields to the event loop every N frames so a large index does not freeze
 * the UI while it is built.
 */
export async function parseTimeline(buffer, onProgress) {
    const { frames } = parseTimelineIndex(buffer);
    const out = [];

    for (let i = 0; i < frames.length; i++) {
        const f = frames[i];
        const segment = buffer.slice(f.offset, f.offset + f.length);
        const rawBlobData = new Blob([segment], { type: "image/jpeg" });
        const url = URL.createObjectURL(rawBlobData);
        out.push({ timestampMs: f.tsMs, url, rawBlobData });

        if (i % YIELD_EVERY_N_FRAMES === 0) {
            if (onProgress) onProgress(i / frames.length);
            await yieldToMain();
        }
    }
    if (onProgress) onProgress(1);
    return out;
}
