// @ts-nocheck
//
// The media-source seam. See `trickplayer-knowledge/SEAM.md`.
//
// **The one rule: shared code never asks a source-shaped question.** Not "does
// this stream have a key", not "what is this frame's byte offset", not "how big
// is this frame". Each has a different answer per provider and a wrong answer
// for at least one of them.
//
// TypeScript can state the contract properly, unlike the PKJS build where it
// is documentation and duck typing. The shapes below are the same ones Wear
// OS's core/source/ declares.

/**
 * One frame's position in time, and what it costs.
 *
 * `sizeHint` is compressed bytes, or **null if the source cannot say**. Null is
 * an answer, not missing data: it is what makes blank filtering (F-007) and
 * duplicate detection (F-036) *unavailable* on a source rather than merely
 * expensive.
 *
 * `locator` is opaque. Only the provider that created it may read it — a byte
 * range on Plex, a sheet index and grid cell on a tile-sheet source. Reading it
 * outside a provider hard-codes that provider.
 *
 *   FrameRef { tsMs: number, sizeHint: number | null, locator: unknown }
 */

/**
 * What a provider can and cannot do, so callers omit steps rather than
 * discovering emptiness — and so the scene policy turns off filters it has no
 * input for, in one place.
 *
 *   Capabilities {
 *     needsAddressFirst   : boolean   Jellyfin true — the address IS the identity
 *     hasServerDiscovery  : boolean   Plex true; Jellyfin has no account service
 *     hasPlaylists        : boolean
 *     hasContinueWatching : boolean
 *     hasFrameSizeHints   : boolean   false disables blank filtering and dedup
 *     fetchGranularity    : "frame" | "batch"
 *   }
 *
 * `fetchGranularity: "batch"` means one fetch yields many frames — Jellyfin's
 * ~865 KB tile sheet, after which the next 99 thumbnails are free. Such a
 * provider **owns its own cache**; callers ask for one frame and must not know
 * a sheet was fetched. Prefetching one frame ahead is meaningless there, and
 * preview cost is not `n × frameSize`.
 */

/**
 * The interface every provider implements.
 *
 *   capabilities()                  → Capabilities
 *   timeline()                      → Promise<FrameRef[]>
 *   frameBytes(frame)               → Promise<ArrayBuffer>
 *   cues()                          → Promise<Cue[]>
 *   previewCostBytes(frames, n)     → number | null
 *
 * Async here where PKJS is callback-based: the seam specifies what a provider
 * must answer, not how it hands the answer back.
 */
export const SEAM_VERSION = 1;
