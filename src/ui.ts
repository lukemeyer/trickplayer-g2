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

// FIRST, and deliberately: importing it installs it, so it is recording before
// the engine below has a chance to say anything. The messages worth reading are
// the ones from boot.
import { setMessageLogging } from "./consolemirror";

import * as engine from "./main";
import { createPlexAccount } from "./plexaccount";
import { createJellyfinAccount } from "./jellyfinaccount";
import * as store from "./store";

// ---------------------------------------------------------------- plumbing

const $ = (id) => document.getElementById(id);
const PANELS = [
    "panel-sources", "panel-add-source", "panel-browse",
    "panel-list", "panel-player",
];

let currentVisiblePanel = "panel-sources";

function show(panel) {
    currentVisiblePanel = panel;
    for (const p of PANELS) $(p).classList.toggle("hidden", p !== panel);
    renderBreadcrumbs();
    updateServerSelect();
}

function updateServerSelect() {
    const sel = $("header-server-select");
    if (!sel) return;
    const saved = loadSaved();
    sel.innerHTML = "";

    if (!saved.length) {
        const opt = document.createElement("option");
        opt.value = "";
        opt.textContent = "No server";
        opt.selected = true;
        opt.disabled = true;
        sel.appendChild(opt);
    } else {
        if (!sourceKey || currentVisiblePanel === "panel-sources") {
            const opt = document.createElement("option");
            opt.value = "";
            opt.textContent = "Choose server…";
            opt.selected = currentVisiblePanel !== "panel-add-source";
            opt.disabled = true;
            sel.appendChild(opt);
        }
        for (const s of saved) {
            const opt = document.createElement("option");
            opt.value = `${s.provider}:${s.id}`;
            opt.textContent = s.name || s.serverUrl;
            if (sourceKey === `${s.provider}:${s.id}` && currentVisiblePanel !== "panel-add-source") {
                opt.selected = true;
            }
            sel.appendChild(opt);
        }
    }

    const addOpt = document.createElement("option");
    addOpt.value = "__add__";
    addOpt.textContent = "+ Add server…";
    if (currentVisiblePanel === "panel-add-source") {
        addOpt.selected = true;
    }
    sel.appendChild(addOpt);
}

const headerServerSelect = $("header-server-select");
if (headerServerSelect) {
    headerServerSelect.onchange = () => {
        const val = headerServerSelect.value;
        if (val === "__add__") {
            startAddSource();
        } else if (val) {
            const saved = loadSaved();
            const rec = saved.find((s) => `${s.provider}:${s.id}` === val);
            if (rec) openSource(rec);
        }
    };
}

function renderBreadcrumbs() {
    const nav = $("header-breadcrumbs");
    if (!nav) return;
    nav.innerHTML = "";

    function addCrumb(text, onClick, isActive = false) {
        const span = document.createElement("span");
        span.className = `breadcrumb-item${isActive ? " active" : ""}`;
        span.textContent = text;
        if (!isActive && onClick) span.onclick = onClick;
        nav.appendChild(span);
    }

    function addSep() {
        const sep = document.createElement("span");
        sep.className = "breadcrumb-sep";
        sep.textContent = " / ";
        nav.appendChild(sep);
    }

    // When on sources or adding a source
    if (currentVisiblePanel === "panel-sources" || !account) {
        addCrumb("Home", () => {
            if (currentVisiblePanel === "panel-player") engine.stop();
            releasePreview();
            playable = null;
            scanGeneration++;
            showSources();
        }, currentVisiblePanel === "panel-sources");
        if (currentVisiblePanel === "panel-add-source") {
            addSep();
            addCrumb("Add server", null, true);
        }
        return;
    }

    // Home crumb
    addCrumb("Home", () => {
        if (currentVisiblePanel === "panel-player") engine.stop();
        releasePreview();
        playable = null;
        scanGeneration++;
        showSources();
    }, false);

    // If we have browse stack or are on browse panel
    if (stack.length > 0 || currentVisiblePanel === "panel-browse" || currentVisiblePanel === "panel-list") {
        addSep();
        const onBrowse = currentVisiblePanel === "panel-browse";
        addCrumb("Browse", () => {
            if (currentVisiblePanel === "panel-player") engine.stop();
            releasePreview();
            playable = null;
            scanGeneration++;
            stack = [];
            showBrowse();
        }, onBrowse && stack.length === 0);

        // Deep containers in stack (e.g. TV / Futurama / Season 1)
        stack.forEach((c, i) => {
            addSep();
            const isTop = i === stack.length - 1 && currentVisiblePanel === "panel-list" && !playable;
            addCrumb(c.title, () => {
                if (currentVisiblePanel === "panel-player") engine.stop();
                releasePreview();
                playable = null;
                scanGeneration++;
                stack = stack.slice(0, i + 1);
                renderList();
            }, isTop);
        });
    }

    // Item or Player level
    if (playable && currentVisiblePanel === "panel-player") {
        addSep();
        const itemCrumb = (stack.length > 0 && playable.shortTitle) ? playable.shortTitle : playable.title;
        addCrumb(itemCrumb, () => {
            if (currentVisiblePanel === "panel-player") {
                engine.stop();
            }
        }, true);
    }
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

/**
 * How long an item runs, as h:mm.
 *
 * Not "12m": the badge it lands in is uppercased by the stylesheet, so that
 * rendered as "12M" next to a media title and read as a file size.
 */
function fmtDuration(ms) {
    if (!ms || ms <= 0) return "";
    const totalMin = Math.round(ms / 60000);
    const h = Math.floor(totalMin / 60);
    const m = totalMin % 60;
    return `${h}:${String(m).padStart(2, "0")}`;
}

function displayTitle(item, isLibrary = true) {
    if (!isLibrary) return item.title;
    if (item.shortTitle) return item.shortTitle;
    if (item.episodeNumber && item.episodeName) {
        return `${item.episodeNumber} — ${item.episodeName}`;
    }
    const m = (item.title || "").match(/^.+?\s+—\s+(S\d+E\d+.*)$/i);
    if (m) return m[1];
    return item.title;
}

function row(parent, title, subtitle, onClick, badges = []) {
    const div = document.createElement("div");
    div.className = "media-item";
    div.innerHTML =
        `<div class="media-info">` +
            `<div class="media-title">${esc(title)}</div>` +
            (subtitle ? `<div class="media-subtitle">${esc(subtitle)}</div>` : "") +
        `</div>` +
        (badges.length
            ? `<span class="tags">${badges.map((b) => {
                const lower = String(b).toLowerCase();
                const cls = lower === "plex" ? " tag-plex" : lower === "jellyfin" ? " tag-jellyfin" : "";
                return `<span class="tag-badge${cls}">${esc(b)}</span>`;
            }).join("")}</span>`
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
        // Which library item this is, as opposed to which bytes to fetch —
        // needed to tell the server where we got to.
        progressRef: match.progressRef ?? null,
        positionMs: Math.max(0, Math.round(positionMs) || 0),
    };
    const rest = loadRecent().filter((r) => !sameItem(r, entry));
    const all = [entry, ...rest].slice(0, RECENT_MAX);
    store.setItem(RECENT_KEY, JSON.stringify(all));
    // Deliberately does NOT push rows at the glasses. This runs every fifteen
    // seconds while watching, and the list they are looking at may be a
    // playlist three levels down; the recents level is built from the store the
    // next time it is opened, which is soon enough.
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

/**
 * Where to start an item that has been watched before.
 *
 * `serverMs` is Plex's or Jellyfin's own position, which is the one that knows
 * about the TV in the living room. It wins when it has something to say: this
 * app's copy only knows about what this app played.
 */
function resumeAt(entry, serverMs = 0) {
    const at = serverMs || entry?.positionMs || 0;
    if (!at) return 0;
    const duration = entry?.durationMs;
    if (duration && at > duration * 0.97) return 0;
    return at;
}


/**
 * Keep the remembered position current while something plays.
 *
 * On a timer rather than at the end, because the end is exactly the moment
 * that tends not to arrive — the app is closed, the glasses are taken off, the
 * WebView is discarded.
 */
/**
 * Tell the media server where we are, when asked to.
 *
 * Off by default: it moves items in and out of Continue Watching on every
 * other device the user owns, which is not a side effect a trick-play viewer
 * should have without being told to.
 */
function pushProgress(state) {
    if (!reportProgress || !playable || !account?.reportProgress) return;
    const ref = playable.progressRef;
    // Worth saying out loud. An item with no progress ref is one this app can
    // play but cannot report on, and silence here reads exactly like a write
    // that succeeded.
    if (!ref) {
        console.warn(`[progress] ${playable.title} has no progress ref — nothing to report`);
        return;
    }
    account.reportProgress(ref, engine.positionMs(), state, playable.durationMs || 0)
        .catch((e) => console.warn(`[progress] report failed: ${e?.message || e}`));
}

setInterval(() => {
    if (!playable || !engine.playbackState().playing) return;
    rememberPlayed(playable, engine.positionMs());
    pushProgress("playing");
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
    setPlayerError(null);
    show("panel-player");
    try {
        await engine.prepareItem({
            title: match.title, durationMs: match.durationMs, source: account.openSource(match),
        });
    } catch (e) {
        // This one is started from the GLASSES, so the phone may be in a
        // pocket — but when it is looked at, it has to say what happened
        // rather than show a player that never starts.
        console.error(`Could not load this item: ${e.message}`);
        setPlayerError(`Could not load ${match.title}: ${e.message}`);
        return false;
    }
    applyOptionsToEngine();
    const from = resumeAt(entry);
    if (from) engine.seekTo(from);
    engine.play();
    return true;
}
let playable = null;     // the resolved item on the item panel
let previewUrls = [];

// ======================================================= BROWSING ON THE GLASSES
//
// The phone's browser walks a library of arbitrary depth. The glasses cannot:
// twenty rows fit and no more (F-054), scrolling is a touchpad, and there is no
// keyboard. So this is not the same tree with a smaller font — it is three ways
// in, chosen because each one is already short:
//
//   Recently played    what this app played, at most five
//   Continue watching  what the SERVER says is part-watched, across every device
//   Playlists          lists someone has already curated
//
// No libraries, no A-Z, no search. A library is thousands of items and twenty
// rows cannot represent it honestly; the phone is right there for that.

/** A level: the caption under the list, and rows that know what they do. */
const glassesStack = [];  // deepest last — the breadcrumb, glasses-side

/** Rows are `{ label, open }`. `open` returns a level to push, or nothing. */
const BACK_ROW = "◀ Back";
/** Twenty rows, less the one Back costs on every level below the root. */
const GLASSES_ROWS = 20;

/**
 * A level carries how to build itself again.
 *
 * Coming back from an episode to the list it was started from is the commonest
 * move there is, and the one thing that has certainly changed in between is the
 * position of the item just watched. Replaying the rows as they were shows the
 * time it had when you walked in, which is the one number the wearer is
 * checking.
 */
function glassesLevel(caption, rows, rebuild) { return { caption, rows, rebuild }; }

/** The three ways in. Recently played is omitted when there is nothing in it. */
function glassesRootLevel() {
    const rows = [];
    if (loadRecent().length) {
        rows.push({ label: "Recently played", open: recentLevel });
    }
    // Both providers answer these; `listRoots` puts them first for exactly this
    // reason. Asked of the account rather than assumed, because a source that
    // grows a third provider one day should not silently show empty rows.
    const caps = account?.capabilities?.() ?? {};
    if (caps.hasContinueWatching) {
        rows.push({ label: "Continue watching", open: () => containerLevel(
            { ref: { kind: account.provider === "jellyfin" ? "resume" : "onDeck" },
                title: "Continue watching" }) });
    }
    if (caps.hasPlaylists) {
        rows.push({ label: "Playlists", open: () => containerLevel(
            { ref: { kind: "playlists" }, title: "Playlists" }) });
    }
    return glassesLevel(rows.length ? "Tap to choose" : "Sign in on the phone",
        rows, glassesRootLevel);
}

/** The app's own five, which need no server round trip at all. */
function recentLevel() {
    return glassesLevel("Recently played", loadRecent().map((r, i) => ({
        label: recentLabel(r),
        open: () => { playRecent(i).catch(() => {}); },
    })), recentLevel);
}

/**
 * One level of the server's own tree, eligibility included.
 *
 * Containers and items arrive mixed, the same as on the phone, and the same
 * loop handles both — depth is discovered, not assumed. The difference here is
 * that the whole level is built BEFORE it is shown: on the phone the list fills
 * in as answers arrive, but on the glasses every redraw is a page rebuild, and
 * a rebuild empties the image container. So the wearer gets a caption that
 * counts, and then the finished list.
 */
async function containerLevel(container) {
    if (!account) return null;
    engine.setGlassesCaption("Loading…").catch(() => {});
    let children;
    try {
        children = await account.listChildren(container.ref);
    } catch (e) {
        return glassesLevel(`Could not load ${container.title}`, [],
            () => containerLevel(container));
    }

    const rows = [];
    for (const c of children.filter((c) => c.kind === "container")) {
        if (rows.length >= GLASSES_ROWS - 1) break;
        rows.push({ label: c.title, open: () => containerLevel(c) });
    }

    const items = children.filter((c) => c.kind === "item");
    let checked = 0;
    for (const item of items) {
        if (rows.length >= GLASSES_ROWS - 1) break;
        engine.setGlassesCaption(`Checking ${++checked} of ${items.length}`).catch(() => {});
        let match = null;
        // The ONLY eligibility signal, and cached for the session, so walking
        // back out of a playlist and into it again asks nothing (F-015).
        try { match = await resolveCached(item); } catch (e) { continue; }
        if (!match) continue;
        rows.push({ label: itemLabel(match), open: () => { playMatch(match).catch(() => {}); } });
    }

    const caption = rows.length
        ? container.title
        : `Nothing here can be played`;
    return glassesLevel(caption, rows, () => containerLevel(container));
}

/** A row for a resolved item: the title, and where it had got to. */
function itemLabel(match) {
    const [, accountId] = (sourceKey || ":").split(":");
    const seen = loadRecent().find((r) => sameItem(r, { accountId, config: match.config }));
    const at = resumeAt(seen, match.resumeMs || 0);
    if (!at) return match.title;
    const time = clock(at);
    const room = 38 - time.length;
    const title = match.title.length > room ? `${match.title.slice(0, room - 1)}…` : match.title;
    return `${title} · ${time}`;
}

/** Start a resolved item chosen on the glasses — the phone follows along. */
async function playMatch(match) {
    playable = match;
    setPlayerError(null);
    show("panel-player");
    try {
        await engine.prepareItem({
            title: match.title, durationMs: match.durationMs,
            source: account.openSource(match),
        });
    } catch (e) {
        console.error(`Could not load this item: ${e.message}`);
        setPlayerError(`Could not load ${match.title}: ${e.message}`);
        return;
    }
    applyOptionsToEngine();
    const [, accountId] = (sourceKey || ":").split(":");
    const seen = loadRecent().find((r) => sameItem(r, { accountId, config: match.config }));
    const from = resumeAt(seen, match.resumeMs || 0);
    if (from) engine.seekTo(from);
    engine.play();
    rememberPlayed(match, from);
}

/** Put the level on top of the stack on the glasses. */
function renderGlasses() {
    const level = glassesStack[glassesStack.length - 1];
    if (!level) return Promise.resolve(false);
    const labels = level.rows.map((r) => r.label);
    // Back is a row rather than a menu entry: the contextual menu is two
    // gestures away and holds ten items at most, and "go up one" is the thing
    // a wearer does most while browsing.
    if (glassesStack.length > 1) labels.unshift(BACK_ROW);
    engine.setGlassesList(labels, level.caption);
    return engine.showGlassesList();
}

/**
 * Come back to the level we left, with its numbers current.
 *
 * Rebuilt rather than replayed: the item just watched has moved, and on
 * Continue watching that movement is the whole content of the row.
 */
async function refreshGlassesLevel() {
    const level = glassesStack[glassesStack.length - 1];
    if (!level?.rebuild) return showGlassesRoot();
    const fresh = await level.rebuild();
    if (fresh) glassesStack[glassesStack.length - 1] = fresh;
    return renderGlasses();
}

/** Start (or restart) glasses browsing at the top. */
function showGlassesRoot() {
    glassesStack.length = 0;
    glassesStack.push(glassesRootLevel());
    return renderGlasses();
}

/**
 * A row was tapped.
 *
 * `open` may return a level to walk into, or nothing at all when it starts
 * playing instead — the engine flips to the player page on its own the moment
 * something loads, so this does not have to know which happened.
 */
async function pickGlassesRow(index) {
    const level = glassesStack[glassesStack.length - 1];
    if (!level) return;
    const hasBack = glassesStack.length > 1;
    if (hasBack && index === 0) {
        glassesStack.pop();
        await renderGlasses();
        return;
    }
    const row = level.rows[hasBack ? index - 1 : index];
    if (!row) return;
    const next = await row.open();
    if (next) {
        glassesStack.push(next);
        await renderGlasses();
    }
}

// ================================================================= SOURCES

function showSources() {
    const saved = loadSaved();

    // Recently played in its own container
    const recent = loadRecent();
    const recentSection = $("recent-section");
    const recentList = $("recent-list");
    if (recent.length) {
        if (recentSection) recentSection.classList.remove("hidden");
        if (recentList) {
            recentList.innerHTML = "";
            recent.forEach((r, i) => {
                const badges = [];
                if (r.durationMs) badges.push(fmtDuration(r.durationMs));
                badges.push(r.provider === "jellyfin" ? "Jellyfin" : "Plex");
                row(
                    recentList,
                    r.title,
                    resumeAt(r) ? `Resume at ${clock(resumeAt(r))}` : null,
                    () => playRecent(i),
                    badges
                );
            });
        }
    } else {
        if (recentSection) recentSection.classList.add("hidden");
        if (recentList) recentList.innerHTML = "";
    }

    // Listed by SERVER name, not provider name — users think in servers, and
    // the provider is a badge (UI.md §1).
    const list = $("source-list");
    list.innerHTML = "";
    for (const rec of saved) {
        row(list, rec.name || rec.serverUrl, rec.serverUrl,
            () => openSource(rec), [rec.provider === "jellyfin" ? "Jellyfin" : "Plex"]);
    }
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

// The debugging tools. Opening the panel records NOTHING — it offers two
// switches and does as it is told. Loaded on demand, so a launch where nobody
// taps it never carries the code.
async function openDebugTools() {
    const btn = $("logging-open");
    if (btn) btn.disabled = true;
    try {
        const { openDebugPanel } = await import("./logging");
        openDebugPanel(engine);
    } catch (e) {
        console.error(`[debug] could not open the panel: ${e.message}`);
    } finally {
        if (btn) btn.disabled = false;
    }
}

const loggingBtn = $("logging-open");
if (loggingBtn) loggingBtn.onclick = openDebugTools;

// `?logging=1` opens the panel at boot. For the simulator and for a phone on a
// desk: neither has a way to tap a button.
const harness = new URLSearchParams(location.search);
// Presence is not the same as truth: `?logging=0` means OFF, and this used to
// read it as "logging was mentioned, switch it on".
if (harness.has("logging") && harness.get("logging") !== "0") {
    setTimeout(() => openDebugTools(), 1500);
}
// `?play=1` starts the first playable item, so a harness can measure the real
// pipeline rather than an idle page.
// `?demorecent=1` draws the glasses picker with placeholder titles. The
// simulator has no server to sign into, and the list container is a piece of
// glasses UI that cannot be checked any other way.
if (harness.has("demorecent")) {
    setTimeout(() => {
        engine.setGlassesList([
            "The Expanse — S1E1", "Finding Dory", "Arrival",
            "Chernobyl — E3", "Paddington 2",
        ], "Recently played");
        engine.showGlassesList();
        // Then the list REORDERS underneath the picker, the way it does when
        // something is played: the picker must redraw, and a tap must pick what
        // the wearer can actually see.
        setTimeout(() => {
            engine.setGlassesList([
                "Paddington 2", "The Expanse — S1E1", "Finding Dory",
                "Arrival", "Chernobyl — E3",
            ], "Recently played");
        }, 4000);
    }, 2000);
}

// `?settings=1` opens the settings dialog. The simulator has no pointer into
// the webview, so the cog cannot be tapped there — and the bridge status now
// lives behind it, which is precisely what a simulator run wants to check.
if (harness.get("settings") === "1") {
    setTimeout(() => openSettings(), 2000);
}

// `?compare=1` starts the picture comparison once something is playing. The
// simulator has no pointer into the webview, and this is the one tool whose
// whole loop — send, swipe, tap — has to be driven from outside.
if (harness.get("compare") === "1") {
    setTimeout(async () => {
        const { runPictureComparison } = engine;
        try {
            const r = await runPictureComparison({
                frames: Number(harness.get("frames")) || 2,
                onProgress: (t) => console.log(`[Compare] ${t}`),
            });
            console.log(`[Compare] done: ${JSON.stringify(r.tally)}`);
        } catch (e) {
            console.error(`[Compare] failed: ${e?.message || e}`);
        }
    }, Number(harness.get("comparedelay")) || 6000);
}

// `?addsource=plex|jellyfin` starts the add-a-server flow on that provider.
// The simulator has no pointer into the webview, so the first tap of sign-in
// cannot be made by hand there.
if (harness.get("addsource")) {
    setTimeout(() => {
        startAddSource();
        document.querySelector(`[data-provider="${harness.get("addsource")}"]`)?.click();
    }, 1800);
}

if (harness.has("play")) {
    setTimeout(() => { firstPlayable(); }, 2500);
}

$("add-source-btn").onclick = () => startAddSource();
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
        const choose = () => {
            account.use(srv);
            saveSource(account);
            stack = [];
            showBrowse();
        };
        row(list, srv.name, srv.owner ? `Shared by ${srv.owner}` : "", choose);
        // `?server=<name>` picks one without a pointer, for the simulator.
        const want = harness.get("server");
        if (want && srv.name.toLowerCase().includes(want.toLowerCase())) setTimeout(choose, 400);
    }
}

// ================================================================== BROWSE

async function showBrowse() {
    show("panel-browse");
    $("browse-title").textContent = account.name;
    // A source just opened, so the glasses' own top level changed: Continue
    // watching and Playlists belong to THIS server and to no other.
    showGlassesRoot().catch(() => {});
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
    const isNonLibrary = here?.ref?.kind === "playlist" ||
                         here?.ref?.kind === "playlists" ||
                         here?.ref?.kind === "onDeck" ||
                         here?.ref?.kind === "resume" ||
                         here?.title === "Continue watching" ||
                         here?.title === "Playlists";
    const isLibrary = !isNonLibrary;

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
        const titleToShow = displayTitle(match, isLibrary);
        const badges = match.badges?.length ? match.badges : (match.durationMs ? [fmtDuration(match.durationMs)] : []);
        row(list, titleToShow, "", () => openItem(match), badges);
    }

    if (myGeneration !== scanGeneration) return;
    // A container that is half ineligible says so rather than silently
    // appearing short — on Plex that is often most of a playlist, and someone
    // who has not heard of the sidecar rule would think the app was broken.
    $("list-status").textContent = found
        ? `${found} of ${items.length} playable`
        : "Nothing here can be played yet — an item needs a trick-play index and subtitles.";
}

// ==================================================================== PLAYER

const PREVIEW_SCENES = 1;

/**
 * Say why an item did not load, on the screen the wearer is looking at.
 *
 * Passing nothing clears it. Every path that starts an item clears it first,
 * so a failure from the previous one cannot sit under a working player.
 */
function setPlayerError(message) {
    const el = $("player-error");
    if (!el) return;
    el.textContent = message || "";
    setHidden("player-error", !message);
}

async function openItem(match) {
    playable = match;
    releasePreview();
    setPlayerError(null);
    show("panel-player");

    try {
        await engine.prepareItem({
            title: match.title,
            durationMs: match.durationMs,
            source: account.openSource(match),
        });
        applyOptionsToEngine();

        // Carry on where this one stopped, however it was opened.
        const [, accountId] = (sourceKey || ":").split(":");
        const seen = loadRecent().find((r) => sameItem(r, { accountId, config: match.config }));
        const from = resumeAt(seen, match.resumeMs || 0);
        if (from) engine.seekTo(from);
        engine.play();
        rememberPlayed(match, from);
    } catch (e) {
        console.error(`Could not load this item: ${e.message}`);
        setPlayerError(`Could not load ${match.title}: ${e.message}`);
    }
}

let lastPreviewScene = null;
let loadingPreview = false;

async function loadPreview(cost) {
    if (loadingPreview) return;
    loadingPreview = true;
    try {
        const scenes = await engine.previewScenes(PREVIEW_SCENES);
        for (const u of previewUrls) URL.revokeObjectURL(u);
        previewUrls = [];
        if (scenes && scenes.length) {
            const s = scenes[0];
            previewUrls = [s.url];
            lastPreviewScene = s;
            updateSettingsPreview();
        }
    } catch (e) {
        console.warn(`Preview failed: ${e.message}`);
    } finally {
        loadingPreview = false;
    }
}

function releasePreview() {
    for (const u of previewUrls) URL.revokeObjectURL(u);
    previewUrls = [];
    lastPreviewScene = null;
    setHidden("settings-preview-wrap", true);
    setHidden("settings-preview-empty", false);
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

// --- settings dialog (native <dialog>) ---

function updateSettingsPreview() {
    const wrap = $("settings-preview-wrap");
    const empty = $("settings-preview-empty");
    const img = $("settings-preview-img");
    const sub = $("settings-preview-sub");
    if (!wrap || !empty) return;

    const isItemSelected = currentVisiblePanel === "panel-player" && playable;
    if (!isItemSelected) {
        setHidden("settings-preview-wrap", true);
        setHidden("settings-preview-empty", false);
        return;
    }

    if (lastPreviewScene) {
        if (img) img.src = lastPreviewScene.url;
        if (sub) sub.innerHTML = esc(lastPreviewScene.text).replace(/\n/g, "<br>");
        setHidden("settings-preview-wrap", false);
        setHidden("settings-preview-empty", true);
    } else if (!previewUrls.length) {
        loadPreview(null).catch(() => {});
    }
}

function openSettings() {
    updateSettingsPreview();
    const dialog = $("panel-settings");
    if (dialog && typeof dialog.showModal === "function") {
        if (!dialog.open) dialog.showModal();
    } else {
        setHidden("panel-settings", false);
    }
}

function closeSettings() {
    const dialog = $("panel-settings");
    if (dialog && typeof dialog.close === "function") {
        if (dialog.open) dialog.close();
    } else {
        setHidden("panel-settings", true);
    }
}

$("settings-open").onclick = openSettings;
$("settings-close").onclick = closeSettings;
$("panel-settings").onclick = (e) => {
    // Clicking backdrop of native dialog closes it
    if (e.target === $("panel-settings")) closeSettings();
};

// --- options ---

const SKIP_SILENT_KEY = "trickplayer.skipSilent";
const REPORT_PROGRESS_KEY = "trickplayer.reportProgress";

$("opt-skip-silent").onchange = (e) => {
    store.setItem(SKIP_SILENT_KEY, e.target.checked ? "1" : "0");
    engine.setSkipSilent(e.target.checked);
    renderConsequences(engine.setBandwidth($("opt-bandwidth").value));
};

$("opt-report-progress").onchange = (e) => {
    store.setItem(REPORT_PROGRESS_KEY, e.target.checked ? "1" : "0");
    reportProgress = e.target.checked;
};

/** Whether to tell the media server where we have got to. Off unless asked. */
let reportProgress = false;

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

// What each texture costs on the wire, measured on hardware with the same
// frame sent five ways. Shown because the whole point of exposing these is a
// judgement about whether the cheaper one looks acceptable, and that judgement
// needs the price next to it.
const TEXTURE_NOTES = {
    "bayer2x2": "Fine — 1117ms a frame measured. The default: a two-pixel pattern repeats at byte granularity, which the host's compressor can pack.",
    "floyd-steinberg": "Smooth — 2697ms a frame measured, the slowest here. Scatters error so no two bytes repeat.",
    "bayer": "Coarse — a four-pixel pattern. More visible texture than Fine, and slower.",
    "atkinson": "Crisp — holds edges, spreads only three quarters of the error.",
    "threshold": "Flat — no dithering at all. Bands, but nothing to compress around.",
};

const LEVEL_NOTES = {
    "auto": "Follows the bandwidth ladder, which drops levels when the link slows.",
    "16": "Every level the display has.",
    "perceptual12": "Twelve, thinned in the midtones — 820ms a frame measured, the cheapest of these.",
    "perceptual8": "Eight, weighted to the shadows — 915ms measured.",
    "4": "Four, evenly spaced. What the old second rung used: 1333ms, and slower than 16 levels with a Fine texture.",
};

for (const btn of document.querySelectorAll("[data-texture]")) {
    btn.onclick = () => {
        for (const b of document.querySelectorAll("[data-texture]")) b.classList.remove("active");
        btn.classList.add("active");
        // Named by effect, not algorithm: nobody chooses between
        // "Floyd–Steinberg" and "Atkinson" from the names (UI.md §4.2).
        engine.setPicture({ texture: btn.dataset.texture });
        $("texture-note").textContent = TEXTURE_NOTES[btn.dataset.texture] || "";
        repaintPreview();
    };
}

for (const btn of document.querySelectorAll("[data-levels]")) {
    btn.onclick = () => {
        for (const b of document.querySelectorAll("[data-levels]")) b.classList.remove("active");
        btn.classList.add("active");
        engine.setLevels(btn.dataset.levels);
        $("levels-note").textContent = LEVEL_NOTES[btn.dataset.levels] || "";
        repaintPreview();
    };
}

$("picture-reset").onclick = () => {
    $("opt-contrast").value = 0;
    $("opt-brightness").value = 0;
    $("opt-gamma").value = 100;
    for (const b of document.querySelectorAll("[data-texture]")) {
        b.classList.toggle("active", b.dataset.texture === "bayer2x2");
    }
    for (const b of document.querySelectorAll("[data-levels]")) {
        b.classList.toggle("active", b.dataset.levels === "auto");
    }
    engine.setPicture({ contrast: 0, brightness: 0, gamma: 1, texture: "bayer2x2" });
    engine.setLevels("auto");
    $("texture-note").textContent = TEXTURE_NOTES["bayer2x2"];
    $("levels-note").textContent = "";
    repaintPreview();
};

// Re-render what is already on screen rather than re-fetching: the frames are
// cached, so a contrast change costs a decode and no network.
let repaintTimer = null;
function repaintPreview() {
    engine.pictureIsLive();
    if (!playable && !previewUrls.length) return;
    clearTimeout(repaintTimer);
    repaintTimer = setTimeout(() => loadPreview(null), 150);
}

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
            return p;
        }
    }
    return null;
}

// =================================================================== BOOT

engine.setUiHooks({
    stopped: () => {
        // The end of watching is the moment the server most wants.
        if (playable) { rememberPlayed(playable, engine.positionMs()); pushProgress("stopped"); }
        releasePreview();
        playable = null;
        if (stack.length) {
            renderList();
        } else {
            showSources();
        }
    },
    playing: (isPlaying) => { if (!isPlaying) pushProgress("paused"); },
    // The glasses picked something from their own list. Nothing above this
    // line knows what a list index is; this does.
    pickGlassesRow: (index) => pickGlassesRow(index).catch(() => {}),
    // "Return to list": the level they left, not the top. Walking back into a
    // playlist after every episode would be the app forgetting where you were.
    returnToGlassesList: () => refreshGlassesLevel().catch(() => {}),
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
    // The glasses need this before anything is on screen: the top level is
    // what the wearer sees if they never touch the phone at all.
    showGlassesRoot().catch(() => {});

    // Both default OFF: skipping silent scenes changes which scenes exist at
    // all, and reporting progress changes what every other client shows.
    const skipSilent = store.getItem(SKIP_SILENT_KEY) === "1";
    $("opt-skip-silent").checked = skipSilent;
    engine.setSkipSilent(skipSilent);
    // `?progress=1` turns reporting on for this launch. It is off by default
    // and deliberately so — it writes to the user's media server — which makes
    // it the one setting that cannot be exercised without a way to set it.
    // Set HERE rather than on a timer: the restore below would otherwise race
    // the flag and win, and the test would silently measure the default.
    reportProgress = harness.get("progress") === "1"
        || store.getItem(REPORT_PROGRESS_KEY) === "1";
    $("opt-report-progress").checked = reportProgress;

    // The debugging switches, both off unless someone turned them on and both
    // sticky across launches — that is the point of them, since the session
    // worth having is the one that spans a crash.
    //
    // This is also the moment the console mirror learns whether it is wanted.
    // It has been buffering since import, because the messages worth reading
    // are the ones from boot and the store cannot be read that early; if the
    // answer is no, that buffer is dropped and the real console handed back.
    const wantMessages = store.getItem("trickplayer.logMessages") === "1";
    const wantReport = store.getItem("trickplayer.reportSession") === "1";
    if (!wantMessages) setMessageLogging(false);
    if (wantMessages || wantReport) {
        const { restoreFromPreferences } = await import("./logging");
        await restoreFromPreferences(engine);
    }

    if (resumePendingAuth()) return;

    const saved = loadSaved();
    if (!saved.length) return startAddSource();

    // The last-used source is the default, and browsing starts there.
    const last = store.getItem(LAST_KEY);
    const rec = saved.find((s) => `${s.provider}:${s.id}` === last) || saved[0];

    // Something to resume: show the list rather than dropping into a library,
    // so one tap on the glasses (or the phone) starts where they left off.
    //
    // The ACCOUNT is opened either way. Which phone panel is showing must not
    // decide what the glasses can browse: stopping here with no account left
    // the glasses top level holding Recently played alone, because Continue
    // watching and Playlists belong to a server and there was not one open.
    if (loadRecent().length) {
        if (rec) {
            account = accountFrom(rec);
            if (sourceKey !== `${rec.provider}:${rec.id}`) eligibility.clear();
            sourceKey = `${rec.provider}:${rec.id}`;
            showGlassesRoot().catch(() => {});
        }
        return showSources();
    }

    if (saved.length === 1 || rec) return openSource(rec);
    showSources();
})();
