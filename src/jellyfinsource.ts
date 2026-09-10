// @ts-nocheck
//
// Jellyfin as a media source. See src/source.ts and trickplayer-knowledge/SEAM.md.
//
// The seam's whole justification, in one file. Where Plex hands out a byte
// index and one frame is one ranged GET, Jellyfin hands out TILE SHEETS:
//
//   * A thumbnail has NO byte length of its own, so `sizeHint` is null and
//     blank filtering (F-007) and duplicate detection (F-036) are unavailable
//     here — skipped, not faked.
//   * The fetch atom is a sheet of up to 100 thumbnails (~865 KB measured), so
//     one thumbnail costs the whole sheet and the next 99 are free. This
//     provider therefore OWNS A CACHE, which is what fetchGranularity "batch"
//     declares (SEAM.md §5).
//   * Native spacing is 10 s rather than Plex's 2 s.
//
// Callers see none of that. They ask for a frame and get JPEG bytes.

import { decodeSubtitleBytes, parseSubtitles } from "./subtitles";

/**
 * Where thumbnail `i` sits inside its sheet.
 *
 * The final sheet is normally PARTIAL — the measured capture has 73
 * thumbnails in a 100-cell grid — so a reader that assumes full sheets runs
 * off the end of the last image.
 */
export function cropBox(info, i) {
    const perSheet = info.TileWidth * info.TileHeight;
    const cell = i % perSheet;
    return {
        sheet: Math.floor(i / perSheet),
        x: (cell % info.TileWidth) * info.Width,
        y: Math.floor(cell / info.TileWidth) * info.Height,
        w: info.Width,
        h: info.Height,
    };
}

export function createJellyfinSource({
    serverUrl, token, itemId, mediaSourceId, width, trickplay, subtitleIndex,
}) {
    const base = serverUrl.replace(/\/$/, "");
    const headers = { Authorization: `MediaBrowser Token="${token}"` };
    const perSheet = trickplay.TileWidth * trickplay.TileHeight;

    // The provider's own cache. A sheet is expensive and serves up to 100
    // thumbnails, so holding a couple covers any plausible run of scenes.
    const SHEET_CACHE_MAX = 2;
    const sheets = new Map(); // sheet index -> Promise<ImageBitmap>

    function capabilities() {
        return {
            // No account service: the address IS the identity, so it must be
            // known before anything can be authenticated.
            needsAddressFirst: true,
            hasServerDiscovery: false,
            hasPlaylists: true,
            hasContinueWatching: true,
            // A thumbnail is a crop, not a file. There is no byte length to
            // judge blankness or duplication by (F-038).
            hasFrameSizeHints: false,
            // One fetch yields up to 100 thumbnails.
            fetchGranularity: "batch",
        };
    }

    async function sheetBitmap(sheet) {
        const hit = sheets.get(sheet);
        if (hit) return hit;

        const pending = (async () => {
            const res = await fetch(
                `${base}/Videos/${itemId}/Trickplay/${width}/${sheet}.jpg`,
                { headers },
            );
            if (!res.ok) throw new Error(`sheet ${sheet} -> HTTP ${res.status}`);
            return createImageBitmap(await res.blob());
        })();

        sheets.set(sheet, pending);
        while (sheets.size > SHEET_CACHE_MAX) {
            const oldest = sheets.keys().next().value;
            // Release the decoded bitmap rather than waiting for GC — these are
            // several megapixels each.
            sheets.get(oldest).then((b) => b.close && b.close()).catch(() => {});
            sheets.delete(oldest);
        }
        return pending;
    }

    /**
     * The frame timeline, derived from geometry rather than parsed from an
     * index. No network at all — the manifest came with the item metadata.
     */
    async function timeline() {
        const frames = Array.from({ length: trickplay.ThumbnailCount }, (_, i) => ({
            tsMs: i * trickplay.Interval,
            // Not missing data: the honest answer for a source that has none.
            sizeHint: null,
            locator: cropBox(trickplay, i),
        }));
        return { header: null, frames };
    }

    /**
     * One thumbnail's bytes, cropped out of its sheet.
     *
     * The caller cannot tell this apart from Plex's ranged GET, which is the
     * point: it asks for a frame and gets JPEG bytes. Whether that cost a
     * request or a crop of something already held is this file's business.
     */
    async function frameBytes(frame) {
        const box = frame.locator;
        const bitmap = await sheetBitmap(box.sheet);

        const canvas = typeof OffscreenCanvas !== "undefined"
            ? new OffscreenCanvas(box.w, box.h)
            : Object.assign(document.createElement("canvas"), { width: box.w, height: box.h });
        const ctx = canvas.getContext("2d");
        ctx.drawImage(bitmap, box.x, box.y, box.w, box.h, 0, 0, box.w, box.h);

        const blob = canvas.convertToBlob
            ? await canvas.convertToBlob({ type: "image/jpeg", quality: 0.9 })
            : await new Promise((r) => canvas.toBlob(r, "image/jpeg", 0.9));
        return blob.arrayBuffer();
    }

    async function cues() {
        if (subtitleIndex === null || subtitleIndex === undefined) return [];
        const res = await fetch(
            `${base}/Videos/${itemId}/${mediaSourceId}/Subtitles/${subtitleIndex}/Stream.srt`,
            { headers },
        );
        if (!res.ok) throw new Error(`subtitle fetch -> HTTP ${res.status}`);
        // Bytes then a BOM sniff, never Content-Type — this server labels a
        // converted track by its own lights and there is no reason to trust it
        // more than the Plex one that said text/html for UTF-16 (F-035).
        return parseSubtitles(decodeSubtitleBytes(await res.arrayBuffer()));
    }

    /**
     * How many SHEETS a preview would touch, not how many frames.
     *
     * Three scenes and a hundred scenes routinely cost the same here. The
     * sheet size is not known until one is fetched, so this estimates from the
     * measured ~865 KB rather than pretending to precision.
     */
    function previewCostBytes(frames, sceneCount) {
        if (!frames.length) return null;
        const step = Math.max(1, Math.floor(frames.length / Math.max(sceneCount, 1)));
        const touched = new Set();
        for (let i = 0; i < frames.length && touched.size <= 64; i += step) {
            touched.add(frames[i].locator.sheet);
        }
        return touched.size * APPROX_SHEET_BYTES;
    }

    function release() {
        for (const p of sheets.values()) {
            p.then((b) => b.close && b.close()).catch(() => {});
        }
        sheets.clear();
    }

    return { capabilities, timeline, frameBytes, cues, previewCostBytes, release };
}

/** Measured on a real 10x10 sheet of 320x132 thumbnails. */
const APPROX_SHEET_BYTES = 865 * 1024;
