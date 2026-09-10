// @ts-nocheck
//
// Plex as an account. See src/account.ts.
//
// Owns everything Plex-shaped about signing in and browsing: the PIN exchange,
// plex.tv's resource list, section keys, rating keys, and the eligibility rule
// that only applies here. Nothing above this file knows any of it exists.

import { createPlexSource } from "./plexsource";

const CLIENT_ID = "trickplayer-g2";
const APP_NAME = "Trickplayer";

export function createPlexAccount(saved = {}) {
    let accountToken = saved.accountToken || null;
    let serverUrl = saved.serverUrl || null;
    let serverToken = saved.serverToken || null; // server-specific (F-020)
    let routes = saved.routes || [];
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
                routes: (Array.isArray(d.connections) ? d.connections : [d.connections])
                    .filter(Boolean)
                    .map((c) => c.uri || `${c.protocol}://${c.address}:${c.port}`),
                // Server-specific, not the account token (F-020).
                accessToken: d.accessToken || accountToken,
            }));
    }

    /**
     * Fix the route this account will use.
     *
     * Local routes first, then the rest. F-016's parallel race is a UI change
     * this build has not made yet; ordering by locality is the part of it that
     * costs nothing, and the whole route list is kept so the race can be added
     * without another sign-in.
     */
    function use(server) {
        id = server.id;
        name = server.name;
        routes = server.routes;
        serverToken = server.accessToken;
        const local = routes.find((u) => /\/\/(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(u));
        serverUrl = local || routes[0] || null;
    }

    // ------------------------------------------------------------- browse

    async function plexFetch(endpoint) {
        const res = await fetch(`${serverUrl.replace(/\/$/, "")}${endpoint}`, {
            headers: { Accept: "application/json", "X-Plex-Token": serverToken },
        });
        if (!res.ok) throw new Error(`Plex ${endpoint} -> HTTP ${res.status}`);
        return res.json();
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
            serverUrl,
            token: serverToken,
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
