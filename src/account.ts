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
//   resolvePlayable(item)   → Playable | null     the ONLY eligibility signal
//   openSource(playable)    → MediaSource         hands the engine src/source.ts
//   persist()               → JSON                what re-creates this account
//
// Shapes:
//
//   Container { ref, title, kind: "container" }
//   Item      { ref, title, kind: "item" }        may still be ineligible
//   Playable  { title, durationMs, badges[], source-shaped provider config }
//
// **`resolvePlayable` returning null is the only eligibility signal there is.**
// Plex needs the non-null-subtitle-key filter and Jellyfin must not have it
// (F-037), so shared code never asks the question itself — it asks the account.
//
// `beginAuth` is one function for both providers because F-018 found the flows
// are the same shape: mint a short code, show it, poll, exchange. What differs
// is only WHERE the code is entered, which is why `enterAt` is a string the
// provider writes rather than something the UI knows.
export const ACCOUNT_SEAM_VERSION = 1;
