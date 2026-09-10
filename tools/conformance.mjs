#!/usr/bin/env node
// Conformance runner — Even Realities G2.
//
// Runs the shipping parsers against the vendored corpus/. This is only
// possible because src/timeline.ts is split into a pure parseTimelineIndex
// and a browser layer that adds Blobs and object URLs; the Blob half cannot
// run under Node.
//
// corpus/ is vendored from trickplayer-knowledge; never edit it here.
//
//   npm run conformance

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CORPUS = path.join(ROOT, "corpus");

// The sources are TypeScript with browser globals in one half. Transpile
// (no type-check) and import, rather than duplicating the logic here — the
// whole point is to test the SHIPPING code.
async function loadTs(rel) {
  const src = fs.readFileSync(path.join(ROOT, rel), "utf8");
  const js = ts.transpileModule(src, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2020 },
  }).outputText;
  const b64 = Buffer.from(js).toString("base64");
  return import(`data:text/javascript;base64,${b64}`);
}

const readJson = (rel) => JSON.parse(fs.readFileSync(path.join(CORPUS, rel), "utf8"));

let pass = 0;
const failures = [];
const skipped = [];
const check = (group, name, actual, expected) => {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { pass++; return; }
  failures.push({ group, name, expected: e, actual: a });
};
const skip = (group, name, why) => skipped.push({ group, name, why });

const timeline = await loadTs("src/timeline.ts");
const subtitles = await loadTs("src/subtitles.ts");

// ---------------------------------------------------------------- timeline

{
  const buf = fs.readFileSync(path.join(CORPUS, "timeline/synthetic.bif"));
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  const exp = readJson("timeline/synthetic.expected.json");

  const got = timeline.parseTimelineIndex(ab);
  check("timeline", "multiplierMs (file stores 0 => 1000)", got.multiplierMs, exp.multiplierMs);
  check("timeline", "frameCount", got.frameCount, exp.frameCount);
  check("timeline", "frames", got.frames.map((f, i) => ({
    index: i, tsMs: f.tsMs, offset: f.offset, length: f.length,
  })), exp.frames);

  check("timeline", "invariant sum(lengths)+header+index == file size",
    got.frames.reduce((n, f) => n + f.length, 0) + exp.invariant.headerPlusIndex,
    exp.fileByteLength);

  // The two fixtures that synthetic.bif cannot catch, because synthetic.bif
  // is shaped like real Plex output and real Plex output is what lets these
  // two bugs look correct.
  for (const name of ["multiplier", "trailing"]) {
    const b = fs.readFileSync(path.join(CORPUS, `timeline/${name}.bif`));
    const a = b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
    const e = readJson(`timeline/${name}.expected.json`);
    const g = timeline.parseTimelineIndex(a);
    check("timeline", `${name}: multiplierMs`, g.multiplierMs, e.multiplierMs);
    check("timeline", `${name}: frames`, g.frames.map((f, i) => ({
      index: i, tsMs: f.tsMs, offset: f.offset, length: f.length,
    })), e.frames);
  }

  for (const [name, mutate] of [
    ["rejects non-BIF magic", (b) => { const c = Buffer.from(b); c[1] = 0; return c; }],
    ["rejects truncated header", (b) => b.subarray(0, 32)],
    ["rejects truncated index", (b) => b.subarray(0, 70)],
  ]) {
    const m = mutate(buf);
    let threw = false;
    try {
      timeline.parseTimelineIndex(m.buffer.slice(m.byteOffset, m.byteOffset + m.byteLength));
    } catch (e) { threw = true; }
    check("timeline", name, threw, true);
  }
  skip("timeline", "byte-identical duplicate detection",
    "F-001 not implemented on G2.");
}

// -------------------------------------------------------------------- subs

{
  const text = fs.readFileSync(path.join(CORPUS, "subs/torture.srt"), "utf8");
  const exp = readJson("subs/torture.expected.json");
  const got = await subtitles.parseSubtitles(text);

  check("subs", "cueCount", got.length, exp.cueCount);
  // G2 joins a cue's own line breaks with <br> for HTML display, where the
  // corpus states the platform-neutral "\n". Normalise before comparing:
  // the markup is a rendering choice, the text content is the rule.
  check("subs", "cues", got.map((c) => ({
    startMs: c.startMs, endMs: c.endMs, text: c.text.replace(/<br>/g, "\n"),
  })), exp.cues);
}

// -------------------------------------------------------------- encodings

{
  const exp = readJson("subs/torture.expected.json");
  const enc = readJson("subs/encodings.expected.json");
  for (const v of enc.variants) {
    const bytes = fs.readFileSync(path.join(CORPUS, v.file));
    const text = subtitles.decodeSubtitleBytes(
      bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
    const cues = await subtitles.parseSubtitles(text);
    check("encoding", `${v.file} cueCount`, cues.length, exp.cueCount);
    check("encoding", `${v.file} cues`, cues.map((c) => ({
      startMs: c.startMs, endMs: c.endMs, text: c.text.replace(/<br>/g, "\n"),
    })), exp.cues);
  }
}

// --------------------------------------------------------- scene / cues

skip("scene", "selection policy",
  "G2 has no scene selection: it walks every frame on a timer. F-001 is what " +
  "would give it one (PLAN.md §3, 'no scene concept').");
skip("cues", "wrap / paginate",
  "F-002 not implemented — groupSceneSubtitles merges cues to fill the " +
  "container but estimates lines rather than wrapping, and clips rather " +
  "than paginating.");

// -------------------------------------------------------------------- real

{
  const dir = path.join(CORPUS, "real");
  const names = fs.existsSync(dir)
    ? fs.readdirSync(dir).filter((f) => f.endsWith(".expected.json"))
        .map((f) => f.replace(/\.expected\.json$/, ""))
    : [];
  if (names.length === 0) {
    skip("real", "captured fixture", "corpus/real/ is empty — see its README");
  } else {
    for (const name of names) {
      const b = fs.readFileSync(path.join(dir, `${name}.bif`));
      const a = b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
      const e = readJson(`real/${name}.expected.json`);
      const g = timeline.parseTimelineIndex(a);
      check("real", `${name}: multiplierMs`, g.multiplierMs, e.multiplierMs);
      check("real", `${name}: frames`, g.frames.map((f, i) => ({
        index: i, tsMs: f.tsMs, offset: f.offset, length: f.length,
      })), e.frames);
    }
  }
}

// -------------------------------------------------------------------- main

console.log("\ncorpus conformance — trickplayer-g2 (src/)\n");
for (const s of skipped) console.log(`  SKIP  [${s.group}] ${s.name}\n          ${s.why}`);
if (skipped.length) console.log("");

if (failures.length === 0) {
  console.log(`  ${pass} checks agree, ${skipped.length} not applicable yet\n`);
  process.exit(0);
}
console.log(`  ${pass} agree, ${failures.length} DISAGREE, ${skipped.length} skipped\n`);
for (const f of failures) {
  console.log(`  [${f.group}] ${f.name}`);
  console.log(`      expected: ${f.expected.slice(0, 260)}`);
  console.log(`      actual:   ${f.actual.slice(0, 260)}\n`);
}
process.exit(1);
