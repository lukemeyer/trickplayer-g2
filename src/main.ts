// @ts-nocheck
import {
    waitForEvenAppBridge,
    ImageRawDataUpdate,
    OsEventTypeList
} from "@evenrealities/even_hub_sdk";
import { buildSceneList, thinScenes } from "./scenes";
import { createBleTransport } from "./bletransport";
import { toGlassesGrey } from "./pixels";

            // --- UI HOOKS ---
            //
            // The engine drives the glasses. It does not know what a panel is,
            // which is what lets the flow in trickplayer-knowledge/UI.md be
            // rewritten without touching the BLE queue, the scene pipeline or
            // the image path.
            const ui = {
                status: (_text, _state) => {},
                stopped: () => {},
                playing: (_isPlaying) => {},
            };
            export function setUiHooks(h) { Object.assign(ui, h); }

            /** Escape text destined for innerHTML. */
            export function escapeHtml(str) {
                return String(str)
                    .replace(/&/g, "&amp;")
                    .replace(/</g, "&lt;")
                    .replace(/>/g, "&gt;");
            }

            // --- APPLICATION METADATA FOR HEADERS ---
            const CLIENT_ID = "plex-bif-viewer";
            const APP_NAME = "plex-bif-viewer";

            // Silent audio loop to prevent WebView suspension in background/screen-off states
            const silentAudio = new Audio(
                "data:audio/wav;base64,UklGRigAAABXQVZFZm10IBAAAAABAAEARKwAAIhYAQACABAAZGF0YQQAAAAAAA==",
            );
            silentAudio.loop = true;

            // --- APPLICATION RUNTIME STATE ---
            let bifs = [];
            let subtitles = [];
            let durationMs = 0;
            let currentTimeMs = 0;
            let isPlaying = false;
            let lastFrameTime = 0;
            let clockIntervalId = null;
            let pollIntervalId = null;

            // --- BLE SERIAL QUEUE ---
            //
            // The link is the least reliable thing in this product, so its
            // rules live in one testable place: src/bletransport.ts, driven
            // against a modelled link by tools/ble-sim.mjs. Five defects that
            // the inline version had are scenarios there now.
            const ble = createBleTransport();
            function bleQueueDepthNow() { return ble.depth; }

            // --- BLE / DEVICE DIAGNOSTICS ---
            // Tracked so every send can be annotated with the link state, which
            // is what tells transient saturation apart from a real disconnect.
            let deviceConnectType = "unknown";
            let deviceBatteryLevel = null;
            let deviceIsWearing = null;
            let consecutiveImageFailures = 0; // length of the current image freeze
            let lastImageSuccessWall = 0; // performance.now() of last good image
            let imageSuccessCount = 0;
            let imageFailureCount = 0;
            let subtitleFailureCount = 0;
            let statsHeartbeatId = null;

            // --- SCENE PIPELINE STATE ---
            let scenePipelineRunning = false;
            let sceneAbortController = null; // AbortController to cancel pipeline on pause/seek
            let renderDurations = []; // last 5 image render durations (ms)
            let averageRenderDuration = 1500; // moving avg, clamped 1000–8000ms
            let lastSentImageTimestampMs = 0;

            // --- GLASSES SUBTITLE DISPLAY CONSTRAINTS ---
            // The G2 subtitle container is 432×132 px. We merge consecutive SRT
            // cues into one on-screen block so the user has more to read while
            // the (slow) next image transfers — without overflowing the box.
            // Tune these against the simulator / real hardware if text clips.
            const GLASSES_MAX_LINES = 5; // ~26px line height into a 132px tall container
            const GLASSES_CHARS_PER_LINE = 32; // ~432px wide; conservative wrap estimate
            const GLASSES_MAX_BLOCK_GAP_MS = 4000; // don't merge cues separated by a longer silence
            const SUBTITLE_CLEAR_GAP_MS = 1500; // only blank the screen if the next text is this far off
            const IMAGE_SEND_MAX_ATTEMPTS = 3; // retry a failed BLE image send before giving up on the frame
            const IMAGE_SEND_RETRY_DELAY_MS = 350; // backoff between image-send retries
            const IMAGE_SEND_RETRY_BUDGET_MS = 5000; // stop retrying past this so a bad frame can't starve subtitles
            const RENDER_DURATION_CAP_MS = 4000; // clamp a single slow success before it feeds the pacing average

            // --- GLASSES IMAGE SIZE ---
            // Smaller than the 288x144 container max => fewer bytes per BLE
            // transfer, which is bandwidth-bound (~2-3s for ~20KB). Smaller
            // images transfer faster and fail less on the flaky image channel.
            // Lower these further to trade image size for more reliability.
            const GLASSES_IMAGE_WIDTH = 256;
            const GLASSES_IMAGE_HEIGHT = 128;
            const GLASSES_IMAGE_X = Math.round((576 - GLASSES_IMAGE_WIDTH) / 2); // keep centered

            // --- ADVANCED IMAGE PREVIEW STATE ---
            let brightnessValue = 0;
            let contrastValue = 0;
            let gammaValue = 1.0;
            let ditherAlgorithm = "floyd-steinberg";

            // --- EVEN HARDWARE STATE WRAPPERS ---
            let bridgeInstance = null;
            let glassesSubtitleContainer = null;
            let glassesImageContainer = null;

            // --- DOM ELEMENT OBJECT CACHES ---
            const statusDiv = document.getElementById("even-status");
            const indicator = document.getElementById("status-indicator");
            const imgTag = document.getElementById("seek-image");
            const subDiv = document.getElementById("subtitle-overlay");
            const timeline = document.getElementById("timeline");
            const playBtn = document.getElementById("play-btn");
            const timeDisplay = document.getElementById("time-display");

            // --- BIF/SUBTITLE LOAD PROGRESS BAR ---
            const loadProgressContainer = document.getElementById(
                "load-progress-container",
            );
            const loadProgressLabel = document.getElementById(
                "load-progress-label",
            );
            const loadProgressFill = document.getElementById(
                "load-progress-fill",
            );

            function showLoadProgress(label) {
                if (!loadProgressContainer) return;
                loadProgressContainer.classList.remove("hidden");
                setLoadProgress(0, label);
            }

            // Pass fraction=null for an indeterminate bar (unknown total size).
            function setLoadProgress(fraction, label) {
                if (!loadProgressContainer) return;
                if (label && loadProgressLabel)
                    loadProgressLabel.textContent = label;
                if (fraction == null) {
                    loadProgressContainer.classList.add("indeterminate");
                    return;
                }
                loadProgressContainer.classList.remove("indeterminate");
                if (loadProgressFill)
                    loadProgressFill.style.width = `${Math.max(0, Math.min(100, fraction * 100))}%`;
            }

            function hideLoadProgress() {
                if (!loadProgressContainer) return;
                loadProgressContainer.classList.add("hidden");
                loadProgressContainer.classList.remove("indeterminate");
            }

            // Reads a fetch Response's body via a streaming reader so download
            // progress can be reported without buffering blind, and without
            // blocking the main thread on one giant arrayBuffer() resolve.
            async function readResponseWithProgress(res, onProgress) {
                const contentLengthHeader =
                    res.headers.get("Content-Length");
                const total = contentLengthHeader
                    ? parseInt(contentLengthHeader, 10)
                    : 0;

                if (!res.body || !res.body.getReader) {
                    const buf = await res.arrayBuffer();
                    if (onProgress)
                        onProgress(buf.byteLength, total || buf.byteLength);
                    return buf;
                }

                const reader = res.body.getReader();
                const chunks = [];
                let received = 0;
                while (true) {
                    const { done, value } = await reader.read();
                    if (done) break;
                    chunks.push(value);
                    received += value.byteLength;
                    if (onProgress) onProgress(received, total);
                }
                const combined = new Uint8Array(received);
                let writeOffset = 0;
                for (const chunk of chunks) {
                    combined.set(chunk, writeOffset);
                    writeOffset += chunk.byteLength;
                }
                return combined.buffer;
            }

            // --- STATUS BAR ---
            // --- RANGED FETCH + FRAME ASSET CACHE ---
            //
            // The track is not downloaded. A 24-minute episode's index is
            // ~9.5 MB and only ~6 KB of that is the index proper; frames are
            // pulled individually by byte range as they are needed
            // (trickplayer-knowledge findings/F-005).
            //
            // This replaces materialising a Blob and an object URL for every
            // frame up front — hundreds of objects, most never shown, none
            // revoked.
            // The media source. Everything below asks IT for frames and cues
            // rather than reaching for Plex directly, so a second provider is a
            // change to this one line. See src/source.ts.
            let source = null;

            const FRAME_CACHE_MAX = 8;
            const frameCache = new Map(); // frame INDEX -> { blob, url }
            let previewWantedIndex = -1;  // guards the async preview update

            /**
             * Cached { blob, url } for one frame, asking the source on a miss.
             *
             * Keyed by frame index rather than byte offset: an offset is
             * locator data and only the provider may read it. On a batch source
             * the "fetch" may be a crop out of a sheet it already holds, and
             * this layer neither knows nor needs to.
             */
            async function getFrameAssets(index) {
                const hit = frameCache.get(index);
                if (hit) return hit;

                const buf = await source.frameBytes(bifs[index]);
                const blob = new Blob([buf], { type: "image/jpeg" });
                const entry = { blob, url: URL.createObjectURL(blob) };
                frameCache.set(index, entry);

                // Evict oldest first, revoking as we go — the revoke is the
                // half that was missing before, and is why the old code leaked
                // one object URL per frame for the life of the episode.
                while (frameCache.size > FRAME_CACHE_MAX) {
                    const oldestKey = frameCache.keys().next().value;
                    URL.revokeObjectURL(frameCache.get(oldestKey).url);
                    frameCache.delete(oldestKey);
                }
                return entry;
            }

            /** Already-cached URL for a frame index, or null. Never fetches. */
            function peekFrameUrl(index) {
                const hit = index >= 0 && frameCache.get(index);
                return hit ? hit.url : null;
            }

            function clearFrameCache() {
                for (const entry of frameCache.values()) URL.revokeObjectURL(entry.url);
                frameCache.clear();
            }

            // Single choke point for the top status line so it can never go
            // stale: every state transition in the app should route through
            // here instead of touching statusDiv/indicator directly.
            function setStatus(text, state = "neutral") {
                ui.status(text, state);
                if (statusDiv) statusDiv.textContent = text;
                if (!indicator) return;
                indicator.classList.remove("active", "error");
                if (state === "active") indicator.classList.add("active");
                else if (state === "error") indicator.classList.add("error");
            }

            /**
             * Fail loudly if the bridge does not have what this app calls.
             *
             * A misspelt SDK method is not a crash — it is `undefined`, and
             * calling it throws inside the transport's per-attempt try/catch,
             * which turns it into "every image failed, three attempts each,
             * forever". That is indistinguishable from a bad radio, and it cost
             * a session to find: `imageRawDataUpgrade` invented by symmetry with
             * the real `textContainerUpgrade`.
             *
             * Names are data the SDK owns and we can only get wrong, so check
             * them once, at the one moment there is something to check against.
             */
            const REQUIRED_BRIDGE_METHODS = [
                "updateImageRawData",
                "textContainerUpgrade",
                "createStartUpPageContainer",
            ];

            function assertBridgeContract(bridge) {
                const missing = REQUIRED_BRIDGE_METHODS.filter(
                    (m) => typeof bridge?.[m] !== "function",
                );
                if (missing.length) {
                    throw new Error(
                        `SDK is missing ${missing.join(", ")} — this build calls ` +
                        `methods the bridge does not have`,
                    );
                }
            }

            async function initEvenBridge() {
                try {
                    setStatus(
                        "Searching for active G2 Webview Environment Hook...",
                    );
                    bridgeInstance = await waitForEvenAppBridge();
                    assertBridgeContract(bridgeInstance);

                    // Wire tap/double-tap/exit event routing now that the
                    // bridge instance actually exists.
                    setupEvenHubEventRouting();

                    // Track link/device state so sends can be annotated with it.
                    if (typeof bridgeInstance.onDeviceStatusChanged === "function") {
                        bridgeInstance.onDeviceStatusChanged((status) => {
                            const prev = deviceConnectType;
                            deviceConnectType = status?.connectType ?? "unknown";
                            deviceBatteryLevel = status?.batteryLevel ?? null;
                            deviceIsWearing = status?.isWearing ?? null;
                            // A link that went away and came back cleared the
                            // glasses; what we believe is on screen is no longer
                            // true, so the next line must be sent even if it is
                            // the same text.
                            if (prev !== "unknown" && deviceConnectType !== prev) {
                                ble.forgetText();
                                // A link that moved is the most likely moment
                                // for the containers to have gone with it, so
                                // drop the repair cooldown: the safety net
                                // should fire on the next couple of failures
                                // rather than waiting out a window sized for a
                                // steady link. The repair is still evidence-led
                                // — nothing is re-declared unless text actually
                                // starts failing while images land — because
                                // there is no reason to trust that every way of
                                // losing a container announces itself here.
                                lastContainerRepairAt = 0;
                                consecutiveSubtitleFailures = 0;
                            }
                            if (linkObserver) {
                                linkObserver({
                                    connectType: deviceConnectType,
                                    batteryLevel: deviceBatteryLevel,
                                    isWearing: deviceIsWearing,
                                });
                            }
                            if (deviceConnectType !== prev) {
                                console.warn(
                                    `[Device] connection ${prev} -> ${deviceConnectType} (battery: ${deviceBatteryLevel ?? "?"}%, wearing: ${deviceIsWearing}, queue: ${bleQueueDepthNow()})`,
                                );
                            }
                        });
                    }

                    glassesSubtitleContainer = {
                        xPosition: 72, // Centered horizontally: (576 - 432) / 2
                        yPosition: 156, // Top = image bottom (144) + 12px padding (half text line)
                        width: 432, // 75% of 576 screen width
                        height: 132, // Fill remaining space: 288 - 156 = 132
                        borderWidth: 0,
                        containerID: 1,
                        containerName: "g2_subs",
                        content: "Sign in to Plex",
                        isEventCapture: 1, // designates subtitle container as primary event receiver
                    };

                    glassesImageContainer = {
                        xPosition: GLASSES_IMAGE_X, // centered: (576 - width) / 2
                        yPosition: 0, // Put at y=0 (no padding on top)
                        width: GLASSES_IMAGE_WIDTH,
                        height: GLASSES_IMAGE_HEIGHT,
                        containerID: 2,
                        containerName: "g2_bif",
                    };

                    const result = await createGlassesContainers();

                    if (result === 0) {
                        setStatus("G2 Glass Engine Connected via BLE!", "active");
                    } else {
                        // 0 success, 1 invalid, 2 oversize, 3 outOfMemory.
                        throw new Error(
                            `Startup container creation returned ` +
                            `${["success", "invalid", "oversize", "outOfMemory"][result] ?? result}`,
                        );
                    }
                } catch (err) {
                    // Say WHICH step failed. "Offline" covered both a bridge
                    // that never appeared and a bridge that appeared and then
                    // threw during wiring, which are different problems.
                    console.error(
                        `[Bridge] init failed after ${bridgeInstance ? "connecting" : "waiting"}: ${err?.message || err}`,
                        err,
                    );
                    setStatus(
                        bridgeInstance
                            ? "G2 bridge connected but wiring failed — see console"
                            : "G2 App Bridge Offline (Browser Preview Loop Active)",
                        "error",
                    );
                }
            }

            // --- STEP 4: MOUNT PLAYER RUNTIME & TRANSMIT OVER BLE ---
            //
            // The provider comes in already built. The engine never names one:
            // which provider this is, and how it was authenticated, is settled
            // before anything here runs (SEAM.md, UI.md §5).
            async function prepareItem(item) {
                document.getElementById("playing-title").textContent = item.title;

                setStatus(`Loading "${item.title}"...`);
                showLoadProgress("Connecting to server...");

                if (source && source.release) source.release();
                source = item.source;
                currentItem = item;
                clearFrameCache();

                // Index phase (0-20%). The provider decides how to get a
                // timeline — two small ranged reads here, tile geometry
                // elsewhere. Either way the track is not downloaded (F-005).
                setLoadProgress(null, "Reading index...");
                const timelineResult = await source.timeline();
                bifs = timelineResult.frames;
                setLoadProgress(0.2, "Reading index...");

                // Subtitle phase (20-90%): the only download large enough to
                // be worth a progress bar now.
                setLoadProgress(0.5, "Downloading subtitles...");
                subtitles = await source.cues();
                setLoadProgress(0.9, "Parsing subtitles...");

                durationMs = item.durationMs || bifs[bifs.length - 1].tsMs;
                rebuildScenes();

                const header = timelineResult.header;
                const trackBytes = bifs.reduce((n, f) => n + (f.sizeHint || 0), 0);
                console.log(
                    `[timeline] ${bifs.length} frames` +
                    (header ? `, index ${header.indexByteLength} B read` : ", from geometry") +
                    (trackBytes ? `, ${(trackBytes / 1e6).toFixed(2)} MB of frames NOT downloaded` : ""),
                );

                timeline.max = durationMs;
                currentTimeMs = 0;
                resetPipelineState();

                setLoadProgress(1, "Ready");
                hideLoadProgress();
                setStatus(`Ready: ${item.title}`, "active");
                return sceneStats();
            }

            function resetPipelineState() {
                scenePipelineRunning = false;
                sceneAbortController = null;
                renderDurations = [];
                averageRenderDuration = 1500;
                lastSentImageTimestampMs = 0;
            }

            // A frame is prepared in three separable phases: decode the
            // provider's JPEG, run the pixel arithmetic, encode a PNG for the
            // bridge. `prepare` used to time all three as one number, and that
            // number reached 4040ms at p90 on hardware — larger than the BLE
            // write it was supposed to be hiding behind.
            //
            // One number cannot be acted on. `tools/pixel-bench.mjs` measures
            // the middle phase at 0.52ms median for this frame size, so the
            // arithmetic was never the cost; it is decode or encode or the main
            // thread being busy elsewhere, and those have different fixes. Each
            // phase is therefore timed separately (F-046).
            //
            // Two changes come from the same measurement:
            //   - `createImageBitmap` where it exists, instead of an <img> and
            //     an object URL. It decodes off the main thread, so a slow
            //     decode stops blocking the timers that drive the pipeline.
            //   - one canvas for the whole session instead of one per frame.
            //     At a scene every few seconds that is a lot of allocation for
            //     a surface whose size never changes.
            let prepCanvas = null;
            let prepCtx = null;

            function prepSurface(w, h) {
                if (!prepCanvas) {
                    prepCanvas = document.createElement("canvas");
                    prepCtx = prepCanvas.getContext("2d", { willReadFrequently: true });
                }
                if (prepCanvas.width !== w || prepCanvas.height !== h) {
                    prepCanvas.width = w;
                    prepCanvas.height = h;
                }
                return { canvas: prepCanvas, ctx: prepCtx };
            }

            /** Decode to something drawable, preferring the off-thread path. */
            async function decodeFrame(blob) {
                if (typeof createImageBitmap === "function") {
                    // `resize` options are not universally honoured, so the
                    // scaling stays in drawImage where it always works.
                    return await createImageBitmap(blob);
                }
                const objectUrl = URL.createObjectURL(blob);
                try {
                    return await new Promise((resolve, reject) => {
                        const img = new Image();
                        img.onload = () => resolve(img);
                        img.onerror = (err) => reject(err);
                        img.src = objectUrl;
                    });
                } finally {
                    URL.revokeObjectURL(objectUrl);
                }
            }

            function encodeFrame(canvas) {
                return new Promise((resolve, reject) => {
                    canvas.toBlob(async (out) => {
                        if (!out) {
                            reject(new Error("Canvas toBlob failed"));
                            return;
                        }
                        try {
                            resolve(await out.arrayBuffer());
                        } catch (e) {
                            reject(e);
                        }
                    }, "image/png");
                });
            }

            async function resizeAndPrepareImage(blob, targetWidth, targetHeight, meta = {}) {
                const bitmap = await timed("decode", meta, () => decodeFrame(blob));
                try {
                    const { canvas, ctx } = prepSurface(targetWidth, targetHeight);
                    const imgData = await timed("pixels", meta, () => {
                        ctx.clearRect(0, 0, targetWidth, targetHeight);
                        ctx.drawImage(bitmap, 0, 0, targetWidth, targetHeight);
                        const d = ctx.getImageData(0, 0, targetWidth, targetHeight);
                        toGlassesGrey(d.data, targetWidth, targetHeight, {
                            brightness: brightnessValue,
                            contrast: contrastValue,
                            gamma: gammaValue,
                            dither: ditherAlgorithm === "ordered-4x4" ? "bayer" : ditherAlgorithm,
                        });
                        ctx.putImageData(d, 0, 0);
                        return d;
                    });
                    void imgData;
                    return await timed("encode", meta, () => encodeFrame(canvas));
                } finally {
                    if (bitmap && typeof bitmap.close === "function") bitmap.close();
                }
            } // --- SCENE PIPELINE HELPERS ---

            function sleep(ms, signal) {
                return new Promise((resolve) => {
                    if (signal?.aborted) {
                        resolve();
                        return;
                    }
                    const timeout = setTimeout(resolve, ms);
                    if (signal) {
                        signal.addEventListener(
                            "abort",
                            () => {
                                clearTimeout(timeout);
                                resolve();
                            },
                            { once: true },
                        );
                    }
                });
            }

            function getSceneDuration() {
                if (renderDurations.length === 0) return 5000;
                const sum = renderDurations.reduce((a, b) => a + b, 0);
                const avg = sum / renderDurations.length;
                return Math.max(5000, Math.min(15000, avg));
            }

            // --- SCENE SELECTION ---
            //
            // The policy itself lives in src/scenes.ts so it can be exercised
            // headlessly against the shared corpus. See that file for why it
            // is shaped the way it is (F-001, F-007, F-009, F-036).
            let sceneList = [];
            let currentItem = null;

            // The two policy options. Neither is a rule: both change which
            // scenes exist, so both rebuild the list rather than being consulted
            // during playback (UI.md §4.2).
            let skipSilent = true;
            let bandwidthStride = 1; // 1 = every scene

            /** Per-scene bytes over BLE — fixed, whatever the provider charged (F-040). */
            const DEVICE_BYTES_PER_SCENE = 16384;

            function rebuildScenes() {
                if (!bifs.length) { sceneList = []; return; }
                // A source with no per-frame sizes gets neither blank filtering
                // nor duplicate detection — skipped, not faked (SEAM.md §4).
                const caps = source.capabilities();
                const full = buildSceneList(bifs, subtitles, durationMs, {
                    hasFrameSizeHints: caps.hasFrameSizeHints,
                    skipSilent,
                });
                sceneList = thinScenes(full, bandwidthStride);
            }

            /**
             * What the consequence lines under the controls quote (UI.md §4.1).
             *
             * `unfiltered` and `withSubtitles` are both computed regardless of
             * how the switch is currently set, because the line has to say what
             * turning it ON would do — "73 scenes -> 73 with subtitles" while it
             * is off is a true sentence that answers nothing.
             *
             * All of it falls out of the scene list, which is built without
             * touching the network, so quoting it costs nothing.
             */
            function sceneStats() {
                const count = (skip) => buildSceneList(bifs, subtitles, durationMs, {
                    hasFrameSizeHints: source.capabilities().hasFrameSizeHints,
                    skipSilent: skip,
                }).length;
                return {
                    scenes: sceneList.length,
                    withSubtitles: count(true),
                    unfiltered: count(false),
                    hasCues: subtitles.length > 0,
                    deviceBytes: sceneList.length * DEVICE_BYTES_PER_SCENE,
                    durationMs,
                };
            }

            /** The selected scene containing startMs, or the first one after it. */
            function sceneContaining(startMs) {
                if (!sceneList.length) return null;
                for (const sc of sceneList) {
                    if (startMs >= sc.startMs && startMs < sc.endMs) return sc;
                }
                return sceneList.find((sc) => sc.startMs >= startMs) || null;
            }

            function buildScene(startMs) {
                const sc = sceneContaining(startMs);
                if (!sc) {
                    return {
                        frameIndex: -1, image: null, subtitles: [],
                        startMs, endMs: startMs, duration: 0,
                    };
                }

                // Own each cue to the scene it STARTS in. Scenes tile the
                // timeline contiguously, so this assigns every cue to exactly
                // one scene — a cue straddling a boundary is not sent twice.
                const sceneSubs = subtitles.filter(
                    (s) => s.startMs >= sc.startMs && s.startMs < sc.endMs,
                );

                return {
                    // The index, not the frame: everything downstream of here
                    // addresses frames by position so it never handles a
                    // provider's locator.
                    frameIndex: sc.frameIndex,
                    image: bifs[sc.frameIndex],
                    subtitles: sceneSubs,
                    startMs: sc.startMs,
                    endMs: sc.endMs,
                    duration: sc.endMs - sc.startMs,
                };
            }

            // Cue text arrives already cleaned — tags and ASS overrides are
            // stripped in subtitles.ts at parse time (F-011), and lines are
            // joined with real newlines. This is kept as a narrow guard for
            // the strings the app itself injects into the same path (status
            // messages like "Loading …"), not as a second cleaning pass.
            function cleanSubText(text) {
                return String(text).trim();
            }

            // Estimate how many rendered lines a block of text occupies on the
            // glasses, accounting for explicit newlines and word-wrap at the
            // container width.
            function estimateGlassesLines(text) {
                let count = 0;
                for (const line of text.split("\n")) {
                    const len = line.trim().length;
                    count += len === 0 ? 1 : Math.ceil(len / GLASSES_CHARS_PER_LINE);
                }
                return count;
            }

            // Merge consecutive SRT cues into multi-line blocks that fit the
            // glasses' line budget. Each returned block is shown as a single
            // combined subtitle update, giving the reader more text per send.
            // Cues keep their natural start/end times (each cue belongs to one
            // scene now, so there is no boundary to clip against).
            function groupSceneSubtitles(subs) {
                const groups = [];
                let current = null;

                for (const sub of subs) {
                    const text = cleanSubText(sub.text);
                    if (!text) continue;
                    if (sub.endMs - sub.startMs <= 0) continue;

                    const lines = estimateGlassesLines(text);

                    // Merge into the current block only if it still fits the line
                    // budget AND follows closely enough that showing it now isn't
                    // a spoiler for a much later line.
                    const gap = current ? sub.startMs - current.endMs : 0;
                    if (
                        current &&
                        current.lineCount + lines <= GLASSES_MAX_LINES &&
                        gap <= GLASSES_MAX_BLOCK_GAP_MS
                    ) {
                        // Append to the in-progress block
                        current.texts.push(text);
                        current.lineCount += lines;
                        current.endMs = Math.max(current.endMs, sub.endMs);
                    } else {
                        // Flush the previous block and start a new one
                        if (current) groups.push(current);
                        current = {
                            texts: [text],
                            lineCount: lines,
                            startMs: sub.startMs,
                            endMs: sub.endMs,
                        };
                    }
                }
                if (current) groups.push(current);

                return groups.map((g) => ({
                    text: g.texts.join("\n"),
                    startMs: g.startMs,
                    endMs: g.endMs,
                }));
            }

            async function sendImageToGlasses(frameIndex) {
                if (!bridgeInstance || frameIndex == null || frameIndex < 0) return 0;
                const frame = bifs[frameIndex];

                // The bytes come from the SOURCE, one frame at a time, rather
                // than every frame being materialised at load time (F-005).
                // How that fetch happens is the provider's business: a ranged
                // GET on Plex, a crop out of a cached sheet elsewhere.
                let assets;
                const cached = !!peekFrameUrl(frameIndex);
                try {
                    assets = await timed("fetch", { frameIndex, cached },
                        () => getFrameAssets(frameIndex));
                } catch (e) {
                    console.warn(
                        `[frame] fetch failed at ${bifs[frameIndex]?.tsMs}ms: ${e.message}`,
                    );
                    return 0;
                }

                const preparedBytes = await timed("prepare", { frameIndex }, () =>
                    resizeAndPrepareImage(
                        assets.blob,
                        GLASSES_IMAGE_WIDTH,
                        GLASSES_IMAGE_HEIGHT,
                        { frameIndex },
                    ),
                );

                const payload =
                    typeof ImageRawDataUpdate !== "undefined"
                        ? new ImageRawDataUpdate({
                              containerID: 2,
                              containerName: "g2_bif",
                              imageData: preparedBytes,
                          })
                        : {
                              containerID: 2,
                              containerName: "g2_bif",
                              imageData: preparedBytes,
                          };
                const payloadKB = (preparedBytes.byteLength / 1024).toFixed(1);

                // Queue, retry, supersession and the failure bookkeeping all
                // live in the transport now. What is left here is the part that
                // is about THIS app: what to log, and how the result feeds the
                // pacing average.
                // `updateImageRawData` resolves to a STRING enum, not a
                // boolean: "success" | "imageException" | "imageSizeInvalid" |
                // "imageToGray4Failed" | "sendFailed". The transport's contract
                // is a boolean, so the mapping happens here — it is the only
                // layer that should know what this SDK calls things.
                //
                // Mapping it with `!== false` would report every one of those
                // failures as a delivery, which is worse than the failure.
                let lastResult = "";
                const r = await ble.sendImage(
                    async (p) => {
                        lastResult = await bridgeInstance.updateImageRawData(p);
                        return lastResult === "success";
                    },
                    payload,
                    { tsMs: frame.tsMs, bytes: preparedBytes.byteLength },
                );

                if (r.reason === "superseded") {
                    console.log(
                        `[Scene Engine] Image ${frame.tsMs / 1000}s: skipped — a newer frame is queued`,
                    );
                    return 0;
                }

                if (r.ok) {
                    renderDurations.push(Math.min(r.duration, RENDER_DURATION_CAP_MS));
                    if (renderDurations.length > 5) renderDurations.shift();
                    averageRenderDuration = getSceneDuration();
                    lastSentImageTimestampMs = frame.tsMs;
                    imageSuccessCount++;
                    if (consecutiveImageFailures > 0) {
                        const frozenMs = lastImageSuccessWall
                            ? performance.now() - lastImageSuccessWall
                            : 0;
                        console.warn(
                            `[Scene Engine] Image UNSTUCK after ${consecutiveImageFailures} failure(s), ~${(frozenMs / 1000).toFixed(1)}s frozen`,
                        );
                    }
                    consecutiveImageFailures = 0;
                    lastImageSuccessWall = performance.now();
                } else {
                    consecutiveImageFailures++;
                    imageFailureCount++;
                }

                const attemptsNote = (r.tried?.length ?? 0) > 1 ? ` attempts[${r.tried.join(", ")}]` : "";
                const stuckNote = consecutiveImageFailures > 0 ? ` STUCK x${consecutiveImageFailures}` : "";
                console.log(
                    `[Scene Engine] Image ${frame.tsMs / 1000}s: ${r.ok ? "success" : r.reason} ` +
                    `(${(r.duration ?? 0).toFixed(0)}ms, ${payloadKB}KB, conn:${deviceConnectType}, ` +
                    `q:${bleQueueDepthNow()}, avg:${averageRenderDuration.toFixed(0)}ms)${attemptsNote}${stuckNote}`,
                );
                return r.ok ? r.duration : 0;
            }

            /**
             * Declare the two containers the glasses draw into.
             *
             * Deliberately callable more than once. It used to run exactly
             * once, at bridge init, which was right up until the link dropped:
             * a disconnect takes the containers with it, and the image path
             * re-establishes itself while `textContainerUpgrade` keeps
             * addressing a container ID that is no longer there. That is
             * precisely the reported symptom — "images started sending again,
             * but no text" — and it is silent, because a text write that names
             * a dead container fails the same way a busy link does.
             */
            async function createGlassesContainers() {
                containerLossInjected = false;
                return await bridgeInstance.createStartUpPageContainer({
                    containerTotalNum: 2,
                    textObject: [glassesSubtitleContainer],
                    imageObject: [glassesImageContainer],
                });
            }

            let lastContainerRepairAt = 0;
            let consecutiveSubtitleFailures = 0;
            const CONTAINER_REPAIR_AFTER = 2;      // failures in a row
            const CONTAINER_REPAIR_COOLDOWN_MS = 15000;

            /**
             * Re-declare the containers when the evidence says text is dead and
             * the link is not.
             *
             * The trigger is deliberately not "we saw a disconnect event": the
             * session that produced this had a genuine hardware disconnect AND
             * an unrelated Bluetooth device dropping, and there is no reason to
             * trust that every way of losing a container announces itself.
             * Repeated text failures while images keep landing is the symptom
             * itself, and it is available without knowing the cause.
             */
            async function repairContainersIfTextIsDead() {
                if (!bridgeInstance) return false;
                if (consecutiveSubtitleFailures < CONTAINER_REPAIR_AFTER) return false;
                const now = Date.now();
                if (now - lastContainerRepairAt < CONTAINER_REPAIR_COOLDOWN_MS) return false;
                // If images are failing too, this is the link, not a container,
                // and re-declaring them adds a write to a queue that is already
                // struggling.
                if (consecutiveImageFailures > 0) return false;

                lastContainerRepairAt = now;
                try {
                    const result = await createGlassesContainers();
                    console.warn(
                        `[Recovery] Text failed ${consecutiveSubtitleFailures}x while images ` +
                        `kept landing — re-declared the containers (${result === 0 ? "ok" : `code ${result}`})`,
                    );
                    noteLifecycle("containers-repaired", {
                        result, afterFailures: consecutiveSubtitleFailures,
                    });
                    // Whatever the glasses are showing now is not ours, and the
                    // line we most recently "sent" was never drawn.
                    ble.forgetText();
                    return result === 0;
                } catch (e) {
                    console.error(`[Recovery] Container re-declaration threw: ${e?.message || e}`);
                    return false;
                }
            }

            /**
             * Reproduce the failure above without unplugging anything: text
             * writes fail until the containers are re-declared, which is what a
             * lost container does. Driven by the telemetry page's `?notext=1`.
             */
            let containerLossInjected = false;
            export function simulateContainerLoss() {
                containerLossInjected = true;
                noteLifecycle("injected-container-loss");
            }

            async function sendSubtitleToGlasses(text) {
                if (!bridgeInstance) return;

                // De-duplication lives in the transport, and it only records a
                // line once the write SUCCEEDED. Recording it here, before the
                // send, is what used to leave the glasses showing the previous
                // line for ever after a single rejected write.
                //
                // `textUpgradeResult` is local, and has to be: the image path
                // has a variable of its own with almost the same name, and this
                // function used to read THAT one. It is a `let` inside
                // `sendImageToGlasses`, so every subtitle failure threw a
                // ReferenceError out of the diagnostic that was supposed to
                // explain it — swallowed by the caller and logged as
                // `Subtitle send failed: {}`, which is how a text channel can
                // die for a whole session without ever saying why.
                let textUpgradeResult;
                const r = await ble.sendText(
                    async (content) => {
                        if (containerLossInjected) return false;
                        textUpgradeResult = await bridgeInstance.textContainerUpgrade({
                            containerID: 1,
                            containerName: "g2_subs",
                            contentOffset: 0,
                            contentLength: 0,
                            content,
                        });
                        return textUpgradeResult;
                    },
                    text,
                );
                if (!r.ok && r.reason !== "superseded") {
                    subtitleFailureCount++;
                    consecutiveSubtitleFailures++;
                    console.warn(
                        `[Scene Engine] Subtitle send failed (${r.reason}` +
                        `${r.error ? `: ${r.error}` : ""}, bridge:${String(textUpgradeResult)}, ` +
                        `conn:${deviceConnectType}, q:${bleQueueDepthNow()}, ` +
                        `${consecutiveSubtitleFailures} in a row)`,
                    );
                    await repairContainersIfTextIsDead();
                } else if (r.ok) {
                    consecutiveSubtitleFailures = 0;
                }
                return r;
            }

            async function runScenePipeline() {
                // Stop any existing pipeline first
                stopScenePipeline();
                while (scenePipelineRunning) {
                    await sleep(10);
                }

                scenePipelineRunning = true;
                sceneAbortController = new AbortController();
                const signal = sceneAbortController.signal;

                // Pipeline drives the timeline — stop the clock
                stopClock();

                console.log(
                    "[Scene Engine] Pipeline started at " +
                        currentTimeMs +
                        "ms",
                );
                startStatsHeartbeat();

                try {
                    let pipelinePos = currentTimeMs;

                    // Build the first scene and kick off its image send. There is
                    // nothing to overlap with yet, so it just starts immediately.
                    let scene = buildScene(pipelinePos);
                    let imageSend =
                        scene.frameIndex >= 0
                            ? sendImageToGlasses(scene.frameIndex)
                            : Promise.resolve(0);

                    while (
                        isPlaying &&
                        !signal.aborted &&
                        pipelinePos < durationMs
                    ) {
                        // No BIF frame at this position — nudge forward and retry.
                        if (scene.frameIndex < 0) {
                            await sleep(50, signal);
                            pipelinePos += 50;
                            scene = buildScene(pipelinePos);
                            imageSend = scene.frameIndex >= 0
                                ? sendImageToGlasses(scene.frameIndex)
                                : Promise.resolve(0);
                            continue;
                        }

                        // 1. Show this scene's image locally and wait for its BLE
                        //    render. The send was issued at the END of the previous
                        //    iteration (prefetched while the last subtitle showed),
                        //    so by now it is usually already complete.
                        currentTimeMs = scene.startMs;
                        updateUI();
                        console.log(
                            `[Scene Engine] Awaiting image at ${scene.startMs}ms (scene: ${scene.duration.toFixed(0)}ms, subs: ${scene.subtitles.length})`,
                        );
                        try {
                            await imageSend;
                        } catch (e) {
                            console.error(
                                "[Scene Engine] Image send failed:",
                                e,
                            );
                        }
                        if (signal.aborted) break;

                        // Mark when this scene visually begins (image now shown),
                        // so we can pace the whole scene to its content duration.
                        const sceneWallStart = performance.now();

                        // Pre-build the next scene so its image can be prefetched
                        // while this scene's last subtitle is still being read.
                        const nextPos = scene.endMs;
                        const nextScene =
                            nextPos < durationMs ? buildScene(nextPos) : null;
                        let nextImageSend = null;
                        const startNextImage = () => {
                            if (nextImageSend) return;
                            nextImageSend =
                                nextScene && nextScene.frameIndex >= 0
                                    ? sendImageToGlasses(nextScene.frameIndex)
                                    : Promise.resolve(0);
                        };

                        // First cue start of the next scene — used to decide whether
                        // to blank the screen after this scene's last block.
                        const nextSceneFirstSubMs =
                            nextScene && nextScene.subtitles.length
                                ? nextScene.subtitles[0].startMs
                                : Infinity;

                        // 2. Merge this scene's cues into multi-line blocks so the
                        //    reader gets a fuller screen of text per BLE update.
                        const blocks = groupSceneSubtitles(scene.subtitles);
                        if (blocks.length) {
                            console.log(
                                `[Scene Engine] ${scene.subtitles.length} cue(s) -> ${blocks.length} block(s) for ${scene.startMs}ms`,
                            );
                        }

                        for (let i = 0; i < blocks.length; i++) {
                            const block = blocks[i];
                            if (signal.aborted) break;

                            const displayDuration = block.endMs - block.startMs;
                            if (displayDuration <= 0) continue;

                            // Update HTML to track this block's start time
                            currentTimeMs = block.startMs;
                            updateUI();

                            // Send to glasses (sendSubtitleToGlasses deduplicates automatically)
                            try {
                                await sendSubtitleToGlasses(block.text);
                            } catch (e) {
                                console.error(
                                    "[Scene Engine] Subtitle send failed:",
                                    e,
                                );
                            }

                            // 3. Once the LAST block is on screen, start sending the
                            //    next image while the user reads it. The serial BLE
                            //    queue holds it behind this subtitle write, so the
                            //    two never transmit at the same time.
                            if (i === blocks.length - 1) startNextImage();

                            // Hold the block on screen for its combined duration
                            if (!signal.aborted && displayDuration > 0) {
                                await sleep(displayDuration, signal);
                            }

                            // 4. Blank the screen only if the next on-screen text is a
                            //    real pause away; if it follows closely, leave this
                            //    block up so the next one simply overwrites it (no
                            //    flicker through an empty frame).
                            const nextStartMs = blocks[i + 1]
                                ? blocks[i + 1].startMs
                                : nextSceneFirstSubMs;
                            if (
                                !signal.aborted &&
                                nextStartMs - block.endMs > SUBTITLE_CLEAR_GAP_MS
                            ) {
                                try {
                                    await sendSubtitleToGlasses(" ");
                                } catch (e) {}
                            }
                        }

                        if (signal.aborted) break;

                        // 5. Scene had no (displayable) subtitles to piggyback on —
                        //    issue the next image now so it is in flight.
                        startNextImage();

                        // 6. Pace the scene to its content duration. Without this,
                        //    subtitle-sparse stretches race ahead and fire image
                        //    sends back-to-back, saturating the BLE link until the
                        //    device rejects them (sendFailed) and the image freezes.
                        const sceneElapsed = performance.now() - sceneWallStart;
                        const remainder = scene.duration - sceneElapsed;
                        if (!signal.aborted && remainder > 0) {
                            await sleep(remainder, signal);
                        }

                        // 7. Advance to the next scene; its image is already sending.
                        pipelinePos = scene.endMs;
                        currentTimeMs = pipelinePos;
                        updateUI();

                        scene = nextScene || buildScene(pipelinePos);
                        imageSend = nextImageSend || Promise.resolve(0);
                    }

                    // End of playback
                    if (pipelinePos >= durationMs && !signal.aborted) {
                        isPlaying = false;
                        currentTimeMs = 0;
                        playBtn.innerText = "Play";
                        try {
                            silentAudio.pause();
                        } catch (e) {}
                        updateUI();
                        const title =
                            document.getElementById("playing-title")
                                ?.textContent || "media";
                        setStatus(`Finished: ${title}`, "active");
                    }
                } catch (e) {
                    console.error("[Scene Engine] Pipeline error:", e);
                } finally {
                    scenePipelineRunning = false;
                    sceneAbortController = null;
                    stopStatsHeartbeat();
                    console.log("[Scene Engine] Pipeline stopped");
                }
            }

            function stopScenePipeline() {
                if (sceneAbortController) {
                    sceneAbortController.abort();
                }
                // Anything already handed to the link is no longer wanted. The
                // pipeline stopping and the QUEUE stopping are different
                // things, and only aborting the first is why a pause used to be
                // followed by several seconds of stale frames still arriving.
                ble.abandonQueued();
            }

            // Periodic one-line health summary while playing, so link state and
            // image-freeze trends can be correlated without scrolling the log.
            function startStatsHeartbeat() {
                if (statsHeartbeatId) return;
                statsHeartbeatId = setInterval(() => {
                    const total = imageSuccessCount + imageFailureCount;
                    const failPct = total
                        ? Math.round((imageFailureCount / total) * 100)
                        : 0;
                    const sinceGood = lastImageSuccessWall
                        ? ((performance.now() - lastImageSuccessWall) / 1000).toFixed(1)
                        : "?";
                    console.log(
                        `[Stats] pos:${(currentTimeMs / 1000).toFixed(0)}s conn:${deviceConnectType} battery:${deviceBatteryLevel ?? "?"}% wearing:${deviceIsWearing} queue:${bleQueueDepthNow()} img:${imageSuccessCount}ok/${imageFailureCount}fail(${failPct}%) subFail:${subtitleFailureCount} lastGoodImg:${sinceGood}s ago${consecutiveImageFailures > 0 ? ` FROZEN x${consecutiveImageFailures}` : ""}`,
                    );
                }, 10000);
            }

            function stopStatsHeartbeat() {
                if (statsHeartbeatId) {
                    clearInterval(statsHeartbeatId);
                    statsHeartbeatId = null;
                }
            }

            // One-shot update for pause/seek — sends current image + subtitle outside the pipeline
            async function sendOneShotUpdate() {
                if (!bridgeInstance) return;

                const frameIndex = bifs.findIndex(
                    (f, i) =>
                        f.tsMs <= currentTimeMs &&
                        (bifs[i + 1]?.tsMs > currentTimeMs || !bifs[i + 1]),
                );

                const sub = subtitles.find(
                    (s) =>
                        currentTimeMs >= s.startMs && currentTimeMs <= s.endMs,
                );

                const cleanText = sub ? cleanSubText(sub.text) : " ";

                try {
                    await sendSubtitleToGlasses(cleanText);
                } catch (e) {
                    console.error(
                        "[Scene Engine] One-shot subtitle failed:",
                        e,
                    );
                }

                if (frameIndex >= 0) {
                    try {
                        await sendImageToGlasses(frameIndex);
                    } catch (e) {
                        console.error(
                            "[Scene Engine] One-shot image failed:",
                            e,
                        );
                    }
                }
            }

            function updateUI() {
                // Every element below belongs to the PREVIEW — the little
                // monitor beside the player. It is a convenience, and on a page
                // that does not have it (the telemetry page) these are null.
                //
                // Guarded because this runs inside the scene pipeline: an
                // exception here does not break a preview, it breaks the
                // GLASSES, by aborting the loop that feeds them. The screen the
                // wearer sees must not depend on the screen the developer does.
                if (!imgTag || !subDiv || !timeline || !timeDisplay) return;
                // Find BIF frame corresponding to current playback time for local preview monitor
                const frameIndex = bifs.findIndex(
                    (f, i) =>
                        f.tsMs <= currentTimeMs &&
                        (bifs[i + 1]?.tsMs > currentTimeMs || !bifs[i + 1]),
                );

                // Update local monitor image src. updateUI runs on a timer and
                // must stay synchronous, so a cached frame is applied straight
                // away and a miss is fetched in the background. The index guard
                // stops a slow fetch for an old frame overwriting a newer one
                // that has since been drawn.
                if (frameIndex >= 0) {
                    const cachedUrl = peekFrameUrl(frameIndex);
                    if (cachedUrl) {
                        if (imgTag.src !== cachedUrl) imgTag.src = cachedUrl;
                    } else {
                        previewWantedIndex = frameIndex;
                        getFrameAssets(frameIndex)
                            .then((a) => {
                                if (previewWantedIndex === frameIndex) {
                                    imgTag.src = a.url;
                                }
                            })
                            .catch(() => {});
                    }
                }

                // Find subtitle matching currentTimeMs for local display
                const sub = subtitles.find(
                    (s) =>
                        currentTimeMs >= s.startMs && currentTimeMs <= s.endMs,
                );

                // Cue text is plain text with real newlines now that cleaning
                // happens at parse time (F-011), so it is escaped and its
                // newlines turned into <br> here rather than trusted as markup.
                const previewHtml = sub
                    ? escapeHtml(sub.text).replace(/\n/g, "<br>")
                    : "";
                if (subDiv.innerHTML !== previewHtml) {
                    subDiv.innerHTML = previewHtml;
                }

                timeline.value = currentTimeMs;

                const fmt = (ms) => {
                    const s = Math.floor(ms / 1000);
                    const m = Math.floor(s / 60);
                    const formattedM = String(m).padStart(2, "0");
                    const formattedS = String(s % 60).padStart(2, "0");
                    return `${formattedM}:${formattedS}`;
                };

                timeDisplay.textContent = `${fmt(currentTimeMs)} / ${fmt(durationMs)}`;
            }

            function startClock() {
                if (clockIntervalId) clearInterval(clockIntervalId);
                lastFrameTime = performance.now();
                clockIntervalId = setInterval(() => {
                    if (!isPlaying) {
                        stopClock();
                        return;
                    }
                    const now = performance.now();
                    const dt = now - lastFrameTime;
                    lastFrameTime = now;
                    currentTimeMs += dt;

                    if (currentTimeMs >= durationMs) {
                        isPlaying = false;
                        currentTimeMs = 0;
                        playBtn.innerText = "Play";
                        stopClock();
                        try {
                            silentAudio.pause();
                        } catch (e) {}
                        updateUI();
                        return;
                    }

                    updateUI();
                }, 50);
            }

            function stopClock() {
                if (clockIntervalId) {
                    clearInterval(clockIntervalId);
                    clockIntervalId = null;
                }
            }

            // --- EVEN HUB SDK EXTENSIONS ---
            // 1. Double tap exit & lifecycle cleanup
            let cleanedUp = false;
            function cleanup() {
                if (cleanedUp) return;
                cleanedUp = true;
                if (typeof stopScenePipeline === 'function') stopScenePipeline();
                isPlaying = false;
                playBtn.innerText = "Play";
                try { silentAudio.pause(); } catch (e) {}
                if (bridgeInstance) {
                    bridgeInstance.shutDownPageContainer(1);
                }
            }

            // --- BACKGROUND / FOREGROUND HANDLING ---
            // The phone screen locking (or this app losing foreground on the
            // glasses launcher) can throttle JS timers and/or the BLE radio
            // without ever fully killing the WebView, so a scene pipeline
            // left running just silently degrades — sends queue up, pacing
            // sleeps fire late — and the glasses are left on a stale frame
            // for a long stretch once things resume. Stop the pipeline the
            // moment we go background, and on return push a fresh
            // frame/subtitle immediately rather than waiting for the next
            // scheduled scene boundary, so there's no backlog to work
            // through.
            let backgroundedWhilePlaying = false;

            function pauseForBackground() {
                if (!isPlaying) return;
                backgroundedWhilePlaying = true;
                isPlaying = false;
                stopScenePipeline();
                try { silentAudio.pause(); } catch (e) {}
                console.log("[Lifecycle] Backgrounded — pipeline paused");
                noteLifecycle("app-paused", { reason: "background" });
            }

            function resumeFromBackground(reason = "foreground") {
                if (!backgroundedWhilePlaying) return;
                backgroundedWhilePlaying = false;
                // What is on the glasses right now is whatever was there when
                // we stopped, and the transport will skip re-sending identical
                // text. After an outage that dedupe is wrong: the wearer has
                // been staring at a stale line and needs it redrawn, even
                // though it has not changed.
                ble.forgetText();
                if (!bifs || bifs.length === 0) return;
                isPlaying = true;
                playBtn.innerText = "Pause";
                silentAudio.play().catch(() => {});
                const title =
                    document.getElementById("playing-title")?.textContent ||
                    "media";
                setStatus(`Now playing: ${title}`, "active");
                console.log(
                    "[Lifecycle] Foregrounded — refreshing and resuming pipeline",
                );
                noteLifecycle("app-resumed", { reason });
                sendOneShotUpdate().catch(() => {});
                runScenePipeline();
            }

            /**
             * Never stay paused while the page is visible.
             *
             * The host is expected to send FOREGROUND_ENTER after its
             * FOREGROUND_EXIT, and a measured session shows it does not always:
             * the app paused at 47s and sat there for 150s with the link
             * connected the whole time, because the only thing that could have
             * restarted it was an event that never arrived.
             *
             * Waiting for a message that may not come is not a resume path. If
             * we are paused, the page is visible, and playback was wanted, then
             * resume — whatever did or did not fire.
             */
            setInterval(() => {
                if (backgroundedWhilePlaying && !document.hidden) {
                    console.warn("[Lifecycle] Still paused while visible — resuming");
                    resumeFromBackground("watchdog");
                }
            }, 5000);

            // Defense in depth: the glasses host is expected to fire
            // FOREGROUND_ENTER/EXIT_EVENT (below), but the generic Page
            // Visibility API covers the plain-browser GitHub Pages build too
            // and costs nothing extra — both handlers are idempotent so it's
            // safe if both fire for the same real transition.
            document.addEventListener("visibilitychange", () => {
                if (document.hidden) {
                    // **The phone screen turning off is NOT a reason to stop.**
                    //
                    // This used to pause playback here, which is backwards for
                    // a glasses app: the phone is the compute in your pocket
                    // and its screen being off is the normal wearing state. The
                    // measured result was exactly what it sounds like —
                    // playback freezing a little while after the phone slept,
                    // 110s of a 3.8 min session with nothing sent at all.
                    //
                    // The glasses host losing foreground is a real reason to
                    // stop, and that still pauses: see FOREGROUND_EXIT_EVENT.
                    noteLifecycle("phone-screen-off", { keptPlaying: isPlaying });
                    console.log("[Lifecycle] Phone hidden — still playing");
                    return;
                }
                noteLifecycle("phone-screen-on", {});
                // Still a resume path, for when something else did pause us.
                resumeFromBackground("phone-screen-on");
            });

            // Event routing for Even Hub.
            // Called from initEvenBridge() once bridgeInstance is actually
            // set — this used to run unconditionally right after firing off
            // initApp() (not awaited), so bridgeInstance was always still
            // null here and it threw on every load, on-device included.
            function setupEvenHubEventRouting() {
                const unsubscribe = bridgeInstance.onEvenHubEvent(event => {
                const sysType = event.sysEvent?.eventType ?? null;
                const textType = event.textEvent?.eventType ?? null;
            
                // Double Tap Exit
                if (sysType === OsEventTypeList.DOUBLE_CLICK_EVENT || textType === OsEventTypeList.DOUBLE_CLICK_EVENT) {
                    cleanup();
                    return;
                }
            
                // Pause / Play toggle on single tap
                if (sysType === OsEventTypeList.CLICK_EVENT) {
                    const title =
                        document.getElementById("playing-title")
                            ?.textContent || "media";
                    if (isPlaying) {
                        isPlaying = false;
                        if (typeof stopScenePipeline === 'function') stopScenePipeline();
                        try { silentAudio.pause(); } catch (e) {}
                        playBtn.innerText = "Play";
                        setStatus(`Paused: ${title}`, "active");
                    } else if (bifs && bifs.length > 0) {
                        isPlaying = true;
                        backgroundedWhilePlaying = false;
                        silentAudio.play().catch(() => {});
                        playBtn.innerText = "Pause";
                        setStatus(`Now playing: ${title}`, "active");
                        if (typeof runScenePipeline === 'function') runScenePipeline();
                    }
                    return;
                }

                // The glasses host lost/regained foreground (e.g. the user
                // switched to another glasses app, or the phone screen
                // locked) — see pauseForBackground/resumeFromBackground.
                if (sysType === OsEventTypeList.FOREGROUND_EXIT_EVENT) {
                    pauseForBackground();
                    return;
                }
                if (sysType === OsEventTypeList.FOREGROUND_ENTER_EVENT) {
                    resumeFromBackground();
                    return;
                }

                if (sysType === OsEventTypeList.SYSTEM_EXIT_EVENT || sysType === OsEventTypeList.ABNORMAL_EXIT_EVENT) {
                    cleanup();
                }
                });
            }

            window.addEventListener('beforeunload', cleanup);

            // 2. Background State Persistence
            //
            // Position only. The old snapshot also handed the host the server
            // URL and the account token, which is a credential leaving the app
            // for no benefit: a restore cannot rebuild a provider from them
            // anyway — that is the UI's saved sources — and this only ever runs
            // against an item that is still loaded.
            window.__getStateSnapshot = () => {
                return JSON.stringify({ currentTimeMs, isPlaying, durationMs });
            };
            
            window.__restoreState = (jsonStr) => {
                if (jsonStr && jsonStr !== '{}') {
                    try {
                        const state = JSON.parse(jsonStr);

                        // Defensive: a pipeline that's already actively
                        // running has a far more accurate currentTimeMs than
                        // whatever snapshot the host just handed back — the
                        // host has been observed replaying a stale snapshot
                        // (from an entirely different point in the file)
                        // into an already-running session across some
                        // background/foreground cycles, which would
                        // otherwise yank playback to a random spot. Only
                        // trust a restore while nothing is actively playing.
                        if (scenePipelineRunning) {
                            console.warn(
                                "[Lifecycle] Ignoring __restoreState while pipeline is already running",
                            );
                            return;
                        }

                        durationMs = state.durationMs ?? durationMs;

                        // Clamp against the actually-loaded media's real
                        // duration when we have one, rather than trusting
                        // the restored durationMs, which comes from the
                        // same (possibly stale) snapshot.
                        const knownDurationMs =
                            bifs.length > 0
                                ? bifs[bifs.length - 1].tsMs
                                : durationMs;
                        if (typeof state.currentTimeMs === "number") {
                            currentTimeMs = Math.max(
                                0,
                                Math.min(state.currentTimeMs, knownDurationMs),
                            );
                        }

                        if (state.isPlaying && bifs.length > 0) {
                            isPlaying = true;
                            backgroundedWhilePlaying = false;
                            playBtn.innerText = "Pause";
                            const title =
                                document.getElementById("playing-title")
                                    ?.textContent || "media";
                            setStatus(`Now playing: ${title}`, "active");
                            if (typeof runScenePipeline === 'function') runScenePipeline();
                        }
                    } catch (e) {
                        console.error("Failed to restore state", e);
                    }
                }
            };
            // ================================================================
            // ENGINE API
            //
            // Everything above drives the glasses; everything the UI is allowed
            // to ask for is below. The split exists so the flow in
            // trickplayer-knowledge/UI.md can be rewritten without touching the
            // BLE queue, the scene pipeline or the image path — and so nothing
            // in this file has to know what a panel is.
            // ================================================================

            export { prepareItem, sceneStats };

            // --- TELEMETRY SEAM ---
            //
            // Three functions, used only by the telemetry page. The production
            // page never calls them and the transport's sink stays null, so
            // recording costs one null check per BLE operation and nothing
            // else.
            export function setEventSink(fn) { ble.setEventSink(fn); }
            export function bleDepth() { return ble.depth; }

            /**
             * Report link state changes — the thing every other number has to
             * be read against, and the one the app cannot infer for itself.
             */
            let linkObserver = null;
            export function setLinkObserver(fn) { linkObserver = fn; }

            /** What the app believes it is doing, for the heartbeat to stamp. */
            export function playbackState() {
                return {
                    playing: isPlaying,
                    pipeline: scenePipelineRunning,
                    scene: sceneList.length ? currentTimeMs : null,
                    bridge: !!bridgeInstance,
                    hidden: document.hidden,
                };
            }

            /**
             * Where the work AROUND a send is recorded.
             *
             * A session showed real frames costing 2.3x what their size
             * explains, and the only honest answer was "whatever else playback
             * is doing while the write is in flight". This is that: the fetch
             * and the decode/dither, timed on the same clock as the writes, so
             * the overlap between them stops being a hypothesis.
             */
            /**
             * Reproduce the host pausing us and never sending us back.
             *
             * The measured freeze was FOREGROUND_EXIT with no matching ENTER,
             * which is a host event and cannot be injected from outside. This
             * is how the recovery path gets exercised without waiting for a
             * pair of glasses to misbehave again — the telemetry page drives it
             * behind ?stuck=1.
             */
            export function simulateHostPause() {
                pauseForBackground();
            }

            let workObserver = null;
            export function setWorkObserver(fn) { workObserver = fn; }

            async function timed(kind, meta, fn) {
                if (!workObserver) return fn();
                const startedAt = Date.now();
                let ok = true;
                try {
                    return await fn();
                } catch (e) {
                    ok = false;
                    throw e;
                } finally {
                    const endedAt = Date.now();
                    workObserver({
                        kind, ok, ...meta,
                        enqueuedAt: startedAt, startedAt, endedAt,
                        queuedMs: 0, durationMs: endedAt - startedAt,
                    });
                }
            }

            let lifecycleObserver = null;
            export function setLifecycleObserver(fn) { lifecycleObserver = fn; }
            function noteLifecycle(what, detail = {}) {
                if (lifecycleObserver) lifecycleObserver(what, detail);
            }

            /**
             * Send synthetic payloads to characterise the link, with no media
             * involved.
             *
             * Worth having because the interesting question — how write time
             * and failure rate vary with payload size — is one a normal session
             * answers badly: real frames cluster around one size, so the
             * regression has almost no range to fit. A sweep gives the analysis
             * the spread it needs, in a minute, on a pair of glasses with
             * nothing configured.
             *
             * The payloads are grey noise at the real geometry, so they
             * compress to something like a real frame rather than to nothing.
             */
            /**
             * Time the prepare path on synthetic frames, with no link and no
             * source involved.
             *
             * The companion to `probeLink`, and needed for the same reason. A
             * real session's prepare numbers are entangled with everything else
             * the phone was doing; this runs the SAME code — `decodeFrame`,
             * the pixel loop, the PNG encode — on frames it makes itself, so
             * the phases can be compared against `tools/pixel-bench.mjs`, which
             * says the arithmetic is half a millisecond. A phone that reports
             * seconds here is not doing arithmetic slowly.
             *
             * It needs no glasses, so it also runs in the simulator, which is
             * how the image path gets exercised at all when there is no account
             * to authenticate against.
             */
            export async function probePrepare({
                runs = 12,
                sourceWidth = 320,
                sourceHeight = 180,
            } = {}) {
                const src = document.createElement("canvas");
                src.width = sourceWidth;
                src.height = sourceHeight;
                const sctx = src.getContext("2d");

                // Something with gradients and edges, because a flat field
                // dithers to nothing and compresses to nothing — neither the
                // encode nor the decode would be doing representative work.
                const g = sctx.createLinearGradient(0, 0, sourceWidth, sourceHeight);
                g.addColorStop(0, "#101820");
                g.addColorStop(0.5, "#c8d0d8");
                g.addColorStop(1, "#201810");
                sctx.fillStyle = g;
                sctx.fillRect(0, 0, sourceWidth, sourceHeight);
                for (let i = 0; i < 40; i++) {
                    sctx.fillStyle = `rgba(${(i * 37) % 256},${(i * 91) % 256},${(i * 53) % 256},0.5)`;
                    sctx.fillRect(
                        (i * 71) % sourceWidth, (i * 43) % sourceHeight,
                        8 + (i % 17), 6 + (i % 13),
                    );
                }
                // JPEG, because that is what a provider hands over, and a JPEG
                // decode is not a PNG decode.
                const blob = await new Promise((r) => src.toBlob(r, "image/jpeg", 0.8));

                // Does the faster decode path give the SAME pixels?
                //
                // `createImageBitmap` replaced an <img> and an object URL to get
                // the decode off the main thread. That is only a free win if
                // the two decoders agree, and a WebView is not obliged to make
                // them agree — colour management and premultiplication are both
                // "default" here, which means implementation-defined. So it is
                // checked on the device rather than assumed on mine.
                const decodeAgrees = await (async () => {
                    if (typeof createImageBitmap !== "function") return null;
                    const draw = async (via) => {
                        const c = document.createElement("canvas");
                        c.width = GLASSES_IMAGE_WIDTH;
                        c.height = GLASSES_IMAGE_HEIGHT;
                        const x = c.getContext("2d", { willReadFrequently: true });
                        x.drawImage(via, 0, 0, c.width, c.height);
                        return x.getImageData(0, 0, c.width, c.height).data;
                    };
                    const bmp = await createImageBitmap(blob);
                    const a = await draw(bmp);
                    if (bmp.close) bmp.close();
                    const url = URL.createObjectURL(blob);
                    try {
                        const el = await new Promise((res, rej) => {
                            const i = new Image();
                            i.onload = () => res(i);
                            i.onerror = rej;
                            i.src = url;
                        });
                        const b = await draw(el);
                        let worst = 0;
                        for (let i = 0; i < a.length; i++) {
                            const d = Math.abs(a[i] - b[i]);
                            if (d > worst) worst = d;
                        }
                        return worst;
                    } finally {
                        URL.revokeObjectURL(url);
                    }
                })();

                const totals = [];
                let outBytes = 0;
                for (let n = 0; n < runs; n++) {
                    const t0 = Date.now();
                    const out = await resizeAndPrepareImage(
                        blob, GLASSES_IMAGE_WIDTH, GLASSES_IMAGE_HEIGHT, { probe: true },
                    );
                    totals.push(Date.now() - t0);
                    outBytes = out.byteLength;
                    // Yield between runs: back to back they would all land in
                    // one task and measure a burst nothing in the app performs.
                    await new Promise((r) => setTimeout(r, 0));
                }
                totals.sort((a, b) => a - b);
                return {
                    runs,
                    sourceBytes: blob.size,
                    outBytes,
                    // null = no createImageBitmap here; 0 = the two decoders
                    // agree exactly; anything else is the worst channel
                    // disagreement in 0-255, and worth knowing about.
                    decodeMaxDelta: decodeAgrees,
                    p50: totals[Math.floor(runs * 0.5)],
                    p90: totals[Math.floor(runs * 0.9)],
                    max: totals[runs - 1],
                };
            }

            export async function probeLink({ densities = null, perSize = 4 } = {}) {
                // Noise density, not a byte target: what a PNG of dithered grey
                // actually compresses to is not something to predict, and the
                // ACTUAL size is what gets recorded. These five bracket the
                // real operating range — a shipping frame is around 16 KB — so
                // the analysis has spread either side of it to fit against.
                const levels = densities || [0.004, 0.02, 0.06, 0.18, 0.5];
                if (!bridgeInstance) throw new Error("no bridge — connect the glasses first");
                const canvas = document.createElement("canvas");
                canvas.width = GLASSES_IMAGE_WIDTH;
                canvas.height = GLASSES_IMAGE_HEIGHT;
                const ctx = canvas.getContext("2d");

                for (const density of levels) {
                    const img = ctx.createImageData(canvas.width, canvas.height);
                    for (let i = 0; i < img.data.length; i += 4) {
                        const v = Math.random() < density ? (Math.random() * 255) | 0 : 128;
                        img.data[i] = img.data[i + 1] = img.data[i + 2] = v;
                        img.data[i + 3] = 255;
                    }
                    ctx.putImageData(img, 0, 0);
                    const blob = await new Promise((r) => canvas.toBlob(r, "image/png"));
                    const bytes = new Uint8Array(await blob.arrayBuffer());

                    for (let n = 0; n < perSize; n++) {
                        const payload =
                            typeof ImageRawDataUpdate !== "undefined"
                                ? new ImageRawDataUpdate({
                                      containerID: 2, containerName: "g2_bif", imageData: bytes,
                                  })
                                : { containerID: 2, containerName: "g2_bif", imageData: bytes };
                        await ble.sendImage(
                            async (p) =>
                                (await bridgeInstance.updateImageRawData(p)) === "success",
                            payload,
                            { bytes: bytes.byteLength, probe: true },
                        );
                        await ble.sendText(
                            (content) => bridgeInstance.textContainerUpgrade({
                                containerID: 1, containerName: "g2_subs",
                                contentOffset: 0, contentLength: 0, content,
                            }),
                            `probe ${(bytes.byteLength / 1024).toFixed(0)}KB #${n + 1}`,
                        );
                    }
                }
            }

            export async function initBridge() {
                await initEvenBridge();
            }

            /** Skip scenes with no subtitles — a rebuild, not a playback flag. */
            export function setSkipSilent(on) {
                skipSilent = !!on;
                rebuildScenes();
                return sceneStats();
            }

            /**
             * Bandwidth, 0 (fewest images) to 2 (every scene).
             *
             * Named for what the user spends rather than for the mechanism: the
             * pictures are identical, there are fewer of them (UI.md §4.2).
             */
            export function setBandwidth(level) {
                bandwidthStride = [3, 2, 1][Math.max(0, Math.min(2, Number(level)))] ?? 1;
                rebuildScenes();
                return sceneStats();
            }

            export function setPicture(p) {
                if (typeof p.brightness === "number") brightnessValue = p.brightness;
                if (typeof p.contrast === "number") contrastValue = p.contrast;
                if (typeof p.gamma === "number") gammaValue = p.gamma;
                if (p.texture) ditherAlgorithm = p.texture;
                return { brightnessValue, contrastValue, gammaValue, ditherAlgorithm };
            }

            /** What a preview would cost to fetch, or null if the source cannot say. */
            export function previewCostBytes(sceneCount) {
                if (!source || !bifs.length) return null;
                return source.previewCostBytes(bifs, sceneCount);
            }

            /**
             * `n` scenes spread across the item, rendered through the SAME image
             * path the glasses get — grey, quantised, dithered, at the real
             * 256x128. The point of a preview here is to answer "will this
             * content survive my display", which a colour thumbnail cannot.
             */
            export async function previewScenes(n = 3) {
                if (!sceneList.length) return [];
                const step = Math.max(1, Math.floor(sceneList.length / n));
                const picked = [];
                for (let i = 0; i < sceneList.length && picked.length < n; i += step) {
                    picked.push(sceneList[i]);
                }

                const out = [];
                for (const sc of picked) {
                    const { blob } = await getFrameAssets(sc.frameIndex);
                    const png = await resizeAndPrepareImage(
                        blob, GLASSES_IMAGE_WIDTH, GLASSES_IMAGE_HEIGHT,
                    );
                    // A cue belongs to the window it STARTS in (F-010).
                    const cue = subtitles.find(
                        (c) => c.startMs >= sc.startMs && c.startMs < sc.endMs,
                    );
                    out.push({
                        url: URL.createObjectURL(new Blob([png], { type: "image/png" })),
                        text: cue ? cleanSubText(cue.text) : "",
                        tsMs: sc.startMs,
                    });
                }
                return out;
            }

            /** Re-render the preview strip after a picture change, same scenes. */
            export function pictureIsLive() {
                if (!isPlaying) return;
                updateUI();
                sendOneShotUpdate();
            }

            export function play() {
                if (isPlaying || !sceneList.length) return;
                isPlaying = true;
                backgroundedWhilePlaying = false;
                playBtn.innerText = "Pause";
                silentAudio.play().catch(() => {});
                setStatus(`Now playing: ${currentItem?.title || "media"}`, "active");
                ui.playing(true);
                // The pipeline drives the timeline — no clock needed.
                runScenePipeline();
            }

            export function pause() {
                if (!isPlaying) return;
                isPlaying = false;
                playBtn.innerText = "Play";
                stopScenePipeline();
                try { silentAudio.pause(); } catch (e) {}
                setStatus(`Paused: ${currentItem?.title || "media"}`, "active");
                ui.playing(false);
            }

            export function togglePlay() {
                if (isPlaying) pause(); else play();
            }

            export function seekTo(ms) {
                // Touching the transport at all is a statement that the wearer
                // is here and wants it running. Seeking used to fire a single
                // frame and leave playback stopped, which is why a frozen
                // session could be nudged into sending images one drag at a
                // time and never actually resume.
                if (backgroundedWhilePlaying) resumeFromBackground("seek");
                const wasPlaying = isPlaying;
                if (wasPlaying) stopScenePipeline();
                currentTimeMs = Number(ms);
                updateUI();
                sendOneShotUpdate();
                if (wasPlaying && isPlaying) runScenePipeline();
            }

            /** Leave the item. The one moment every object URL is certainly dead. */
            export function stop() {
                isPlaying = false;
                stopScenePipeline();
                stopClock();
                hideLoadProgress();
                clearFrameCache();
                playBtn.innerText = "Play";
                try { silentAudio.pause(); } catch (e) {}
                if (bridgeInstance) sendSubtitleToGlasses("Stream terminated.").catch(() => {});
                if (source && source.release) source.release();
                resetPipelineState();
                ui.playing(false);
                ui.stopped();
            }

            // The player's own two controls stay wired here: they act on engine
            // state and have no flow meaning, unlike every other button.
            //
            // Guarded, because importing this module must not depend on a
            // particular page's markup. The telemetry page found that the hard
            // way: it has no transport bar, and the engine threw at import.
            if (playBtn) playBtn.onclick = togglePlay;
            if (timeline) timeline.oninput = (e) => seekTo(e.target.value);
