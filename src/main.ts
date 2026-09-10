// @ts-nocheck
import {
    waitForEvenAppBridge,
    ImageRawDataUpdate,
    OsEventTypeList
} from "@evenrealities/even_hub_sdk";
import { parseTimelineHeader, parseTimelineIndex } from "./timeline";
import { parseSubtitles } from "./subtitles";

            // --- APPLICATION METADATA FOR HEADERS ---
            const CLIENT_ID = "plex-bif-viewer";
            const APP_NAME = "plex-bif-viewer";

            // Silent audio loop to prevent WebView suspension in background/screen-off states
            const silentAudio = new Audio(
                "data:audio/wav;base64,UklGRigAAABXQVZFZm10IBAAAAABAAEARKwAAIhYAQACABAAZGF0YQQAAAAAAA==",
            );
            silentAudio.loop = true;

            // --- APPLICATION RUNTIME STATE ---
            let SERVER_URL = "";
            let TOKEN = "";
            let bifs = [];
            let subtitles = [];
            let durationMs = 0;
            let currentTimeMs = 0;
            let isPlaying = false;
            let lastFrameTime = 0;
            let clockIntervalId = null;
            let pollIntervalId = null;
            let plexServers = [];
            let libraryTypes = {};

            // --- BLE SERIAL QUEUE ---
            // All BLE writes go through here so they never overlap on the channel.
            let bleQueue = Promise.resolve();
            let bleQueueDepth = 0; // pending BLE ops — a backpressure / saturation gauge
            function bleEnqueue(fn) {
                bleQueueDepth++;
                bleQueue = bleQueue
                    .then(() => fn())
                    .catch(() => {})
                    .finally(() => {
                        bleQueueDepth--;
                    });
                return bleQueue;
            }

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
            let lastPushedSubText = "";

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
            const authStatus = document.getElementById("auth-status");
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
            let timelineUrl = "";
            const FRAME_CACHE_MAX = 8;
            const frameCache = new Map(); // byte offset -> { blob, url }
            let previewWantedOffset = -1;  // guards the async preview update

            async function fetchRange(url, from, to) {
                const res = await fetch(url, {
                    headers: { Range: `bytes=${from}-${to}` },
                });
                if (!res.ok && res.status !== 206) {
                    throw new Error(`range fetch ${from}-${to} -> HTTP ${res.status}`);
                }
                const buf = await res.arrayBuffer();
                // A proxy in front of the server may ignore Range and return
                // 200 with the whole body. Slice locally rather than trusting
                // the status code (F-022).
                if (res.status === 200 && buf.byteLength > to - from + 1) {
                    return buf.slice(from, to + 1);
                }
                return buf;
            }

            /** Cached { blob, url } for one frame, range-fetching on a miss. */
            async function getFrameAssets(frame) {
                const hit = frameCache.get(frame.offset);
                if (hit) return hit;

                const buf = await fetchRange(
                    timelineUrl,
                    frame.offset,
                    frame.offset + frame.length - 1,
                );
                const blob = new Blob([buf], { type: "image/jpeg" });
                const entry = { blob, url: URL.createObjectURL(blob) };
                frameCache.set(frame.offset, entry);

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

            /** Already-cached URL for a frame, or null. Never fetches. */
            function peekFrameUrl(frame) {
                const hit = frame && frameCache.get(frame.offset);
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
                if (statusDiv) statusDiv.textContent = text;
                if (!indicator) return;
                indicator.classList.remove("active", "error");
                if (state === "active") indicator.classList.add("active");
                else if (state === "error") indicator.classList.add("error");
            }

            // --- ON-PAGE DEBUG CONSOLE ---
            // Mirrors console.{log,info,warn,error} into the collapsible panel
            // at the bottom of the page so logs are visible on the phone without
            // a remote inspector. Set up first so it captures everything after.
            const DEBUG_MAX_LINES = 500;
            const debugLogBuffer = [];
            const debugPanel = document.getElementById("debug-panel");
            const debugLogOutput = document.getElementById("debug-log-output");
            const debugCount = document.getElementById("debug-count");

            function escapeHtml(str) {
                return String(str)
                    .replace(/&/g, "&amp;")
                    .replace(/</g, "&lt;")
                    .replace(/>/g, "&gt;");
            }

            function formatLogArg(arg) {
                if (typeof arg === "string") return arg;
                if (arg instanceof Error) return arg.stack || arg.message;
                try {
                    return JSON.stringify(arg);
                } catch (e) {
                    return String(arg);
                }
            }

            function appendDebugLog(level, args) {
                const time = new Date().toLocaleTimeString("en-US", {
                    hour12: false,
                });
                const text = Array.from(args).map(formatLogArg).join(" ");
                debugLogBuffer.push({ time, level, text });
                if (debugLogBuffer.length > DEBUG_MAX_LINES) {
                    debugLogBuffer.shift();
                }
                if (debugCount) debugCount.textContent = debugLogBuffer.length;

                if (debugLogOutput) {
                    const line = document.createElement("div");
                    line.className = `log-line log-${level}`;
                    line.innerHTML = `<span class="log-time">${time}</span><span class="log-text">${escapeHtml(text)}</span>`;
                    debugLogOutput.appendChild(line);
                    while (
                        debugLogOutput.childElementCount > DEBUG_MAX_LINES
                    ) {
                        debugLogOutput.removeChild(debugLogOutput.firstChild);
                    }
                    // Keep the latest line in view when expanded
                    debugLogOutput.scrollTop = debugLogOutput.scrollHeight;
                }
            }

            // Wrap the native console so logs reach both devtools and the panel.
            ["log", "info", "warn", "error"].forEach((level) => {
                const original = console[level].bind(console);
                console[level] = (...args) => {
                    original(...args);
                    try {
                        appendDebugLog(level, args);
                    } catch (e) {
                        /* never let logging break the app */
                    }
                };
            });

            function setDebugExpanded(expanded) {
                if (!debugPanel) return;
                debugPanel.classList.toggle("expanded", expanded);
                debugPanel.classList.toggle("collapsed", !expanded);
                const toggleBtn =
                    document.getElementById("debug-toggle-btn");
                if (toggleBtn) {
                    toggleBtn.textContent = expanded ? "Collapse" : "Expand";
                }
                if (expanded && debugLogOutput) {
                    debugLogOutput.scrollTop = debugLogOutput.scrollHeight;
                }
            }

            document
                .getElementById("debug-header")
                ?.addEventListener("click", () => {
                    setDebugExpanded(
                        debugPanel.classList.contains("collapsed"),
                    );
                });

            document
                .getElementById("debug-toggle-btn")
                ?.addEventListener("click", (e) => {
                    e.stopPropagation();
                    setDebugExpanded(
                        debugPanel.classList.contains("collapsed"),
                    );
                });

            document
                .getElementById("debug-clear-btn")
                ?.addEventListener("click", (e) => {
                    e.stopPropagation();
                    debugLogBuffer.length = 0;
                    if (debugLogOutput) debugLogOutput.innerHTML = "";
                    if (debugCount) debugCount.textContent = "0";
                });

            document
                .getElementById("debug-copy-btn")
                ?.addEventListener("click", async (e) => {
                    e.stopPropagation();
                    const copyBtn =
                        document.getElementById("debug-copy-btn");
                    const allText = debugLogBuffer
                        .map((l) => `[${l.time}] ${l.text}`)
                        .join("\n");

                    const flash = (msg) => {
                        if (!copyBtn) return;
                        const prev = copyBtn.textContent;
                        copyBtn.textContent = msg;
                        setTimeout(() => {
                            copyBtn.textContent = prev;
                        }, 1500);
                    };

                    try {
                        if (
                            navigator.clipboard &&
                            window.isSecureContext
                        ) {
                            await navigator.clipboard.writeText(allText);
                        } else {
                            const ta = document.createElement("textarea");
                            ta.value = allText;
                            ta.style.position = "fixed";
                            ta.style.top = "0";
                            ta.style.left = "0";
                            ta.style.opacity = "0";
                            document.body.appendChild(ta);
                            ta.focus();
                            ta.select();
                            document.execCommand("copy");
                            document.body.removeChild(ta);
                        }
                        flash("Copied!");
                    } catch (err) {
                        flash("Copy failed");
                    }
                });

            // --- SYSTEM INITIALIZATION: HARDWARE & TOKEN CHECK ---
            async function initApp() {
                // 1. Initialize Glasses Frame Bridge
                await initEvenBridge();

                // 2. Check for existing session token in localStorage
                const cachedToken = localStorage.getItem("plex_jwt_token");
                const cachedUrl = localStorage.getItem("plex_server_url");

                if (cachedToken && cachedUrl) {
                    TOKEN = cachedToken;
                    SERVER_URL = cachedUrl;

                    // Inject values back into form fields for visibility (server-url removed)

                    setStatus(
                        "Active Plex session restored from storage.",
                        "active",
                    );
                    document
                        .getElementById("auth-panel")
                        .classList.add("hidden");

                    // Restore connection, fetch server list in background, and jump straight to libraries
                    fetchServers(true);
                }
            }

            async function initEvenBridge() {
                try {
                    setStatus(
                        "Searching for active G2 Webview Environment Hook...",
                    );
                    bridgeInstance = await waitForEvenAppBridge();

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
                            if (deviceConnectType !== prev) {
                                console.warn(
                                    `[Device] connection ${prev} -> ${deviceConnectType} (battery: ${deviceBatteryLevel ?? "?"}%, wearing: ${deviceIsWearing}, queue: ${bleQueueDepth})`,
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

                    const result =
                        await bridgeInstance.createStartUpPageContainer({
                            containerTotalNum: 2,
                            textObject: [glassesSubtitleContainer],
                            imageObject: [glassesImageContainer],
                        });

                    if (result === 0) {
                        setStatus("G2 Glass Engine Connected via BLE!", "active");
                    } else {
                        throw new Error(
                            `Startup container creation failed with result ${result}`,
                        );
                    }
                } catch (err) {
                    setStatus(
                        "G2 App Bridge Offline (Browser Preview Loop Active)",
                        "error",
                    );
                }
            }

            // --- STEP 1: PIN AUTHENTICATION ENGINE ---
            async function beginPlexAuthExchange() {
                document.getElementById("pin-area").classList.remove("hidden");
                authStatus.textContent =
                    "Requesting verification codes from Plex...";

                try {
                    const res = await fetch("https://plex.tv/api/v2/pins", {
                        method: "POST",
                        headers: {
                            Accept: "application/json",
                            "Content-Type": "application/json",
                            "X-Plex-Product": APP_NAME,
                            "X-Plex-Client-Identifier": CLIENT_ID,
                        },
                        body: JSON.stringify({ strong: true }),
                    });

                    if (!res.ok)
                        throw new Error(
                            "Could not initialize Pin validation handshake.",
                        );
                    const data = await res.json();
                    const pinId = data.id;
                    const pinCode = data.code;
                    document.getElementById("pin-code").textContent = pinCode;

                    const authUrl = `https://app.plex.tv/auth#?clientID=${CLIENT_ID}&code=${pinCode}&context%5Bdevice%5D%5Bproduct%5D=${encodeURIComponent(APP_NAME)}&forwardURL=${location.href}`;

                    const authLinkText =
                        document.getElementById("auth-link-text");
                    if (authLinkText) {
                        authLinkText.value = authUrl;
                        authLinkText.setAttribute("value", authUrl);

                        const copyBtn =
                            document.getElementById("copy-auth-link-btn");
                        if (copyBtn) {
                            copyBtn.onclick = () => {
                                const urlToCopy = authUrl;

                                if (
                                    navigator.clipboard &&
                                    window.isSecureContext
                                ) {
                                    navigator.clipboard
                                        .writeText(urlToCopy)
                                        .then(() => {
                                            showCopied();
                                        })
                                        .catch((err) => {
                                            fallbackCopy(urlToCopy);
                                        });
                                } else {
                                    fallbackCopy(urlToCopy);
                                }

                                function showCopied() {
                                    copyBtn.textContent = "Copied!";
                                    copyBtn.style.background = "#2ecc71";
                                    setTimeout(() => {
                                        copyBtn.textContent =
                                            "Copy Link to Clipboard";
                                        copyBtn.style.background =
                                            "var(--accent)";
                                    }, 2000);
                                }

                                function fallbackCopy(text) {
                                    try {
                                        const textArea =
                                            document.createElement("textarea");
                                        textArea.value = text;
                                        textArea.style.top = "0";
                                        textArea.style.left = "0";
                                        textArea.style.position = "fixed";
                                        textArea.style.opacity = "0";
                                        document.body.appendChild(textArea);
                                        textArea.focus();
                                        textArea.select();
                                        const successful =
                                            document.execCommand("copy");
                                        document.body.removeChild(textArea);
                                        if (successful) {
                                            showCopied();
                                        } else {
                                            alert(
                                                "Failed to copy automatically. Please select the URL and copy manually.",
                                            );
                                        }
                                    } catch (err) {
                                        console.error(
                                            "Fallback copy failed:",
                                            err,
                                        );
                                        alert(
                                            "Failed to copy automatically. Please select the URL and copy manually.",
                                        );
                                    }
                                }
                            };
                        }
                    } else {
                        // Safe fallback dynamic self-healing container injection (with new block structure)
                        const container = document.getElementById(
                            "auth-link-container",
                        );
                        if (container) {
                            container.innerHTML = `
                                <label for="auth-link-text" style="display: block; font-size: 0.85rem; color: var(--text-muted); margin-bottom: 6px;">Authorization URL</label>
                                <input type="text" id="auth-link-text" readonly value="${authUrl}" style="display: block; width: 100%; box-sizing: border-box; padding: 12px; background: #1a1a1a; border: 1px solid #444; color: #fff; border-radius: 8px; font-family: monospace; font-size: 0.85em; outline: none; margin-bottom: 8px;" onclick="this.select()" />
                                <button id="copy-auth-link-btn" style="display: block; width: 100%; box-sizing: border-box; padding: 12px; background: var(--accent); color: #fff; font-weight: bold; border: none; border-radius: 8px; cursor: pointer; font-size: 0.95em; transition: background 0.2s;" onmouseover="this.style.background='#ffb71c'" onmouseout="this.style.background='var(--accent)'">Copy Link to Clipboard</button>
                            `;
                            const newCopyBtn =
                                document.getElementById("copy-auth-link-btn");
                            const newAuthLinkText =
                                document.getElementById("auth-link-text");
                            if (newCopyBtn && newAuthLinkText) {
                                newCopyBtn.onclick = () => {
                                    const urlToCopy = authUrl;

                                    if (
                                        navigator.clipboard &&
                                        window.isSecureContext
                                    ) {
                                        navigator.clipboard
                                            .writeText(urlToCopy)
                                            .then(() => {
                                                showCopied();
                                            })
                                            .catch((err) => {
                                                fallbackCopy(urlToCopy);
                                            });
                                    } else {
                                        fallbackCopy(urlToCopy);
                                    }

                                    function showCopied() {
                                        newCopyBtn.textContent = "Copied!";
                                        newCopyBtn.style.background = "#2ecc71";
                                        setTimeout(() => {
                                            newCopyBtn.textContent =
                                                "Copy Link to Clipboard";
                                            newCopyBtn.style.background =
                                                "var(--accent)";
                                        }, 2000);
                                    }

                                    function fallbackCopy(text) {
                                        try {
                                            const textArea =
                                                document.createElement(
                                                    "textarea",
                                                );
                                            textArea.value = text;
                                            textArea.style.top = "0";
                                            textArea.style.left = "0";
                                            textArea.style.position = "fixed";
                                            textArea.style.opacity = "0";
                                            document.body.appendChild(textArea);
                                            textArea.focus();
                                            textArea.select();
                                            const successful =
                                                document.execCommand("copy");
                                            document.body.removeChild(textArea);
                                            if (successful) {
                                                showCopied();
                                            } else {
                                                alert(
                                                    "Failed to copy automatically. Please select the URL and copy manually.",
                                                );
                                            }
                                        } catch (err) {
                                            console.error(
                                                "Fallback copy failed:",
                                                err,
                                            );
                                            alert(
                                                "Failed to copy automatically. Please select the URL and copy manually.",
                                            );
                                        }
                                    }
                                };
                            }
                        }
                    }

                    authStatus.textContent =
                        "Awaiting authorization confirmation...";

                    pollIntervalId = setInterval(() => {
                        checkPinVerificationStatus(pinId);
                    }, 3000);
                } catch (e) {
                    authStatus.textContent = `Authentication Initialization Failure: ${e.message}`;
                }
            }

            async function checkPinVerificationStatus(pinId, popupRef) {
                try {
                    const res = await fetch(
                        `https://plex.tv/api/v2/pins/${pinId}`,
                        {
                            headers: {
                                Accept: "application/json",
                                "X-Plex-Client-Identifier": CLIENT_ID,
                            },
                        },
                    );
                    const data = await res.json();
                    if (data.authToken) {
                        clearInterval(pollIntervalId);
                        TOKEN = data.authToken;

                        // Save credentials permanently to local storage strings
                        localStorage.setItem("plex_jwt_token", TOKEN);
                        authStatus.textContent =
                            "Login verified and session saved!";
                        setStatus("Plex login verified — fetching servers...");

                        if (popupRef && !popupRef.closed) popupRef.close();
                        document
                            .getElementById("auth-panel")
                            .classList.add("hidden");

                        // Advance to fetch servers instead of directly to libraries
                        fetchServers();
                    }
                } catch (e) {
                    console.error(
                        "Polling resolution tracking update anomaly:",
                        e,
                    );
                }
            }

            // --- STEP 1.5: SERVER ROUTING & API DISCOVERY ---
            async function fetchServers(skipToLibraries = false) {
                setStatus("Fetching Plex servers...");
                try {
                    const url = `https://plex.tv/api/v2/resources?includeHttps=1&includeRelay=1&X-Plex-Token=${TOKEN}&X-Plex-Client-Identifier=${CLIENT_ID}`;
                    const res = await fetch(url, {
                        headers: { Accept: "application/json" },
                    });
                    if (!res.ok)
                        throw new Error(
                            `Plex.tv Resources Error: ${res.status}`,
                        );
                    const data = await res.json();

                    let devices = [];
                    if (data) {
                        if (Array.isArray(data)) {
                            devices = data;
                        } else if (
                            data.MediaContainer &&
                            data.MediaContainer.Device
                        ) {
                            devices = Array.isArray(data.MediaContainer.Device)
                                ? data.MediaContainer.Device
                                : [data.MediaContainer.Device];
                        } else if (data.Device) {
                            devices = Array.isArray(data.Device)
                                ? data.Device
                                : [data.Device];
                        }
                    }

                    plexServers = devices.filter((d) => {
                        const prov = d.provides || "";
                        return prov
                            .split(",")
                            .map((s) => s.trim().toLowerCase())
                            .includes("server");
                    });

                    const serverSelect =
                        document.getElementById("server-select");
                    serverSelect.innerHTML = "";

                    if (plexServers.length === 0) {
                        const opt = document.createElement("option");
                        opt.value = "";
                        opt.text = "No servers found";
                        serverSelect.appendChild(opt);
                        document
                            .getElementById("connection-group")
                            .classList.add("hidden");
                        document.getElementById("connect-server-btn").disabled =
                            true;

                        document
                            .getElementById("auth-panel")
                            .classList.add("hidden");
                        document
                            .getElementById("server-panel")
                            .classList.remove("hidden");
                        setStatus("No Plex servers found on this account.", "error");
                        return;
                    }

                    document
                        .getElementById("connection-group")
                        .classList.remove("hidden");
                    document.getElementById("connect-server-btn").disabled =
                        false;

                    plexServers.forEach((srv, idx) => {
                        const opt = document.createElement("option");
                        opt.value = idx;
                        opt.text = `${srv.name} (Owner: ${srv.sourceTitle || "Me"})`;
                        serverSelect.appendChild(opt);
                    });

                    // Match current SERVER_URL to pre-select the active server/connection
                    let matchedServerIdx = 0;
                    let matchedConnIdx = 0;
                    let foundMatch = false;

                    if (SERVER_URL) {
                        for (let sIdx = 0; sIdx < plexServers.length; sIdx++) {
                            const srv = plexServers[sIdx];
                            const rawConnections =
                                srv.connections || srv.Connection || [];
                            const connections = Array.isArray(rawConnections)
                                ? rawConnections
                                : [rawConnections].filter(Boolean);
                            for (
                                let cIdx = 0;
                                cIdx < connections.length;
                                cIdx++
                            ) {
                                const conn = connections[cIdx];
                                const uri =
                                    conn.uri ||
                                    `${conn.protocol}://${conn.address}:${conn.port}`;
                                if (
                                    uri === SERVER_URL ||
                                    conn.uri === SERVER_URL
                                ) {
                                    matchedServerIdx = sIdx;
                                    matchedConnIdx = cIdx;
                                    foundMatch = true;
                                    break;
                                }
                            }
                            if (foundMatch) break;
                        }
                    }

                    serverSelect.value = matchedServerIdx;
                    populateConnections(matchedServerIdx);

                    const connSelect =
                        document.getElementById("connection-select");
                    if (foundMatch) {
                        connSelect.value = matchedConnIdx;
                    }

                    if (skipToLibraries && foundMatch) {
                        document
                            .getElementById("auth-panel")
                            .classList.add("hidden");
                        document
                            .getElementById("server-panel")
                            .classList.add("hidden");
                        fetchLibraries();
                    } else {
                        document
                            .getElementById("auth-panel")
                            .classList.add("hidden");
                        document
                            .getElementById("server-panel")
                            .classList.remove("hidden");
                        setStatus("Select a Plex server to continue.");
                        sendSubtitleToGlasses("Select a server").catch(
                            () => {},
                        );
                    }
                } catch (e) {
                    console.error("Failed to fetch servers:", e);
                    setStatus("Failed to fetch Plex servers.", "error");
                    if (skipToLibraries) {
                        document
                            .getElementById("auth-panel")
                            .classList.add("hidden");
                        document
                            .getElementById("server-panel")
                            .classList.add("hidden");
                        fetchLibraries();
                    } else {
                        alert("Failed to view server list: " + e.message);
                        disconnectAccount();
                    }
                }
            }

            function populateConnections(serverIdx) {
                const server = plexServers[serverIdx];
                const connSelect = document.getElementById("connection-select");
                connSelect.innerHTML = "";

                if (!server) return;

                const rawConnections =
                    server.connections || server.Connection || [];
                const connections = Array.isArray(rawConnections)
                    ? rawConnections
                    : [rawConnections].filter(Boolean);

                connections.forEach((conn, idx) => {
                    const opt = document.createElement("option");
                    opt.value = idx;
                    const type = conn.local
                        ? "Local"
                        : conn.relay
                          ? "Relay"
                          : "Remote";
                    opt.text = `${type}: ${conn.address}:${conn.port} (${conn.protocol})`;
                    connSelect.appendChild(opt);
                });
            }

            async function connectToSelectedServer() {
                const serverIdx = Number(
                    document.getElementById("server-select").value,
                );
                const connIdx = Number(
                    document.getElementById("connection-select").value,
                );

                const server = plexServers[serverIdx];
                if (!server) return alert("Please select a valid server.");

                const rawConnections =
                    server.connections || server.Connection || [];
                const connections = Array.isArray(rawConnections)
                    ? rawConnections
                    : [rawConnections].filter(Boolean);
                const connection = connections[connIdx];
                if (!connection)
                    return alert("Please select a valid connection route.");

                // Update runtime state
                SERVER_URL =
                    connection.uri ||
                    `${connection.protocol}://${connection.address}:${connection.port}`;
                TOKEN = server.accessToken || TOKEN;

                // Save details to localStorage
                localStorage.setItem("plex_server_url", SERVER_URL);
                localStorage.setItem("plex_jwt_token", TOKEN);

                setStatus(
                    `Connected to ${server.name} (${connection.local ? "Local" : "Remote"})`,
                    "active",
                );

                document.getElementById("server-panel").classList.add("hidden");
                fetchLibraries();
            }

            async function querySourceSecurityResources() {
                const sourceId = document
                    .getElementById("source-id-input")
                    .value.trim();
                if (!sourceId)
                    return alert("Please enter a source identifier.");

                const resultDiv = document.getElementById(
                    "source-query-result",
                );
                resultDiv.style.display = "block";
                resultDiv.textContent =
                    "Querying security resources from selected server...";

                const serverIdx = Number(
                    document.getElementById("server-select").value,
                );
                const server = plexServers[serverIdx];
                if (!server) {
                    resultDiv.textContent =
                        "Error: Please select a server first.";
                    return;
                }

                const connIdx = Number(
                    document.getElementById("connection-select").value,
                );
                const rawConnections =
                    server.connections || server.Connection || [];
                const connections = Array.isArray(rawConnections)
                    ? rawConnections
                    : [rawConnections].filter(Boolean);
                const connection = connections[connIdx];
                if (!connection) {
                    resultDiv.textContent =
                        "Error: Please select a connection route first.";
                    return;
                }

                const hostUrl =
                    connection.uri ||
                    `${connection.protocol}://${connection.address}:${connection.port}`;
                const token = server.accessToken || TOKEN;

                try {
                    const cleanHostUrl = hostUrl.replace(/\/$/, "");
                    const queryUrl = `${cleanHostUrl}/security/resources?source=${encodeURIComponent(sourceId)}&refresh=0&X-Plex-Token=${token}`;

                    const res = await fetch(queryUrl, {
                        headers: { Accept: "application/json" },
                    });

                    if (!res.ok)
                        throw new Error(`Server returned HTTP ${res.status}`);
                    const data = await res.json();

                    resultDiv.textContent = JSON.stringify(data, null, 4);
                } catch (e) {
                    resultDiv.textContent = `Query Failed: ${e.message}`;
                }
            }

            // --- SESSION REVOCATION / DISCONNECT ---
            function disconnectAccount() {
                // Clear variable references
                TOKEN = "";
                SERVER_URL = "";
                // Wipe persistent browser cache records
                localStorage.removeItem("plex_jwt_token");
                localStorage.removeItem("plex_server_url");
                // Reset UI layouts
                document
                    .getElementById("library-panel")
                    .classList.add("hidden");
                document.getElementById("media-panel").classList.add("hidden");
                document.getElementById("player-panel").classList.add("hidden");
                document.getElementById("pin-area").classList.add("hidden");
                document.getElementById("server-panel").classList.add("hidden");
                document
                    .getElementById("auth-panel")
                    .classList.remove("hidden");
                setStatus("Signed out. Sign in to continue.");
                if (bridgeInstance) {
                    sendSubtitleToGlasses("Sign in to Plex").catch(() => {});
                }
                alert(
                    "Logged out successfully. Local storage credentials dropped.",
                );
            }

            // --- STEP 2 & 3: MEDIA EXPLORATION VIA TOKEN ---
            async function plexFetch(endpoint) {
                const cleanUrl = SERVER_URL.replace(/\/$/, "");
                const url = `${cleanUrl}${endpoint}${endpoint.includes("?") ? "&" : "?"}X-Plex-Token=${TOKEN}`;
                const res = await fetch(url, {
                    headers: { Accept: "application/json" },
                });
                if (!res.ok) throw new Error(`Plex Server Error ${res.status}`);
                return await res.json();
            }

            async function fetchLibraries() {
                setStatus("Loading library list...");
                try {
                    const data = await plexFetch("/library/sections");
                    const dirs = data.MediaContainer.Directory || [];
                    const select = document.getElementById("library-select");
                    select.innerHTML = "";
                    libraryTypes = {};

                    dirs.forEach((lib) => {
                        if (["movie", "show"].includes(lib.type)) {
                            libraryTypes[lib.key] = lib.type;
                            const opt = document.createElement("option");
                            opt.value = lib.key;
                            opt.text = `${lib.title} (${lib.type})`;
                            select.appendChild(opt);
                        }
                    });

                    // Trigger library selection change to handle initial state
                    if (select.value) {
                        handleLibraryChange(select.value);
                    }

                    document
                        .getElementById("library-panel")
                        .classList.remove("hidden");
                    setStatus("Select a library to browse.", "active");
                } catch (e) {
                    setStatus("Failed to load libraries.", "error");
                    alert("Failed to view server libraries: " + e.message);
                    disconnectAccount();
                }
            }

            async function handleLibraryChange(libId) {
                const showGroup = document.getElementById("show-select-group");
                const type = libraryTypes[libId];

                if (type === "show") {
                    showGroup.classList.remove("hidden");
                    await fetchShowsForLibrary(libId);
                } else {
                    showGroup.classList.add("hidden");
                }
            }

            async function fetchShowsForLibrary(libId) {
                const showSelect = document.getElementById("show-select");
                showSelect.innerHTML = "<option>Loading shows...</option>";
                showSelect.disabled = true;

                try {
                    const data = await plexFetch(
                        `/library/sections/${libId}/all`,
                    );
                    const items = data.MediaContainer.Metadata || [];
                    showSelect.innerHTML = "";

                    if (items.length === 0) {
                        showSelect.innerHTML =
                            "<option value=''>No shows found</option>";
                        return;
                    }

                    items.forEach((show) => {
                        const opt = document.createElement("option");
                        opt.value = show.ratingKey;
                        opt.text = show.title;
                        showSelect.appendChild(opt);
                    });
                    showSelect.disabled = false;
                } catch (e) {
                    showSelect.innerHTML = `<option value=''>Error: ${e.message}</option>`;
                    console.error("Failed to fetch shows:", e);
                }
            }

            async function scanForValidMedia() {
                const libId = document.getElementById("library-select").value;
                const scanStatus = document.getElementById("scan-status");
                const results = document.getElementById("results-list");

                if (scanStatus)
                    scanStatus.textContent = "Scanning directory trees...";
                setStatus("Scanning library for compatible media...");
                results.innerHTML = "";

                try {
                    const type = libraryTypes[libId];
                    let items = [];
                    let isEpisodeFlow = false;

                    if (type === "show") {
                        const showId =
                            document.getElementById("show-select").value;
                        if (!showId) {
                            if (scanStatus) scanStatus.textContent = "";
                            return alert("Please select a show first.");
                        }
                        // Query leaves (episodes) of the show
                        const data = await plexFetch(
                            `/library/metadata/${showId}/allLeaves`,
                        );
                        items = data.MediaContainer.Metadata || [];
                        isEpisodeFlow = true;
                    } else {
                        // Movie section
                        const data = await plexFetch(
                            `/library/sections/${libId}/all`,
                        );
                        items = data.MediaContainer.Metadata || [];
                    }

                    const validItems = [];
                    let processedCount = 0;
                    const totalItems = items.length;

                    // Fetch details in batches of 20 to check full streams eligibility
                    const batchSize = 20;
                    for (let i = 0; i < items.length; i += batchSize) {
                        const batch = items.slice(i, i + batchSize);
                        if (scanStatus) {
                            scanStatus.textContent = `Verifying eligibility: ${processedCount}/${totalItems} items...`;
                        }

                        await Promise.all(
                            batch.map(async (item) => {
                                try {
                                    const details = await plexFetch(
                                        `/library/metadata/${item.ratingKey}`,
                                    );
                                    const detailedItem =
                                        details.MediaContainer?.Metadata?.[0];
                                    if (!detailedItem || !detailedItem.Media)
                                        return;

                                    detailedItem.Media.forEach((media) => {
                                        if (!media.Part) return;
                                        media.Part.forEach((part) => {
                                            const hasBif =
                                                part.indexes &&
                                                part.indexes.includes("sd");
                                            const subStream = part.Stream
                                                ? part.Stream.find(
                                                      (s) =>
                                                          s.streamType === 3 &&
                                                          s.codec === "srt" &&
                                                          s.key,
                                                  )
                                                : null;

                                            if (hasBif && subStream) {
                                                let displayTitle =
                                                    detailedItem.title;
                                                if (isEpisodeFlow) {
                                                    const sNum = String(
                                                        detailedItem.parentIndex ||
                                                            0,
                                                    ).padStart(2, "0");
                                                    const eNum = String(
                                                        detailedItem.index || 0,
                                                    ).padStart(2, "0");
                                                    displayTitle = `${detailedItem.grandparentTitle || ""} - S${sNum}E${eNum} - ${detailedItem.title}`;
                                                }

                                                validItems.push({
                                                    title: displayTitle,
                                                    timelineRef: part.id,
                                                    subId: subStream.id,
                                                    subtitleRef: subStream.key,
                                                    res: media.videoResolution,
                                                });
                                            }
                                        });
                                    });
                                } catch (err) {
                                    console.error(
                                        `Failed to verify eligibility for ${item.title || item.ratingKey}:`,
                                        err,
                                    );
                                }
                            }),
                        );
                        processedCount += batch.length;
                    }

                    if (validItems.length === 0) {
                        results.innerHTML =
                            '<div style="padding:20px; text-align:center; color:var(--text-muted)">No compatible items containing both BIF and internal SRT Subtitles were found.</div>';
                    } else {
                        validItems.forEach((match) => {
                            const div = document.createElement("div");
                            div.className = "media-item";
                            div.innerHTML = `<span>${match.title}</span><span class="tags"><span class="tag-badge">${match.res}p</span><span class="tag-badge">SRT</span></span>`;
                            div.onclick = () => loadPlayer(match);
                            results.appendChild(div);
                        });
                    }

                    if (scanStatus) scanStatus.textContent = "";
                    document
                        .getElementById("library-panel")
                        .classList.add("hidden");
                    document
                        .getElementById("media-panel")
                        .classList.remove("hidden");
                    setStatus(
                        validItems.length
                            ? `Found ${validItems.length} compatible item(s). Select one to play.`
                            : "No compatible media found in this library.",
                        "active",
                    );
                } catch (e) {
                    if (scanStatus)
                        scanStatus.textContent =
                            "Error scanning file tree: " + e.message;
                    else alert("Error scanning file tree: " + e.message);
                    setStatus("Error scanning library: " + e.message, "error");
                }
            }

            // --- STEP 4: MOUNT PLAYER RUNTIME & TRANSMIT OVER BLE ---
            async function loadPlayer(media) {
                document.getElementById("media-panel").classList.add("hidden");
                document
                    .getElementById("player-panel")
                    .classList.remove("hidden");
                document.getElementById("playing-title").textContent =
                    media.title;

                setStatus(`Loading "${media.title}"...`);
                showLoadProgress("Connecting to server...");
                sendSubtitleToGlasses(`Loading ${media.title}`).catch(
                    () => {},
                );

                timelineUrl = `${SERVER_URL}/library/parts/${media.timelineRef}/indexes/sd?X-Plex-Token=${TOKEN}`;
                const cleanServerUrl = SERVER_URL.replace(/\/$/, "");
                const cleanSubtitleRef = media.subtitleRef.startsWith("/")
                    ? media.subtitleRef
                    : `/${media.subtitleRef}`;
                const subUrl = `${cleanServerUrl}${cleanSubtitleRef}${cleanSubtitleRef.includes("?") ? "&" : "?"}X-Plex-Token=${TOKEN}`;

                clearFrameCache();

                try {
                    // Index phase (0-20%). Two small ranged reads instead of a
                    // 9.5 MB download: 64 bytes to learn how long the index is,
                    // then the index itself (~6 KB). Frames are fetched
                    // individually, later, only when actually shown (F-005).
                    setLoadProgress(null, "Reading index...");
                    const headerBuf = await fetchRange(timelineUrl, 0, 63);
                    const header = parseTimelineHeader(headerBuf);
                    const indexBuf = await fetchRange(
                        timelineUrl, 0, header.indexByteLength - 1);
                    setLoadProgress(0.2, "Reading index...");

                    const parsed = parseTimelineIndex(indexBuf);
                    bifs = parsed.frames.map((f) => ({
                        timestampMs: f.tsMs,
                        offset: f.offset,
                        length: f.length,
                    }));

                    // Subtitle phase (20-90%): the only download large enough
                    // to be worth a progress bar now.
                    const subRes = await fetch(subUrl);
                    if (!subRes.ok) {
                        throw new Error(
                            `SRT subtitle file download returned HTTP ${subRes.status}`,
                        );
                    }
                    const subBuffer = await readResponseWithProgress(
                        subRes,
                        (received, total) => {
                            setLoadProgress(
                                total > 0 ? 0.2 + (received / total) * 0.7 : null,
                                "Downloading subtitles...",
                            );
                        },
                    );
                    const subText = new TextDecoder().decode(subBuffer);

                    // Parse phase (90-100%): chunked, yields to the main thread.
                    subtitles = await parseSubtitles(subText, (frac) => {
                        setLoadProgress(
                            0.9 + frac * 0.1,
                            "Parsing subtitles...",
                        );
                    });

                    const trackBytes = bifs.reduce((n, f) => n + f.length, 0);
                    console.log(
                        `[timeline] ${bifs.length} frames, multiplier ` +
                        `${header.rawMultiplier} (=> ${header.multiplierMs} ms), ` +
                        `index ${header.indexByteLength} B read, ` +
                        `${(trackBytes / 1e6).toFixed(2)} MB of frames NOT downloaded`,
                    );

                    durationMs = bifs[bifs.length - 1].timestampMs;
                    timeline.max = durationMs;
                    currentTimeMs = 0;

                    // Reset scene pipeline state
                    scenePipelineRunning = false;
                    sceneAbortController = null;
                    renderDurations = [];
                    averageRenderDuration = 1500;
                    lastSentImageTimestampMs = 0;
                    lastPushedSubText = "";

                    setLoadProgress(1, "Ready");
                    hideLoadProgress();
                    setStatus(`Now playing: ${media.title}`, "active");

                    updateUI();
                    sendOneShotUpdate();
                } catch (e) {
                    hideLoadProgress();
                    setStatus(`Failed to load "${media.title}".`, "error");
                    alert("Failed to load stream: " + e.message);
                    resetPlayer();
                }
            }

            function resizeAndPrepareImage(blob, targetWidth, targetHeight) {
                return new Promise((resolve, reject) => {
                    const img = new Image();
                    const objectUrl = URL.createObjectURL(blob);
                    img.onload = () => {
                        URL.revokeObjectURL(objectUrl);
                        try {
                            const canvas = document.createElement("canvas");
                            canvas.width = targetWidth;
                            canvas.height = targetHeight;
                            const ctx = canvas.getContext("2d");
                            ctx.clearRect(0, 0, targetWidth, targetHeight);
                            ctx.drawImage(img, 0, 0, targetWidth, targetHeight);

                            const imgData = ctx.getImageData(
                                0,
                                0,
                                targetWidth,
                                targetHeight,
                            );
                            const data = imgData.data;
                            const w = targetWidth;
                            const h = targetHeight;

                            const gray = new Float32Array(w * h);
                            // Precalculate contrast factor
                            const contrastFactor =
                                (259 * (contrastValue + 255)) /
                                (255 * (259 - contrastValue));

                            for (let i = 0; i < w * h; i++) {
                                const r = data[i * 4];
                                const g = data[i * 4 + 1];
                                const b = data[i * 4 + 2];

                                // Convert to luminance greyscale
                                let v = 0.299 * r + 0.587 * g + 0.114 * b;

                                // 1. Apply Brightness
                                v += brightnessValue;

                                // 2. Apply Contrast
                                v = contrastFactor * (v - 128) + 128;

                                // 3. Apply Gamma
                                if (gammaValue !== 1.0) {
                                    v =
                                        255 *
                                        Math.pow(
                                            Math.max(0, v) / 255,
                                            1 / gammaValue,
                                        );
                                }

                                // Clamp intermediate values
                                gray[i] = Math.max(0, Math.min(255, v));
                            }

                            // Apply selected dithering algorithm
                            if (ditherAlgorithm === "floyd-steinberg") {
                                for (let y = 0; y < h; y++) {
                                    for (let x = 0; x < w; x++) {
                                        const idx = y * w + x;
                                        const oldVal = gray[idx];

                                        // Quantize to 16 levels (0-15, mapped to 0-255)
                                        let level = Math.round(oldVal / 17);
                                        if (level < 0) level = 0;
                                        if (level > 15) level = 15;
                                        const newVal = level * 17;
                                        gray[idx] = newVal;

                                        const err = oldVal - newVal;

                                        // Diffuse error
                                        if (x + 1 < w) {
                                            gray[idx + 1] += (err * 7) / 16;
                                        }
                                        if (y + 1 < h) {
                                            if (x - 1 >= 0) {
                                                gray[idx + w - 1] +=
                                                    (err * 3) / 16;
                                            }
                                            gray[idx + w] += (err * 5) / 16;
                                            if (x + 1 < w) {
                                                gray[idx + w + 1] +=
                                                    (err * 1) / 16;
                                            }
                                        }
                                    }
                                }
                            } else if (ditherAlgorithm === "atkinson") {
                                for (let y = 0; y < h; y++) {
                                    for (let x = 0; x < w; x++) {
                                        const idx = y * w + x;
                                        const oldVal = gray[idx];

                                        let level = Math.round(oldVal / 17);
                                        if (level < 0) level = 0;
                                        if (level > 15) level = 15;
                                        const newVal = level * 17;
                                        gray[idx] = newVal;

                                        const err = oldVal - newVal;
                                        const errPart = err / 8;

                                        // Atkinson diffuses only 3/8ths of the total error to immediate neighbors
                                        if (x + 1 < w) gray[idx + 1] += errPart;
                                        if (x + 2 < w) gray[idx + 2] += errPart;
                                        if (y + 1 < h) {
                                            if (x - 1 >= 0)
                                                gray[idx + w - 1] += errPart;
                                            gray[idx + w] += errPart;
                                            if (x + 1 < w)
                                                gray[idx + w + 1] += errPart;
                                        }
                                        if (y + 2 < h) {
                                            gray[idx + 2 * w] += errPart;
                                        }
                                    }
                                }
                            } else if (ditherAlgorithm === "ordered-4x4") {
                                const BAYER_4X4 = [
                                    [0, 8, 2, 10],
                                    [12, 4, 14, 6],
                                    [3, 11, 1, 9],
                                    [15, 7, 13, 5],
                                ];
                                for (let y = 0; y < h; y++) {
                                    for (let x = 0; x < w; x++) {
                                        const idx = y * w + x;
                                        const oldVal = gray[idx];

                                        const level = Math.floor(oldVal / 17);
                                        const remainder = (oldVal % 17) / 17;
                                        const threshold =
                                            (BAYER_4X4[y % 4][x % 4] + 0.5) /
                                            16;

                                        const newVal =
                                            (remainder > threshold
                                                ? level + 1
                                                : level) * 17;
                                        gray[idx] = Math.min(255, newVal);
                                    }
                                }
                            } else {
                                // Threshold / High Contrast (No Dither)
                                for (let i = 0; i < w * h; i++) {
                                    let level = Math.round(gray[i] / 17);
                                    if (level < 0) level = 0;
                                    if (level > 15) level = 15;
                                    gray[i] = level * 17;
                                }
                            }

                            // Write the dithered greyscale values back to image data array
                            for (let i = 0; i < w * h; i++) {
                                const val = Math.min(
                                    255,
                                    Math.max(0, Math.round(gray[i])),
                                );
                                data[i * 4] = val;
                                data[i * 4 + 1] = val;
                                data[i * 4 + 2] = val;
                                data[i * 4 + 3] = 255; // fully opaque
                            }
                            ctx.putImageData(imgData, 0, 0);

                            canvas.toBlob(async (blob) => {
                                if (!blob) {
                                    reject(new Error("Canvas toBlob failed"));
                                    return;
                                }
                                try {
                                    const buffer = await blob.arrayBuffer();
                                    resolve(buffer);
                                } catch (e) {
                                    reject(e);
                                }
                            }, "image/png");
                        } catch (err) {
                            reject(err);
                        }
                    };
                    img.onerror = (err) => {
                        URL.revokeObjectURL(objectUrl);
                        reject(err);
                    };
                    img.src = objectUrl;
                });
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

            function buildScene(startMs) {
                const baseDuration = getSceneDuration();
                const targetEndMs = startMs + baseDuration;

                // Find BIF frame at startMs
                const frame = bifs.find(
                    (f, i) =>
                        f.timestampMs <= startMs &&
                        (bifs[i + 1]?.timestampMs > startMs || !bifs[i + 1]),
                );

                // Ensure scene extends to the NEXT image's exact timestamp
                // so we never send the same image twice
                const nextFrame = bifs.find(f => f.timestampMs >= targetEndMs);
                const endMs = nextFrame ? nextFrame.timestampMs : targetEndMs;
                const duration = endMs - startMs;

                // Own each cue to the scene it STARTS in. Scenes tile the
                // timeline contiguously, so this assigns every cue to exactly
                // one scene — a cue straddling a boundary is no longer sent in
                // both scenes (the source of duplicate subtitles).
                const sceneSubs = subtitles.filter(
                    (s) => s.startMs >= startMs && s.startMs < endMs,
                );

                return {
                    image: frame,
                    subtitles: sceneSubs,
                    startMs,
                    endMs,
                    duration,
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

            async function sendImageToGlasses(frame) {
                if (!bridgeInstance || !frame) return 0;

                // The frame's bytes are fetched here, by byte range, rather
                // than having been materialised for every frame at load time
                // (F-005). The cache means a frame shown twice is fetched once.
                let assets;
                try {
                    assets = await getFrameAssets(frame);
                } catch (e) {
                    console.warn(
                        `[frame] fetch failed at ${frame.timestampMs}ms: ${e.message}`,
                    );
                    return 0;
                }

                const preparedBytes = await resizeAndPrepareImage(
                    assets.blob,
                    GLASSES_IMAGE_WIDTH,
                    GLASSES_IMAGE_HEIGHT,
                );

                return new Promise((resolve) => {
                    bleEnqueue(async () => {
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

                        const payloadKB = (
                            preparedBytes.byteLength / 1024
                        ).toFixed(1);

                        // The BLE image transfer fails intermittently (the link
                        // is flaky). Retry the same frame a few times within this
                        // queue slot so a transient failure recovers in ~1s rather
                        // than leaving the image frozen until the next scene.
                        let result = "sendFailed";
                        let duration = 0;
                        const attemptResults = [];
                        const sendStart = performance.now();
                        for (
                            let attempt = 1;
                            attempt <= IMAGE_SEND_MAX_ATTEMPTS;
                            attempt++
                        ) {
                            // Measure only the actual BLE render, not time spent
                            // waiting behind other writes in the serial queue.
                            const start = performance.now();
                            result = await bridgeInstance.updateImageRawData(payload);
                            duration = performance.now() - start;
                            attemptResults.push(`${result}/${duration.toFixed(0)}ms`);

                            if (result === "success") break;
                            // Cap total retry time. Each failed attempt still takes
                            // ~2-3s, so without this a bad frame blocks the serial
                            // queue (and the next scene's subtitles) for ~10s.
                            if (
                                performance.now() - sendStart >=
                                IMAGE_SEND_RETRY_BUDGET_MS
                            ) {
                                break;
                            }
                            if (attempt < IMAGE_SEND_MAX_ATTEMPTS) {
                                await new Promise((r) =>
                                    setTimeout(r, IMAGE_SEND_RETRY_DELAY_MS),
                                );
                            }
                        }

                        // Only successful renders inform the scene-size average;
                        // failed-attempt durations aren't real render times. Cap
                        // any single outlier (e.g. a send that resolved slow
                        // while the BLE link was congested) so it can't drag
                        // the pacing average — and therefore scene size — up
                        // for the next several iterations.
                        if (result === "success") {
                            renderDurations.push(
                                Math.min(duration, RENDER_DURATION_CAP_MS),
                            );
                            if (renderDurations.length > 5) renderDurations.shift();
                            averageRenderDuration = getSceneDuration();
                            lastSentImageTimestampMs = frame.timestampMs;
                            imageSuccessCount++;

                            // Report how long the image had been frozen.
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

                        const attemptsNote =
                            attemptResults.length > 1
                                ? ` attempts[${attemptResults.join(", ")}]`
                                : "";
                        const stuckNote =
                            consecutiveImageFailures > 0
                                ? ` STUCK x${consecutiveImageFailures}`
                                : "";
                        console.log(
                            `[Scene Engine] Image ${frame.timestampMs / 1000}s: ${result} (${duration.toFixed(0)}ms, ${payloadKB}KB, conn:${deviceConnectType}, q:${bleQueueDepth}, avg:${averageRenderDuration.toFixed(0)}ms)${attemptsNote}${stuckNote}`,
                        );

                        resolve(duration);
                    });
                });
            }

            async function sendSubtitleToGlasses(text) {
                if (!bridgeInstance) return;
                const displayText = text || " ";
                if (displayText === lastPushedSubText) return;

                lastPushedSubText = displayText;
                return new Promise((resolve) => {
                    bleEnqueue(async () => {
                        // textContainerUpgrade resolves to a boolean. Logging text
                        // failures shows whether a bad patch is the whole BLE link
                        // or just the image channel.
                        const ok = await bridgeInstance.textContainerUpgrade({
                            containerID: 1,
                            containerName: "g2_subs",
                            contentOffset: 0,
                            contentLength: 0,
                            content: displayText,
                        });
                        if (ok === false) {
                            subtitleFailureCount++;
                            console.warn(
                                `[Scene Engine] Subtitle send failed (conn:${deviceConnectType}, q:${bleQueueDepth})`,
                            );
                        }
                        resolve();
                    });
                });
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
                        scene.image
                            ? sendImageToGlasses(scene.image)
                            : Promise.resolve(0);

                    while (
                        isPlaying &&
                        !signal.aborted &&
                        pipelinePos < durationMs
                    ) {
                        // No BIF frame at this position — nudge forward and retry.
                        if (!scene.image) {
                            await sleep(50, signal);
                            pipelinePos += 50;
                            scene = buildScene(pipelinePos);
                            imageSend = scene.image
                                ? sendImageToGlasses(scene.image)
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
                                nextScene && nextScene.image
                                    ? sendImageToGlasses(nextScene.image)
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
                        `[Stats] pos:${(currentTimeMs / 1000).toFixed(0)}s conn:${deviceConnectType} battery:${deviceBatteryLevel ?? "?"}% wearing:${deviceIsWearing} queue:${bleQueueDepth} img:${imageSuccessCount}ok/${imageFailureCount}fail(${failPct}%) subFail:${subtitleFailureCount} lastGoodImg:${sinceGood}s ago${consecutiveImageFailures > 0 ? ` FROZEN x${consecutiveImageFailures}` : ""}`,
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

                const frame = bifs.find(
                    (f, i) =>
                        f.timestampMs <= currentTimeMs &&
                        (bifs[i + 1]?.timestampMs > currentTimeMs ||
                            !bifs[i + 1]),
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

                if (frame) {
                    try {
                        await sendImageToGlasses(frame);
                    } catch (e) {
                        console.error(
                            "[Scene Engine] One-shot image failed:",
                            e,
                        );
                    }
                }
            }

            function updateUI() {
                // Find BIF frame corresponding to current playback time for local preview monitor
                const frame = bifs.find(
                    (f, i) =>
                        f.timestampMs <= currentTimeMs &&
                        (bifs[i + 1]?.timestampMs > currentTimeMs ||
                            !bifs[i + 1]),
                );

                // Update local monitor image src. updateUI runs on a timer and
                // must stay synchronous, so a cached frame is applied straight
                // away and a miss is fetched in the background. The offset
                // guard stops a slow fetch for an old frame overwriting a
                // newer one that has since been drawn.
                if (frame) {
                    const cachedUrl = peekFrameUrl(frame);
                    if (cachedUrl) {
                        if (imgTag.src !== cachedUrl) imgTag.src = cachedUrl;
                    } else {
                        previewWantedOffset = frame.offset;
                        getFrameAssets(frame)
                            .then((a) => {
                                if (previewWantedOffset === frame.offset) {
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

            // --- ATTACH HANDLERS ---
            document.getElementById("login-btn").onclick =
                beginPlexAuthExchange;
            document.getElementById("scan-media-btn").onclick =
                scanForValidMedia;
            document.getElementById("logout-btn-0").onclick = disconnectAccount;
            document.getElementById("logout-btn-1").onclick = disconnectAccount;
            document.getElementById("logout-btn-2").onclick = disconnectAccount;
            document.getElementById("back-to-lib-btn").onclick = () => {
                document.getElementById("media-panel").classList.add("hidden");
                document
                    .getElementById("library-panel")
                    .classList.remove("hidden");
            };

            document.getElementById("library-select").onchange = (e) => {
                handleLibraryChange(e.target.value);
            };

            document.getElementById("server-select").onchange = (e) => {
                populateConnections(Number(e.target.value));
            };

            document.getElementById("connect-server-btn").onclick =
                connectToSelectedServer;
            document.getElementById("query-source-btn").onclick =
                querySourceSecurityResources;

            document.getElementById("switch-server-btn-1").onclick = () => {
                document
                    .getElementById("library-panel")
                    .classList.add("hidden");
                document
                    .getElementById("server-panel")
                    .classList.remove("hidden");
            };

            document.getElementById("switch-server-btn-2").onclick = () => {
                document.getElementById("media-panel").classList.add("hidden");
                document
                    .getElementById("server-panel")
                    .classList.remove("hidden");
            };

            playBtn.onclick = () => {
                isPlaying = !isPlaying;
                playBtn.innerText = isPlaying ? "Pause" : "Play";
                const title =
                    document.getElementById("playing-title")?.textContent ||
                    "media";
                if (isPlaying) {
                    backgroundedWhilePlaying = false;
                    try {
                        silentAudio.play();
                    } catch (e) {
                        console.warn("Silent audio play failed:", e);
                    }
                    setStatus(`Now playing: ${title}`, "active");
                    // Pipeline drives the timeline — no clock needed
                    runScenePipeline();
                } else {
                    stopScenePipeline();
                    try {
                        silentAudio.pause();
                    } catch (e) {}
                    setStatus(`Paused: ${title}`, "active");
                }
            };

            timeline.oninput = (e) => {
                const wasPlaying = isPlaying;
                if (wasPlaying) {
                    stopScenePipeline();
                }
                currentTimeMs = Number(e.target.value);
                updateUI();
                sendOneShotUpdate();
                // Restart pipeline from new position if was playing
                if (wasPlaying && isPlaying) {
                    runScenePipeline();
                }
            };

            function resetPlayer() {
                isPlaying = false;
                stopScenePipeline();
                stopClock();
                hideLoadProgress();
                // Release the frame cache's object URLs. Leaving the episode is
                // the one moment they are certainly all dead.
                clearFrameCache();
                try {
                    silentAudio.pause();
                } catch (e) {}
                if (bridgeInstance) {
                    sendSubtitleToGlasses("Stream terminated.").catch(() => {});
                }
                document.getElementById("player-panel").classList.add("hidden");
                document
                    .getElementById("media-panel")
                    .classList.remove("hidden");
                setStatus("Select a title to play.", "active");

                // Reset scene pipeline state
                scenePipelineRunning = false;
                sceneAbortController = null;
                renderDurations = [];
                averageRenderDuration = 1500;
                lastSentImageTimestampMs = 0;
                lastPushedSubText = "";
            }

            document.getElementById("close-player-btn").onclick = resetPlayer;

            // --- IMAGE ADJUSTMENTS HANDLERS ---
            const brightnessSlider = document.getElementById("img-brightness");
            const contrastSlider = document.getElementById("img-contrast");
            const gammaSlider = document.getElementById("img-gamma");
            const ditherSelect = document.getElementById("img-dither");

            const valBrightness = document.getElementById("val-brightness");
            const valContrast = document.getElementById("val-contrast");
            const valGamma = document.getElementById("val-gamma");

            brightnessSlider.oninput = (e) => {
                brightnessValue = Number(e.target.value);
                valBrightness.textContent =
                    brightnessValue > 0
                        ? `+${brightnessValue}`
                        : brightnessValue;
                updateUI();
                sendOneShotUpdate();
            };

            contrastSlider.oninput = (e) => {
                contrastValue = Number(e.target.value);
                valContrast.textContent =
                    contrastValue > 0 ? `+${contrastValue}` : contrastValue;
                updateUI();
                sendOneShotUpdate();
            };

            gammaSlider.oninput = (e) => {
                gammaValue = Number(e.target.value);
                valGamma.textContent = gammaValue.toFixed(1);
                updateUI();
                sendOneShotUpdate();
            };

            ditherSelect.onchange = (e) => {
                ditherAlgorithm = e.target.value;
                updateUI();
                sendOneShotUpdate();
            };

            document.getElementById("reset-img-btn").onclick = () => {
                brightnessValue = 0;
                contrastValue = 0;
                gammaValue = 1.0;
                ditherAlgorithm = "floyd-steinberg";

                brightnessSlider.value = 0;
                contrastSlider.value = 0;
                gammaSlider.value = 1.0;
                ditherSelect.value = "floyd-steinberg";

                valBrightness.textContent = "0";
                valContrast.textContent = "0";
                valGamma.textContent = "1.0";

                updateUI();
                sendOneShotUpdate();
            };

            // Run startup authentication and layout initializations
            initApp();

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
            }

            function resumeFromBackground() {
                if (!backgroundedWhilePlaying) return;
                backgroundedWhilePlaying = false;
                if (!bifs || bifs.length === 0) return;
                isPlaying = true;
                playBtn.innerText = "Pause";
                try { silentAudio.play(); } catch (e) {}
                const title =
                    document.getElementById("playing-title")?.textContent ||
                    "media";
                setStatus(`Now playing: ${title}`, "active");
                console.log(
                    "[Lifecycle] Foregrounded — refreshing and resuming pipeline",
                );
                sendOneShotUpdate().catch(() => {});
                runScenePipeline();
            }

            // Defense in depth: the glasses host is expected to fire
            // FOREGROUND_ENTER/EXIT_EVENT (below), but the generic Page
            // Visibility API covers the plain-browser GitHub Pages build too
            // and costs nothing extra — both handlers are idempotent so it's
            // safe if both fire for the same real transition.
            document.addEventListener("visibilitychange", () => {
                if (document.hidden) pauseForBackground();
                else resumeFromBackground();
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
                        try { silentAudio.play(); } catch (e) {}
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
            window.__getStateSnapshot = () => {
                return JSON.stringify({
                    currentTimeMs,
                    isPlaying,
                    durationMs,
                    SERVER_URL,
                    TOKEN
                });
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

                        SERVER_URL = state.SERVER_URL ?? SERVER_URL;
                        TOKEN = state.TOKEN ?? TOKEN;
                        durationMs = state.durationMs ?? durationMs;

                        // Clamp against the actually-loaded media's real
                        // duration when we have one, rather than trusting
                        // the restored durationMs, which comes from the
                        // same (possibly stale) snapshot.
                        const knownDurationMs =
                            bifs.length > 0
                                ? bifs[bifs.length - 1].timestampMs
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