// @ts-nocheck
import {
    waitForEvenAppBridge,
    ImageRawDataUpdate,
    OsEventTypeList
} from "@evenrealities/even_hub_sdk";
import { buildSceneList, thinScenes } from "./scenes";
import { createBleTransport } from "./bletransport";
import { toGlassesLevels, expandBlocks } from "./pixels";
import { createQualityController } from "./quality";
import { encodeGreyPng } from "./png";
import * as store from "./store";

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
                /** Start the nth remembered item — the glasses' own way in. */
                playRecent: (_index) => {},
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
            /** Frames come off the network; subtitles do not. See sendImageToGlasses. */
            let consecutiveFetchFailures = 0;
            const FETCH_FAILURES_BEFORE_SAYING_SO = 3;
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
                        content: IDLE_TEXT,
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
                        startupPageReady = true;
                        setStatus("G2 Glass Engine Connected via BLE!", "active");
                        // The idle screen: the frame, and the picker if there is
                        // anything to pick. Failures here are cosmetic.
                        showIdleSkeleton().catch(() => {});
                        if (recentTitles.length) showRecentOnGlasses().catch(() => {});
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
            /**
             * Tell the GLASSES what is coming. The idle line says "Select video
             * to begin"; once something is chosen it should name it, because
             * reading the index and subtitles takes a few seconds and the wearer
             * is looking at the glasses, not at the phone.
             */
            export function announceLoading(title) {
                if (!bridgeInstance || !title) return;
                if (showingRecent) applyPage("player").catch(() => {});
                ble.forgetText();
                sendSubtitleToGlasses(`Loading ${title}`).catch(() => {});
            }

            async function prepareItem(item) {
                // Stop whatever is running FIRST. Choosing something from the
                // recent list while an episode was playing left both pipelines
                // alive, and the wearer got two films interleaved on one screen.
                if (isPlaying || scenePipelineRunning) {
                    noteLifecycle("playback-stopped", { by: "another item was chosen" });
                    isPlaying = false;
                    stopScenePipeline();
                    try { silentAudio.pause(); } catch (e) {}
                    playBtn.innerText = "Play";
                    ui.playing(false);
                }
                document.getElementById("playing-title").textContent = item.title;

                // On the GLASSES too. The idle line says "Select video to begin";
                // once something is selected it should say what is coming, since
                // reading the index and the subtitles takes a few seconds and the
                // wearer is looking at the glasses, not the phone.
                announceLoading(item.title);

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
                ensureMenu();
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

            /**
             * 4 unless the host has told us it cannot read a 4-bit PNG.
             *
             * Not a preference — 4-bit greyscale is the display's own format,
             * and its samples scale by exactly the 17 the dither quantises to.
             * The retreat exists because the decoder lives in someone else's
             * firmware, and because the bridge says so out loud when it fails
             * rather than returning a plausible-looking success.
             */
            /**
             * How a frame is encoded for the glasses, in order of preference.
             *
             * A ladder rather than a constant, because hardware disagreed with
             * the simulator and there is no way to tell from here which rung
             * works. A session on a Pixel 10 had every synthetic payload land
             * (0, 4, 12, 28 and 44 KB, all made by `canvas.toBlob`) while every
             * REAL frame failed — and the only thing separating them was the
             * encoding, since 16 KB sits between two sizes that worked.
             *
             * The glasses answered `sendFailed` for all of them, which says
             * nothing about why, so the app finds out by trying:
             *
             *   grey4  4-bit greyscale, our encoder    16 KB, 0.07 ms
             *   grey8  8-bit greyscale, our encoder    33 KB, 0.1 ms
             *   rgba   whatever `canvas.toBlob` makes  ~16 KB, SECONDS (F-048)
             *
             * The last rung is the one measured at p50 4022 ms, so it is a
             * genuine last resort — but a slow picture beats no picture, and it
             * is the only encoding this hardware has ever been seen to accept.
             */
            const IMAGE_FORMATS = ["grey4", "grey8", "rgba"];
            let formatIndex = 0;
            /** Failures in a row before trying the next rung. */
            const ESCALATE_AFTER = 2;

            /**
             * Formats that have delivered at least one frame THIS session.
             *
             * A format that has worked cannot be the reason frames stop. A
             * session ran grey4 for ten minutes, then every image failed — and
             * the ladder read that as an encoding problem, climbed through grey8
             * to the four-second `toBlob` rung, and changed nothing, because the
             * encoding was never what broke. Once a rung is proven, failures go
             * to recovery instead of to the next rung.
             */
            const provenFormats = new Set();

            function currentFormat() { return IMAGE_FORMATS[formatIndex]; }

            /**
             * Deliberately NOT restored from storage any more.
             *
             * The ladder used to persist every escalation, so the session above
             * saved `rgba` as this device's format — and every launch after it
             * would have started on the slowest encoder there is, on hardware
             * where grey4 is proven. A wedge is a moment, not a property of the
             * device. Rediscovering a rung costs a couple of failed frames once
             * per launch; remembering a wrong one costs four seconds a frame
             * for ever. The old key is simply no longer read.
             */
            function loadImageFormat() { formatIndex = 0; }

            function escalateFormat(why) {
                if (formatIndex >= IMAGE_FORMATS.length - 1) return false;
                if (provenFormats.has(currentFormat())) return false;
                const from = currentFormat();
                formatIndex++;
                console.warn(
                    `[Image] ${from} failed ${why} — trying ${currentFormat()} instead`,
                );
                noteLifecycle("image-format-changed", { from, to: currentFormat(), why });
                return true;
            }

            /**
             * Climb back down the FORMAT ladder when frames are landing.
             *
             * It only ever went up. A session escalated to grey8 during a bad
             * patch and then sent 32 KB PNGs for the rest of its life with
             * nothing failing — twice the bytes across the bridge for a picture
             * the host re-encodes anyway. Rungs above grey4 exist for hardware
             * that cannot read grey4 at all, and that is a property of the
             * device, so it is worth re-testing once things are healthy.
             */
            let formatGoodRun = 0;
            let formatProbeAfter = 10;
            let formatProbing = false;
            function maybeRestoreFormat() {
                if (formatIndex === 0) { formatProbing = false; return; }
                formatGoodRun++;
                if (formatProbing && formatGoodRun >= 2) {
                    // The lower rung is holding.
                    formatProbing = false;
                    formatProbeAfter = 10;
                    return;
                }
                if (formatProbing || formatGoodRun < formatProbeAfter) return;
                const from = currentFormat();
                formatIndex--;
                formatGoodRun = 0;
                formatProbing = true;
                console.warn(`[Image] ${from} has been fine for a while — trying ${currentFormat()} again`);
                noteLifecycle("image-format-changed", { from, to: currentFormat(), why: "probe back down" });
            }

            /**
             * The last rung: hand the canvas to the host and wait.
             *
             * This is the path F-048 removed for costing four seconds. It is
             * back only as a fallback, for hardware that will not take anything
             * our own encoder produces.
             */
            function encodeViaHost(canvas) {
                return new Promise((resolve, reject) => {
                    canvas.toBlob(async (out) => {
                        if (!out) { reject(new Error("Canvas toBlob failed")); return; }
                        try { resolve(new Uint8Array(await out.arrayBuffer())); }
                        catch (e) { reject(e); }
                    }, "image/png");
                });
            }

            /**
             * How much picture to send, moved by how sends are going (F-050).
             * With the phone locked the link slows and full frames time out;
             * see src/quality.ts for the measurements and the rules.
             */
            const pictureQuality = createQualityController();
            /**
             * Ignore one sample after playback restarts.
             *
             * The first frame out of a resume or a seek queues behind the
             * one-shot update that goes with it, and the ladder read that queue
             * wait as a slow link.
             */
            let skipNextQualitySample = false;

            /** Harness only: show what a given picture level looks like on the glasses. */
            export function forcePictureQuality(name) {
                const rung = pictureQuality.force(name);
                noteLifecycle("picture-quality", { to: rung.name, why: "forced by harness" });
                return rung.name;
            }

            async function resizeAndPrepareImage(blob, targetWidth, targetHeight, meta = {}) {
                const bitmap = await timed("decode", meta, () => decodeFrame(blob));
                // Read once: the rung can move while this frame is being made,
                // and the send has to report the rung it was actually made at.
                const rung = pictureQuality.current;
                meta.quality = rung.name;
                try {
                    const { canvas, ctx } = prepSurface(targetWidth, targetHeight);
                    const levels = await timed("pixels", meta, () => {
                        const sw = targetWidth / rung.block, sh = targetHeight / rung.block;
                        ctx.clearRect(0, 0, targetWidth, targetHeight);
                        ctx.drawImage(bitmap, 0, 0, sw, sh);
                        const d = ctx.getImageData(0, 0, sw, sh);
                        const small = toGlassesLevels(d.data, sw, sh, {
                            brightness: brightnessValue,
                            contrast: contrastValue,
                            gamma: gammaValue,
                            dither: ditherAlgorithm === "ordered-4x4" ? "bayer" : ditherAlgorithm,
                            shades: rung.shades,
                        });
                        return expandBlocks(small, sw, sh, rung.block);
                    });
                    // Our own encoder for the first two rungs: synchronous,
                    // about a tenth of a millisecond, against the four seconds
                    // `toBlob` cost on real hardware (F-048). The last rung
                    // pays that cost because some hardware takes nothing else.
                    const format = currentFormat();
                    return await timed("encode", { ...meta, format }, async () => {
                        if (format === "grey4") return encodeGreyPng(levels, targetWidth, targetHeight, 4);
                        if (format === "grey8") return encodeGreyPng(levels, targetWidth, targetHeight, 8);
                        // rgba: the pixels are already on the canvas, but they
                        // are the ORIGINAL ones — the dither wrote to a plane,
                        // not back to the surface. Put them there first, or the
                        // fallback would quietly send an undithered frame.
                        const d = ctx.getImageData(0, 0, targetWidth, targetHeight);
                        for (let i = 0; i < levels.length; i++) {
                            const v = levels[i] * 17, o = i << 2;
                            d.data[o] = d.data[o + 1] = d.data[o + 2] = v;
                            d.data[o + 3] = 255;
                        }
                        ctx.putImageData(d, 0, 0);
                        return await encodeViaHost(canvas);
                    });
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
            let skipSilent = false;   // off unless the wearer asks; see the settings overlay
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

            /** In-flight waits, so a heartbeat can say what a silence was stuck behind. */
            const activity = new Map();
            let activitySeq = 0;
            async function during(what, work) {
                const key = ++activitySeq;
                activity.set(key, { what, since: Date.now() });
                try { return await work; } finally { activity.delete(key); }
            }

            // --- IMAGE BACKOFF ---------------------------------------------
            //
            // When the glasses stop taking pictures, stop throwing pictures at
            // them. A hardware session showed the image path refusing everything
            // for four minutes, each refusal taking FIVE SECONDS OR MORE of host
            // effort, while the app sent another every scene — and three
            // accepted page rebuilds changed nothing, so the page was never the
            // problem. Subtitles carried on throughout.
            //
            // Two things this buys. It stops a wedged image path being hammered
            // back into the ground every few seconds, which may be what keeps it
            // wedged. And it turns "does it recover if left alone?" from a guess
            // into a line in the report: every backoff and every resumption is
            // marked.
            // Tuned down after a locked session where backoff did more harm than
            // good: pictures at the smallest level were still landing about half
            // the time, and pauses of 10, 20, 40 and then 60 seconds made the
            // longest freeze 226s — mostly deliberate. Now it only engages once
            // the picture ladder has nothing smaller to try, needs a longer run of
            // failures there, and never pauses for more than 20s.
            const BACKOFF_AFTER = 6;                    // failures in a row, at the smallest level
            const BACKOFF_STEPS_MS = [10000, 20000];
            /** Faster than this, a failure is the glasses REFUSING, not a transfer timing out. */
            const QUICK_REFUSAL_MS = 2000;
            let imageBackoffUntil = 0;
            let backoffStep = 0;
            let skippedDuringBackoff = 0;

            function imagesBackingOff() {
                return Date.now() < imageBackoffUntil;
            }

            async function sendImageToGlasses(frameIndex) {
                if (!bridgeInstance || frameIndex == null || frameIndex < 0) return 0;
                if (imagesBackingOff()) {
                    // Not even fetched: the frame would be stale by the time the
                    // backoff ends, and the network is not the thing resting.
                    skippedDuringBackoff++;
                    return 0;
                }
                const frame = bifs[frameIndex];

                // The bytes come from the SOURCE, one frame at a time, rather
                // than every frame being materialised at load time (F-005).
                // How that fetch happens is the provider's business: a ranged
                // GET on Plex, a crop out of a cached sheet elsewhere.
                let assets;
                const cached = !!peekFrameUrl(frameIndex);
                try {
                    assets = await during("frame fetch", timed("fetch", { frameIndex, cached },
                        () => getFrameAssets(frameIndex)));
                } catch (e) {
                    // A frame comes off the network every scene; the subtitles
                    // were parsed once at load and live in memory. So when the
                    // server becomes unreachable — the token expired, the phone
                    // moved off the WiFi the plex.direct address points at, the
                    // connection went stale over a long sleep — the picture
                    // freezes and the dialogue carries on as if nothing is
                    // wrong. That is exactly what the first beta reported, and
                    // this used to be a console warning nobody could see.
                    consecutiveFetchFailures++;
                    console.warn(
                        `[frame] fetch failed at ${bifs[frameIndex]?.tsMs}ms ` +
                        `(${consecutiveFetchFailures} in a row): ${e.message}`,
                    );
                    noteLifecycle("frame-fetch-failed", {
                        frameIndex, run: consecutiveFetchFailures, error: String(e?.message || e),
                    });
                    if (consecutiveFetchFailures === FETCH_FAILURES_BEFORE_SAYING_SO) {
                        // Said once, at a threshold, rather than on every frame:
                        // one failed fetch is a blip worth retrying silently,
                        // and a run of them is a broken session the wearer is
                        // otherwise given no reason to suspect.
                        setStatus(
                            "Picture stopped — cannot reach the server. Subtitles are from memory.",
                            "error",
                        );
                    }
                    return 0;
                }
                if (consecutiveFetchFailures > 0) {
                    console.log(
                        `[frame] fetch recovered after ${consecutiveFetchFailures} failure(s)`,
                    );
                    if (consecutiveFetchFailures >= FETCH_FAILURES_BEFORE_SAYING_SO) {
                        const title =
                            document.getElementById("playing-title")?.textContent || "media";
                        setStatus(`Now playing: ${title}`, "active");
                    }
                    consecutiveFetchFailures = 0;
                }

                const prepMeta = { frameIndex };
                const preparedBytes = await timed("prepare", { frameIndex }, () =>
                    resizeAndPrepareImage(
                        assets.blob,
                        GLASSES_IMAGE_WIDTH,
                        GLASSES_IMAGE_HEIGHT,
                        prepMeta,
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
                // Filled in by the send below and read by the transport when it
                // writes the record — which is why it is one object rather than
                // a value passed in.
                const imageMeta = { tsMs: frame.tsMs, bytes: preparedBytes.byteLength,
                    quality: prepMeta.quality };
                const sendStartedAt = Date.now();
                const r = await during("image write", ble.sendImage(
                    async (p) => {
                        if (imageWedgeInjected ||
                            (rejectImagesUntilFormat && currentFormat() !== rejectImagesUntilFormat)) {
                            lastResult = "sendFailed";
                            imageMeta.result = lastResult;
                            return false;
                        }
                        lastResult = await during("glasses answering an image",
                            bridgeInstance.updateImageRawData(p));
                        imageMeta.result = lastResult;
                        return lastResult === "success";
                    },
                    payload,
                    // `result` rides along so the REPORT can say why, not just
                    // how many. A session came back reading "0 sent, 20 failed"
                    // with no other clue, and the cause had to be inferred from
                    // the write times all being 0ms. The SDK told us the reason
                    // every single time; we were throwing it away.
                    imageMeta,
                ));

                // The glasses can fail to READ a frame rather than fail to
                // receive it, and they say which. 4-bit greyscale is the
                // display's own format, but the decoder is in someone else's
                // firmware — so the exact format is tried, the answer is
                // watched, and the session drops to 8-bit if it has to.
                // Feed the picture ladder the frame's real cost — wall clock,
                // not the transport's capped duration, since "how slow" is the
                // whole signal. A superseded frame never went out and says
                // nothing about the link.
                if (r.reason !== "superseded" && !skipNextQualitySample) {
                    // The transport's own duration — the WRITE — not wall clock
                    // from when this function asked. Resuming fires a one-shot
                    // update and the pipeline together, so the second send waits
                    // behind the first and read as a 4s "slow link": the picture
                    // dropped a level every single time playback was resumed.
                    const took = r.ok ? (r.duration ?? (Date.now() - sendStartedAt))
                                      : (Date.now() - sendStartedAt);
                    const change = pictureQuality.onResult(r.ok, took);
                    if (change) {
                        noteLifecycle("picture-quality", change);
                        console.warn(`[Picture] ${change.from} -> ${change.to} (${change.why})`);
                    }
                }
                skipNextQualitySample = false;

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
                    lastImageSuccessWall = performance.now();
                }
                // BOTH outcomes, through the one place that keeps the books.
                // Only failures used to come here, so during playback no format
                // was ever marked proven — and the rule that stops the ladder
                // climbing past a format that works could never fire in the
                // exact situation it was written for.
                await noteImageResult(r.ok, lastResult,
                    { ms: Date.now() - sendStartedAt, quality: prepMeta.quality });

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
            // --- WHAT THE GLASSES SHOW WHEN NOTHING IS PLAYING ------------------
            //
            // The first thing a wearer sees used to be "Sign in to Plex", which
            // is both wrong (they are usually signed in already) and an
            // instruction they cannot act on from the glasses. The idle screen
            // is now the shape of the thing that is coming — a thin frame where
            // the picture will be — and an invitation.
            const IDLE_TEXT = "Select video to begin";
            const MENU_RETURN_ID = 1;
            const MENU_PLAYPAUSE_ID = 2;
            const MENU_RESTART_ID = 4;
            const RECENT_CONTAINER_ID = 3;

            /** Titles of the last few played items, set by the flow (src/ui.ts). */
            let recentTitles = [];
            let menuSignature = "";
            let lastMenuShape = "";

            /**
             * Rebuild only when the menu's SHAPE changes — loading an item adds
             * Play/Pause and Stop, stopping takes them away. A rebuild empties
             * the image container, so doing it on any other schedule would blank
             * the picture for no reason.
             */
            function ensureMenu() {
                if (!bridgeInstance || !startupPageReady) return;
                const shape = menuShape();
                if (shape === lastMenuShape) return;
                lastMenuShape = shape;
                applyPage(showingRecent ? "recent" : "player").catch(() => {});
            }
            export function setRecentTitles(titles) {
                recentTitles = (titles || []).slice(0, 5).map((t) => String(t || "").slice(0, 40));
                // Rebuild only when the MENU would actually change. Rebuilding
                // unconditionally wiped the idle frame that had just been drawn:
                // the flow calls this at boot, milliseconds after the picture
                // went out, and a rebuild empties the image container.
                const sig = recentTitles.join("\u0000");
                if (sig === menuSignature) return;
                menuSignature = sig;
                if (!bridgeInstance) return;
                // ONLY when the picker is on screen. The labels carry a resume
                // time that moves as playback advances, so this fires every
                // fifteen seconds while watching — and a rebuild empties the
                // image container. That is what the wearer saw as the whole
                // display blanking and redrawing between scenes, all session.
                // The titles are still updated; the picker is built from them
                // the next time it is shown.
                if (showingRecent) applyPage("recent").catch(() => {});
                else ensureMenu();
            }

            /** Which page the glasses are on: the picker, or the player. */
            let showingRecent = false;
            /** When the contextual menu last did something — see the FOREGROUND_EXIT guard. */
            let menuActiveAt = 0;
            let foregroundEnteredAt = 0;

            /**
             * The contextual menu, raised on the glasses with tap-then-long-press.
             *
             * Labels are verbs, not state: the menu is replaced wholesale by a
             * page rebuild and cannot be edited item by item, so one "Play /
             * Pause" entry that toggles beats two entries that lie half the time.
             * A rebuild also clears the picture, so the set only changes when
             * there is a real change of state — loaded or not.
             */
            function menuObject() {
                const items = [];
                if (sceneList.length) {
                    items.push({ itemID: MENU_PLAYPAUSE_ID, itemName: "Play / Pause" });
                    items.push({ itemID: MENU_RESTART_ID, itemName: "Play from start" });
                }
                // One way back: stopping and showing the list were two entries
                // for what is, from the wearer's side, a single intention.
                if (sceneList.length || recentTitles.length) {
                    items.push({ itemID: MENU_RETURN_ID, itemName: "Return to list" });
                }
                return items.length ? { menuItems: items } : undefined;
            }

            /** What the menu currently offers, so a rebuild happens only when it changes. */
            function menuShape() {
                return (menuObject()?.menuItems || []).map((m) => m.itemID).join(",");
            }

            function recentListContainer() {
                return {
                    xPosition: 72, yPosition: 24, width: 432, height: 240,
                    borderWidth: 0, containerID: RECENT_CONTAINER_ID, containerName: "g2_recent",
                    isEventCapture: 1,
                    itemContainer: {
                        itemCount: recentTitles.length,
                        itemWidth: 432,
                        isItemSelectBorderEn: 1,
                        itemName: recentTitles,
                    },
                };
            }

            /**
             * Put the glasses on one page or the other.
             *
             * `rebuildPageContainer` is the call for a page after launch (F-047);
             * the startup declaration happens once, at connect.
             */
            async function applyPage(which) {
                if (!bridgeInstance || typeof bridgeInstance.rebuildPageContainer !== "function") return false;
                const wantRecent = which === "recent" && recentTitles.length > 0;
                const page = wantRecent
                    ? { containerTotalNum: 2,
                        listObject: [recentListContainer()],
                        // `isEventCapture: 0` is load-bearing: ONE container per
                        // page may capture events, and a page with two is
                        // refused outright — `rebuildPageContainer` returns
                        // false, with no error and nothing in the SDK's own
                        // validator to catch it (F-053). The subtitle container
                        // this is cloned from captures events, so the copy must
                        // give that up to the list.
                        textObject: [{ ...glassesSubtitleContainer, yPosition: 264, height: 24,
                            isEventCapture: 0, content: "Tap to start" }] }
                    : { containerTotalNum: 2,
                        // Blank while playing. The container's default content is
                        // the idle invitation, and a rebuild puts it back on
                        // screen — so "Select video to begin" appeared under the
                        // picture during every quiet stretch.
                        textObject: [{ ...glassesSubtitleContainer,
                            content: isPlaying ? " " : IDLE_TEXT }],
                        imageObject: [glassesImageContainer] };
                if (menuObject()) page.menuObject = menuObject();
                const ok = (await bridgeInstance.rebuildPageContainer(page)) === true;
                if (ok) {
                    lastMenuShape = menuShape();
                    showingRecent = wantRecent;
                    ble.forgetText();
                    // A rebuild empties the image container, so the idle frame
                    // has to be put back — otherwise the picture area is simply
                    // blank until something plays.
                    if (!wantRecent && !isPlaying) showIdleSkeleton().catch(() => {});
                }
                noteLifecycle("page-shown", { which: wantRecent ? "recent" : "player", ok });
                console.log(`[Page] ${wantRecent ? "recent list" : "player"}: ` +
                    `${ok ? "shown" : "REFUSED by the host"} (${recentTitles.length} recent)`);
                return ok;
            }

            /** Show the recent-items picker on the glasses. */
            export async function showRecentOnGlasses() {
                return applyPage("recent");
            }

            /** Back to the picture-and-subtitle page. */
            export async function showPlayerOnGlasses() {
                return applyPage("player");
            }

            /**
             * The idle screen's picture: a thin frame where the video will be.
             *
             * Sent as a real frame rather than described, because the image
             * container shows whatever was last put in it — which, before this,
             * was nothing at all.
             */
            async function showIdleSkeleton() {
                if (!bridgeInstance) return;
                const w = GLASSES_IMAGE_WIDTH, h = GLASSES_IMAGE_HEIGHT;
                const levels = new Uint8Array(w * h);      // 0 = dark
                // Full brightness: the display is monochrome and a dim outline on
                // a dark field is not a visible frame, it is nothing.
                const edge = 3;
                const CORNER_X = 40, CORNER_Y = 26;
                for (let y = 0; y < h; y++) {
                    for (let x = 0; x < w; x++) {
                        const onEdge = x < edge || y < edge || x >= w - edge || y >= h - edge;
                        if (!onEdge) continue;
                        // Corner brackets rather than a full box: it reads as
                        // "a picture goes here" instead of an empty panel.
                        const inCorner = (x < CORNER_X || x >= w - CORNER_X) ||
                                         (y < CORNER_Y || y >= h - CORNER_Y);
                        if (inCorner) levels[y * w + x] = 15;
                    }
                }
                const png = encodeGreyPng(levels, w, h, 4);
                const payload = typeof ImageRawDataUpdate !== "undefined"
                    ? new ImageRawDataUpdate({ containerID: 2, containerName: "g2_bif", imageData: png })
                    : { containerID: 2, containerName: "g2_bif", imageData: png };
                const r = await ble.sendImage(
                    async (pl) => (await bridgeInstance.updateImageRawData(pl)) === "success",
                    payload, { idle: true, bytes: png.byteLength },
                );
                console.log(`[Idle] frame ${r.ok ? "shown" : `failed (${r.reason})`}`);
            }

            async function createGlassesContainers() {
                return await bridgeInstance.createStartUpPageContainer({
                    containerTotalNum: 2,
                    textObject: [glassesSubtitleContainer],
                    imageObject: [glassesImageContainer],
                });
            }

            /**
             * Rebuild the page on a RUNNING app.
             *
             * Not `createStartUpPageContainer` again. The SDK documents that one
             * as the call made when the app launches, with `rebuildPageContainer`
             * for every page after it — and on hardware a second startup call
             * answers `1`, invalid. Every container repair this app ever
             * attempted on the glasses got exactly that: the F-047 recovery
             * called the startup method, was refused, and changed nothing. It
             * only looked like it worked in the simulator because the injected
             * fault cleared on the CALL rather than on the call succeeding.
             *
             * @returns true when the host accepted the rebuild.
             */
            async function rebuildGlassesContainers() {
                if (typeof bridgeInstance.rebuildPageContainer !== "function") return false;
                const ok = (await bridgeInstance.rebuildPageContainer({
                    containerTotalNum: 2,
                    textObject: [glassesSubtitleContainer],
                    imageObject: [glassesImageContainer],
                })) === true;
                // Injected faults clear only on a rebuild that WORKED — the
                // mistake above was a test double more forgiving than the host.
                if (ok) {
                    containerLossInjected = false;
                    if (!wedgeSurvivesRebuild) imageWedgeInjected = false;
                }
                return ok;
            }

            /** Set once `createStartUpPageContainer` has answered 0. */
            let startupPageReady = false;
            let lastContainerRepairAt = 0;
            let consecutiveSubtitleFailures = 0;
            const CONTAINER_REPAIR_AFTER = 2;      // failures in a row
            const CONTAINER_REPAIR_COOLDOWN_MS = 15000;

            /**
             * Re-declare the containers when the evidence says ONE channel is
             * dead and the link is not.
             *
             * Originally this only ran one way — text dead, images alive — and
             * the first beta produced the mirror image: the picture froze while
             * subtitles carried on for the rest of the session, with nothing in
             * the code able to notice. The asymmetry is the signal whichever
             * way round it points, so the direction is a parameter.
             *
             * The trigger is deliberately not "we saw a disconnect event": the
             * session that produced this had a genuine hardware disconnect AND
             * an unrelated Bluetooth device dropping, and there is no reason to
             * trust that every way of losing a container announces itself.
             * Repeated text failures while images keep landing is the symptom
             * itself, and it is available without knowing the cause.
             */
            /**
             * One place every image outcome passes through, whoever sent it.
             *
             * Made shared because the payload sweep was not using it: a sweep
             * run against a dead image container produced twenty rejections,
             * attempted no recovery, and reported a link problem that was not
             * one.
             */
            /**
             * @param sent.ms       how long the send took, when known.
             * @param sent.quality  the picture level it was made at, when known.
             *   Unknown only for the simulator harnesses' injected wedges.
             */
            async function noteImageResult(ok, result, sent = {}) {
                if (ok) {
                    provenFormats.add(currentFormat());
                    maybeRestoreFormat();
                    if (backoffStep > 0) {
                        noteLifecycle("image-resumed", {
                            afterBackoffs: backoffStep, skipped: skippedDuringBackoff,
                        });
                        console.warn(`[Recovery] Images are landing again after ` +
                            `${backoffStep} backoff(s), ${skippedDuringBackoff} frame(s) skipped`);
                    }
                    backoffStep = 0;
                    skippedDuringBackoff = 0;
                    imageBackoffUntil = 0;
                    consecutiveImageFailures = 0;
                    return;
                }
                consecutiveImageFailures++;
                imageFailureCount++;
                if (formatProbing) {
                    // The rung we dropped back to is not accepted after all.
                    formatProbing = false;
                    formatGoodRun = 0;
                    formatProbeAfter = Math.min(formatProbeAfter * 2, 160);
                    if (formatIndex < IMAGE_FORMATS.length - 1) formatIndex++;
                }

                // Back off once failures are clearly not a blip. Each further
                // failure — which can only be the single probe frame let through
                // when a backoff ends — lengthens the next one.
                const atSmallest = sent.quality == null || sent.quality === pictureQuality.current.name &&
                    pictureQuality.atLowest;
                if (atSmallest && consecutiveImageFailures >= BACKOFF_AFTER && !imagesBackingOff()) {
                    const ms = BACKOFF_STEPS_MS[Math.min(backoffStep, BACKOFF_STEPS_MS.length - 1)];
                    backoffStep++;
                    imageBackoffUntil = Date.now() + ms;
                    noteLifecycle("image-backoff", {
                        ms, step: backoffStep, afterFailures: consecutiveImageFailures, result,
                    });
                    console.warn(`[Recovery] ${consecutiveImageFailures} image failures in a row — ` +
                        `pausing pictures for ${ms / 1000}s (subtitles continue)`);
                }

                // Escalate on repeated failure of a format that has NEVER
                // worked this session — `escalateFormat` refuses a proven one.
                // A format that has delivered frames and then stops is a wedge,
                // not an encoding, and belongs to the rebuild below.
                if (consecutiveImageFailures >= ESCALATE_AFTER &&
                    consecutiveImageFailures % ESCALATE_AFTER === 0 &&
                    escalateFormat(`${consecutiveImageFailures}x (${result || "no reason given"})`)) {
                    return;
                }
                // The mirror of the text case, and the one the beta hit: the
                // picture stopped while subtitles carried on. An instant
                // rejection — the SDK answering before the radio is touched,
                // which is why those writes time at 0ms — is the clearest
                // version of the same signal.
                // Only for a picture the glasses REFUSED quickly. A rebuild answers
                // a lost container, which shows up as an instant rejection; a send
                // that failed after eight seconds is a slow link, and rebuilding
                // the page there only adds another write to it. A locked session
                // rebuilt the page eight times that way, every one accepted and
                // none of them helping.
                if (sent.ms == null || sent.ms < QUICK_REFUSAL_MS) {
                    await repairContainersIfOneChannelIsDead("image");
                }
            }

            async function repairContainersIfOneChannelIsDead(dead) {
                if (!bridgeInstance) return false;
                // Nothing to rebuild until the launch declaration has landed.
                // The bridge object exists before the page does, so a frame sent
                // in that window fails for the plainest reason there is — and a
                // rebuild fired then races the startup call instead of repairing
                // anything. Seen in the simulator as a "wedge" that was really
                // just a sweep started half a second too early.
                if (!startupPageReady) return false;
                // The evidence is the ASYMMETRY: one channel failing while the
                // other keeps landing. Both failing is the link, and
                // re-declaring containers there adds a write to a queue that is
                // already struggling.
                const failures = dead === "text" ? consecutiveSubtitleFailures : consecutiveImageFailures;
                const otherIsFine = dead === "text" ? consecutiveImageFailures === 0
                                                    : consecutiveSubtitleFailures === 0;
                if (failures < CONTAINER_REPAIR_AFTER) return false;
                if (!otherIsFine) return false;
                const now = Date.now();
                if (now - lastContainerRepairAt < CONTAINER_REPAIR_COOLDOWN_MS) return false;

                lastContainerRepairAt = now;
                try {
                    const ok = await rebuildGlassesContainers();
                    console.warn(
                        `[Recovery] ${dead === "text" ? "Text" : "Images"} failed ${failures}x while ` +
                        `${dead === "text" ? "images" : "text"} kept landing — rebuilt the page ` +
                        `(${ok ? "accepted" : "REFUSED"})`,
                    );
                    noteLifecycle("page-rebuilt", { ok, dead, afterFailures: failures });
                    // Whatever the glasses are showing now is not ours, and the
                    // line we most recently "sent" was never drawn.
                    ble.forgetText();
                    return ok;
                } catch (e) {
                    console.error(`[Recovery] Page rebuild threw: ${e?.message || e}`);
                    noteLifecycle("page-rebuilt", { ok: false, dead, afterFailures: failures,
                        error: String(e?.message || e) });
                    return false;
                }
            }

            /**
             * Reproduce the failure above without unplugging anything: text
             * writes fail until the containers are re-declared, which is what a
             * lost container does. Driven by the telemetry page's `?notext=1`.
             */
            /**
             * Make the glasses reject images, the way hardware did: `sendFailed`
             * every time, while text keeps landing. Real rejection cannot be
             * induced from software, and this is the only way to exercise the
             * encoding ladder without a pair of glasses that dislikes our PNGs.
             *
             * `until` is a format name: rejection stops once the ladder reaches
             * it, so a test can assert the app found its way there.
             */
            let rejectImagesUntilFormat = null;
            export function simulateImageRejection(until = "rgba") {
                rejectImagesUntilFormat = until;
                noteLifecycle("injected-image-rejection", { until });
            }

            /**
             * The whole ten-minute wedge, in order, in seconds — for the simulator.
             *
             * 1. a sweep that succeeds, so grey4 is PROVEN on this session;
             * 2. the wedge: every image `sendFailed` while text still lands;
             * 3. a second sweep, which has to recover by rebuilding the page —
             *    without the ladder climbing past a format that just worked.
             *
             * A run of the separate flags could not answer this: the sweep in the
             * simulator finishes in about a second, so a wedge on a timer landed
             * after it with nothing left to fail.
             */
            /**
             * The wedge hardware actually produced — rebuilds accepted, images
             * still refused — lifting on its own after a while. Checks that
             * pictures are PAUSED rather than hammered, and that coming back is
             * noticed and recorded.
             */
            /**
             * A person's sweep against failing pictures must leave recovery alone:
             * no rebuild, no backoff, no failure count for playback to inherit.
             */
            export async function checkSweepLeavesRecoveryAlone() {
                const before = { failures: consecutiveImageFailures, backoff: imagesBackingOff(),
                    rebuiltAt: lastContainerRepairAt };
                simulateImageWedge({ survivesRebuild: true });
                await probeLink({ perSize: 1 });
                imageWedgeInjected = false;
                const after = { failures: consecutiveImageFailures, backoff: imagesBackingOff(),
                    rebuiltAt: lastContainerRepairAt };
                const out = { untouched: JSON.stringify(before) === JSON.stringify(after), before, after };
                console.log("[sweep-recovery-test]", JSON.stringify(out));
                return out;
            }

            export async function reproduceStubbornWedge() {
                await probeLink({ perSize: 1, recover: true });                       // prove grey4
                simulateImageWedge({ survivesRebuild: true, clearsAfterMs: 20000 });
                lastContainerRepairAt = 0;
                await probeLink({ perSize: 2, recover: true });                       // 10 failures
                const backedOff = imagesBackingOff();
                await new Promise((r) => setTimeout(r, 24000));         // wedge lifts
                await probeLink({ perSize: 1, recover: true });                       // should land
                const out = { backedOff, recovered: consecutiveImageFailures === 0,
                    backoffStepAfter: backoffStep };
                console.log("[stubborn-test]", JSON.stringify(out));
                return out;
            }

            export async function reproduceImageWedge() {
                noteLifecycle("wedge-test", { step: "prove" });
                await probeLink({ perSize: 2, recover: true });
                const formatBefore = currentFormat();
                simulateImageWedge();
                noteLifecycle("wedge-test", { step: "wedged" });
                // Past the rebuild cooldown, so the repair is allowed to fire
                // however recently anything else touched the page.
                lastContainerRepairAt = 0;
                await probeLink({ perSize: 4, recover: true });
                const out = {
                    formatBefore, formatAfter: currentFormat(),
                    wedgeCleared: !imageWedgeInjected,
                    stillFailing: consecutiveImageFailures,
                };
                noteLifecycle("wedge-test", { step: "done", ...out });
                console.log("[wedge-test]", JSON.stringify(out));
                return out;
            }

            /**
             * The session that prompted page rebuilds: ten minutes of pictures,
             * then `sendFailed` on every image for good while text kept landing.
             * Images fail until the page is successfully rebuilt. Driven by the
             * telemetry page's `?noimage=1`.
             */
            let imageWedgeInjected = false;
            let wedgeSurvivesRebuild = false;
            /**
             * @param opts.survivesRebuild  what hardware actually did: three
             *   accepted rebuilds, images still refused.
             * @param opts.clearsAfterMs    let it lift on its own, so "does
             *   backing off let it recover" can be exercised end to end.
             */
            export function simulateImageWedge({ survivesRebuild = false, clearsAfterMs = 0 } = {}) {
                imageWedgeInjected = true;
                wedgeSurvivesRebuild = survivesRebuild;
                if (clearsAfterMs) setTimeout(() => { imageWedgeInjected = false; }, clearsAfterMs);
                noteLifecycle("injected-image-wedge", { survivesRebuild, clearsAfterMs });
            }

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
                    await repairContainersIfOneChannelIsDead("text");
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
                            await during("waiting for this scene's image", imageSend);
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
                                await during("subtitle write", sendSubtitleToGlasses(block.text));
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
                                await during("showing a subtitle", sleep(displayDuration, signal));
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

                        // 5a. A scene with nothing to say CLEARS the line.
                        //     Without this the previous scene's subtitle stayed
                        //     under a picture it has nothing to do with, for as
                        //     long as the quiet lasted — the wearer reads a line
                        //     that belongs to a different moment.
                        if (!blocks.length && !signal.aborted) {
                            try { await sendSubtitleToGlasses(" "); } catch (e) {}
                        }

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
                            await during("pacing the scene", sleep(remainder, signal));
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
                        // A session stopped sending at 1365s with no pause and no
                        // error, and nothing could say whether the episode had
                        // simply ended.
                        noteLifecycle("playback-ended", { atMs: durationMs });
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

                    // `durationMs` is 0 with nothing loaded, and `0 >= 0` reported
                    // the end of playback three times while the wearer was still
                    // browsing.
                    if (durationMs > 0 && currentTimeMs >= durationMs) {
                        noteLifecycle("playback-ended", { by: "clock" });
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
                noteLifecycle("app-cleanup", { wasPlaying: isPlaying });
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
                skipNextQualitySample = true;
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
                    noteLifecycle("glasses-double-tap", { wasPlaying: isPlaying });
                    cleanup();
                    return;
                }
            
                // Pause / Play toggle on single tap
                if (sysType === OsEventTypeList.CLICK_EVENT) {
                    // MARKED, because an unmarked one cost a session. Playback
                    // stopped mid-episode with the glasses on a wearer's face and
                    // the report could say nothing: no user pause, no background
                    // pause, no end of media — because a tap on the glasses took
                    // this branch and left no trace. A brush against the temple
                    // pauses the picture, and that has to be visible.
                    noteLifecycle("glasses-tap", { wasPlaying: isPlaying, to: isPlaying ? "paused" : "playing" });
                    const title =
                        document.getElementById("playing-title")
                            ?.textContent || "media";
                    if (isPlaying) {
                        isPlaying = false;
                        if (typeof stopScenePipeline === 'function') stopScenePipeline();
                        try { silentAudio.pause(); } catch (e) {}
                        playBtn.innerText = "Play";
                        setStatus(`Paused: ${title}`, "active");
                        // SAY SO ON THE GLASSES. `setStatus` writes to the phone,
                        // which is in a pocket. A tester's playback stopped
                        // mid-episode and all the glasses showed was a picture
                        // that had stopped changing — indistinguishable from the
                        // freezes we have been chasing for days. A brush against
                        // the temple pauses this, so the pause has to be legible
                        // where the wearer is actually looking.
                        ble.forgetText();
                        sendSubtitleToGlasses("Paused - tap to resume").catch(() => {});
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
                if (sysType === OsEventTypeList.FOREGROUND_ENTER_EVENT) {
                    foregroundEnteredAt = Date.now();
                }
                if (sysType === OsEventTypeList.FOREGROUND_EXIT_EVENT) {
                    // The menu overlay hands the foreground back on the way out,
                    // and pausing on that would stop the video every time the
                    // wearer used the menu — including the moment they chose
                    // "Play / Pause", which would then undo itself.
                    const sinceMenu = Date.now() - menuActiveAt;
                    const sinceEnter = Date.now() - foregroundEnteredAt;
                    if (sinceMenu < 4000 || sinceEnter < 4000) {
                        noteLifecycle("host-foreground-exit", {
                            wasPlaying: isPlaying, ignored: "menu overlay",
                            sinceMenuMs: sinceMenu, sinceEnterMs: sinceEnter,
                        });
                        return;
                    }
                }
                if (sysType === OsEventTypeList.FOREGROUND_EXIT_EVENT) {
                    // Marked separately from the pause it causes: whether the
                    // host sends this when the PHONE sleeps — rather than only
                    // when the wearer leaves the app — is the open question, and
                    // "app-paused" alone cannot answer it.
                    noteLifecycle("host-foreground-exit", { wasPlaying: isPlaying });
                    pauseForBackground();
                    return;
                }
                if (sysType === OsEventTypeList.FOREGROUND_ENTER_EVENT) {
                    noteLifecycle("host-foreground-enter", { paused: backgroundedWhilePlaying });
                    resumeFromBackground();
                    return;
                }

                // The contextual menu. Selecting an item is bracketed by
                // FOREGROUND_ENTER and FOREGROUND_EXIT — the overlay taking and
                // giving back the foreground — and the EXIT half would otherwise
                // pause playback every time the menu is used. See `menuActiveAt`.
                const menuId = event.menuItemClickEvent?.itemID;
                if (menuId != null) {
                    menuActiveAt = Date.now();
                    noteLifecycle("menu-item", { itemID: menuId });
                    if (menuId === MENU_RETURN_ID) {
                        console.log("[Menu] return to list");
                        if (sceneList.length) stop();
                        showRecentOnGlasses().catch(() => {});
                    } else if (menuId === MENU_PLAYPAUSE_ID) {
                        console.log(`[Menu] play/pause (was ${isPlaying ? "playing" : "paused"})`);
                        togglePlay();
                    } else if (menuId === MENU_RESTART_ID) {
                        console.log("[Menu] play from start");
                        seekTo(0);
                        if (!isPlaying) play();
                    }
                    return;
                }

                // A pick from the recent list on the glasses. The flow decides
                // what that means; this file does not know what an item is.
                // The glasses handle scrolling themselves and only tell us about a
                // SELECTION, which arrives with no `eventType` at all — a filter
                // on CLICK_EVENT matched nothing and the picker did nothing when
                // tapped. Any list event on our container is a choice.
                const listEvent = event.listEvent || null;
                if (listEvent && listEvent.containerID === RECENT_CONTAINER_ID &&
                    (listEvent.eventType == null || listEvent.eventType === OsEventTypeList.CLICK_EVENT)) {
                    // Match on the LABEL the glasses actually had on screen; the
                    // index is only a fallback. The two disagree the moment the
                    // list is reordered underneath a picker still showing the
                    // old order.
                    const shown = listEvent.currentSelectItemName ?? null;
                    const byName = shown == null ? -1 : recentTitles.indexOf(shown);
                    const index = byName >= 0 ? byName : (listEvent.currentSelectItemIndex ?? 0);
                    console.log(`[Recent] picked "${shown ?? recentTitles[index] ?? index}"` +
                        `${byName < 0 ? " (by position — the glasses sent no name)" : ""}`);
                    noteLifecycle("recent-picked", { index, title: recentTitles[index] });
                    showingRecent = false;
                    applyPage("player")
                        .then(() => ui.playRecent(index))
                        .catch((e) => console.warn(`[Recent] could not start: ${e?.message || e}`));
                    return;
                }

                if (sysType === OsEventTypeList.SYSTEM_EXIT_EVENT || sysType === OsEventTypeList.ABNORMAL_EXIT_EVENT) {
                    noteLifecycle("glasses-exit-event", {
                        abnormal: sysType === OsEventTypeList.ABNORMAL_EXIT_EVENT, wasPlaying: isPlaying });
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
            /** Where playback has got to, for whoever wants to remember it. */
            export function positionMs() { return Math.round(currentTimeMs) || 0; }

            export function playbackState() {
                const t = Date.now();
                return {
                    playing: isPlaying,
                    pipeline: scenePipelineRunning,
                    scene: sceneList.length ? currentTimeMs : null,
                    bridge: !!bridgeInstance,
                    hidden: document.hidden,
                    // What the engine is waiting on, oldest first. A report once
                    // showed sixty seconds of silence "while the app believed it
                    // was playing" and could not say what it was stuck behind —
                    // a write the glasses never answered, a fetch, or a sleep.
                    doing: [...activity.values()]
                        .sort((a, b) => a.since - b.since)
                        .map((a) => ({ what: a.what, ms: t - a.since })),
                    ...(imageBackoffUntil > t ? { imageBackoffMs: imageBackoffUntil - t } : {}),
                    // The silent loop is what is supposed to keep the WebView
                    // running with the phone asleep. Whether it actually is
                    // playing then has never been observed — only assumed.
                    keepAlive: silentAudio.paused ? "paused" : "playing",
                    backgroundPaused: backgroundedWhilePlaying,
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
                sendLast = false,
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

                // Does a real decoder read what our own PNG writer produced?
                //
                // `canvas.toBlob` was replaced because it cost four seconds on
                // hardware; what replaced it is a hand-written encoder, and a
                // hand-written container format is exactly the kind of thing
                // that works where it was written and fails where it is read.
                // `tools/png-check.mjs` verifies it against Node's zlib; this
                // verifies it against the WebView's own image decoder, on the
                // phone, with the bytes the glasses are actually handed.
                const pngReadsBack = await (async () => {
                    if (typeof createImageBitmap !== "function") return null;
                    const w = 64, h = 32;
                    const levels = new Uint8Array(w * h);
                    for (let i = 0; i < levels.length; i++) levels[i] = i % 16;
                    const png = encodeGreyPng(levels, w, h, currentFormat() === "grey8" ? 8 : 4);
                    try {
                        const bmp = await createImageBitmap(
                            new Blob([png], { type: "image/png" }));
                        const c = document.createElement("canvas");
                        c.width = w; c.height = h;
                        const x = c.getContext("2d", { willReadFrequently: true });
                        x.drawImage(bmp, 0, 0);
                        if (bmp.close) bmp.close();
                        const px = x.getImageData(0, 0, w, h).data;
                        let worst = 0;
                        for (let i = 0; i < levels.length; i++) {
                            const d = Math.abs(px[i << 2] - levels[i] * 17);
                            if (d > worst) worst = d;
                        }
                        return worst;
                    } catch (e) {
                        return `threw: ${e?.message || e}`;
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
                    if (sendLast && n === runs - 1 && bridgeInstance) {
                        const result = await bridgeInstance.updateImageRawData(
                            typeof ImageRawDataUpdate !== "undefined"
                                ? new ImageRawDataUpdate({ containerID: 2, containerName: "g2_bif", imageData: out })
                                : { containerID: 2, containerName: "g2_bif", imageData: out });
                        console.log(`[prep-probe] sent the last frame at "${pictureQuality.current.name}": ${result}`);
                    }
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
                    // 0 = the WebView's decoder reproduces our levels exactly.
                    format: currentFormat(),
                    pngReadsBack,
                    p50: totals[Math.floor(runs * 0.5)],
                    p90: totals[Math.floor(runs * 0.9)],
                    max: totals[runs - 1],
                };
            }

            /**
             * Which encodings will these glasses actually accept?
             *
             * The question a whole beta session failed to answer: every
             * synthetic payload landed and every real frame failed, and the
             * only difference was how the bytes were made. Three candidate
             * causes — bit depth, colour type, or stored deflate blocks — and
             * `sendFailed` distinguishes none of them.
             *
             * So send the SAME picture encoded each way and see. A minute, on
             * the hardware, and the ladder in IMAGE_FORMATS stops being a guess.
             */
            export async function probeFormats({ perFormat = 3 } = {}) {
                if (!bridgeInstance) throw new Error("no bridge — connect the glasses first");
                const w = GLASSES_IMAGE_WIDTH, h = GLASSES_IMAGE_HEIGHT;

                // A real-looking frame: gradients and edges, so it dithers to
                // something with structure rather than compressing to nothing.
                const c = document.createElement("canvas");
                c.width = w; c.height = h;
                const x = c.getContext("2d", { willReadFrequently: true });
                const g = x.createLinearGradient(0, 0, w, h);
                g.addColorStop(0, "#101820"); g.addColorStop(0.5, "#c8d0d8"); g.addColorStop(1, "#201810");
                x.fillStyle = g; x.fillRect(0, 0, w, h);
                for (let i = 0; i < 40; i++) {
                    x.fillStyle = `rgba(${(i * 37) % 256},${(i * 91) % 256},${(i * 53) % 256},0.5)`;
                    x.fillRect((i * 71) % w, (i * 43) % h, 8 + (i % 17), 6 + (i % 13));
                }
                const levels = toGlassesLevels(x.getImageData(0, 0, w, h).data, w, h, {
                    brightness: brightnessValue, contrast: contrastValue,
                    gamma: gammaValue, dither: ditherAlgorithm,
                });

                const candidates = [
                    ["grey4", async () => encodeGreyPng(levels, w, h, 4)],
                    ["grey8", async () => encodeGreyPng(levels, w, h, 8)],
                    ["rgba", async () => {
                        const d = x.getImageData(0, 0, w, h);
                        for (let i = 0; i < levels.length; i++) {
                            const v = levels[i] * 17, o = i << 2;
                            d.data[o] = d.data[o + 1] = d.data[o + 2] = v;
                            d.data[o + 3] = 255;
                        }
                        x.putImageData(d, 0, 0);
                        return await encodeViaHost(c);
                    }],
                ];

                const results = [];
                for (const [name, encode] of candidates) {
                    const t0 = Date.now();
                    let bytes;
                    try { bytes = await encode(); }
                    catch (e) { results.push({ format: name, error: String(e?.message || e) }); continue; }
                    const encodeMs = Date.now() - t0;

                    let ok = 0, lastReason = "";
                    const times = [];
                    for (let n = 0; n < perFormat; n++) {
                        const payload =
                            typeof ImageRawDataUpdate !== "undefined"
                                ? new ImageRawDataUpdate({ containerID: 2, containerName: "g2_bif", imageData: bytes })
                                : { containerID: 2, containerName: "g2_bif", imageData: bytes };
                        const meta = { bytes: bytes.byteLength, probe: true, format: name };
                        const r = await ble.sendImage(async (p) => {
                            const res = await bridgeInstance.updateImageRawData(p);
                            meta.result = res;
                            lastReason = res;
                            return res === "success";
                        }, payload, meta);
                        if (r.ok) { ok++; times.push(r.duration); }
                        // Say which one is on screen, so it can be judged by eye
                        // as well as by the return value — a frame the glasses
                        // ACCEPT but draw as noise would otherwise read as a pass.
                        await ble.sendText(
                            (content) => bridgeInstance.textContainerUpgrade({
                                containerID: 1, containerName: "g2_subs",
                                contentOffset: 0, contentLength: 0, content,
                            }),
                            `${name} ${(bytes.byteLength / 1024).toFixed(0)}KB #${n + 1}`,
                        );
                    }
                    times.sort((a, b) => a - b);
                    results.push({
                        format: name, kb: +(bytes.byteLength / 1024).toFixed(1), encodeMs,
                        ok, of: perFormat, writeMs: times[times.length >> 1] ?? 0,
                        reason: ok === perFormat ? "" : lastReason,
                    });
                }
                noteLifecycle("format-probe", { results });
                return results;
            }

            /**
             * The same sweep, meant to be run with the phone LOCKED.
             *
             * Pictures stop the moment the phone locks while subtitles carry
             * on, each failure taking 8-14 seconds, with the app's own timers on
             * time throughout. One explanation fits all of it: the link slows
             * when the phone locks (Android commonly lowers a background app's
             * Bluetooth priority), a 16 KB frame no longer completes inside the
             * host's transfer time limit, and a one-line subtitle still does.
             *
             * If that is right, small payloads land locked and large ones fail,
             * with a threshold between. If everything fails, or everything
             * lands, it is wrong. Finer steps than the normal sweep, because the
             * threshold is the thing being looked for.
             */
            export async function probeLockedLink() {
                return probeLink({
                    densities: [0.004, 0.012, 0.025, 0.04, 0.06, 0.08, 0.1],
                    perSize: 3,
                    label: "locked",
                    paceMs: 1500,
                });
            }

            /**
             * @param recover  let failures drive recovery (rebuilds, backoff, the
             *   format ladder). OFF for any sweep a person runs: a sweep sends
             *   sizes chosen to FAIL, and letting that drive recovery rebuilt the
             *   glasses page three times mid-test (the host refused all three),
             *   put images into backoff, and handed playback a failure count and
             *   a backoff it had not earned — the first real frame to fail then
             *   jumped straight to the second backoff step. On hardware, that
             *   session ended with "connection lost". Only the simulator
             *   harnesses, which inject a wedge on purpose, turn it on.
             * @param paceMs   pause between sends. A person's sweep is not a
             *   throughput test; back-to-back 20 KB transfers each spending 16s
             *   failing are load on a link that is already struggling.
             */
            export async function probeLink({ densities = null, perSize = 4, label = null,
                                              recover = false, paceMs = 0 } = {}) {
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
                        let probeResult = "";
                        const probeMeta = { bytes: bytes.byteLength, probe: true,
                            ...(label ? { sweep: label } : {}) };
                        const pr = await ble.sendImage(
                            async (p) => {
                                if (imageWedgeInjected ||
                                    (rejectImagesUntilFormat && currentFormat() !== rejectImagesUntilFormat)) {
                                    probeResult = "sendFailed";
                                    probeMeta.result = probeResult;
                                    return false;
                                }
                                probeResult = await bridgeInstance.updateImageRawData(p);
                                probeMeta.result = probeResult;
                                return probeResult === "success";
                            },
                            payload,
                            probeMeta,
                        );
                        if (recover) await noteImageResult(pr.ok, probeResult);
                        await ble.sendText(
                            (content) => bridgeInstance.textContainerUpgrade({
                                containerID: 1, containerName: "g2_subs",
                                contentOffset: 0, contentLength: 0, content,
                            }),
                            `probe ${(bytes.byteLength / 1024).toFixed(0)}KB #${n + 1}`,
                        );
                        if (paceMs) await new Promise((r) => setTimeout(r, paceMs));
                    }
                }
            }

            export async function initBridge() {
                loadImageFormat();
                await initEvenBridge();
            }

            /**
             * The bridge, once it exists — or null if it does not arrive in time.
             *
             * The flow needs it for one thing before anything is on screen: the
             * host-backed store, which is the only place a Plex sign-in
             * survives a relaunch. But there is no bridge at all in the browser
             * build, so waiting for one unconditionally would hang the page
             * that is easiest to test in. Hence a deadline rather than an
             * await.
             */
            export function whenBridgeReady(timeoutMs = 2000) {
                if (bridgeInstance) return Promise.resolve(bridgeInstance);
                return new Promise((resolve) => {
                    const started = Date.now();
                    const tick = setInterval(() => {
                        if (bridgeInstance) { clearInterval(tick); resolve(bridgeInstance); }
                        else if (Date.now() - started >= timeoutMs) { clearInterval(tick); resolve(null); }
                    }, 50);
                });
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
                skipNextQualitySample = true;
                // The picker is a full-screen page; leaving it up meant the
                // picture had nowhere to appear while subtitles showed
                // underneath it.
                if (showingRecent) applyPage("player").catch(() => {});
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
                noteLifecycle("playback-stopped", { by: "pause" });
                isPlaying = false;
                playBtn.innerText = "Play";
                stopScenePipeline();
                try { silentAudio.pause(); } catch (e) {}
                setStatus(`Paused: ${currentItem?.title || "media"}`, "active");
                ui.playing(false);
            }

            export function togglePlay() {
                // A tester woke the phone, found the stream paused and pressed
                // play. Without this, that press is indistinguishable in the
                // report from the app resuming by itself.
                noteLifecycle(isPlaying ? "user-pause" : "user-play", {
                    wasBackgroundPaused: backgroundedWhilePlaying,
                });
                if (isPlaying) pause(); else play();
            }

            export function seekTo(ms) {
                // Touching the transport at all is a statement that the wearer
                // is here and wants it running. Seeking used to fire a single
                // frame and leave playback stopped, which is why a frozen
                // session could be nudged into sending images one drag at a
                // time and never actually resume.
                if (backgroundedWhilePlaying) resumeFromBackground("seek");
                skipNextQualitySample = true;      // the frame after a seek queues behind its one-shot
                const wasPlaying = isPlaying;
                if (wasPlaying) stopScenePipeline();
                currentTimeMs = Number(ms);
                updateUI();
                sendOneShotUpdate();
                if (wasPlaying && isPlaying) runScenePipeline();
            }

            /** Leave the item. The one moment every object URL is certainly dead. */
            export function stop() {
                // Only when there was playback to stop. Backing out of five
                // screens while browsing produced five "playback stopped" marks
                // and no playback.
                if (isPlaying) noteLifecycle("playback-stopped", { by: "left the item" });
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
                ensureMenu();
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
