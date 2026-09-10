// @ts-nocheck
//
// Trick-play index parsing, split into two layers:
//
//   parseTimelineIndex(buffer)  pure, synchronous, no DOM. Structure only.
//   parseTimeline(buffer, cb)   the browser layer: adds a Blob and an object
//                               URL per frame. Only for the case where the
//                               whole track is already in memory.
//
// The split exists so the parser can be exercised headlessly against the
// shared conformance corpus (see KNOWLEDGE.md) — `Blob` and
// `URL.createObjectURL` do not exist under Node.
//
// BIF layout: a 64-byte header, then (frameCount + 1) 8-byte entries of
// [timestamp uint32 LE, offset uint32 LE]. The final entry is a sentinel
// whose timestamp is 0xFFFFFFFF and whose offset is EOF.

const MAGIC = [0x89, 0x42, 0x49, 0x46, 0x0d, 0x0a, 0x1a, 0x0a];
const HEADER_BYTES = 64;
const ENTRY_BYTES = 8;

const YIELD_EVERY_N_FRAMES = 40;

function yieldToMain() {
    return new Promise((resolve) => setTimeout(resolve, 0));
}

/**
 * Header fields only. A 64-byte range fetch is enough to call this, which is
 * what lets the caller learn how many index bytes to ask for next.
 */
export function parseTimelineHeader(buffer) {
    const view = new DataView(buffer);
    if (view.byteLength < HEADER_BYTES) {
        throw new Error(
            `BIF header truncated: got ${view.byteLength} bytes, need ${HEADER_BYTES}`,
        );
    }
    for (let i = 0; i < MAGIC.length; i++) {
        if (view.getUint8(i) !== MAGIC[i]) throw new Error("not a BIF file: bad magic bytes");
    }

    const frameCount = view.getUint32(12, true);
    // The multiplier lives at byte 16, and 0 means "use the 1000 ms default"
    // per the BIF spec — it does NOT mean zero. This build used to hardcode
    // 1000, which is correct against every file Plex produces (Plex writes 0)
    // and wrong against any file that states a real multiplier. See
    // trickplayer-knowledge findings/F-004.
    const rawMultiplier = view.getUint32(16, true);
    const multiplierMs = rawMultiplier === 0 ? 1000 : rawMultiplier;

    return {
        version: view.getUint32(8, true),
        frameCount,
        rawMultiplier,
        multiplierMs,
        // header + every entry including the sentinel: exactly what to fetch.
        indexByteLength: HEADER_BYTES + ENTRY_BYTES * (frameCount + 1),
    };
}

/**
 * Parse the index into plain frame records. No DOM, no I/O, no allocation per
 * frame beyond the record itself.
 *
 * @param {ArrayBuffer} buffer  at least the index region; the whole file is fine
 */
export function parseTimelineIndex(buffer) {
    const header = parseTimelineHeader(buffer);
    const view = new DataView(buffer);
    if (view.byteLength < header.indexByteLength) {
        throw new Error(
            `BIF index truncated: got ${view.byteLength} bytes, ` +
            `need ${header.indexByteLength}`,
        );
    }

    const frames = [];
    for (let i = 0; i < header.frameCount; i++) {
        const at = HEADER_BYTES + ENTRY_BYTES * i;
        const tsMs = view.getUint32(at, true) * header.multiplierMs;
        const offset = view.getUint32(at + 4, true);
        // The next entry's offset is this frame's end. For the LAST frame that
        // next entry is the sentinel, whose offset is EOF — which is why the
        // sentinel must be read rather than the buffer length used. Those two
        // are the same number only when the whole file happens to be in
        // memory, which is exactly what this build no longer does. F-004.
        const end = view.getUint32(at + ENTRY_BYTES + 4, true);
        frames.push({ tsMs, offset, length: end - offset });
    }

    return {
        multiplierMs: header.multiplierMs,
        frameCount: header.frameCount,
        indexByteLength: header.indexByteLength,
        frames,
    };
}

/**
 * Browser layer for the whole-track-in-memory case: the same frames, each
 * carrying a Blob and an object URL.
 *
 * The player does NOT use this — it range-fetches frames on demand instead
 * (F-005), because materialising a Blob and an object URL for every frame of
 * a 9.5 MB track allocates hundreds of objects that are never shown and leaks
 * every one of them. Kept for callers that genuinely do hold the whole file.
 *
 * Callers own the returned object URLs and must revoke them.
 */
export async function parseTimeline(buffer, onProgress) {
    const { frames } = parseTimelineIndex(buffer);
    const out = [];

    for (let i = 0; i < frames.length; i++) {
        const f = frames[i];
        const segment = buffer.slice(f.offset, f.offset + f.length);
        const rawBlobData = new Blob([segment], { type: "image/jpeg" });
        out.push({
            timestampMs: f.tsMs,
            offset: f.offset,
            length: f.length,
            url: URL.createObjectURL(rawBlobData),
            rawBlobData,
        });

        if (i % YIELD_EVERY_N_FRAMES === 0) {
            if (onProgress) onProgress(i / frames.length);
            await yieldToMain();
        }
    }
    if (onProgress) onProgress(1);
    return out;
}
