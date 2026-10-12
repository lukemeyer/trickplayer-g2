// @ts-nocheck
//
// Jellyfin as an account. See src/account.ts.
//
// The mirror of plexaccount.ts, and deliberately not a variation on it: there
// is no account service here, so the address IS the identity and must be known
// before anything can be authenticated (UI.md §1).

import { createJellyfinSource } from "./jellyfinsource";
import { rankSubtitleCandidates, checkCandidateName } from "./account";

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

    /**
     * Tell the server where the wearer has got to.
     *
     * `/Sessions/Playing/Progress` is what a real client posts while playing;
     * position is in 100-nanosecond ticks. Off by default in the UI, because it
     * changes what every other device shows.
     */
    async function reportProgress(ref, positionMs, state = "playing") {
        if (!ref?.id) return false;
        try {
            await req("/Sessions/Playing/Progress", {
                method: "POST",
                body: {
                    ItemId: ref.id,
                    PositionTicks: Math.max(0, Math.round(positionMs)) * 10000,
                    IsPaused: state !== "playing",
                    PlayMethod: "DirectPlay",
                },
            });
            return true;
        } catch (e) {
            console.warn(`[jellyfin] could not report progress: ${e.message}`);
            return false;
        }
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
    // `UserData` carries the server's own resume position. It is returned by
    // default on user-scoped queries, but asked for explicitly so a listing that
    // is not user-scoped does not silently lose it.
    const ITEM_FIELDS = "MediaSources,MediaStreams,Trickplay,RunTimeTicks,UserData,Overview,ProductionYear";

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
        const isEp = it.Type === "Episode";
        const epLabel = isEp && it.ParentIndexNumber !== undefined && it.IndexNumber !== undefined
            ? `S${pad(it.ParentIndexNumber)}E${pad(it.IndexNumber)}`
            : "";
        const shortTitle = isEp
            ? (epLabel ? `${epLabel} — ${it.Name}` : it.Name)
            : it.Name;
        const fullTitle = isEp && it.SeriesName
            ? `${it.SeriesName} — ${shortTitle}`
            : it.Name;
        const durationMs = it.RunTimeTicks ? Math.round(it.RunTimeTicks / 10000) : null;

        // The whole item rides along: the listing already asked for the fields
        // eligibility needs, so resolvePlayable can answer without a request.
        return {
            ref: { kind: "item", id: it.Id, raw: it },
            title: fullTitle,
            shortTitle,
            seriesTitle: it.SeriesName || "",
            episodeNumber: epLabel,
            episodeName: it.Name,
            // For the episode page on the phone.
            summary: it.Overview || "",
            seasonNumber: isEp ? (it.ParentIndexNumber ?? null) : null,
            episodeIndex: isEp ? (it.IndexNumber ?? null) : null,
            year: it.ProductionYear || null,
            durationMs,
            kind: "item",
            // Ticks are 100-nanosecond units; milliseconds is what everything
            // above this line speaks.
            resumeMs: Math.round((it.UserData?.PlaybackPositionTicks || 0) / 10000),
        };
    }

    const pad = (n) => String(n || 0).padStart(2, "0");

    /**
     * Eligibility, what is missing if not, and the fetch config if eligible.
     *
     * **Deliberately NOT Plex's rule.** Requiring an external subtitle file
     * would hide most of a Jellyfin library, because embedded tracks are
     * converted on demand (F-037). What this needs is trickplay generated at
     * some width, and a TEXT subtitle stream, embedded or not. An image-based
     * one (PGS, VobSub) cannot be served as SRT: Jellyfin only burns those into
     * video. The default text track is preferred, as a player would pick it.
     */
    async function assess(item) {
        const it = item.ref.raw
            || (await req(`/Items?${q({ userId, Ids: item.ref.id, Fields: ITEM_FIELDS })}`)).Items?.[0];
        if (!it) return { img: false, subs: "none", playable: null, still: null };

        const tp = it.Trickplay && Object.keys(it.Trickplay).length ? it.Trickplay : null;
        const ms = (it.MediaSources || [])[0];
        // Not forced tracks: they cover only foreign-language moments.
        const texts = (ms?.MediaStreams || []).filter((s) => s.Type === "Subtitle" && s.IsTextSubtitleStream && !s.IsForced);
        const sub = texts.find((s) => s.IsDefault) || texts[0];
        // Jellyfin converts on demand, so a text track plays at once: "file".
        const status = { img: !!tp, subs: sub ? "file" : "none", playable: null, still: chooseStill(it, ms) };
        if (!tp || !ms || !sub) return status;

        // Widest available: more pixels per thumbnail, and the sheet count is
        // the same either way, so there is nothing to trade (F-038).
        const [mediaSourceId, byWidth] = Object.entries(tp)[0];
        const width = Math.max(...Object.keys(byWidth).map(Number));
        const durationMs = it.RunTimeTicks ? Math.round(it.RunTimeTicks / 10000) : (item.durationMs || null);

        status.playable = {
            still: chooseStill(it, ms),
            title: item.title,
            shortTitle: item.shortTitle || item.title,
            seriesTitle: item.seriesTitle || "",
            episodeNumber: item.episodeNumber || "",
            episodeName: item.episodeName || "",
            summary: it.Overview || item.summary || "",
            seasonNumber: item.seasonNumber ?? null,
            episodeIndex: item.episodeIndex ?? null,
            year: it.ProductionYear || item.year || null,
            durationMs,
            resumeMs: Math.round((it.UserData?.PlaybackPositionTicks || 0) / 10000),
            progressRef: { id: it.Id },
            // Duration is FORMATTED by the flow, not here: three
            // copies of one formatter have to agree for ever, and the
            // shape of a badge is a presentation question anyway.
            badges: [],
            config: {
                itemId: it.Id,
                mediaSourceId,
                width,
                trickplay: byWidth[String(width)],
                subtitleMediaSourceId: ms.Id,
                subtitleIndex: sub.Index,
            },
        };
        return status;
    }

    async function resolvePlayable(item) {
        return (await assess(item)).playable;
    }

    /**
     * The curated picture: an episode's Primary image is its still (16:9); a
     * film's Primary is its poster (2:3), so its Backdrop or Thumb (both 16:9)
     * wins. Whichever is nearest the video's own shape.
     */
    function chooseStill(it, ms) {
        const v = (ms?.MediaStreams || []).find((s) => s.Type === "Video");
        const video = v?.Width && v?.Height ? v.Width / v.Height : 16 / 9;
        const tags = it.ImageTags || {};
        const candidates = it.Type === "Episode"
            ? [{ type: "Primary", aspect: 16 / 9, ok: !!tags.Primary }]
            : [{ type: "Backdrop", index: 0, aspect: 16 / 9, ok: !!(it.BackdropImageTags || []).length },
               { type: "Thumb", aspect: 16 / 9, ok: !!tags.Thumb },
               { type: "Primary", aspect: 2 / 3, ok: !!tags.Primary }];
        const best = candidates.filter((c) => c.ok)
            .sort((a, b) => Math.abs(a.aspect - video) - Math.abs(b.aspect - video))[0];
        return best ? { itemId: it.Id, type: best.type, index: best.index ?? null } : null;
    }

    /**
     * Subtitles the server can find, best first. Jellyfin searches through a
     * subtitle plugin (OpenSubtitles); without one configured this is empty.
     * Not yet run against a real server.
     */
    async function searchSubtitles(item, language = "eng") {
        const list = await req(`/Items/${item.ref.id}/RemoteSearch/Subtitles/${encodeURIComponent(language)}`);
        return (list || [])
            .filter((c) => c.Id && !c.Forced)
            .map((c) => {
                const name = c.Name || "";
                const check = checkCandidateName(name, item);
                return {
                    id: c.Id,
                    name,
                    language: c.ThreeLetterISOLanguageName || language,
                    provider: c.ProviderName || "",
                    perfect: !!c.IsHashMatch && !check.mismatch,
                    hearingImpaired: !!c.HearingImpaired,
                    score: Number(c.DownloadCount) || 0,
                    mismatch: check.mismatch,
                    nameTag: check.tag,
                };
            })
            .sort(rankSubtitleCandidates);
    }

    /** The server downloads it and attaches it to the item. */
    async function downloadSubtitle(item, candidate) {
        await req(`/Items/${item.ref.id}/RemoteSearch/Subtitles/${encodeURIComponent(candidate.id)}`, { method: "POST" });
        return true;
    }

    /** The still, resized by the server, as a Blob — or null if there is none. */
    async function fetchStill(playable, width, height) {
        const st = playable?.still;
        if (!st) return null;
        const path = `/Items/${st.itemId}/Images/${st.type}${st.index != null ? `/${st.index}` : ""}`;
        try {
            const res = await fetch(`${base}${path}?${q({ maxWidth: width, maxHeight: height, quality: 80 })}`, {
                headers: { Authorization: authHeader(token), Accept: "image/*" },
            });
            if (!res.ok) throw new Error(`still -> HTTP ${res.status}`);
            return await res.blob();
        } catch (e) {
            console.warn(`[jellyfin] no still: ${e.message}`);
            return null;
        }
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
        listRoots, listChildren, assess, resolvePlayable, fetchStill,
        searchSubtitles, downloadSubtitle, openSource, persist, reportProgress,
    };
}
