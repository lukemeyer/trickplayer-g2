// @ts-nocheck
//
// Plex as an account. See src/account.ts.
//
// Owns everything Plex-shaped about signing in and browsing: the PIN exchange,
// plex.tv's resource list, section keys, rating keys, and the eligibility rule
// that only applies here. Nothing above this file knows any of it exists.

import { createPlexSource } from "./plexsource";
import { normaliseRoutes, raceRoutes, staticBest, rank } from "./plexroutes";

const CLIENT_ID = "trickplayer-g2";
const APP_NAME = "Trickplayer";

export function createPlexAccount(saved = {}) {
    let accountToken = saved.accountToken || null;
    let serverUrl = saved.serverUrl || null;
    let serverToken = saved.serverToken || null; // server-specific (F-020)
    let routes = normaliseRoutes(saved.routes);
    let name = saved.name || "Plex";
    let id = saved.id || null;

    function capabilities() {
        return {
            needsAddressFirst: false,   // plex.tv authenticates first
            hasServerDiscovery: true,
            hasPlaylists: true,
            hasContinueWatching: true,
            hasFrameSizeHints: true,
            fetchGranularity: "frame",
        };
    }

    // --------------------------------------------------------------- auth

    /**
     * Mint a PIN, then poll it. Same shape as Jellyfin's Quick Connect (F-018).
     *
     * `strong: false` deliberately: a short code can be TYPED at plex.tv/link
     * on any device the user already has open. A strong PIN is a long string
     * that only works through a deep link, which is what forced this build's
     * old popup-and-clipboard dance and is the thing F-018 exists to prevent.
     *
     * Credentials go in headers, never the query string (F-021); plex.tv's
     * preflight allows exactly `x-plex-token` and `x-plex-client-identifier`.
     *
     * `resuming` re-attaches to a PIN minted before a reload, so a page refresh
     * mid-sign-in does not send the user back to a fresh code.
     */
    async function beginAuth(resuming) {
        let pin = resuming;
        if (!pin) {
            const res = await fetch("https://plex.tv/api/v2/pins", {
                method: "POST",
                headers: {
                    Accept: "application/json",
                    "Content-Type": "application/json",
                    "X-Plex-Product": APP_NAME,
                    "X-Plex-Client-Identifier": CLIENT_ID,
                },
                body: JSON.stringify({ strong: false }),
            });
            if (!res.ok) throw new Error(`PIN request -> HTTP ${res.status}`);
            const data = await res.json();
            pin = {
                id: data.id,
                code: data.code,
                // plex.tv gives ~15 minutes. Detected rather than waited out:
                // a code that has quietly died looks exactly like one the user
                // has not got round to typing.
                expiresAt: data.expiresAt || Date.now() + 15 * 60 * 1000,
            };
        }

        return {
            code: pin.code,
            enterAt: "plex.tv/link",
            state: { id: pin.id, code: pin.code, expiresAt: pin.expiresAt },
            /** @returns "pending" | "ok" | "expired" */
            async poll() {
                const r = await fetch(`https://plex.tv/api/v2/pins/${pin.id}`, {
                    headers: {
                        Accept: "application/json",
                        "X-Plex-Client-Identifier": CLIENT_ID,
                    },
                });
                // A consumed or expired PIN 404s; so does one from a previous
                // install that outlived its server-side record.
                if (r.status === 404) return "expired";
                if (!r.ok) return "pending";
                const data = await r.json();
                if (data.authToken) {
                    accountToken = data.authToken;
                    return "ok";
                }
                const deadline = Date.parse(pin.expiresAt) || Number(pin.expiresAt);
                return deadline && Date.now() > deadline ? "expired" : "pending";
            },
        };
    }

    // ------------------------------------------------------------ servers

    async function listServers() {
        const res = await fetch(
            "https://plex.tv/api/v2/resources?includeHttps=1&includeRelay=1",
            {
                headers: {
                    Accept: "application/json",
                    "X-Plex-Token": accountToken,
                    "X-Plex-Client-Identifier": CLIENT_ID,
                },
            },
        );
        if (!res.ok) throw new Error(`resources -> HTTP ${res.status}`);
        const data = await res.json();
        const devices = Array.isArray(data)
            ? data
            : data.MediaContainer?.Device || data.Device || [];

        return (Array.isArray(devices) ? devices : [devices])
            .filter((d) => (d.provides || "").split(",").map((s) => s.trim()).includes("server"))
            .map((d) => ({
                id: d.clientIdentifier,
                name: d.name,
                owner: d.sourceTitle || null,
                // EVERY route, not just the winner: F-016 re-races when the
                // network changes, which it cannot do from a single saved URL.
                routes: normaliseRoutes((Array.isArray(d.connections) ? d.connections : [d.connections])
                    .filter(Boolean)
                    .map((c) => ({
                        uri: c.uri || `${c.protocol}://${c.address}:${c.port}`,
                        // plex.tv says outright which is which; guessing from
                        // the hostname is only for records saved before this.
                        local: !!c.local, relay: !!c.relay,
                    }))),
                // Server-specific, not the account token (F-020).
                accessToken: d.accessToken || accountToken,
            }));
    }

    /**
     * Choose a server. The ADDRESS is not chosen here any more.
     *
     * It used to be: the LAN route was picked at sign-in and kept for ever, so
     * off the home network every request went to a private IP that did not
     * exist and the server "did not load" — until a VPN put the phone back
     * inside. Now this only makes a first guess; the real choice is a race,
     * run before the first request of each session and again whenever the
     * chosen address stops answering (F-016).
     */
    function use(server) {
        id = server.id;
        name = server.name;
        routes = normaliseRoutes(server.routes);
        serverToken = server.accessToken;
        serverUrl = staticBest(routes)?.uri || null;
        racedThisSession = false;
    }

    // ------------------------------------------------------------- routes

    /** Long enough for a phone on LTE; a dead LAN address never answers at all. */
    const PROBE_TIMEOUT_MS = 8000;
    /** Requests that hang are how a vanished LAN address shows up mid-session. */
    const REQUEST_TIMEOUT_MS = 12000;

    let racedThisSession = false;
    let racing = null;

    async function probe(uri) {
        const ctl = new AbortController();
        const timer = setTimeout(() => ctl.abort(), PROBE_TIMEOUT_MS);
        try {
            const res = await fetch(`${uri.replace(/\/$/, "")}/identity`, {
                headers: { Accept: "application/json", "X-Plex-Token": serverToken },
                signal: ctl.signal,
            });
            return res.ok;
        } catch (e) {
            return false;
        } finally {
            clearTimeout(timer);
        }
    }

    /** The routes plex.tv lists NOW — a home's public IP changes, and its route with it. */
    async function refreshRoutes() {
        if (!accountToken || !id) return false;
        try {
            const fresh = (await listServers()).find((sv) => sv.id === id);
            if (!fresh?.routes.length) return false;
            routes = fresh.routes;
            serverToken = fresh.accessToken || serverToken;
            return true;
        } catch (e) {
            return false;
        }
    }

    function unreachableMessage() {
        const kinds = new Set(routes.map((r) => ["home network", "internet", "relay"][rank(r)]));
        const onlyLocal = routes.length > 0 && routes.every((r) => r.local);
        return `Couldn't reach ${name} from this network (tried ${routes.length} address` +
            `${routes.length === 1 ? "" : "es"}: ${[...kinds].join(", ")}).` +
            (onlyLocal
                ? " Plex only lists a home-network address for this server, which usually means" +
                  " Remote Access is turned off in the server's settings — so away from home" +
                  " it can only be reached over a VPN."
                : " If it works at home or over a VPN, check Remote Access in the server's settings.");
    }

    /**
     * Pick the address that answers from where the phone is right now.
     *
     * Concurrent callers share one race. If nothing answers, the route list
     * itself may be stale — a changed public IP moves the internet route — so
     * it is refreshed from plex.tv, which is reachable from anywhere, and raced
     * once more before giving up with a reason instead of a spinner.
     */
    function reroute(why) {
        if (racing) return racing;
        racing = (async () => {
            let r = await raceRoutes(routes, { probe, timeoutMs: PROBE_TIMEOUT_MS });
            if (!r.route && await refreshRoutes()) {
                r = await raceRoutes(routes, { probe, timeoutMs: PROBE_TIMEOUT_MS });
            }
            racedThisSession = true;
            if (!r.route) throw new Error(unreachableMessage());
            if (r.route.uri !== serverUrl) {
                console.log(`[plex] ${why}: using ${["local", "internet", "relay"][rank(r.route)]} ` +
                    `route (${r.answered}/${r.tried} answered, ${r.ms}ms)`);
            }
            serverUrl = r.route.uri;
            return serverUrl;
        })().finally(() => { racing = null; });
        return racing;
    }

    /** A failure of the NETWORK — the only kind a different address can fix. */
    function isRouteFailure(e) {
        return e?.name === "TypeError" || e?.name === "AbortError";
    }

    /**
     * Run a request against the current route; if the route itself fails,
     * race again and retry once. HTTP errors are the server answering, so they
     * are passed through — another address would get the same answer.
     */
    async function withRoute(request) {
        if (!racedThisSession) await reroute("first request this session");
        try {
            return await request(serverUrl);
        } catch (e) {
            if (!isRouteFailure(e)) throw e;
            await reroute("the current address stopped answering");
            return await request(serverUrl);
        }
    }

    /** fetch, with a deadline — a vanished address hangs rather than failing. */
    async function timedFetch(url, init = {}) {
        const ctl = new AbortController();
        const timer = setTimeout(() => ctl.abort(), REQUEST_TIMEOUT_MS);
        try {
            return await fetch(url, { ...init, signal: ctl.signal });
        } finally {
            clearTimeout(timer);
        }
    }

    // ------------------------------------------------------------- browse

    async function plexFetch(endpoint) {
        return withRoute(async (base) => {
            const res = await timedFetch(`${base.replace(/\/$/, "")}${endpoint}`, {
                headers: { Accept: "application/json", "X-Plex-Token": serverToken },
            });
            if (!res.ok) throw new Error(`Plex ${endpoint} -> HTTP ${res.status}`);
            return res.json();
        });
    }

    /** Continue watching, playlists, then libraries — the same three everywhere. */
    async function listRoots() {
        const roots = [
            { ref: { kind: "onDeck" }, title: "Continue watching", kind: "container" },
            { ref: { kind: "playlists" }, title: "Playlists", kind: "container" },
        ];
        const data = await plexFetch("/library/sections");
        for (const lib of data.MediaContainer?.Directory || []) {
            if (lib.type !== "movie" && lib.type !== "show") continue;
            roots.push({
                ref: { kind: "section", key: lib.key, type: lib.type },
                title: lib.title,
                kind: "container",
            });
        }
        return roots;
    }

    /**
     * One level down, whatever that level is.
     *
     * A show is a container and an episode is an item; a film library holds
     * items directly; a playlist holds items. Depth is discovered rather than
     * assumed, which is what stops the TV-shaped `Shows → Items` walk from
     * being baked into the flow (UI.md §2).
     */
    async function listChildren(ref) {
        if (ref.kind === "onDeck") {
            const d = await plexFetch("/library/onDeck");
            return (d.MediaContainer?.Metadata || []).map(toItem);
        }
        if (ref.kind === "playlists") {
            const d = await plexFetch("/playlists?playlistType=video");
            return (d.MediaContainer?.Metadata || []).map((pl) => ({
                ref: { kind: "playlist", key: pl.ratingKey },
                title: pl.title,
                subtitle: `${pl.leafCount || 0} items`,
                kind: "container",
            }));
        }
        if (ref.kind === "playlist") {
            const d = await plexFetch(`/playlists/${ref.key}/items`);
            return (d.MediaContainer?.Metadata || []).map(toItem);
        }
        if (ref.kind === "section") {
            const d = await plexFetch(`/library/sections/${ref.key}/all`);
            const rows = d.MediaContainer?.Metadata || [];
            if (ref.type === "show") {
                return rows.map((show) => ({
                    ref: { kind: "show", key: show.ratingKey },
                    title: show.title,
                    kind: "container",
                }));
            }
            return rows.map(toItem);
        }
        if (ref.kind === "show") {
            const d = await plexFetch(`/library/metadata/${ref.key}/allLeaves`);
            return (d.MediaContainer?.Metadata || []).map(toItem);
        }
        return [];
    }

    function toItem(md) {
        return {
            ref: { kind: "item", key: md.ratingKey },
            title: md.type === "episode"
                ? `${md.grandparentTitle || ""} — S${pad(md.parentIndex)}E${pad(md.index)} — ${md.title}`
                : md.title,
            kind: "item",
        };
    }

    const pad = (n) => String(n || 0).padStart(2, "0");

    /**
     * Eligibility, and the fetch config if eligible. One request per item.
     *
     * **Plex's rule, and only Plex's.** An item needs an `sd` trick-play index
     * AND a subtitle stream with a NON-NULL key: most SRT streams Plex reports
     * are embedded in the media file and cannot be fetched separately (F-014).
     * Jellyfin converts embedded tracks on demand and must not be asked this
     * (F-037), which is why the question lives here and not in shared code.
     */
    async function resolvePlayable(item) {
        const d = await plexFetch(`/library/metadata/${item.ref.key}`);
        const md = d.MediaContainer?.Metadata?.[0];
        if (!md?.Media) return null;

        for (const media of md.Media) {
            for (const part of media.Part || []) {
                if (!part.indexes || !part.indexes.includes("sd")) continue;
                const sub = (part.Stream || []).find(
                    (st) => st.streamType === 3 && st.codec === "srt" && st.key,
                );
                if (!sub) continue;
                return {
                    title: item.title,
                    durationMs: md.duration || null,
                    badges: [media.videoResolution ? `${media.videoResolution}p` : null, "SRT"]
                        .filter(Boolean),
                    config: { timelineRef: part.id, subtitleRef: sub.key },
                };
            }
        }
        return null;
    }

    /** The item-scoped half of the seam, ready for the engine. */
    function openSource(playable) {
        return createPlexSource({
            // The ROUTE, not a snapshot of it: frames are fetched for the whole
            // episode, and leaving the house halfway through changes which
            // address works.
            withRoute: (request) => withRoute((base) => request(base, timedFetch)),
            token: () => serverToken,
            timelineRef: playable.config.timelineRef,
            subtitleRef: playable.config.subtitleRef,
        });
    }

    /**
     * What re-creates this account after a reload.
     *
     * The account token is kept as well as the server one so a server that has
     * moved can be re-discovered without another sign-in, and every route is
     * kept for the same reason (UI.md §1).
     */
    function persist() {
        return { provider: "plex", id, name, accountToken, serverToken, serverUrl, routes };
    }

    return {
        provider: "plex",
        get name() { return name; },
        get serverUrl() { return serverUrl; },
        get isAuthenticated() { return !!accountToken; },
        get hasServer() { return !!serverUrl; },
        capabilities, beginAuth, listServers, use,
        listRoots, listChildren, resolvePlayable, openSource, persist,
    };
}
