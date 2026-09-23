// What each encoding costs the link, in bytes that actually went over the air.
//
// Every dither decision so far has rested on a guess. `probeDithers` times a
// write and divides by a constant; `wire-size.mjs` deflates a plane and hopes
// the host's compressor behaves like zlib. Both rank correctly and neither
// gives a magnitude — and worse, they disagree with hardware by DIFFERENT
// factors depending on the dither. Deflate sees Floyd-Steinberg as 20% bigger
// than Bayer 2x2; the link saw it as 141% slower. Any comparison across that
// boundary is currently unfounded.
//
// This reads the real numbers. The EvenHub host logs every BLE write it makes,
// one layer below where our telemetry stops:
//
//     I/BleDevice: Send cmd: <MAC> is success = true,
//                  name=Even G2_32_R_06F9F7, type=0, data length=240
//
// HOW TO USE IT
//
//   1. Debugging tools -> "Measure the real link cost". It counts down 15s.
//   2. On a computer with the phone attached, during that countdown:
//          adb logcat -c && adb logcat -v time > session.log
//   3. Let the probe finish, then ^C the capture.
//   4. Copy JSON from the panel, save it as report.json.
//   5. node tools/link-cost.mjs session.log report.json
//
// WHY IT CAN ATTRIBUTE BURSTS AT ALL
//
// The shipping host does not forward `console.log` to logcat, so the capture
// cannot see our side of the story, and the recorder deliberately exports no
// wall clock — so the two streams cannot be joined on time either.
//
// They are joined on ORDER instead, and on the SHAPE of the run. The probe
// records every send's duration; the capture holds every burst's span. Slide
// one along the other and the true offset is the one where they correlate —
// minutes of steadily varying transfer times fit in exactly one place.
//
// The first version keyed on the text write `probeLinkCost` sends before each
// variant, and that was wrong: the link makes small writes of its own, and one
// keepalive landing between two images of a variant splits it, after which
// every count disagrees and a perfectly good capture is refused. The
// delimiters are still sent, and are still a useful diagnostic, but they are
// not the key.
//
// Correlation is also self-checking in a way counting was not: a wrong offset
// does not merely miscount, it fails to fit, so the r it reports IS the
// evidence that the join is real. Below 0.6 this prints what it found and
// stops. A mis-aligned join would otherwise produce a confident, wrong table.
import fs from "node:fs";

const [logFile, reportFile] = process.argv.slice(2);
if (!logFile) {
    console.error("usage: node tools/link-cost.mjs <logcat capture> [report.json]");
    process.exit(2);
}

// What separates a picture from a control write.
//
// NOT a byte floor. The first version used 4 KB, which quietly assumed no
// frame is ever smaller than that — true only while nothing is compressed, and
// the whole point of the controls is to test exactly that. A blank frame under
// LZ4 lands around 600 B and was being thrown away as a delimiter, which would
// have hidden compression working.
//
// A delimiter is one short write. A picture, however well it compresses, is
// several. So count writes, with a small byte floor to exclude keepalives.
const IMAGE_MIN_B = 4096;    // still used for "is this burst oversized"
const isImage = (b) => b.writes >= 2 && b.bytes >= 256;

// ---------------------------------------------------------------- the capture

const writes = [];
for (const line of fs.readFileSync(logFile, "utf8").split("\n")) {
    const m = line.match(
        /(\d\d:\d\d:\d\d\.\d+).*name=Even G2_(\S+?)_([LR])_\w+, type=(\d+), data length=(\d+)/);
    if (!m) continue;
    const [h, mn, s] = m[1].split(":");
    writes.push({
        t: +h * 3600 + +mn * 60 + parseFloat(s),
        side: m[3], bytes: +m[5], ok: /success = true/.test(line),
    });
}
if (!writes.length) {
    console.error("no BLE writes in that capture — was the app running while it was taken?");
    process.exit(1);
}

// The lenses are separate peripherals and picture data goes to one of them.
const L = writes.filter((w) => w.side === "L"), R = writes.filter((w) => w.side === "R");
const busy = R.length >= L.length ? R : L;

// Bursts by time first, because that is what a quiet link gives you for free.
//
// The probe now idles briefly between sends, so each transfer is its own burst.
// It did not always, and a real capture came back as ONE burst of 712 KB
// spanning 79 seconds — 3108 writes with every frame in the run fused into it.
// Captures taken before that fix still exist and are still worth reading, so
// `refine` below can pull a fused burst apart by shape when the count is short.
//
// Shape is deliberately not the primary key: the host mixes in small writes of
// its own, and a keepalive is indistinguishable from a frame's final partial
// chunk by size alone. Used as the primary split it cuts real frames in half.
const sizes = new Map();
for (const w of busy) sizes.set(w.bytes, (sizes.get(w.bytes) || 0) + 1);
const MTU = [...sizes.entries()].sort((a, b) => b[1] - a[1])[0][0];

function buildBursts(gap) {
    const out = [];
    for (const w of busy) {
        const last = out[out.length - 1];
        if (!last || w.t - last.end > gap) {
            out.push({ start: w.t, end: w.t, bytes: w.bytes, writes: 1, ok: w.ok, ws: [w] });
        } else {
            last.end = w.t; last.bytes += w.bytes; last.writes++;
            last.ok = last.ok && w.ok; last.ws.push(w);
        }
    }
    return out.map(measure);
}
const measure = (f) => { f.kb = f.bytes / 1024; f.s = f.end - f.start; return f; };
const rebuild = (ws) => {
    const f = { start: ws[0].t, end: ws[ws.length - 1].t, bytes: 0,
                writes: ws.length, ok: true, ws };
    for (const w of ws) { f.bytes += w.bytes; f.ok = f.ok && w.ok; }
    return measure(f);
};

let BURST_GAP_S = 0.6;
let bursts = buildBursts(BURST_GAP_S);

let images = bursts.filter(isImage);
let smalls = bursts.filter((b) => !isImage(b));

console.log(`\n  ${writes.length} BLE writes, MTU ${MTU} B -> ${bursts.length} frames` +
    `   (${images.length} image-sized, ${smalls.length} small)`);

// ----------------------------------------------------------------- the report

let expected = null;
const handedKb = new Map();
if (reportFile) {
    const session = JSON.parse(fs.readFileSync(reportFile, "utf8"));
    const evs = (session.events || []).filter((e) => e.linkCost && e.kind === "image");
    if (!evs.length) {
        console.error("\n  That report holds no link-cost events. Copy the JSON from the same\n" +
            "  session the probe ran in, after it finished.\n");
        process.exit(1);
    }
    const order = [];
    for (const e of evs) {
        const last = order[order.length - 1];
        if (!last || last.name !== e.variant) order.push({ name: e.variant, sends: [e] });
        else last.sends.push(e);
    }
    expected = order;
    // What we handed the SDK, per variant — NOT a constant. Two reference
    // variants are 8-bit PNGs, twice the size of the rest, and that difference
    // is the whole point of them.
    for (const e of evs) if (e.variant && e.bytes) handedKb.set(e.variant, e.bytes / 1024);
    console.log(`  report: ${evs.length} sends over ${order.length} variants` +
        ` — ${order.map((o) => o.sends.length).join("/")} each`);
}

// --------------------------------------------------------------- fused frames
//
// Only ever called when the capture holds fewer image bursts than the report
// says were sent, and only allowed to split as many times as it is short — so
// it cannot invent frames out of a capture that simply lacks them.
//
// Two ways to cut, tried in that order:
//
//   by shape  the host chunks a payload into MTU-sized writes and the last is
//             the remainder, so a write below the MTU ends a frame. Fragments
//             too small to be a picture are folded back into the frame before
//             them, which is what keeps a keepalive from cutting a real frame.
//   by pause  a frame whose payload is an exact multiple of the MTU has no
//             remainder to end it. The app does real work between sends, so
//             the widest gap inside the fused burst is where they meet.
/** Cut one burst in two, by shape if it can and by its widest pause if not. */
function splitOne(f) {
    if (!f.ws || f.ws.length < 4) return null;
    const pieces = []; let run = [];
    for (const w of f.ws) { run.push(w); if (w.bytes < MTU) { pieces.push(run); run = []; } }
    if (run.length) pieces.push(run);
    const kept = [];
    for (const piece of pieces) {
        const bytes = piece.reduce((t, w) => t + w.bytes, 0);
        if (bytes < 256 && kept.length) kept[kept.length - 1].push(...piece);
        else kept.push(piece);
    }
    if (kept.length >= 2) return kept.map(rebuild);
    let at = -1, widest = -1;
    for (let i = 1; i < f.ws.length; i++) {
        const g = f.ws[i].t - f.ws[i - 1].t;
        if (g > widest) { widest = g; at = i; }
    }
    if (at < 2 || at > f.ws.length - 2) return null;
    return [rebuild(f.ws.slice(0, at)), rebuild(f.ws.slice(at))];
}

function refine(frames, want) {
    const out = [...frames];
    const count = () => out.filter(isImage).length;

    const byShape = (f) => {
        const pieces = [];
        let run = [];
        for (const w of f.ws) {
            run.push(w);
            if (w.bytes < MTU) { pieces.push(run); run = []; }
        }
        if (run.length) pieces.push(run);
        if (pieces.length < 2) return null;
        // Fold anything too small to be a picture into its predecessor: that is
        // a keepalive or a status write sitting inside the transfer.
        const kept = [];
        for (const piece of pieces) {
            const bytes = piece.reduce((t, w) => t + w.bytes, 0);
            if (bytes < 256 && kept.length) kept[kept.length - 1].push(...piece);
            else kept.push(piece);
        }
        return kept.length >= 2 ? kept.map(rebuild) : null;
    };

    const byPause = (f) => {
        if (!f.ws || f.ws.length < 4) return null;
        let at = -1, widest = -1;
        for (let i = 1; i < f.ws.length; i++) {
            const g = f.ws[i].t - f.ws[i - 1].t;
            if (g > widest) { widest = g; at = i; }
        }
        if (at < 2 || at > f.ws.length - 2) return null;
        return [rebuild(f.ws.slice(0, at)), rebuild(f.ws.slice(at))];
    };

    let guard = 0;
    while (count() < want && guard++ < want) {
        const imgs = out.filter(isImage);
        if (!imgs.length) break;
        const biggest = imgs.reduce((x, y) => (y.bytes > x.bytes ? y : x));
        const cut = byShape(biggest) || byPause(biggest);
        if (!cut) break;
        out.splice(out.indexOf(biggest), 1, ...cut);
    }
    return out;
}

// -------------------------------------------------------------- the alignment
//
// Not by the delimiters. They are there, and they are a useful diagnostic, but
// they turned out to be a bad primary key: the link carries small writes of its
// own — keepalives, status polls — and one of those landing between two images
// of the same variant splits it in two, after which every count is wrong and
// the tool refuses a capture that was perfectly good.
//
// Instead: slide the report's list of sends along the capture's image bursts
// and take the offset where our recorded durations best correlate with the
// bursts' spans. The probe is minutes of steadily varying transfer times, so
// the true offset stands out sharply and a wrong one does not fit at all. That
// also tolerates traffic before and after the probe, which a capture started
// early or stopped late will always have.

const delimiters = bursts.filter((b) => b.bytes < IMAGE_MIN_B).length;

function pearson(a, b) {
    const m = (x) => x.reduce((t, v) => t + v, 0) / x.length;
    const ma = m(a), mb = m(b);
    let cov = 0, va = 0, vb = 0;
    for (let i = 0; i < a.length; i++) {
        cov += (a[i] - ma) * (b[i] - mb);
        va += (a[i] - ma) ** 2; vb += (b[i] - mb) ** 2;
    }
    return va && vb ? cov / Math.sqrt(va * vb) : 0;
}

function diagnose(msg) {
    console.log(`\n  CANNOT ALIGN — not reporting numbers that would be wrong.\n`);
    console.log(`    ${msg}\n`);
    console.log(`  What the capture holds:`);
    console.log(`    image-sized bursts   ${images.length}`);
    console.log(`    small bursts         ${delimiters}   (delimiters plus any link keepalives)`);
    if (images.length) {
        const kbs = images.map((b) => b.kb).sort((x, y) => x - y);
        console.log(`    burst sizes          ${kbs[0].toFixed(1)} - ${kbs[kbs.length - 1].toFixed(1)} KB`);
        console.log(`    spans                ${(images[images.length - 1].end - images[0].start).toFixed(0)}s end to end`);
    }
    if (expected) {
        console.log(`  What the report expects:`);
        console.log(`    variants             ${expected.length}`);
        console.log(`    successful sends     ${expected.reduce((t, o) => t + o.sends.filter((e) => e.ok !== false).length, 0)}`);
        console.log(`    per variant          ${expected.map((o) => o.sends.filter((e) => e.ok !== false).length).join("/")}`);
    }
    console.log(`\n  Most often this means the capture and the report are from different runs,`);
    console.log(`  or logcat was still buffering when the probe began. The capture file is`);
    console.log(`  reusable — nothing needs running on the glasses again.\n`);
    process.exit(1);
}

let groups;
if (expected) {
    const sends = expected.flatMap((o) => o.sends.filter((e) => e.ok !== false));
    // THE GAP THRESHOLD IS NOT A CONSTANT, so stop pretending it is.
    //
    // 0.6s came from wire-from-logcat, where playback leaves seconds between
    // frames. This probe idles 0.8s, and a real capture's gaps turned out to be
    // bimodal around that: a mode at 1.0-1.1s between sends, and a tail at
    // 0.6-0.9s which is one transfer stalling mid-flight. A fixed 0.6s sits
    // inside the tail, so it cut frames in three — and the first fix, merging
    // undersized neighbours by size, welded the eight blank control frames
    // together instead, because a genuinely tiny frame and a fragment are the
    // same size by definition.
    //
    // The report says how many frames there are. That is a real constraint, so
    // use it: sweep the threshold and keep the one that yields exactly that
    // many, after splitting anything plainly fused. One parameter, one
    // objective, no heuristics about what a small burst "probably" is.
    {
        const med = (a2) => { const t = [...a2].sort((x, y) => x - y); return t[t.length >> 1] || 0; };
        const splitFat = (list, limit) => {
            const out = [...list];
            let guard = 0;
            while (guard++ < limit) {
                const unit = med(out.map((x) => x.kb));
                const fat = out.find((x) => x.kb > unit * 1.6);
                if (!fat) break;
                const cut = splitOne(fat);
                if (!cut) break;
                out.splice(out.indexOf(fat), 1, ...cut);
            }
            return out;
        };
        let best = null;
        for (let g = 0.30; g <= 1.60; g += 0.05) {
            const got = splitFat(buildBursts(g).filter(isImage), sends.length);
            const miss = Math.abs(got.length - sends.length);
            if (!best || miss < best.miss) best = { g, miss, got };
            if (miss === 0) break;
        }
        // Always take the swept result. The first version only took it when the
        // COUNT improved, which skipped a capture holding exactly 55 bursts for
        // 55 sends — four of them fused pairs and one frame broken into three,
        // errors that cancelled in the total and wrecked the order. A matching
        // count is not a matching set of frames.
        if (best) {
            BURST_GAP_S = best.g;
            images = best.got;
            bursts = buildBursts(BURST_GAP_S);
            smalls = bursts.filter((x) => !isImage(x));
            console.log(`  gap threshold ${BURST_GAP_S.toFixed(2)}s chosen from the capture` +
                `  ->  ${images.length} frames against ${sends.length} sends`);
        }
    }

    if (images.length < sends.length) {
        const fixed = refine(bursts, sends.length);
        const got = fixed.filter(isImage);
        if (got.length > images.length) {
            const split = got.length - images.length;
            console.log(`  ${split} fused frame(s) recovered — ${images.length} -> ${got.length}`);
            if (split > sends.length * 0.1) {
                console.log(`\n  WARNING: most frames had to be reconstructed rather than read.`);
                console.log(`  Sizes below are only as good as that reconstruction, and a`);
                console.log(`  reconstruction that assumes a frame size cannot then be used as`);
                console.log(`  evidence about frame sizes. Re-run the probe with idle gaps`);
                console.log(`  between sends (current builds do this) before trusting them.\n`);
            }
            images.length = 0; images.push(...got);
        }
    }
    const ours = sends.map((e) => e.endedAt - e.startedAt);
    if (images.length < sends.length) {
        diagnose(`the report has ${sends.length} successful sends but the capture holds only ` +
            `${images.length} image bursts — ${sends.length - images.length} short.`);
    }
    // Correlation needs something to correlate. If every send took the same
    // time there is no signal to align on — and that is not a failure, it is
    // the single most interesting outcome this probe can have: it means the
    // encoding made no difference at all. Refusing to report it would hide
    // exactly the result the controls were added to find.
    {
        const med = (a) => { const t = [...a].sort((x, y) => x - y); return t[t.length >> 1] || 0; };
        let guard = 0;
        while (guard++ < sends.length) {
            const unit = med(images.map((b) => b.kb));
            const fat = images.find((b) => b.kb > unit * 1.6);
            if (!fat) break;
            const cut = splitOne(fat);
            if (!cut) break;
            images.splice(images.indexOf(fat), 1, ...cut);
        }
    }

    const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
    const mo = mean(ours);
    const cv = Math.sqrt(mean(ours.map((x) => (x - mo) ** 2))) / (mo || 1);

    let bestOffset = 0, bestR = -2;
    if (cv < 0.05) {
        if (images.length !== sends.length) {
            diagnose(`every send took the same time (spread ${(cv * 100).toFixed(1)}%), so there ` +
                `is nothing to align on, and the capture holds ${images.length} bursts against ` +
                `${sends.length} sends. Uniform timings are a real result — but they can only be ` +
                `attributed to variants when the counts match exactly.`);
        }
        bestOffset = 0; bestR = 1;
        console.log(`  every send took the same time (spread ${(cv * 100).toFixed(1)}%) — aligned by`);
        console.log(`  position, since counts match exactly. That uniformity is itself the finding.`);
    } else {
        for (let o = 0; o + sends.length <= images.length; o++) {
            const r = pearson(ours, images.slice(o, o + sends.length).map((b) => b.s * 1000));
            if (r > bestR) { bestR = r; bestOffset = o; }
        }
        if (bestR < 0.6) {
            diagnose(`no offset lines the capture up with the report — best correlation ` +
                `r=${bestR.toFixed(2)}, and anything below 0.6 is not a match.`);
        }
    }
    const window = images.slice(bestOffset, bestOffset + sends.length);
    groups = [];
    let k = 0;
    for (const v of expected) {
        const n = v.sends.filter((e) => e.ok !== false).length;
        groups.push(window.slice(k, k + n));
        k += n;
    }
    if (cv >= 0.05) {
        console.log(`  aligned at burst ${bestOffset + 1} of ${images.length}, r=${bestR.toFixed(2)}` +
            (bestOffset ? `   (${bestOffset} earlier burst(s) ignored)` : ""));
    }
} else {
    // No report: fall back to the delimiters, and say that it is a guess.
    const segs = [];
    for (const b of bursts) {
        if (b.bytes < IMAGE_MIN_B) segs.push([]);
        else if (segs.length) segs[segs.length - 1].push(b);
    }
    groups = segs.filter((g) => g.length);
    if (!groups.length) diagnose("no image bursts follow a small write, so nothing can be bracketed.");
    console.log(`  no report given — grouping by delimiter only, which any link keepalive`);
    console.log(`  can split. Pass the report JSON for a checked alignment.`);
}

// ------------------------------------------------------------------ the table

const name = (i) => (expected ? expected[i].name : `variant ${i + 1}`);
const median = (a) => { const s = [...a].sort((x, y) => x - y); return s[s.length >> 1] || 0; };

const rows = groups.map((g, i) => ({
    name: name(i),
    handed: handedKb.get(name(i)) ?? HANDED_KB,
    kb: median(g.map((b) => b.kb)),
    s: median(g.map((b) => b.s)),
    n: g.length,
    failed: g.filter((b) => !b.ok).length,
}));

const HANDED_KB = 16.2;   // fallback only
// Against what SHIPS, not against whatever ran first — the controls now lead
// the run, and anchoring on them made every column meaningless.
const base = rows.find((r) => /shipping/.test(r.name)) || rows.find((r) => !/CONTROL/.test(r.name)) || rows[0];

console.log(`\n  Wire cost per encoding — median of ${rows[0].n} sends each\n`);
console.log(`  ${"encoding".padEnd(28)}${"wire KB".padStart(9)}${"ratio".padStart(8)}` +
    `${"seconds".padStart(9)}${"KB/s".padStart(8)}${"vs shipping".padStart(13)}`);
for (const r of rows) {
    console.log(`  ${r.name.padEnd(28)}${r.kb.toFixed(2).padStart(9)}` +
        `${(HANDED_KB / r.kb).toFixed(1).padStart(7)}x${r.s.toFixed(2).padStart(9)}` +
        `${(r.kb / r.s).toFixed(1).padStart(8)}` +
        `${`${(r.s / base.s).toFixed(2)}x`.padStart(13)}` +
        (r.failed ? `   ${r.failed} FAILED` : ""));
}

// The question this exists to settle, and it is not the dither.
//
// `blank` is one flat level — the most compressible plane there is. `noise` is
// uniform random levels, as close to incompressible as this format allows. The
// SDK compresses with LZ4 from 0.0.12 and this app is pinned to 0.0.14, so if
// compression reaches the air those two cannot come back the same size.
const find = (re) => rows.filter((r) => re.test(r.name));
const blanks = find(/CONTROL blank/), noises = find(/CONTROL noise/);
if (blanks.length && noises.length) {
    const mb = blanks.reduce((t, r) => t + r.kb, 0) / blanks.length;
    const mn = noises.reduce((t, r) => t + r.kb, 0) / noises.length;
    console.log(`\n  IS ANYTHING COMPRESSED?\n`);
    console.log(`    blank (flat)      ${mb.toFixed(2)} KB`);
    console.log(`    noise (random)    ${mn.toFixed(2)} KB`);
    const ratio = mn / mb;
    if (ratio > 1.5) {
        console.log(`    noise is ${ratio.toFixed(1)}x the blank — COMPRESSION IS REAL on this path,`);
        console.log(`    so how compressible a frame is does decide what it costs.`);
    } else {
        console.log(`    within ${((ratio - 1) * 100).toFixed(0)}% of each other, against a handed-over ` +
            `${HANDED_KB} KB.`);
        console.log(`    A flat plane and pure noise cannot both be incompressible, so NOTHING`);
        console.log(`    on this path is being compressed — and every argument that a dither`);
        console.log(`    is a transport choice is void, including the ones in this repo.`);
    }
}

// WHICH MECHANISM? Three explanations fit "blank is small and nothing else is",
// and these controls tell them apart.
const row = (re) => rows.find((r) => re.test(r.name));
const blank1 = row(/blank \(first\)/), almost = row(/almost-blank/);
const halves = row(/halves/), ramp = row(/ramp/);
const b8 = row(/blank grey8/), n8 = row(/noise grey8/);
if (blank1 && (almost || halves || ramp)) {
    console.log(`\n  WHERE DOES COMPRESSION STOP?\n`);
    const show = (r, note) => r && console.log(
        `    ${r.name.padEnd(24)}${r.kb.toFixed(2).padStart(8)} KB   ${note}`);
    show(blank1, "one flat level");
    show(almost, "flat but for a single pixel");
    show(halves, "two flat regions");
    show(ramp,   "smooth gradient (lz4 offline: 6.06 KB)");
    if (almost) {
        const jumped = almost.kb > blank1.kb * 4;
        console.log(`\n    ${jumped
            ? "Changing ONE pixel sends it to full size. A uniform image is being\n" +
              "    special-cased, not compressed — so blank was never evidence that\n" +
              "    anything on this path compresses."
            : "One changed pixel barely moves it, so this is real compression\n" +
              "    responding to content, not a uniform-image shortcut."}`);
    }
}
if (b8 && n8) {
    console.log(`\n  DOES WHAT WE HAND OVER REACH THE AIR?\n`);
    // The control only means anything if it actually differed. A run went out
    // with both "grey8" variants encoded at 4 bits — the bit-depth override had
    // been applied to the wrong function — and this section cheerfully reported
    // that the host re-encodes our PNG, on the strength of a test that never
    // ran. Check the premise before reading the result.
    const ref4 = row(/noise \(first\)/);
    if (ref4 && Math.abs(n8.handed - ref4.handed) < 0.5) {
        console.log(`    NOT RUN: the grey8 variants were handed over at ` +
            `${n8.handed.toFixed(1)} KB, the same as the 4-bit ones.`);
        console.log(`    Nothing can be concluded from a control that did not differ.\n`);
    } else {
    console.log(`    blank grey8   handed ${b8.handed.toFixed(1)} KB  ->  wire ${b8.kb.toFixed(2)} KB`);
    console.log(`    noise grey8   handed ${n8.handed.toFixed(1)} KB  ->  wire ${n8.kb.toFixed(2)} KB`);
    const ref = row(/noise \(first\)/);
    if (ref) {
        const doubled = n8.kb > ref.kb * 1.5;
        console.log(`\n    ${doubled
            ? "Doubling the PNG doubled the wire, so the host forwards OUR bytes and\n" +
              "    the encoding we choose is what travels."
            : "Doubling the PNG left the wire unchanged, so the host DECODED our PNG\n" +
              "    and sent its own representation. Nothing we do to the file matters —\n" +
              "    only the picture inside it."}`);
        }
    }
}

// Drift, measured rather than assumed: the same control ran first and last.
for (const kind of ["blank", "noise"]) {
    const first = rows.find((r) => r.name.includes(kind) && r.name.includes("first"));
    const last = rows.find((r) => r.name.includes(kind) && r.name.includes("last"));
    if (first && last && first.s) {
        const drift = last.s / first.s;
        console.log(`\n  drift on ${kind}: ${first.s.toFixed(2)}s first, ${last.s.toFixed(2)}s last` +
            `  -> ${drift.toFixed(2)}x` +
            (Math.abs(drift - 1) > 0.15
                ? `   <- the link changed DURING the run; per-variant times are not comparable`
                : `   (steady, so the ordering is not doing the work)`));
    }
}

const dithers = rows.filter((r) => !/CONTROL/.test(r.name));
const ordered = dithers.filter((r) => /bayer/i.test(r.name));
const diffused = dithers.filter((r) => /atkinson|steinberg/i.test(r.name));
if (ordered.length && diffused.length) {
    const mo = ordered.reduce((t, r) => t + r.kb, 0) / ordered.length;
    const md = diffused.reduce((t, r) => t + r.kb, 0) / diffused.length;
    console.log(`\n  ordered mean ${mo.toFixed(2)} KB, error-diffused mean ${md.toFixed(2)} KB` +
        `  ->  ${(md / mo).toFixed(2)}x`);
    console.log(`  Offline deflate puts that at about 1.15x, and hardware timings once`);
    console.log(`  implied 2.4x; measured in bytes it is 1.26x. Read this only if the controls\n  above say compression is on.`);
}
console.log(`\n  "ratio" is how far the host compressed the fixed ${HANDED_KB} KB we handed it.\n`);
