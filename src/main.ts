// @ts-nocheck
import {
    waitForEvenAppBridge,
    ImageRawDataUpdate,
    OsEventTypeList
} from "@evenrealities/even_hub_sdk";
import { decodeBif } from "./bif";
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
            function bleEnqueue(fn) {
                bleQueue = bleQueue.then(() => fn()).catch(() => {});
                return bleQueue;
            }

            // --- CHUNK PIPELINE STATE ---
            let chunkPipelineRunning = false;
            let chunkAbortController = null; // AbortController to cancel pipeline on pause/seek
            let renderDurations = []; // last 5 image render durations (ms)
            let averageRenderDuration = 1500; // moving avg, clamped 1000–8000ms
            let lastSentImageTimestampMs = 0;
            let lastPushedSubText = "";

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

                    statusDiv.textContent =
                        "Active Plex session restored from storage.";
                    if (indicator) indicator.classList.add("active");
                    document
                        .getElementById("auth-panel")
                        .classList.add("hidden");

                    // Restore connection, fetch server list in background, and jump straight to libraries
                    fetchServers(true);
                }
            }

            async function initEvenBridge() {
                try {
                    statusDiv.textContent =
                        "Searching for active G2 Webview Environment Hook...";
                    bridgeInstance = await waitForEvenAppBridge();

                    glassesSubtitleContainer = {
                        xPosition: 72, // Centered horizontally: (576 - 432) / 2
                        yPosition: 156, // Top = image bottom (144) + 12px padding (half text line)
                        width: 432, // 75% of 576 screen width
                        height: 132, // Fill remaining space: 288 - 156 = 132
                        borderWidth: 0,
                        containerID: 1,
                        containerName: "g2_subs",
                        content: "Awaiting Sign-In...",
                        isEventCapture: 1, // designates subtitle container as primary event receiver
                    };

                    glassesImageContainer = {
                        xPosition: 144, // Centered horizontally: (576 - 288) / 2
                        yPosition: 0, // Put at y=0 (no padding on top)
                        width: 288,
                        height: 144,
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
                        statusDiv.textContent =
                            "G2 Glass Engine Connected via BLE!";
                        if (indicator) indicator.classList.add("active");
                    } else {
                        throw new Error(
                            `Startup container creation failed with result ${result}`,
                        );
                    }
                } catch (err) {
                    statusDiv.textContent =
                        "G2 App Bridge Offline (Browser Preview Loop Active)";
                    // Leave indicator orange to signify local sandbox / emulator mode
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
                if (statusDiv)
                    statusDiv.textContent = "Fetching Plex servers...";
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
                    }
                } catch (e) {
                    console.error("Failed to fetch servers:", e);
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

                statusDiv.textContent = `Connected to ${server.name} (${connection.local ? "Local" : "Remote"})`;
                if (indicator) indicator.classList.add("active");

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
                if (bridgeInstance) {
                    sendSubtitleToGlasses("Account Disconnected.").catch(
                        () => {},
                    );
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
                } catch (e) {
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
                                                    partId: part.id,
                                                    subId: subStream.id,
                                                    subKey: subStream.key,
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
                } catch (e) {
                    if (scanStatus)
                        scanStatus.textContent =
                            "Error scanning file tree: " + e.message;
                    else alert("Error scanning file tree: " + e.message);
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

                if (bridgeInstance) {
                    await bridgeInstance.textContainerUpgrade({
                        containerID: 1,
                        containerName: "g2_subs",
                        contentOffset: 0,
                        contentLength: 0,
                        content: "Unpacking streaming matrix...",
                    });
                }

                const bifUrl = `${SERVER_URL}/library/parts/${media.partId}/indexes/sd?X-Plex-Token=${TOKEN}`;
                const cleanServerUrl = SERVER_URL.replace(/\/$/, "");
                const cleanSubKey = media.subKey.startsWith("/")
                    ? media.subKey
                    : `/${media.subKey}`;
                const subUrl = `${cleanServerUrl}${cleanSubKey}${cleanSubKey.includes("?") ? "&" : "?"}X-Plex-Token=${TOKEN}`;

                try {
                    const [bifRes, subRes] = await Promise.all([
                        fetch(bifUrl),
                        fetch(subUrl),
                    ]);

                    if (!bifRes.ok)
                        throw new Error(
                            `BIF index file download returned HTTP ${bifRes.status}`,
                        );
                    if (!subRes.ok)
                        throw new Error(
                            `SRT subtitle file download returned HTTP ${subRes.status}`,
                        );

                    bifs = decodeBif(await bifRes.arrayBuffer());
                    subtitles = parseSubtitles(await subRes.text());

                    durationMs = bifs[bifs.length - 1].timestampMs;
                    timeline.max = durationMs;
                    currentTimeMs = 0;

                    // Reset chunk pipeline state
                    chunkPipelineRunning = false;
                    chunkAbortController = null;
                    renderDurations = [];
                    averageRenderDuration = 1500;
                    lastSentImageTimestampMs = 0;
                    lastPushedSubText = "";

                    updateUI();
                    sendOneShotUpdate();
                } catch (e) {
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
            } // --- CHUNK PIPELINE HELPERS ---

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

            function getChunkDuration() {
                if (renderDurations.length === 0) return 5000;
                const sum = renderDurations.reduce((a, b) => a + b, 0);
                const avg = sum / renderDurations.length;
                return Math.max(5000, Math.min(15000, avg));
            }

            function buildChunk(startMs) {
                const baseDuration = getChunkDuration();
                const targetEndMs = startMs + baseDuration;

                // Find BIF frame at startMs
                const frame = bifs.find(
                    (f, i) =>
                        f.timestampMs <= startMs &&
                        (bifs[i + 1]?.timestampMs > startMs || !bifs[i + 1]),
                );

                // Ensure chunk extends to the NEXT image's exact timestamp
                // so we never send the same image twice
                const nextFrame = bifs.find(f => f.timestampMs >= targetEndMs);
                const endMs = nextFrame ? nextFrame.timestampMs : targetEndMs;
                const duration = endMs - startMs;

                // Collect subtitles that overlap [startMs, endMs)
                const chunkSubs = subtitles.filter(
                    (s) => s.endMs > startMs && s.startMs < endMs,
                );

                return {
                    image: frame,
                    subtitles: chunkSubs,
                    startMs,
                    endMs,
                    duration,
                };
            }

            async function sendImageToGlasses(frame) {
                if (!bridgeInstance || !frame?.rawBlobData) return 0;

                const preparedBytes = await resizeAndPrepareImage(
                    frame.rawBlobData,
                    288,
                    144,
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

                        // Measure only the actual BLE render, not time spent
                        // waiting behind other writes in the serial queue.
                        const start = performance.now();
                        const result = await bridgeInstance.updateImageRawData(payload);
                        const duration = performance.now() - start;

                        renderDurations.push(duration);
                        if (renderDurations.length > 5) renderDurations.shift();
                        averageRenderDuration = getChunkDuration();

                        console.log(
                            `[Chunk Engine] Image rendered for ${frame.timestampMs / 1000}s: ${result} (${duration.toFixed(0)}ms, avg: ${averageRenderDuration.toFixed(0)}ms)`,
                        );

                        if (result === "success") {
                            lastSentImageTimestampMs = frame.timestampMs;
                        }
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
                        await bridgeInstance.textContainerUpgrade({
                            containerID: 1,
                            containerName: "g2_subs",
                            contentOffset: 0,
                            contentLength: 0,
                            content: displayText,
                        });
                        resolve();
                    });
                });
            }

            async function runChunkPipeline() {
                // Stop any existing pipeline first
                stopChunkPipeline();
                while (chunkPipelineRunning) {
                    await sleep(10);
                }

                chunkPipelineRunning = true;
                chunkAbortController = new AbortController();
                const signal = chunkAbortController.signal;

                // Pipeline drives the timeline — stop the clock
                stopClock();

                console.log(
                    "[Chunk Engine] Pipeline started at " +
                        currentTimeMs +
                        "ms",
                );

                try {
                    let pipelinePos = currentTimeMs;

                    // Build the first chunk and kick off its image send. There is
                    // nothing to overlap with yet, so it just starts immediately.
                    let chunk = buildChunk(pipelinePos);
                    let imageSend =
                        chunk.image
                            ? sendImageToGlasses(chunk.image)
                            : Promise.resolve(0);

                    while (
                        isPlaying &&
                        !signal.aborted &&
                        pipelinePos < durationMs
                    ) {
                        // No BIF frame at this position — nudge forward and retry.
                        if (!chunk.image) {
                            await sleep(50, signal);
                            pipelinePos += 50;
                            chunk = buildChunk(pipelinePos);
                            imageSend = chunk.image
                                ? sendImageToGlasses(chunk.image)
                                : Promise.resolve(0);
                            continue;
                        }

                        // 1. Show this chunk's image locally and wait for its BLE
                        //    render. The send was issued at the END of the previous
                        //    iteration (prefetched while the last subtitle showed),
                        //    so by now it is usually already complete.
                        currentTimeMs = chunk.startMs;
                        updateUI();
                        console.log(
                            `[Chunk Engine] Awaiting image at ${chunk.startMs}ms (chunk: ${chunk.duration.toFixed(0)}ms, subs: ${chunk.subtitles.length})`,
                        );
                        try {
                            await imageSend;
                        } catch (e) {
                            console.error(
                                "[Chunk Engine] Image send failed:",
                                e,
                            );
                        }
                        if (signal.aborted) break;

                        // Pre-build the next chunk so its image can be prefetched
                        // while this chunk's last subtitle is still being read.
                        const nextPos = chunk.endMs;
                        const nextChunk =
                            nextPos < durationMs ? buildChunk(nextPos) : null;
                        let nextImageSend = null;
                        const startNextImage = () => {
                            if (nextImageSend) return;
                            nextImageSend =
                                nextChunk && nextChunk.image
                                    ? sendImageToGlasses(nextChunk.image)
                                    : Promise.resolve(0);
                        };

                        // 2. Stream subtitles for this chunk with natural display duration
                        const subs = chunk.subtitles;
                        for (let i = 0; i < subs.length; i++) {
                            const sub = subs[i];
                            if (signal.aborted) break;

                            const cleanText = sub.text
                                .replace(/<br\s*\/?>/gi, "\n")
                                .replace(/<[^>]*>/g, "");

                            // Only wait for the portion of the subtitle that is within THIS chunk
                            const startTimeInChunk = Math.max(sub.startMs, chunk.startMs);
                            const endTimeInChunk = Math.min(sub.endMs, chunk.endMs);
                            const displayDuration = endTimeInChunk - startTimeInChunk;

                            if (displayDuration <= 0) continue;

                            // Update HTML to show this subtitle
                            currentTimeMs = sub.startMs;
                            updateUI();

                            // Send to glasses (sendSubtitleToGlasses will deduplicate automatically)
                            try {
                                await sendSubtitleToGlasses(cleanText);
                            } catch (e) {
                                console.error(
                                    "[Chunk Engine] Subtitle send failed:",
                                    e,
                                );
                            }

                            // 3. Once the LAST subtitle is on screen, start sending
                            //    the next image while the user reads it. The serial
                            //    BLE queue holds it behind this subtitle write, so
                            //    the two never transmit at the same time.
                            if (i === subs.length - 1) startNextImage();

                            // Hold subtitle on screen for its duration within this chunk
                            if (!signal.aborted && displayDuration > 0) {
                                await sleep(displayDuration, signal);
                            }

                            // 4. Clear subtitle ONLY if it actually ends within this chunk
                            if (!signal.aborted && sub.endMs <= chunk.endMs) {
                                try {
                                    await sendSubtitleToGlasses(" ");
                                } catch (e) {}
                            }
                        }

                        if (signal.aborted) break;

                        // 5. Chunk had no (displayable) subtitles to piggyback on —
                        //    issue the next image now so it is in flight.
                        startNextImage();

                        // 6. Advance to the next chunk; its image is already sending.
                        pipelinePos = chunk.endMs;
                        currentTimeMs = pipelinePos;
                        updateUI();

                        chunk = nextChunk || buildChunk(pipelinePos);
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
                    }
                } catch (e) {
                    console.error("[Chunk Engine] Pipeline error:", e);
                } finally {
                    chunkPipelineRunning = false;
                    chunkAbortController = null;
                    console.log("[Chunk Engine] Pipeline stopped");
                }
            }

            function stopChunkPipeline() {
                if (chunkAbortController) {
                    chunkAbortController.abort();
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

                const cleanText = sub
                    ? sub.text
                          .replace(/<br\s*\/?>/gi, "\n")
                          .replace(/<[^>]*>/g, "")
                    : " ";

                try {
                    await sendSubtitleToGlasses(cleanText);
                } catch (e) {
                    console.error(
                        "[Chunk Engine] One-shot subtitle failed:",
                        e,
                    );
                }

                if (frame) {
                    try {
                        await sendImageToGlasses(frame);
                    } catch (e) {
                        console.error(
                            "[Chunk Engine] One-shot image failed:",
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

                // Update local monitor image src
                if (frame && imgTag.src !== frame.url) {
                    imgTag.src = frame.url;
                }

                // Find subtitle matching currentTimeMs for local display
                const sub = subtitles.find(
                    (s) =>
                        currentTimeMs >= s.startMs && currentTimeMs <= s.endMs,
                );

                if (subDiv.innerHTML !== (sub ? sub.text : "")) {
                    subDiv.innerHTML = sub ? sub.text : "";
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
                if (isPlaying) {
                    try {
                        silentAudio.play();
                    } catch (e) {
                        console.warn("Silent audio play failed:", e);
                    }
                    // Pipeline drives the timeline — no clock needed
                    runChunkPipeline();
                } else {
                    stopChunkPipeline();
                    try {
                        silentAudio.pause();
                    } catch (e) {}
                }
            };

            timeline.oninput = (e) => {
                const wasPlaying = isPlaying;
                if (wasPlaying) {
                    stopChunkPipeline();
                }
                currentTimeMs = Number(e.target.value);
                updateUI();
                sendOneShotUpdate();
                // Restart pipeline from new position if was playing
                if (wasPlaying && isPlaying) {
                    runChunkPipeline();
                }
            };

            function resetPlayer() {
                isPlaying = false;
                stopChunkPipeline();
                stopClock();
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

                // Reset chunk pipeline state
                chunkPipelineRunning = false;
                chunkAbortController = null;
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
                if (typeof stopChunkPipeline === 'function') stopChunkPipeline();
                isPlaying = false;
                try { silentAudio.pause(); } catch (e) {}
                if (bridgeInstance) {
                    bridgeInstance.shutDownPageContainer(1);
                }
            }

            // Event routing for Even Hub
            
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
                    if (isPlaying) {
                        isPlaying = false;
                        if (typeof stopChunkPipeline === 'function') stopChunkPipeline();
                    } else if (bifs && bifs.length > 0) {
                        isPlaying = true;
                        if (typeof runChunkPipeline === 'function') runChunkPipeline();
                    }
                    return;
                }
            
                if (sysType === OsEventTypeList.SYSTEM_EXIT_EVENT || sysType === OsEventTypeList.ABNORMAL_EXIT_EVENT) {
                    cleanup();
                }
            });
            
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
                        currentTimeMs = state.currentTimeMs ?? currentTimeMs;
                        durationMs = state.durationMs ?? durationMs;
                        SERVER_URL = state.SERVER_URL ?? SERVER_URL;
                        TOKEN = state.TOKEN ?? TOKEN;
                        
                        if (state.isPlaying) {
                            isPlaying = true;
                            if (typeof runChunkPipeline === 'function') runChunkPipeline();
                        }
                    } catch (e) {
                        console.error("Failed to restore state", e);
                    }
                }
            };