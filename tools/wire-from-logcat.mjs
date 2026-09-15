// What actually went over the air, read out of an adb capture.
//
// The EvenHub host app logs every BLE write it makes, which is the layer BELOW
// `updateImageRawData` — where our telemetry stops. It is the only view of what
// the link really costs, and it needs no instrumentation on our side at all:
//
//     I/BleDevice: Send cmd: <MAC> is success = true,
//                  name=Even G2_32_R_06F9F7, type=0, data length=240
//
// Capture one while using the app, then run this over it:
//
//     adb logcat -c && adb logcat -v time > session.log     # ^C when done
//     node tools/wire-from-logcat.mjs session.log
//
// The WebView in the shipping host does not forward `console.log` to logcat
// (no `setWebContentsDebuggingEnabled`, and no devtools socket), so this is not
// a convenience — it is the only way to see the transport from outside.
import fs from "node:fs";

const file = process.argv[2];
if (!file) {
    console.error("usage: node tools/wire-from-logcat.mjs <logcat capture>");
    process.exit(2);
}

const BURST_GAP_S = 0.6;     // longer than any inter-write gap inside a frame
const IMAGE_MIN_B = 4096;    // anything smaller is a subtitle or a status write

const rows = [];
for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    const m = line.match(
        /(\d\d:\d\d:\d\d\.\d+).*name=Even G2_(\S+?)_([LR])_\w+, type=(\d+), data length=(\d+)/);
    if (!m) continue;
    const [h, mn, s] = m[1].split(":");
    rows.push({
        t: +h * 3600 + +mn * 60 + parseFloat(s),
        side: m[3], bytes: +m[5], ok: /success = true/.test(line),
    });
}
if (!rows.length) {
    console.error("no BLE writes found — is this a capture taken while the app was running?");
    process.exit(1);
}

const failed = rows.filter((r) => !r.ok).length;
const bySide = { L: rows.filter((r) => r.side === "L"), R: rows.filter((r) => r.side === "R") };

console.log(`\n  ${rows.length} BLE writes, ${failed} failed` +
    `   left lens ${bySide.L.length}, right lens ${bySide.R.length}`);
// The lenses are separate peripherals. Display traffic going to one of them is
// worth seeing rather than assuming: a frame that reaches only one eye is a
// different bug from a frame that fails.
if (bySide.L.length && bySide.R.length &&
    Math.min(bySide.L.length, bySide.R.length) * 20 < Math.max(bySide.L.length, bySide.R.length)) {
    const quiet = bySide.L.length < bySide.R.length ? "left" : "right";
    console.log(`  (essentially all of it goes to one lens; the ${quiet} sees only small` +
        ` periodic writes — a keepalive, not picture data)`);
}

const busy = bySide.R.length >= bySide.L.length ? bySide.R : bySide.L;
const bursts = [];
for (const r of busy) {
    const last = bursts[bursts.length - 1];
    if (!last || r.t - last[last.length - 1].t > BURST_GAP_S) bursts.push([r]);
    else last.push(r);
}

const candidates = bursts
    .map((b) => ({ kb: b.reduce((t, r) => t + r.bytes, 0) / 1024, s: b[b.length - 1].t - b[0].t, n: b.length }))
    .filter((b) => b.kb * 1024 >= IMAGE_MIN_B && b.s > 0);

// Frames sent back to back arrive with no gap between them, so a burst can hold
// two or three. Left in, one of those triples sets the maximum and the spread
// reads as 250% when the real per-frame variation is a third of that. Keep the
// bursts within a factor of two of the median, which is one frame by
// construction — the pipeline sends one at a time far more often than not.
const sorted = [...candidates].map((c) => c.kb).sort((a, b) => a - b);
const median = sorted[sorted.length >> 1] || 0;
const images = candidates.filter((c) => c.kb >= median * 0.4 && c.kb <= median * 1.8);
const merged = candidates.length - images.length;

if (images.length < 3) {
    console.log("\n  Not enough image-sized bursts to say anything. Capture a longer session.\n");
    process.exit(0);
}

const kbs = images.map((i) => i.kb), secs = images.map((i) => i.s);
const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
const mk = mean(kbs), ms_ = mean(secs);
const cov = kbs.reduce((t, k, i) => t + (k - mk) * (secs[i] - ms_), 0);
const vk = kbs.reduce((t, k) => t + (k - mk) ** 2, 0);
const vs = secs.reduce((t, x) => t + (x - ms_) ** 2, 0);

console.log(`\n  ${images.length} image transfers` +
    (merged ? `   (${merged} multi-frame burst(s) set aside)` : ""));
console.log(`    wire payload   ${Math.min(...kbs).toFixed(1)} - ${Math.max(...kbs).toFixed(1)} KB` +
    `   (mean ${mk.toFixed(1)})`);
console.log(`    time on air    ${Math.min(...secs).toFixed(2)} - ${Math.max(...secs).toFixed(2)} s` +
    `   (mean ${ms_.toFixed(2)})`);
console.log(`    throughput     ${(mk / ms_).toFixed(1)} KB/s`);
console.log(`    bytes vs time  r=${(cov / Math.sqrt(vk * vs)).toFixed(2)}` +
    `   ${Math.round((cov / vk) * 1000)} ms per KB`);

// The conclusion the spread licenses. The logical frame is a fixed 16,384 bytes
// of 4-bit greyscale, so if what reaches the air varies, something between here
// and there is compressing it — and then the CONTENT of a frame decides how
// long it takes, which makes the dither a transport choice.
const spread = (Math.max(...kbs) - Math.min(...kbs)) / mk;
console.log(spread > 0.15
    ? `\n  The logical frame is a fixed 16,384 B, and the wire payload varies by ` +
      `${(spread * 100).toFixed(0)}%.\n  So it is being COMPRESSED, and how compressible a frame is decides ` +
      `how long it\n  takes to send. See tools/wire-size.mjs for what the dither is worth.\n`
    : `\n  The wire payload barely varies, so compression is not in play here and ` +
      `the\n  frame costs what its size says it costs.\n`);
