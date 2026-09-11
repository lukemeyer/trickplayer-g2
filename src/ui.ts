// @ts-nocheck
//
// The flow. See trickplayer-knowledge/UI.md.
//
//     sources -> browse -> list -> item -> player
//
// This file is the ONLY one that knows a panel exists, and it names no
// provider: every provider-shaped question is asked of an account object
// (src/account.ts), and every item-shaped one of a source (src/source.ts).
// `main.ts` below it is the engine and knows nothing about any of this.
//
// The debug console, the mirrored logs and the four separate settings screens
// the old build carried are gone rather than ported: they were scaffolding for
// getting the image path working, and the image path works.

import * as engine from "./main";
import { createPlexAccount } from "./plexaccount";
import { createJellyfinAccount } from "./jellyfinaccount";

// ---------------------------------------------------------------- plumbing

const $ = (id) => document.getElementById(id);
const PANELS = [
    "panel-sources", "panel-add-source", "panel-browse",
    "panel-list", "panel-item", "panel-player",
];

function show(panel) {
    for (const p of PANELS) $(p).classList.toggle("hidden", p !== panel);
}

function setHidden(id, hidden) { $(id).classList.toggle("hidden", hidden); }

const esc = engine.escapeHtml;

/** A tappable row. Every list in this app is made of these. */
function row(parent, title, subtitle, onClick, badges = []) {
    const div = document.createElement("div");
    div.className = "media-item";
    div.innerHTML =
        `<span>${esc(title)}${subtitle ? `<br><small class="text-muted">${esc(subtitle)}</small>` : ""}</span>` +
        (badges.length
            ? `<span class="tags">${badges.map((b) => `<span class="tag-badge">${esc(b)}</span>`).join("")}</span>`
            : "");
    div.onclick = onClick;
    parent.appendChild(div);
    return div;
}

const mb = (bytes) => bytes >= 1e6
    ? `${(bytes / 1e6).toFixed(1)} MB`
    : `${Math.round(bytes / 1e3)} KB`;

// ------------------------------------------------------------ saved sources
//
// A source is (provider + server + account), saved whole. On Jellyfin this is
// not a convenience: the address IS the identity and there is no account
// service to rebuild it from, so a build that forgets it asks someone to type
// an IP address into a pair of glasses (UI.md §1).

const STORE_KEY = "trickplayer.sources";
const LAST_KEY = "trickplayer.lastSource";

function loadSaved() {
    try { return JSON.parse(localStorage.getItem(STORE_KEY) || "[]"); }
    catch (e) { return []; }
}

function saveSource(account) {
    const rec = account.persist();
    const all = loadSaved().filter((s) => !(s.provider === rec.provider && s.id === rec.id));
    all.push(rec);
    localStorage.setItem(STORE_KEY, JSON.stringify(all));
    localStorage.setItem(LAST_KEY, `${rec.provider}:${rec.id}`);
}

/** The only place a persisted record becomes a live account. */
function accountFrom(rec) {
    return rec.provider === "jellyfin" ? createJellyfinAccount(rec) : createPlexAccount(rec);
}

// -------------------------------------------------------------- flow state

let account = null;      // the live source we are browsing
let stack = [];          // container refs, deepest last — the breadcrumb
let scanGeneration = 0;  // bumped to abandon an in-flight eligibility scan
let playable = null;     // the resolved item on the item panel
let previewUrls = [];

// ================================================================= SOURCES

function showSources() {
    const saved = loadSaved();
    const list = $("source-list");
    list.innerHTML = "";
    // Listed by SERVER name, not provider name — users think in servers, and
    // the provider is a badge (UI.md §1).
    for (const rec of saved) {
        row(list, rec.name || rec.serverUrl, rec.serverUrl,
            () => openSource(rec), [rec.provider === "jellyfin" ? "Jellyfin" : "Plex"]);
    }
    // Reached deliberately now, not only on the way in, so there has to be a
    // way out that is not "pick a server again".
    setHidden("sources-back", !account);
    show("panel-sources");
}

async function openSource(rec) {
    account = accountFrom(rec);
    localStorage.setItem(LAST_KEY, `${rec.provider}:${rec.id}`);
    stack = [];
    await showBrowse();
}

$("add-source-btn").onclick = () => startAddSource();
$("sources-back").onclick = () => { if (account) showBrowse(); };
$("add-source-cancel").onclick = () => {
    stopPolling();
    loadSaved().length ? showSources() : startAddSource();
};

// ============================================================== ADD SOURCE

let pollTimer = null;
function stopPolling() { if (pollTimer) { clearInterval(pollTimer); pollTimer = null; } }

function startAddSource() {
    stopPolling();
    localStorage.removeItem(PENDING_KEY);
    setHidden("add-step-provider", false);
    setHidden("add-step-address", true);
    setHidden("add-step-server", true);
    setHidden("add-step-code", true);
    show("panel-add-source");
}

for (const btn of document.querySelectorAll("[data-provider]")) {
    btn.onclick = () => {
        account = btn.dataset.provider === "jellyfin"
            ? null                       // needs an address before it exists
            : createPlexAccount();
        setHidden("add-step-provider", true);
        // The add-source flow is provider-ORDERED, not a shared sequence:
        // Jellyfin needs the address first, Plex discovers servers after
        // authenticating (UI.md §1).
        if (btn.dataset.provider === "jellyfin") {
            setHidden("add-step-address", false);
            $("jf-address").focus();
        } else {
            beginAuth();
        }
    };
}

$("jf-address-next").onclick = () => {
    const raw = $("jf-address").value.trim();
    if (!raw) return;
    const url = /^https?:\/\//.test(raw) ? raw : `http://${raw}`;
    account = createJellyfinAccount({ serverUrl: url, name: url });
    setHidden("add-step-address", true);
    beginAuth();
};

// A code in flight, kept across a reload. F-018: the sign-in must not depend on
// the polling timer surviving — a refresh mid-sign-in should re-attach to the
// code the user is holding, not mint a new one they have to go and re-type.
const PENDING_KEY = "trickplayer.pendingAuth";

/**
 * Code-and-poll, one implementation for both providers.
 *
 * They are the same shape — mint, show, poll, exchange — which is what let
 * F-018's rules transfer at all. The only difference is where the code is
 * entered, and that string comes from the provider because the user cannot
 * guess it.
 *
 * All four of F-018's requirements live here: a short typeable code (the
 * providers'), a code that survives a reload, expiry detected rather than
 * waited out, and a manual check for when polling is not being delivered.
 */
async function beginAuth(resuming) {
    setHidden("add-step-code", false);
    $("code-display").textContent = "····";
    $("code-status").textContent = resuming ? "Checking your code…" : "Requesting a code…";
    try {
        const auth = await account.beginAuth(resuming);
        $("code-display").textContent = auth.code;
        $("code-instruction").textContent = `Enter this code at ${auth.enterAt}`;
        $("code-status").textContent = "Waiting for you to approve it…";
        localStorage.setItem(PENDING_KEY, JSON.stringify({
            provider: account.provider,
            serverUrl: account.serverUrl,
            state: auth.state,
        }));

        const check = async () => {
            try {
                const result = await auth.poll();
                if (result === "pending") return;
                stopPolling();
                localStorage.removeItem(PENDING_KEY);
                if (result === "expired") {
                    // Said out loud rather than left spinning: an expired code
                    // looks exactly like one the user has not typed yet.
                    $("code-status").textContent = "That code expired. Getting a new one…";
                    return beginAuth();
                }
                await afterAuth();
            } catch (e) {
                $("code-status").textContent = `Sign-in failed: ${e.message}`;
            }
        };
        pollTimer = setInterval(check, 2000);
        // Polling is the fallback, not the mechanism: on a WebView that has
        // been backgrounded the timer may simply not have run.
        $("code-check-now").onclick = check;
    } catch (e) {
        localStorage.removeItem(PENDING_KEY);
        $("code-status").textContent = `Could not start sign-in: ${e.message}`;
    }
}

/** Re-attach to a code minted before a reload, if there is one. @returns true */
function resumePendingAuth() {
    let pending = null;
    try { pending = JSON.parse(localStorage.getItem(PENDING_KEY) || "null"); }
    catch (e) { /* fall through to a fresh sign-in */ }
    if (!pending || !pending.state) return false;

    account = pending.provider === "jellyfin"
        ? createJellyfinAccount({ serverUrl: pending.serverUrl, name: pending.serverUrl })
        : createPlexAccount();
    setHidden("add-step-provider", true);
    setHidden("add-step-address", true);
    setHidden("add-step-server", true);
    show("panel-add-source");
    beginAuth(pending.state);
    return true;
}

async function afterAuth() {
    $("code-status").textContent = "Approved. Finding servers…";
    const servers = await account.listServers();

    // Provider-supplied, not a fixed step: Jellyfin returns the one server it
    // was given, so there is nothing to choose and nothing to show.
    if (servers.length === 1 || !account.capabilities().hasServerDiscovery) {
        account.use(servers[0]);
        saveSource(account);
        stack = [];
        return showBrowse();
    }

    setHidden("add-step-code", true);
    setHidden("add-step-server", false);
    const list = $("server-list");
    list.innerHTML = "";
    if (!servers.length) {
        list.innerHTML = '<p class="text-muted">No servers on this account.</p>';
        return;
    }
    for (const srv of servers) {
        row(list, srv.name, srv.owner ? `Shared by ${srv.owner}` : "", () => {
            account.use(srv);
            saveSource(account);
            stack = [];
            showBrowse();
        });
    }
}

// ================================================================== BROWSE

async function showBrowse() {
    show("panel-browse");
    $("browse-title").textContent = account.name;
    // Always reachable, however many are saved.
    //
    // UI.md §1's rule is that the source step does not APPEAR when there is
    // only one — it is not a screen you dismiss on the way in. That was read
    // here as "there is no way to reach it", which strands anyone who has
    // signed in to one provider with no route to the other: the only place to
    // add a server is the screen this button leads to. Absent from the path,
    // reachable on purpose.
    setHidden("browse-back", false);
    const list = $("root-list");
    list.innerHTML = '<p class="text-muted">Loading…</p>';
    try {
        const roots = await account.listRoots();
        list.innerHTML = "";
        for (const r of roots) row(list, r.title, r.subtitle, () => openContainer(r));
    } catch (e) {
        list.innerHTML = `<p class="text-muted">Could not reach ${esc(account.name)}: ${esc(e.message)}</p>`;
    }
}

$("browse-back").onclick = () => { scanGeneration++; showSources(); };

// ==================================================================== LIST

function openContainer(container) {
    stack.push(container);
    renderList();
}

$("list-back").onclick = () => {
    scanGeneration++;
    stack.pop();
    stack.length ? renderList() : showBrowse();
};

/**
 * One level, whatever that level is.
 *
 * Containers and items are rendered by the same loop because depth is
 * discovered, not assumed: a show is a container, a film is an item, a playlist
 * is a container of items. The old `library -> show -> episode` walk was a
 * television structure that films and playlists had to be bent to fit.
 */
async function renderList() {
    const here = stack[stack.length - 1];
    const myGeneration = ++scanGeneration;
    show("panel-list");
    $("list-title").textContent = here.title;
    $("list-status").textContent = "Loading…";
    const list = $("results-list");
    list.innerHTML = "";

    let children;
    try {
        children = await account.listChildren(here.ref);
    } catch (e) {
        $("list-status").textContent = `Could not load: ${e.message}`;
        return;
    }
    if (myGeneration !== scanGeneration) return;

    const containers = children.filter((c) => c.kind === "container");
    const items = children.filter((c) => c.kind === "item");

    for (const c of containers) row(list, c.title, c.subtitle, () => openContainer(c));

    if (!items.length) {
        $("list-status").textContent = containers.length ? "" : "Nothing here.";
        return;
    }

    // Eligibility is one question per item, and the list is shown NOW and
    // filled in as answers arrive (F-015). The total is the same either way;
    // four seconds of blank screen is a bad app and four seconds of a list
    // filling in is a working one, and the user picks something long before the
    // scan ends.
    let found = 0;
    for (let i = 0; i < items.length; i++) {
        if (myGeneration !== scanGeneration) return;
        $("list-status").textContent =
            `Checking ${i + 1} of ${items.length}` + (found ? ` — ${found} playable` : "");
        let match = null;
        try {
            // The ONLY eligibility signal. Plex needs the sidecar-subtitle
            // rule and Jellyfin must not have it (F-037), so this file never
            // asks the question itself.
            match = await account.resolvePlayable(items[i]);
        } catch (e) {
            console.warn(`eligibility check failed for ${items[i].title}: ${e.message}`);
        }
        if (!match) continue;
        found++;
        row(list, match.title, "", () => openItem(match), match.badges);
    }

    if (myGeneration !== scanGeneration) return;
    // A container that is half ineligible says so rather than silently
    // appearing short — on Plex that is often most of a playlist, and someone
    // who has not heard of the sidecar rule would think the app was broken.
    $("list-status").textContent = found
        ? `${found} of ${items.length} playable`
        : "Nothing here can be played yet — an item needs a trick-play index and subtitles.";
}

// ==================================================================== ITEM

const PREVIEW_SCENES = 3;
const PREVIEW_AUTO_LIMIT = 250 * 1024;

async function openItem(match) {
    playable = match;
    releasePreview();
    show("panel-item");
    $("item-title").textContent = match.title;
    $("preview-strip").innerHTML = "";
    $("preview-note").textContent = "Reading index…";
    setHidden("preview-load", true);

    try {
        const stats = await engine.prepareItem({
            title: match.title,
            durationMs: match.durationMs,
            source: account.openSource(match),
        });
        applyOptionsToEngine();

        // Gate on the ESTIMATE, not a fixed rule: a Plex 3-scene preview is
        // ~45 KB and a Jellyfin one is a whole ~865 KB tile sheet — after which
        // the rest of the film is free (F-038).
        const cost = engine.previewCostBytes(PREVIEW_SCENES);
        if (cost === null || cost <= PREVIEW_AUTO_LIMIT) {
            await loadPreview(cost);
        } else {
            $("preview-note").textContent = `Preview — about ${mb(cost)}`;
            setHidden("preview-load", false);
        }
    } catch (e) {
        $("preview-note").textContent = `Could not load this item: ${e.message}`;
    }
}

$("preview-load").onclick = () => loadPreview(engine.previewCostBytes(PREVIEW_SCENES));

async function loadPreview(cost) {
    setHidden("preview-load", true);
    $("preview-note").textContent = "Loading preview…";
    try {
        const scenes = await engine.previewScenes(PREVIEW_SCENES);
        releasePreview();
        previewUrls = scenes.map((s) => s.url);
        const strip = $("preview-strip");
        strip.innerHTML = "";
        for (const s of scenes) {
            const fig = document.createElement("figure");
            fig.className = "preview-scene";
            fig.innerHTML =
                `<img src="${s.url}" alt="" />` +
                `<figcaption>${esc(s.text).replace(/\n/g, "<br>")}</figcaption>`;
            strip.appendChild(fig);
        }
        // Say what it bought. On a batch source that is the whole film, which
        // is worth knowing before deciding whether to be careful again.
        $("preview-note").textContent = cost
            ? `${mb(cost)} loaded${engine.previewCostBytes(1000) === cost ? " — covers the whole item" : ""}`
            : "";
    } catch (e) {
        $("preview-note").textContent = `Preview failed: ${e.message}`;
    }
}

function releasePreview() {
    for (const u of previewUrls) URL.revokeObjectURL(u);
    previewUrls = [];
}

/**
 * The consequence line under each control.
 *
 * Every one of these is a trade, and the label alone cannot be evaluated. Both
 * numbers fall out of the scene list, which is built without touching the
 * network — so this costs nothing (UI.md §4.1).
 */
function renderConsequences(stats) {
    $("bandwidth-note").textContent =
        `${stats.scenes} scenes · about ${mb(stats.deviceBytes)} to the glasses`;
    $("skip-silent-note").textContent = !stats.hasCues
        ? "This item has no subtitles, so this changes nothing."
        : `${stats.unfiltered} scenes → ${stats.withSubtitles} with subtitles`;
}

/** Push the controls' current values into the engine for a freshly-opened item. */
function applyOptionsToEngine() {
    engine.setSkipSilent($("opt-skip-silent").checked);
    engine.setPicture({
        contrast: Number($("opt-contrast").value),
        brightness: Number($("opt-brightness").value),
        gamma: Number($("opt-gamma").value) / 100,
        texture: document.querySelector("[data-texture].active")?.dataset.texture,
    });
    // Bandwidth last: it is the one that rebuilds and returns the counts.
    renderConsequences(engine.setBandwidth($("opt-bandwidth").value));
}

// --- options ---

$("opt-skip-silent").onchange = (e) => {
    engine.setSkipSilent(e.target.checked);
    renderConsequences(engine.setBandwidth($("opt-bandwidth").value));
};

$("opt-bandwidth").oninput = (e) => renderConsequences(engine.setBandwidth(e.target.value));

// Picture controls live ON the preview, because contrast and dither are
// unjudgeable as words and obvious as pictures.
const pictureInputs = { "opt-contrast": "contrast", "opt-brightness": "brightness" };
for (const [id, key] of Object.entries(pictureInputs)) {
    $(id).oninput = (e) => { engine.setPicture({ [key]: Number(e.target.value) }); repaintPreview(); };
}
$("opt-gamma").oninput = (e) => {
    engine.setPicture({ gamma: Number(e.target.value) / 100 });
    repaintPreview();
};

for (const btn of document.querySelectorAll("[data-texture]")) {
    btn.onclick = () => {
        for (const b of document.querySelectorAll("[data-texture]")) b.classList.remove("active");
        btn.classList.add("active");
        // Named by effect, not algorithm: nobody chooses between
        // "Floyd–Steinberg" and "Atkinson" from the names (UI.md §4.2).
        engine.setPicture({ texture: btn.dataset.texture });
        repaintPreview();
    };
}

$("picture-reset").onclick = () => {
    $("opt-contrast").value = 0;
    $("opt-brightness").value = 0;
    $("opt-gamma").value = 100;
    engine.setPicture({ contrast: 0, brightness: 0, gamma: 1 });
    repaintPreview();
};

// Re-render what is already on screen rather than re-fetching: the frames are
// cached, so a contrast change costs a decode and no network.
let repaintTimer = null;
function repaintPreview() {
    engine.pictureIsLive();
    if (!previewUrls.length) return;
    clearTimeout(repaintTimer);
    repaintTimer = setTimeout(() => loadPreview(null), 150);
}

$("item-back").onclick = () => { engine.stop(); releasePreview(); renderList(); };
$("item-play").onclick = () => { show("panel-player"); engine.play(); };

// ================================================================== PLAYER

$("close-player-btn").onclick = () => engine.stop();

// =================================================================== BOOT

engine.setUiHooks({
    stopped: () => { releasePreview(); show("panel-item"); },
});

(async function boot() {
    // The bridge first: it is the one thing that can fail in a way no amount of
    // browsing works around, and its status line is already on screen.
    engine.initBridge();

    if (resumePendingAuth()) return;

    const saved = loadSaved();
    if (!saved.length) return startAddSource();

    // The last-used source is the default, and browsing starts there.
    const last = localStorage.getItem(LAST_KEY);
    const rec = saved.find((s) => `${s.provider}:${s.id}` === last) || saved[0];
    if (saved.length === 1 || rec) return openSource(rec);
    showSources();
})();
