// @ts-nocheck
//
// Plex as a media source. See src/source.ts and trickplayer-knowledge/SEAM.md.
//
// Owns everything Plex-shaped: the ranged GETs, the BIF index, the byte
// offsets, the token header. Nothing above this file knows any of it exists.

import { parseTimelineHeader, parseTimelineIndex } from "./timeline";
import { decodeSubtitleBytes, parseSubtitles } from "./subtitles";
import * as store from "./store";

/**
 * Embedded tracks extracted recently, so a replay or a resume does not cost the
 * server another full transcode. Raw ASS text, ~35 KB an episode, newest first.
 */
const EMBEDDED_CACHE_KEY = "trickplayer.embeddedSubs";
const EMBEDDED_CACHE_ITEMS = 6;
/** The transcoder's DASH segment length when its manifest does not say, for a progress estimate only. */
const SEGMENT_SECONDS = 8;
/** A slow, CPU-only server can take minutes; past this, give up. */
const EXTRACT_DEADLINE_MS = 6 * 60 * 1000;
/** Once every segment is consumed, how long the subtitle stream may sit idle before it is taken as finished. */
const SUBS_QUIET_MS = 15000;

/** A load that was abandoned on purpose: not an error to show anyone. */
function cancelled() {
    const e = new Error("cancelled");
    e.code = "CANCELLED";
    return e;
}

/** Which embedded tracks are already extracted, by cache id — so a list can show them as ready. */
export async function cachedEmbeddedIds() {
    try {
        return new Set(JSON.parse((await store.readBulk(EMBEDDED_CACHE_KEY)) || "[]").map((e) => e.id));
    } catch (e) { return new Set(); }
}

export function createPlexSource({
    serverUrl, withRoute, token, timelineRef, subtitleRef,
    embedded = null, clientId = "trickplayer", product = "Trickplayer", durationMs = null,
}) {
    // Every request goes through the account's route, so an address that stops
    // answering mid-episode is raced away from instead of hanging each frame.
    // A bare `serverUrl` still works — the conformance runner has no race.
    const route = withRoute || ((request) => request(serverUrl, fetch));
    const tokenNow = () => (typeof token === "function" ? token() : token);
    const indexPath = `/library/parts/${timelineRef}/indexes/sd`;

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

    async function fetchRange(path, from, to) {
        const res = await route((base, fetchFn) => fetchFn(`${base.replace(/\/$/, "")}${path}`, {
            headers: { Range: `bytes=${from}-${to}`, "X-Plex-Token": tokenNow() },
        }));
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
        const headerBuf = await fetchRange(indexPath, 0, 63);
        const header = parseTimelineHeader(headerBuf);
        const indexBuf = await fetchRange(indexPath, 0, header.indexByteLength - 1);
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
        return fetchRange(indexPath, offset, offset + length - 1);
    }

    async function cues(onProgress) {
        if (!subtitleRef) return embedded ? embeddedCues(onProgress) : [];
        const clean = subtitleRef.startsWith("/") ? subtitleRef : `/${subtitleRef}`;
        const res = await route((base, fetchFn) => fetchFn(`${base.replace(/\/$/, "")}${clean}`, {
            headers: { "X-Plex-Token": tokenNow() },
        }));
        if (res.status === 404) {
            // Plex lists the sidecar but it is gone from disk: moved or deleted
            // since the library was last scanned. The file's own track, if it
            // has one, is the other way to the same words.
            if (embedded) {
                console.warn(`[plex] listed subtitle file is missing (404); reading the track inside the file instead`);
                return embeddedCues(onProgress);
            }
            const missing = new Error("Plex lists a subtitle file for this item, but the file is missing from the server. Refresh the item's metadata in Plex, then try again.");
            missing.code = "SUBS_MISSING";
            throw missing;
        }
        if (!res.ok) throw new Error(`subtitle fetch -> HTTP ${res.status}`);
        // Bytes then a BOM sniff — never Content-Type. A real Plex server
        // serves UTF-16 sidecars labelled text/html (F-035).
        return parseSubtitles(decodeSubtitleBytes(await res.arrayBuffer()));
    }

    /**
     * An EMBEDDED track, extracted by the server's transcoder (F-023).
     *
     * `/library/streams/{id}` is 501 for a track inside the file, but the
     * transcoder's `/subtitles` stream delivers the whole of it as ASS — once
     * the session's video AND audio have been consumed. It holds subtitle
     * output back until both catch up, and a segment counts as consumed when
     * it is REQUESTED: so one byte of every segment of both is asked for.
     * Measured: a 22-minute episode's 435 cues in 11 s from Node, ~35 s from
     * a phone, with ~500 bytes of segment data.
     *
     * The cost is the server's: one full transcode it throws away. Hence the
     * cache, and the session is always stopped.
     *
     * The track is the one SELECTED for this item in Plex. The transcoder
     * ignores a `subtitleStreamID` in the query, and changing the selection is
     * a write to the user's library, which this app does not make.
     */
    async function embeddedCues(onProgress) {
        const cacheId = embedded.cacheId;
        const cached = await readCache(cacheId);
        if (cached) {
            console.log(`[plex] embedded subtitles from cache (${cacheId})`);
            return parseSubtitles(cached);
        }
        const text = await extractEmbedded(onProgress);
        const subs = await parseSubtitles(text);
        if (!subs.length) {
            throw new Error("Plex sent no subtitles from the file. Check that a subtitle track is selected for this item in Plex.");
        }
        await writeCache(cacheId, text);
        return subs;
    }

    /**
     * Abandon whatever this source is still doing: the engine calls this when
     * the wearer stops, or picks something else, mid-load. An extraction left
     * running kept a server transcode busy for minutes — slowing the item
     * chosen next — and then reported its timeout under that item.
     */
    let released = false;
    let cancelExtract = null;
    function release() {
        released = true;
        if (cancelExtract) cancelExtract();
    }

    async function extractEmbedded(onProgress) {
        if (released) throw cancelled();
        // The route, raced once; the long requests below cannot go through the
        // account's 12-second request deadline.
        const base = (await route(async (b) => b)).replace(/\/$/, "");
        const auth = { "X-Plex-Token": tokenNow() };
        const deadline = new AbortController();
        const timer = setTimeout(() => deadline.abort(), EXTRACT_DEADLINE_MS);
        cancelExtract = () => deadline.abort();
        const session = `trickplayer-${Math.random().toString(36).slice(2, 10)}`;
        const t0 = Date.now();
        let q = null;
        let manifest = "";
        try {
            // The video is never looked at — one byte of each segment is
            // read — so the cheapest session for the SERVER is the one that
            // copies the video rather than re-encoding it. Measured: Futurama
            // (HEVC) 3.8 s copied against 10.3 s at 320x180; The 100 (H.264)
            // 78 s against 142 s. The profile has to say HEVC plays, or the
            // server re-encodes it at full size, which is slower than either.
            // If the server will not copy, fall back to the smallest picture
            // it will make: below a file's own minimum bandwidth, /decision
            // and /start answer 400.
            const COPY = {
                videoResolution: "3840x2160", maxVideoBitrate: "200000", videoQuality: "100",
                "X-Plex-Client-Profile-Extra":
                    "append-transcode-target-codec(type=videoProfile&context=streaming&protocol=dash&videoCodec=hevc)" +
                    "+add-limitation(scope=videoCodec&scopeName=hevc&type=upperBound&name=video.bitDepth&value=10)",
            };
            const SMALL = (kbps) => ({ videoResolution: "320x180", maxVideoBitrate: kbps });
            for (const shape of [COPY, SMALL("300"), SMALL("1000"), SMALL("2000")]) {
                const params = new URLSearchParams({
                    path: `/library/metadata/${embedded.ratingKey}`, mediaIndex: "0", partIndex: "0",
                    protocol: "dash", fastSeek: "1", directPlay: "0", directStream: "1", directStreamAudio: "1",
                    location: "lan", subtitles: "auto", hasMDE: "1", autoAdjustSubtitle: "1",
                    "X-Plex-Incomplete-Segments": "1", session, offset: "0",
                    ...shape,
                    "X-Plex-Session-Identifier": session,
                    // In the query rather than as headers, as Plex's own web
                    // client sends them. The transcoder picks its client
                    // profile from the platform, and without one /decision is a
                    // 400. The token stays a header (F-021).
                    "X-Plex-Client-Identifier": clientId, "X-Plex-Product": product, "X-Plex-Platform": "Chrome",
                });
                const d = await fetch(`${base}/video/:/transcode/universal/decision?${params}`, {
                    headers: { ...auth, Accept: "application/json" }, signal: deadline.signal,
                });
                // A copy is only worth having if the server will actually copy.
                // Offered HEVC it cannot copy (a 10-bit 1080p file, measured),
                // it RE-ENCODES to full-size HEVC in 1-second segments: five
                // times the requests and the heaviest session it can run. The
                // small re-encode beats that.
                const decided = d.ok ? (await d.json().catch(() => null))?.MediaContainer?.Metadata?.[0]
                    ?.Media?.[0]?.Part?.[0]?.Stream || [] : [];
                // The subtitles only come out of /subtitles when the server is
                // CONVERTING them into their own segments. Burned into the
                // picture, or copied as they are, the stream stays empty — say
                // so now rather than after every segment has been asked for.
                const subDecision = decided.find((st) => st.streamType === 3);
                if (d.ok && !(subDecision?.decision === "transcode" && /subs/.test(subDecision?.location || ""))) {
                    await stopSession(base, session, auth);
                    throw new Error(`Plex won't send this item's subtitles as text (it would ${subDecision?.decision === "burn" ? "burn them into the picture" : subDecision ? subDecision.decision + " them" : "leave them out"}).`);
                }
                if (d.ok && shape === COPY) {
                    const video = decided.find((st) => st.streamType === 1);
                    if (video?.decision !== "copy") {
                        console.log(`[plex] embedded subtitles: the server would re-encode the video (${video?.codec} ${video?.width}x${video?.height}); using the small re-encode`);
                        await stopSession(base, session, auth);
                        continue;
                    }
                }
                const start = d.ok && await fetch(`${base}/video/:/transcode/universal/start.mpd?${params}`, {
                    headers: auth, signal: deadline.signal,
                });
                if (start && start.ok) { q = params; manifest = await start.text(); break; }
                await stopSession(base, session, auth);
            }
            if (!q) throw new Error("Plex would not start a transcode to read this item's subtitles");

            // Read as it arrives, rather than waiting for the response to end:
            // the server does not always close it after the last cue.
            let finished = false;
            const subsCtl = new AbortController();
            const onDeadlineSubs = () => subsCtl.abort();
            deadline.signal.addEventListener("abort", onDeadlineSubs);
            const chunks = [];
            let lastChunkAt = Date.now();
            const subsP = fetch(`${base}/video/:/transcode/universal/subtitles?${q}`, {
                headers: auth, signal: subsCtl.signal,
            }).then(async (res) => {
                if (!res.ok) throw new Error(`embedded subtitles -> HTTP ${res.status}`);
                const reader = res.body.getReader();
                try {
                    for (;;) {
                        const { done, value } = await reader.read();
                        if (done) break;
                        chunks.push(value);
                        lastChunkAt = Date.now();
                    }
                } catch (e) {
                    // Hung up on deliberately, below: what arrived is the track.
                    if (!subsCtl.signal.aborted || deadline.signal.aborted) throw e;
                }
            }).finally(() => { finished = true; });
            subsP.catch(() => {});

            // Ask for each segment of both streams; one chunk of each is enough.
            // Segment length is the manifest's: 8 s for a re-encode, 5 s for a
            // copy on this server. For the progress bar only.
            const tpl = /<SegmentTemplate[^>]*?timescale="(\d+)"[^>]*?duration="(\d+)"/.exec(manifest);
            const segSeconds = tpl ? Number(tpl[2]) / Number(tpl[1]) : SEGMENT_SECONDS;
            const expected = durationMs ? Math.ceil(durationMs / 1000 / segSeconds) : null;
            let pulled = 0;
            // One BYTE of each segment. The server counts a segment as
            // consumed when it is asked for, and honours Range on segments
            // (206, `bytes 0-0/84340`), so a whole episode's track is
            // released for ~500 bytes of segment data. Reading the first chunk
            // and aborting instead cost ~6 MB from a phone: whatever arrived
            // before the abort landed.
            const consume = async (stream, i) => {
                const r = await fetch(`${base}/video/:/transcode/universal/session/${session}/${stream}/${i}.m4s`, {
                    headers: { ...auth, Range: "bytes=0-0" }, signal: deadline.signal,
                });
                if (!r.ok) return false;
                pulled += (await r.arrayBuffer()).byteLength;
                return true;
            };
            for (let i = 0; !finished && !released; i++) {
                // One after the other. Asking for both at once was no faster
                // from a phone, and left the server holding the /subtitles
                // response open after the last cue.
                const more = (await consume("0", i)) && (await consume("1", i));
                if (i % 20 === 0) console.log(`[plex] embedded subtitles: segment ${i}${expected ? ` of ~${expected}` : ""}, ${((Date.now() - t0) / 1000).toFixed(1)}s, ${pulled} B`);
                if (onProgress && expected) onProgress(Math.min(1, i / expected));
                if (!more) break;
            }
            // Every segment is consumed, so every cue has been released. Give
            // the stream a moment to end on its own; if it goes quiet without
            // ending, stop waiting.
            while (!finished && Date.now() - lastChunkAt < SUBS_QUIET_MS) {
                await Promise.race([subsP.catch(() => {}), new Promise((r) => setTimeout(r, 500))]);
            }
            if (!finished) subsCtl.abort();
            await subsP;
            deadline.signal.removeEventListener("abort", onDeadlineSubs);
            const bytes = new Uint8Array(chunks.reduce((n, c) => n + c.byteLength, 0));
            let at = 0;
            for (const c of chunks) { bytes.set(c, at); at += c.byteLength; }
            const text = decodeSubtitleBytes(bytes.buffer);
            console.log(`[plex] embedded subtitles extracted in ${((Date.now() - t0) / 1000).toFixed(1)}s, ${text.length} chars, ${pulled} B of segment data`);
            return text;
        } catch (e) {
            if (released) throw cancelled();
            if (deadline.signal.aborted) throw new Error("Plex took too long to read this item's subtitles");
            throw e;
        } finally {
            clearTimeout(timer);
            cancelExtract = null;
            await stopSession(base, session, auth);
        }
    }

    async function stopSession(base, session, auth) {
        try {
            await fetch(`${base}/video/:/transcode/universal/stop?session=${session}`, { headers: auth });
        } catch (e) { /* the server ends idle sessions on its own */ }
    }

    async function readCache(id) {
        try {
            const all = JSON.parse((await store.readBulk(EMBEDDED_CACHE_KEY)) || "[]");
            return all.find((e) => e.id === id)?.text || null;
        } catch (e) { return null; }
    }

    async function writeCache(id, text) {
        try {
            const all = JSON.parse((await store.readBulk(EMBEDDED_CACHE_KEY)) || "[]");
            const next = [{ id, text }, ...all.filter((e) => e.id !== id)].slice(0, EMBEDDED_CACHE_ITEMS);
            await store.writeBulk(EMBEDDED_CACHE_KEY, JSON.stringify(next));
        } catch (e) {
            console.warn(`[plex] could not cache embedded subtitles: ${e?.message || e}`);
        }
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

    return { capabilities, timeline, frameBytes, cues, previewCostBytes, release };
}
