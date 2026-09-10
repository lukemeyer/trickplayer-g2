# Shared knowledge

This is **Trickplayer** — the Even Realities G2 build of Trickplayer, one of three
implementations of the same product:

| Repo | Platform |
|---|---|
| `trickplayer-g2` | Even Realities G2 |
| `trickplayer-pebble` | Pebble Time 2 |
| `trickplayer-wearos` | Wear OS |

Findings that are not specific to Even Realities G2 live in **`trickplayer-knowledge`**,
not here.

## The rule

A non-obvious discovery gets a `findings/` entry in `trickplayer-knowledge`,
with the per-platform *applies / status* table filled in, **before the PR that
acts on it merges**.

"Does not apply to Pebble, because X" is a complete answer and takes ten
seconds. Silence is what costs six months — see `PLAN.md` §2 for the three
corrections that sat in one repo's comments while the other two shipped the bug.

## What belongs where

**`trickplayer-knowledge`** — the rules, and the conformance corpus that
enforces them: trick-play index parsing, SRT parsing and cue-window ownership,
scene selection policy, cursor semantics, the media-source contract.

**Here** — everything shaped by this platform's constraints: the image pipeline,
the transport, the trigger model, layout, and config UI. Those are genuinely
different across the three and are not worth unifying.

## Vocabulary

Domain terms are standardized across all three repos. `Timeline` (not
`BifIndex`), `FrameRef`, `timelineRef`, `itemId`, `subtitleRef`, `scene`
(not `chunk`). See `PLAN.md` §7, Phase 0.

## Conformance corpus

`corpus/` is **vendored** from `trickplayer-knowledge` — never edit it here.
Refresh it by running that repo's `tools/corpus/sync-corpus.sh`, which also has
a `--check` mode that reports drift.

```bash
npm run conformance
```

**13 checks agree, 0 disagree.** The four divergences this runner was built to
report — the hardcoded timestamp multiplier, the buffer-length last-frame
length, and unstripped subtitle markup — are fixed (`PLAN.md` Phase 2, items 11
and 12).

Four checks still skip. A skip is not a pass: each names a rule this build does
not implement yet, with a pointer to where it is tracked.

Testing the parser headlessly is possible only because `src/timeline.ts` is
split into a pure `parseTimelineIndex` and a browser layer that adds Blobs and
object URLs — `Blob` and `URL.createObjectURL` do not exist under Node, and
previously they were entangled with the parsing.
