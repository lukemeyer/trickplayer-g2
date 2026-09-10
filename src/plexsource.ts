// @ts-nocheck
//
// Plex as a media source. See src/source.ts and trickplayer-knowledge/SEAM.md.
//
// Owns everything Plex-shaped: the ranged GETs, the BIF index, the byte
// offsets, the token header. Nothing above this file knows any of it exists.

import { parseTimelineHeader, parseTimelineIndex } from "./timeline";
import { decodeSubtitleBytes, parseSubtitles } from "./subtitles";

export function createPlexSource({ serverUrl, token, timelineRef, subtitleRef }) {
    const indexUrl = `${serverUrl}/library/parts/${timelineRef}/indexes/sd`;

    function capabilities() {
        return {
            // plex.tv authenticates first and discovers servers after.
            needsAddressFirst: false,
            hasServerDiscovery: true,
            hasPlaylists: true,
            hasContinueWatching: true,
            // A BIF index states every frame's byte length, which is what makes
            // F-007 blank filtering and F-036 duplicate detection possible.
            hasFrameSizeHints: true,
            // One frame is one ranged GET, ~13 KB.
            fetchGranularity: "frame",
        };
    }

    async function fetchRange(url, from, to) {
        const res = await fetch(url, {
            headers: { Range: `bytes=${from}-${to}`, "X-Plex-Token": token },
        });
        if (!res.ok && res.status !== 206) {
            throw new Error(`range fetch ${from}-${to} -> HTTP ${res.status}`);
        }
        const buf = await res.arrayBuffer();
        // A proxy in front of the server may ignore Range and return 200 with
        // the whole body. Slice locally rather than trusting the status (F-022).
        if (res.status === 200 && buf.byteLength > to - from + 1) {
            return buf.slice(from, to + 1);
        }
        return buf;
    }

    /**
     * The frame timeline: two small ranged reads, never the track.
     *
     * A 24-minute episode's BIF is 9.5 MB; the index is ~6 KB and the frames
     * are fetched one at a time as they are shown (F-005).
     */
    async function timeline() {
        const headerBuf = await fetchRange(indexUrl, 0, 63);
        const header = parseTimelineHeader(headerBuf);
        const indexBuf = await fetchRange(indexUrl, 0, header.indexByteLength - 1);
        const parsed = parseTimelineIndex(indexBuf);
        // The BIF entry becomes the opaque LOCATOR; its byte length becomes the
        // size hint. Plex is a source that CAN answer "how big is this frame".
        return {
            header,
            frames: parsed.frames.map((f) => ({
                tsMs: f.tsMs,
                sizeHint: f.length,
                locator: { offset: f.offset, length: f.length },
            })),
        };
    }

    /** Unwrapping the locator is this provider's own business (SEAM.md §5). */
    async function frameBytes(frame) {
        const { offset, length } = frame.locator;
        return fetchRange(indexUrl, offset, offset + length - 1);
    }

    async function cues() {
        if (!subtitleRef) return [];
        const clean = subtitleRef.startsWith("/") ? subtitleRef : `/${subtitleRef}`;
        const res = await fetch(`${serverUrl.replace(/\/$/, "")}${clean}`, {
            headers: { "X-Plex-Token": token },
        });
        if (!res.ok) throw new Error(`subtitle fetch -> HTTP ${res.status}`);
        // Bytes then a BOM sniff — never Content-Type. A real Plex server
        // serves UTF-16 sidecars labelled text/html (F-035).
        return parseSubtitles(decodeSubtitleBytes(await res.arrayBuffer()));
    }

    /**
     * One fetch per frame here, so cost really is proportional — unlike a batch
     * source, where three scenes and a hundred cost the same.
     */
    function previewCostBytes(frames, sceneCount) {
        const sizes = frames.map((f) => f.sizeHint).filter((n) => typeof n === "number");
        if (!sizes.length) return null;
        sizes.sort((a, b) => a - b);
        return sizes[sizes.length >> 1] * sceneCount;
    }

    return { capabilities, timeline, frameBytes, cues, previewCostBytes };
}
