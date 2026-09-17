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
import * as store from "./store";

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
/** h:mm:ss / m:ss, for "resuming at". */
function clock(ms) {
    const total = Math.max(0, Math.round(ms / 1000));
    const h = Math.floor(total / 3600), m = Math.floor((total % 3600) / 60), sec = total % 60;
    const two = (n) => String(n).padStart(2, "0");
    return h ? `${h}:${two(m)}:${two(sec)}` : `${m}:${two(sec)}`;
}

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
    try { return JSON.parse(store.getItem(STORE_KEY) || "[]"); }
    catch (e) { return []; }
}

function saveSource(account) {
    const rec = account.persist();
    // A freshly authorised source is also "the open one", and the eligibility
    // cache is scoped by it.
    if (sourceKey !== `${rec.provider}:${rec.id}`) eligibility.clear();
    sourceKey = `${rec.provider}:${rec.id}`;
    const all = loadSaved().filter((s) => !(s.provider === rec.provider && s.id === rec.id));
    all.push(rec);
    store.setItem(STORE_KEY, JSON.stringify(all));
    store.setItem(LAST_KEY, `${rec.provider}:${rec.id}`);
}

/** The only place a persisted record becomes a live account. */
function accountFrom(rec) {
    return rec.provider === "jellyfin" ? createJellyfinAccount(rec) : createPlexAccount(rec);
}

// -------------------------------------------------------------- flow state

let account = null;      // the live source we are browsing
let stack = [];          // container refs, deepest last — the breadcrumb
let scanGeneration = 0;  // bumped to abandon an in-flight eligibility scan
let sourceKey = null;    // provider:id of the open source — scopes the cache below

/**
 * Answers to "can this item be played", kept for the session.
 *
 * Eligibility is one network round trip per item (F-015), and walking into an
 * episode and back out asked every one of them again — the list rebuilt itself
 * from scratch each time, several seconds of "Checking 7 of 24" for answers it
 * already had.
 *
 * Session-scoped, deliberately. The answer depends on what the server currently
 * has — a subtitle added later makes an ineligible item eligible — and each
 * entry is ~200 bytes, so a library of a thousand episodes would be ~200 KB to
 * carry across launches, hydrated on every start by everyone. Not worth it for
 * a question this cheap to re-ask once per session; see the note in README.
 */
const eligibility = new Map();
const eligibilityKey = (item) => `${sourceKey}|${JSON.stringify(item.ref)}`;

/** Ask once per item per session. `null` (ineligible) is an answer worth keeping. */
async function resolveCached(item) {
    const key = eligibilityKey(item);
    if (eligibility.has(key)) return eligibility.get(key);
    const match = await account.resolvePlayable(item);
    eligibility.set(key, match);
    return match;
}

// ------------------------------------------------------------ recently played
//
// So the glasses alone can start something: five entries, each a resolved
// playable plus the source it came from, which is everything `prepareItem`
// needs. No browsing, no phone.

const RECENT_KEY = "trickplayer.recent";
const RECENT_MAX = 5;

function loadRecent() {
    try { return JSON.parse(store.getItem(RECENT_KEY) || "[]"); }
    catch (e) { return []; }
}

const sameItem = (a, b) =>
    a && b && a.accountId === b.accountId && JSON.stringify(a.config) === JSON.stringify(b.config);

/**
 * Remember an item, and where it had got to.
 *
 * The position is the point: picking something from the list is "carry on
 * watching", and starting it from the beginning every time is not that.
 */
function rememberPlayed(match, positionMs = 0) {
    if (!match || !sourceKey) return;
    const [provider, id] = sourceKey.split(":");
    const entry = {
        provider, accountId: id, title: match.title,
        durationMs: match.durationMs ?? null, config: match.config,
        positionMs: Math.max(0, Math.round(positionMs) || 0),
    };
    const rest = loadRecent().filter((r) => !sameItem(r, entry));
    const all = [entry, ...rest].slice(0, RECENT_MAX);
    store.setItem(RECENT_KEY, JSON.stringify(all));
    engine.setRecentTitles(all.map(recentLabel));
}

/**
 * What a remembered item looks like on the glasses: the title, and where it
 * had got to. A list of titles alone cannot answer "which one was I part-way
 * through", which is the question the list exists to answer.
 */
function recentLabel(r) {
    const at = resumeAt(r);
    if (!at) return r.title;
    const time = clock(at);
    const room = 38 - time.length;           // list items are truncated by the engine
    const title = r.title.length > room ? `${r.title.slice(0, room - 1)}…` : r.title;
    return `${title} · ${time}`;
}

/** Where to start an item that has been watched before. */
function resumeAt(entry) {
    if (!entry?.positionMs) return 0;
    // Nearly finished is finished: resuming into the credits is worse than
    // starting again, and the wearer cannot easily seek from the glasses.
    if (entry.durationMs && entry.positionMs > entry.durationMs * 0.97) return 0;
    return entry.positionMs;
}

/**
 * Keep the remembered position current while something plays.
 *
 * On a timer rather than at the end, because the end is exactly the moment
 * that tends not to arrive — the app is closed, the glasses are taken off, the
 * WebView is discarded.
 */
setInterval(() => {
    if (!playable || !engine.playbackState().playing) return;
    rememberPlayed(playable, engine.positionMs());
}, 15000);

/** Play a remembered item without going through the browser. */
async function playRecent(index) {
    const all = loadRecent();
    const entry = all[index];
    if (!entry) return false;
    const rec = loadSaved().find((sv) => sv.provider === entry.provider && sv.id === entry.accountId);
    if (!rec) return false;
    if (!account || sourceKey !== `${entry.provider}:${entry.accountId}`) {
        account = accountFrom(rec);
        sourceKey = `${entry.provider}:${entry.accountId}`;
        eligibility.clear();
    }
    const match = { title: entry.title, durationMs: entry.durationMs, badges: [], config: entry.config };
    playable = match;
    show("panel-player");
    await engine.prepareItem({
        title: match.title, durationMs: match.durationMs, source: account.openSource(match),
    });
    applyOptionsToEngine();
    const from = resumeAt(entry);
    if (from) engine.seekTo(from);
    engine.play();
    return true;
}
let playable = null;     // the resolved item on the item panel
let previewUrls = [];

// ================================================================= SOURCES

function showSources() {
    const saved = loadSaved();
    const list = $("source-list");
    list.innerHTML = "";
    // Recently played first: the whole point is not having to browse, and that
    // is as true on the phone as on the glasses.
    const recent = loadRecent();
    if (recent.length) {
        const head = document.createElement("p");
        head.className = "text-muted";
        head.textContent = "Recently played";
        list.appendChild(head);
        recent.forEach((r, i) => row(
            list, r.title, resumeAt(r) ? `Resume at ${clock(resumeAt(r))}` : null,
            () => playRecent(i), [r.provider === "jellyfin" ? "Jellyfin" : "Plex"]));
        const sep = document.createElement("p");
        sep.className = "text-muted";
        sep.textContent = "Servers";
        list.appendChild(sep);
    }
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
    if (sourceKey !== `${rec.provider}:${rec.id}`) eligibility.clear();
    sourceKey = `${rec.provider}:${rec.id}`;
    store.setItem(LAST_KEY, `${rec.provider}:${rec.id}`);
    stack = [];
    await showBrowse();
}

// Turn the recorder on, HERE, without going anywhere.
//
// This used to be `location.href = "telemetry.html"`, and on the glasses that
// is not a navigation — it is the end of the app. The G2 prompts "End this
// feature", the startup containers go with it, and every image write after that
// is refused instantly while text carries on. A beta caught it exactly:
// 0 images sent, 20 failed, every write timing 0ms.
//
// So the recorder comes to the app instead. Loaded on demand, so a wearer who
// never taps it does not carry the code.
for (const btn of document.querySelectorAll("[data-logging]")) {
    btn.onclick = async () => {
        btn.disabled = true;
        btn.textContent = "Starting the recorder…";
        try {
            const { enableLogging } = await import("./logging");
            await enableLogging(engine);
            // Both of them — the offer appears on the server list and on the
            // add-a-server step, and once the recorder is on neither is an
            // offer any more.
            for (const b of document.querySelectorAll("[data-logging]")) b.remove();
        } catch (e) {
            btn.disabled = false;
            btn.textContent = "Connect with logging";
            console.error(`[logging] could not start: ${e.message}`);
        }
    };
}

// `?logging=1` turns the recorder on at boot. For the simulator and for a
// phone on a desk: neither has a way to tap a button, and this path is now the
// one every tester uses, so it has to be drivable from a harness.
const harness = new URLSearchParams(location.search);
if (harness.has("logging")) {
    setTimeout(() => document.querySelector("[data-logging]")?.click(), 1500);
}
// `?play=1` starts the first playable item, so a harness can measure the real
// pipeline rather than an idle page.
// `?demorecent=1` draws the glasses picker with placeholder titles. The
// simulator has no server to sign into, and the list container is a piece of
// glasses UI that cannot be checked any other way.
if (harness.has("demorecent")) {
    setTimeout(() => {
        engine.setRecentTitles([
            "The Expanse — S1E1", "Finding Dory", "Arrival",
            "Chernobyl — E3", "Paddington 2",
        ]);
        engine.showRecentOnGlasses();
        // ...and what picking one looks like.
        setTimeout(() => {
            engine.showPlayerOnGlasses();
            engine.announceLoading("Finding Dory");
        }, 4000);
    }, 2000);
}

if (harness.has("play")) {
    setTimeout(() => { firstPlayable(); }, 2500);
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
    store.removeItem(PENDING_KEY);
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
        store.setItem(PENDING_KEY, JSON.stringify({
            provider: account.provider,
            serverUrl: account.serverUrl,
            state: auth.state,
        }));

        const check = async () => {
            try {
                const result = await auth.poll();
                if (result === "pending") return;
                stopPolling();
                store.removeItem(PENDING_KEY);
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
        store.removeItem(PENDING_KEY);
        $("code-status").textContent = `Could not start sign-in: ${e.message}`;
    }
}

/** Re-attach to a code minted before a reload, if there is one. @returns true */
function resumePendingAuth() {
    let pending = null;
    try { pending = JSON.parse(store.getItem(PENDING_KEY) || "null"); }
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
        // The account's own message already names the server and says why,
        // when it has a why; don't wrap it in a second "could not reach".
        const said = /^Couldn't reach /.test(e.message);
        list.innerHTML = `<p class="text-muted">${said ? "" : `Could not reach ${esc(account.name)}: `}${esc(e.message)}</p>`;
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
            match = await resolveCached(items[i]);
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

        // Carry on where this one stopped, however it was opened.
        const [provider, accountId] = (sourceKey || ":").split(":");
        const seen = loadRecent().find((r) => sameItem(r, { accountId, config: match.config }));
        const from = resumeAt(seen);
        if (from) {
            engine.seekTo(from);
            $("item-title").textContent = `${match.title} — resuming at ${clock(from)}`;
        }
        void provider;

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
$("item-play").onclick = () => {
    show("panel-player");
    rememberPlayed(playable, engine.positionMs());
    engine.play();
};

// ================================================================== PLAYER

$("close-player-btn").onclick = () => engine.stop();

/**
 * Open and play the first item the current source can actually show.
 *
 * Exported for the telemetry page, which needs a long unattended session and
 * has no fingertip. It drives the SAME path a tap does — resolve, open, play —
 * rather than a shortcut, because a measurement of a different path would
 * measure the wrong thing.
 */
export async function firstPlayable() {
    if (!account) return null;
    for (const root of await account.listRoots()) {
        const children = await account.listChildren(root.ref);
        for (const item of children.filter((c) => c.kind === "item")) {
            const p = await resolveCached(item).catch(() => null);
            if (!p) continue;
            await openItem(p);
            $("item-play").click();
            return p;
        }
    }
    return null;
}

// =================================================================== BOOT

engine.setUiHooks({
    stopped: () => { releasePreview(); show("panel-item"); },
    // The glasses picked something from their own list. Nothing above this
    // line knows what a list index is; this does.
    playRecent: (index) => { playRecent(index).catch(() => {}); },
});

(async function boot() {
    // The bridge first: it is the one thing that can fail in a way no amount of
    // browsing works around, and its status line is already on screen.
    engine.initBridge();

    // Then the store, and this one IS awaited. Everything below reads saved
    // sources, and in a packaged app those live in the HOST's store rather than
    // the WebView's — reading before it is hydrated is what made the first beta
    // ask for a fresh Plex code on every launch. The wait is bounded, so the
    // browser build (where there is no bridge) still boots immediately.
    await store.init(await engine.whenBridgeReady());

    // If a previous launch turned the recorder on, turn it on again — before
    // anything else, so the launch itself is inside the recording. A tester
    // enables logging because they are chasing something that crashes, and a
    // crash is exactly when nobody is there to press the button a second time.
    // The flag is read from the store rather than from the recorder module, so
    // that a launch which is NOT logging never loads the recorder at all.
    // The glasses need these before anything is on screen: they are what the
    // idle picker is made of.
    engine.setRecentTitles(loadRecent().map(recentLabel));

    if (store.getItem("trickplayer.logging") === "1") {
        const { enableLogging } = await import("./logging");
        await enableLogging(engine);
        for (const b of document.querySelectorAll("[data-logging]")) b.remove();
    }

    if (resumePendingAuth()) return;

    const saved = loadSaved();
    if (!saved.length) return startAddSource();

    // Something to resume: show the list rather than dropping into a library,
    // so one tap on the glasses (or the phone) starts where they left off.
    if (loadRecent().length) return showSources();

    // The last-used source is the default, and browsing starts there.
    const last = store.getItem(LAST_KEY);
    const rec = saved.find((s) => `${s.provider}:${s.id}` === last) || saved[0];
    if (saved.length === 1 || rec) return openSource(rec);
    showSources();
})();
