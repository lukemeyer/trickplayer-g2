// @ts-nocheck
//
// Jellyfin as an account. See src/account.ts.
//
// The mirror of plexaccount.ts, and deliberately not a variation on it: there
// is no account service here, so the address IS the identity and must be known
// before anything can be authenticated (UI.md §1).

import { createJellyfinSource } from "./jellyfinsource";

const CLIENT = "Trickplayer";
const DEVICE = "even-g2";
const DEVICE_ID = "trickplayer-g2";
const VERSION = "0.1.0";

/**
 * The unauthenticated header still has to identify the client: Quick Connect
 * ties the pending request to this device, and the approval screen shows this
 * app name to the person approving it.
 */
function authHeader(token) {
    const parts = [
        `Client="${CLIENT}"`, `Device="${DEVICE}"`,
        `DeviceId="${DEVICE_ID}"`, `Version="${VERSION}"`,
    ];
    if (token) parts.push(`Token="${token}"`);
    return `MediaBrowser ${parts.join(", ")}`;
}

const q = (o) => Object.entries(o)
    .filter(([, v]) => v !== undefined && v !== null)
    .map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join("&");

export function createJellyfinAccount(saved = {}) {
    const base = (saved.serverUrl || "").replace(/\/$/, "");
    let token = saved.token || null;
    let userId = saved.userId || null;
    let name = saved.name || base;
    let id = saved.id || null;

    function capabilities() {
        return {
            // No account service: the address is typed, not discovered.
            needsAddressFirst: true,
            hasServerDiscovery: false,
            hasPlaylists: true,
            hasContinueWatching: true,
            hasFrameSizeHints: false,
            fetchGranularity: "batch",
        };
    }

    async function req(path_, { method = "GET", body } = {}) {
        const headers = { Authorization: authHeader(token), Accept: "application/json" };
        if (body) headers["Content-Type"] = "application/json";
        const res = await fetch(`${base}${path_}`, {
            method, headers, body: body ? JSON.stringify(body) : undefined,
        });
        if (!res.ok) throw new Error(`Jellyfin ${path_} -> HTTP ${res.status}`);
        const text = await res.text();
        return text ? JSON.parse(text) : null;
    }

    // --------------------------------------------------------------- auth

    /**
     * Quick Connect: mint a code, show it, poll, exchange. Same shape as Plex's
     * PIN (F-018) — the difference is where the code is entered, which the user
     * cannot guess, so `enterAt` names the server they just typed in.
     */
    async function beginAuth(resuming) {
        const init = resuming || await req("/QuickConnect/Initiate", { method: "POST" });
        const secret = init.Secret;

        return {
            code: init.Code,
            enterAt: `${base} — sign in, then Quick Connect`,
            state: { Secret: secret, Code: init.Code },
            /** @returns "pending" | "ok" | "expired" */
            async poll() {
                let r;
                try {
                    r = await req(`/QuickConnect/Connect?${q({ secret })}`);
                } catch (e) {
                    // The server forgets a request it has timed out, and a
                    // forgotten secret is a 404. Same meaning as a dead PIN.
                    if (/404/.test(e.message)) return "expired";
                    throw e;
                }
                if (!r || !r.Authenticated) return "pending";
                // Approval is not a token: it has to be redeemed for one.
                const auth = await req("/Users/AuthenticateWithQuickConnect", {
                    method: "POST", body: { Secret: secret },
                });
                token = auth.AccessToken;
                userId = auth.User?.Id || null;
                id = auth.ServerId || base;
                return "ok";
            },
        };
    }

    /** There is nothing to discover — the server is the address that was typed. */
    async function listServers() {
        return [{ id: id || base, name, routes: [base], accessToken: token }];
    }

    function use() { /* nothing to choose */ }

    // ------------------------------------------------------------- browse

    async function listRoots() {
        const roots = [
            { ref: { kind: "resume" }, title: "Continue watching", kind: "container" },
            { ref: { kind: "playlists" }, title: "Playlists", kind: "container" },
        ];
        const views = await req(`/Users/${userId}/Views`);
        for (const v of views.Items || []) {
            if (v.CollectionType && v.CollectionType !== "movies" && v.CollectionType !== "tvshows") continue;
            roots.push({
                ref: { kind: "view", id: v.Id, type: v.CollectionType },
                title: v.Name,
                kind: "container",
            });
        }
        return roots;
    }

    // Everything eligibility needs, asked for once with the listing, so
    // resolvePlayable costs no second request here (unlike Plex).
    const ITEM_FIELDS = "MediaSources,MediaStreams,Trickplay,RunTimeTicks";

    async function listChildren(ref) {
        if (ref.kind === "resume") {
            const r = await req(`/Users/${userId}/Items/Resume?${q({
                Limit: 40, MediaTypes: "Video", Fields: ITEM_FIELDS,
            })}`);
            return (r.Items || []).map(toItem);
        }
        if (ref.kind === "playlists") {
            const r = await req(`/Items?${q({
                userId, Recursive: true, IncludeItemTypes: "Playlist", SortBy: "SortName",
            })}`);
            return (r.Items || []).map((pl) => ({
                ref: { kind: "playlist", id: pl.Id },
                title: pl.Name,
                subtitle: pl.ChildCount ? `${pl.ChildCount} items` : "",
                kind: "container",
            }));
        }
        if (ref.kind === "playlist") {
            const r = await req(`/Playlists/${ref.id}/Items?${q({ userId, Fields: ITEM_FIELDS })}`);
            return (r.Items || []).map(toItem);
        }
        if (ref.kind === "view") {
            // A TV view lists series; a film view lists films. Same discovered
            // depth as Plex, arrived at from the collection type.
            const isShows = ref.type === "tvshows";
            const r = await req(`/Items?${q({
                userId, ParentId: ref.id, Recursive: true, SortBy: "SortName",
                IncludeItemTypes: isShows ? "Series" : "Movie",
                Fields: isShows ? undefined : ITEM_FIELDS,
            })}`);
            return (r.Items || []).map(isShows ? toSeries : toItem);
        }
        if (ref.kind === "series") {
            const r = await req(`/Items?${q({
                userId, ParentId: ref.id, Recursive: true,
                IncludeItemTypes: "Episode", SortBy: "SortName", Fields: ITEM_FIELDS,
            })}`);
            return (r.Items || []).map(toItem);
        }
        return [];
    }

    const toSeries = (it) => ({
        ref: { kind: "series", id: it.Id }, title: it.Name, kind: "container",
    });

    function toItem(it) {
        const title = it.Type === "Episode"
            ? `${it.SeriesName || ""} — S${pad(it.ParentIndexNumber)}E${pad(it.IndexNumber)} — ${it.Name}`
            : it.Name;
        // The whole item rides along: the listing already asked for the fields
        // eligibility needs, so resolvePlayable can answer without a request.
        return { ref: { kind: "item", id: it.Id, raw: it }, title, kind: "item" };
    }

    const pad = (n) => String(n || 0).padStart(2, "0");

    /**
     * Eligibility, and the fetch config if eligible.
     *
     * **Deliberately NOT Plex's rule.** Requiring an external subtitle file
     * would hide most of a Jellyfin library, because embedded tracks are
     * converted on demand (F-037). What this needs is trickplay generated at
     * some width, and a subtitle stream of any kind.
     */
    async function resolvePlayable(item) {
        const it = item.ref.raw
            || (await req(`/Items?${q({ userId, Ids: item.ref.id, Fields: ITEM_FIELDS })}`)).Items?.[0];
        if (!it) return null;

        const tp = it.Trickplay && Object.keys(it.Trickplay).length ? it.Trickplay : null;
        if (!tp) return null;
        const ms = (it.MediaSources || [])[0];
        if (!ms) return null;
        const sub = (ms.MediaStreams || []).find((s) => s.Type === "Subtitle");
        if (!sub) return null;

        // Widest available: more pixels per thumbnail, and the sheet count is
        // the same either way, so there is nothing to trade (F-038).
        const [mediaSourceId, byWidth] = Object.entries(tp)[0];
        const width = Math.max(...Object.keys(byWidth).map(Number));

        return {
            title: item.title,
            durationMs: it.RunTimeTicks ? Math.round(it.RunTimeTicks / 10000) : null,
            badges: [`${width}px`, sub.IsExternal ? "SRT" : "Embedded"],
            config: {
                itemId: it.Id,
                mediaSourceId,
                width,
                trickplay: byWidth[String(width)],
                subtitleMediaSourceId: ms.Id,
                subtitleIndex: sub.Index,
            },
        };
    }

    function openSource(playable) {
        const c = playable.config;
        return createJellyfinSource({
            serverUrl: base,
            token,
            itemId: c.itemId,
            mediaSourceId: c.subtitleMediaSourceId,
            width: c.width,
            trickplay: c.trickplay,
            subtitleIndex: c.subtitleIndex,
        });
    }

    /**
     * The address is saved with the credential because here the address IS the
     * identity: there is no account service to rebuild it from, and asking for
     * an IP again on a pair of glasses is not a recovery path (UI.md §1).
     */
    function persist() {
        return { provider: "jellyfin", id, name, serverUrl: base, token, userId };
    }

    return {
        provider: "jellyfin",
        get name() { return name; },
        get serverUrl() { return base; },
        get isAuthenticated() { return !!token; },
        get hasServer() { return !!base; },
        capabilities, beginAuth, listServers, use,
        listRoots, listChildren, resolvePlayable, openSource, persist,
    };
}
