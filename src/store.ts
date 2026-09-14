// @ts-nocheck
//
// Where the app's memory actually lives.
//
// It used to be `window.localStorage`, which works in a browser and does not
// survive in a packaged EvenHub app: the first beta forgot its Plex server
// every launch and asked the tester to re-authorise with a fresh code. That is
// the kind of bug that never appears in development, because development runs
// in the browser where localStorage is exactly what it says it is.
//
// The SDK has a host-backed store for this — `setLocalStorage` /
// `getLocalStorage` on the bridge — and it is the one that persists. Verified
// against the simulator: a write returns `true`, a read returns the string
// back, and an ABSENT key returns `""` rather than null, which is why empty
// string is treated as "not there" throughout.
//
// **Hydrate once, then behave synchronously.** The bridge API is async and
// every call site here is not; making them all async would ripple through the
// whole flow for no benefit, since the data is a few hundred bytes read once
// at boot. So `init` pulls the known keys into memory, reads come from there,
// and writes go to memory, the host, and localStorage at once.
//
// Both, not either: localStorage still works in the browser build (GitHub
// Pages, and the simulator pointed at a dev server), and the host store still
// works in the packaged app. Writing both means one code path covers both, and
// whichever survives is read back next time.

/**
 * Every key the app persists.
 *
 * An explicit list rather than a prefix scan, because the host store offers no
 * enumeration — you can only ask for a key you already know the name of.
 */
const PROBE_KEY = "trickplayer.storeProbe";

const KEYS = [
    "trickplayer.sources",
    "trickplayer.lastSource",
    "trickplayer.pendingAuth",
];

const mem = new Map();
let host = null;
let hydrated = false;

/** Did the host store answer? Reported on screen, because it decides whether sign-in sticks. */
export function isHostBacked() { return !!host; }
export function isReady() { return hydrated; }

/**
 * Pull the known keys into memory.
 *
 * @param bridge the EvenHub bridge, or null when there is not one (browser).
 */
export async function init(bridge) {
    // A capability PROBE, not a duck-type check. `waitForEvenAppBridge()`
    // resolves to something with these methods even in a plain browser, where
    // the handshake has otherwise failed — so asking "does it have the method"
    // answered yes and the telemetry page then promised that sign-in would
    // survive a relaunch, which is the exact claim this module exists to make
    // truthfully. Write a sentinel and read it back instead.
    host = null;
    if (bridge && typeof bridge.getLocalStorage === "function"
             && typeof bridge.setLocalStorage === "function") {
        try {
            const token = `probe-${Date.now()}`;
            await bridge.setLocalStorage(PROBE_KEY, token);
            if ((await bridge.getLocalStorage(PROBE_KEY)) === token) host = bridge;
        } catch (e) { host = null; }
    }
    for (const k of KEYS) {
        let v = "";
        if (host) {
            try { v = (await host.getLocalStorage(k)) || ""; }
            catch (e) { v = ""; }
        }
        if (!v) {
            // Nothing in the host store: either this is the browser, or it is
            // the first launch after the upgrade that started writing there.
            // Either way localStorage may still hold it, and if it does the
            // first write below migrates it across.
            try { v = localStorage.getItem(k) || ""; } catch (e) { v = ""; }
            if (v && host) { try { host.setLocalStorage(k, v); } catch (e) {} }
        }
        if (v) mem.set(k, v);
    }
    hydrated = true;
}

export function getItem(key) {
    return mem.has(key) ? mem.get(key) : null;
}

export function setItem(key, value) {
    const v = String(value);
    mem.set(key, v);
    try { localStorage.setItem(key, v); } catch (e) {}
    // Fire and forget: a failed host write must not break the flow the user is
    // in the middle of, and the in-memory copy is already correct for this
    // session. It is logged because "sign-in did not stick" is otherwise
    // indistinguishable from "sign-in did not happen".
    if (host) {
        try {
            Promise.resolve(host.setLocalStorage(key, v)).then(
                (ok) => { if (ok === false) console.warn(`[store] host refused ${key}`); },
                (e) => console.warn(`[store] host write ${key} failed: ${e?.message || e}`),
            );
        } catch (e) { console.warn(`[store] host write ${key} threw: ${e?.message || e}`); }
    }
}

export function removeItem(key) {
    mem.delete(key);
    try { localStorage.removeItem(key); } catch (e) {}
    // The host store has no delete, and "" is what it returns for a key that
    // was never set — so writing "" IS deleting, as far as any reader knows.
    if (host) { try { Promise.resolve(host.setLocalStorage(key, "")).catch(() => {}); } catch (e) {} }
}
