// @ts-nocheck
//
// The ACCOUNT seam: signing in, and finding something to play.
//
// `src/source.ts` is the other half — one item, already chosen. This half is
// everything before that, and it exists for the same reason: the two providers'
// sign-in flows are genuinely different shapes, and a UI written against either
// one of them hard-codes it. See trickplayer-knowledge/UI.md §5.
//
//   capabilities()          → Capabilities        the same object src/source.ts declares
//   beginAuth()             → { code, enterAt, poll() }
//   listServers()           → [Server]            Jellyfin returns the one it was given
//   use(server)             → void                fixes the route later calls use
//   listRoots()             → [Container]
//   listChildren(ref)       → [Container | Item]  recursive; no assumed depth
//   assess(item)            → { img, subs, playable }   the ONLY eligibility signal
//                              img: has preview thumbnails; subs: "file" (plays
//                              at once), "embedded" (read from the media file on
//                              first play), "none"; playable: Playable | null
//   resolvePlayable(item)   → Playable | null     assess(item).playable
//   searchSubtitles(item)   → [Candidate]         what the SERVER can download:
//                              { name (the release it was timed to), language,
//                                perfect, hearingImpaired, score, mismatch }
//   downloadSubtitle(item, candidate)             the server fetches and attaches it
//   openSource(playable)    → MediaSource         hands the engine src/source.ts
//   persist()               → JSON                what re-creates this account
//
// Shapes:
//
//   Container { ref, title, kind: "container" }
//   Item      { ref, title, kind: "item" }        may still be ineligible
//   Playable  { title, durationMs, badges[], source-shaped provider config }
//
// **`assess` is the only eligibility signal there is**; `resolvePlayable` is its
// yes-or-no half.
// Plex needs the non-null-subtitle-key filter and Jellyfin must not have it
// (F-037), so shared code never asks the question itself — it asks the account.
//
// `beginAuth` is one function for both providers because F-018 found the flows
// are the same shape: mint a short code, show it, poll, exchange. What differs
// is only WHERE the code is entered, which is why `enterAt` is a string the
// provider writes rather than something the UI knows.
export const ACCOUNT_SEAM_VERSION = 1;

/**
 * Subtitle candidates, best first: anything named for a different episode last,
 * then a perfect (hash) match before a guess, a
 * plain track before one for the hearing impaired (it describes sounds too),
 * then the more downloaded. Shared, so both providers order the same way.
 */
export function rankSubtitleCandidates(a, b) {
    return (a.mismatch - b.mismatch)
        || (b.perfect - a.perfect)
        || (a.hearingImpaired - b.hearingImpaired)
        || (b.score - a.score);
}

const STOP_WORDS = new Set(["the", "a", "an", "and", "of"]);
const words = (t) => String(t || "").toLowerCase().split(/[^a-z0-9]+/).filter((w) => w && !STOP_WORDS.has(w));

/**
 * Does a candidate's release name say it is for some OTHER episode?
 *
 * OpenSubtitles names a file for the release it was timed to, and its "perfect
 * match" flag is not proof: The 100 S04E09's top perfect match was
 * `Lucifer.S02E15.720p.HDTV.x264-KILLERS`. A name with a season and episode
 * that differ from the item's, or a show name sharing no word with the item's,
 * is a different episode. A name that says neither is given the benefit of
 * the doubt.
 *
 * @returns { mismatch: boolean, tag: "S02E15" | null }
 */
export function checkCandidateName(name, item) {
    const m = /S(\d{1,2})[ ._-]*E(\d{1,3})/i.exec(name || "") || /\b(\d{1,2})x(\d{2,3})\b/.exec(name || "");
    if (!m) return { mismatch: false, tag: null };
    const season = Number(m[1]), episode = Number(m[2]);
    const tag = `S${String(season).padStart(2, "0")}E${String(episode).padStart(2, "0")}`;
    if (item?.seasonNumber != null && item?.episodeIndex != null &&
        (season !== Number(item.seasonNumber) || episode !== Number(item.episodeIndex))) {
        return { mismatch: true, tag };
    }
    const show = words(item?.seriesTitle);
    const named = words((name || "").slice(0, m.index));
    if (show.length && named.length && !named.some((w) => show.includes(w))) {
        return { mismatch: true, tag };
    }
    return { mismatch: false, tag };
}
