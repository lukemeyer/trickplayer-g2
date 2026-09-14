// BLE link simulator for the glasses transport.
//
// There is no emulator for a pair of Even Realities glasses, and the Android
// emulator drives nothing here — the link is BLE from the phone to hardware
// that does not exist in software. What CAN be tested is the part that has
// actually broken: the queue, the retry policy, the de-duplication and the
// behaviour when the host throttles us.
//
// So this models the link instead — latency, failure rate, throws, disconnects
// and a background state where timers stretch — and drives the shipping
// `createBleTransport` against it. Virtual time, so a twenty-minute session
// runs in milliseconds and the results are deterministic.
//
//   node tools/ble-sim.mjs
//
import ts from "typescript";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "blesim-"));

async function load(name) {
    const src = fs.readFileSync(path.join(ROOT, "src", name), "utf8");
    const js = ts.transpileModule(src, {
        compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.ESNext },
    }).outputText;
    const out = path.join(TMP, name.replace(/\.ts$/, ".mjs"));
    fs.writeFileSync(out, js);
    return import(pathToFileURL(out).href);
}

// ------------------------------------------------------------------ link
//
// Time is REAL but scaled 1:100 — a 2,200 ms image write takes 22 ms here. The
// properties under test are ordering, de-duplication, supersession and bounds,
// none of which care about the absolute numbers, and real timers keep the
// harness honest about promise scheduling in a way a virtual clock did not.

const SCALE = 100;
const ms = (real) => Math.max(1, Math.round(real / SCALE));
const wait = (real) => new Promise((r) => setTimeout(r, ms(real)));

/**
 * The glasses, as far as the phone can tell.
 *
 * @param background the host is throttling us: writes take far longer. This is
 *   the state the app spends most of its life in, and the one that has produced
 *   every stuck-image report.
 */
function makeLink(opts = {}) {
    const cfg = {
        imageMs: 2200,          // measured: a ~16 KB image over BLE
        textMs: 120,
        failRate: 0,
        throwRate: 0,
        disconnectAfter: Infinity,
        background: false,
        backgroundFactor: 4,
        seed: 12345,
        ...opts,
    };
    let seed = cfg.seed;
    const rand = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
    let writes = 0;
    let connected = true;
    // The glasses hold two containers, declared once at startup. A dropped link
    // takes them with it, and nothing about a text write to a container that is
    // no longer there distinguishes itself from a text write to a busy link:
    // both come back false. That is the whole reason the reported failure was
    // invisible — "images started sending again, but no text".
    let container = true;
    return {
        get connected() { return connected; },
        get writes() { return writes; },
        get container() { return container; },
        setBackground(on) { cfg.background = on; },
        disconnect() { connected = false; },
        reconnect() { connected = true; },
        loseContainer() { container = false; },
        declareContainers() { container = true; },
        async write(kind) {
            writes++;
            if (writes >= cfg.disconnectAfter) connected = false;
            const base = kind === "image" ? cfg.imageMs : cfg.textMs;
            await wait(cfg.background ? base * cfg.backgroundFactor : base);
            if (!connected) return false;
            if (kind === "text" && !container) return false;
            if (rand() < cfg.throwRate) throw new Error("BLE write threw");
            return rand() >= cfg.failRate;
        },
    };
}

// ----------------------------------------------------------------- cases

const cases = [];
const def = (name, fn) => cases.push({ name, fn });

def("a clean link sends every scene exactly once", async ({ make }) => {
    const { t, link } = make();
    for (let i = 0; i < 20; i++) {
        t.sendImage((p) => link.write("image"), { i });
        t.sendText((x) => link.write("text"), `line ${i}`);
        await wait(3000);
    }
    await settle();
    return {
        pass: t.stats.imageOk === 20 && t.stats.textOk === 20 && t.stats.imageFail === 0,
        detail: `images ${t.stats.imageOk}ok/${t.stats.imageFail}fail, text ${t.stats.textOk}ok`,
    };
});

def("a write that THROWS settles its caller instead of hanging it", async ({ make }) => {
    const { t, link } = make({ throwRate: 1 });
    let settled = false;
    t.sendImage(() => link.write("image"), {}).then(() => { settled = true; });
    await settle();
    return { pass: settled, detail: settled ? "settled" : "CALLER LEFT AWAITING FOREVER" };
});

def("a rejected line is retried, not remembered as sent", async ({ make }) => {
    const { t, link } = make({ failRate: 1 });
    await t.sendText(() => link.write("text"), "hello");   // the link rejects it
    await settle();

    // The link recovers. The same line must reach it again — the glasses are
    // still showing the previous one.
    let attempted = false;
    const r = await t.sendText(async () => { attempted = true; return true; }, "hello");
    await settle();
    return {
        pass: attempted && r.ok === true,
        detail: attempted
            ? "re-sent after the failure"
            : "SUPPRESSED as a duplicate — the glasses keep the stale line",
    };
});

def("identical text is not re-sent once it has landed", async ({ make }) => {
    const { t, link } = make();
    t.sendText(() => link.write("text"), "same");
    await settle();
    const before = link.writes;
    await t.sendText(() => link.write("text"), "same");
    await settle();
    return { pass: link.writes === before, detail: `${link.writes - before} extra write(s)` };
});

def("pausing drops queued frames rather than transmitting them", async ({ make }) => {
    const { t, link } = make();
    const sent = [];
    for (let i = 0; i < 6; i++) t.sendImage(async () => { sent.push(i); return link.write("image"); }, { i });
    t.abandonQueued();                      // the user paused
    await settle();
    return {
        pass: sent.length <= 1,
        detail: `${sent.length} frame(s) reached the link after pause (want <= 1 in flight)`,
    };
});

def("a backlog keeps the newest frame, not the oldest", async ({ make }) => {
    const { t, link } = make({ imageMs: 5000 });
    const sent = [];
    for (let i = 0; i < 5; i++) t.sendImage(async () => { sent.push(i); return link.write("image"); }, { i });
    await settle();
    const newestSent = sent.includes(4);
    return {
        pass: newestSent && sent.length < 5,
        detail: `link saw [${sent}] — newest ${newestSent ? "sent" : "DROPPED"}, ${t.stats.imageDropped} dropped`,
    };
});

def("a flaky link recovers inside one queue slot", async ({ make }) => {
    // Fails twice then succeeds: the retry loop should absorb it.
    let n = 0;
    const { t, link } = make();
    const r = t.sendImage(async () => { await wait(500); return ++n >= 3; }, {});
    await settle();
    const res = await r;
    return { pass: res.ok && res.attempts === 3, detail: `ok after ${res.attempts} attempt(s)` };
});

def("a dead frame cannot starve the text channel", async ({ make }) => {
    const { t } = make();
    const started = Date.now();
    let textAt = null;
    // A frame that fails every attempt: the retry budget must cut it off.
    t.sendImage(async () => { await wait(3000); return false; }, {});
    t.sendText(async () => { textAt = Date.now() - started; return true; }, "after");
    await settle();
    const budget = ms(DEADLINE_MS);
    return {
        pass: textAt !== null && textAt <= budget,
        detail: textAt === null
            ? "text never sent — the image starved it"
            : `text sent ${textAt}ms in (budget ${budget}ms)`,
    };
});

def("BACKGROUND: throttled writes still drain without unbounded growth", async ({ make }) => {
    const { t, link } = make({ background: true, backgroundFactor: 6 });
    let maxDepth = 0;
    for (let i = 0; i < 30; i++) {
        t.sendImage(() => link.write("image"), { i });
        maxDepth = Math.max(maxDepth, t.depth);
        await wait(2000);            // pipeline produces faster than the link drains
    }
    await settle();
    // What matters is not the instantaneous depth — a superseded op resolves
    // the moment it reaches the head — but that the queue DRAINS and the link
    // is never asked to send more than it can.
    return {
        pass: t.depth === 0 && t.stats.imageOk > 0 && link.writes <= t.stats.imageOk + 2,
        detail: `peak depth ${maxDepth}, drained to ${t.depth}, ${t.stats.imageDropped} dropped, `
            + `${t.stats.imageOk} sent in ${link.writes} write(s)`,
    };
});

def("BACKGROUND: a disconnect mid-session does not wedge the queue", async ({ make }) => {
    const { t, link } = make({ background: true, disconnectAfter: 5 });
    for (let i = 0; i < 12; i++) { t.sendImage(() => link.write("image"), { i }); await wait(1500); }
    await settle();
    return {
        pass: t.depth === 0,
        detail: `queue drained to ${t.depth}, ${t.stats.imageFail} failed after disconnect`,
    };
});

def("reconnecting re-sends the text, because the screen was cleared", async ({ make }) => {
    const { t, link } = make();
    await (async () => { t.sendText(() => link.write("text"), "on screen"); await settle(); })();
    link.disconnect(); link.reconnect();
    t.forgetText();                          // what the app must do on reconnect
    const before = link.writes;
    t.sendText(() => link.write("text"), "on screen");
    await settle();
    return { pass: link.writes > before, detail: `${link.writes - before} write(s) after reconnect` };
});

/**
 * The app-side rule from `main.ts`: after two text failures in a row, with
 * images still landing, re-declare the containers.
 *
 * `repair: false` is the shipped behaviour — containers were declared exactly
 * once, at bridge init — so the two cases below can run the same scenario
 * against both and the difference is a measurement rather than a claim. The
 * repair lives in the app, not the transport, which is why it is modelled here
 * rather than being read out of `createBleTransport`.
 *
 * The image condition is the load-bearing half. Repeated text failures are also
 * exactly what a struggling link looks like, and adding a container write to a
 * queue that is already failing makes a bad session worse.
 */
function makeSubtitleSender(t, link, { repair = true } = {}) {
    let consecutiveTextFailures = 0;
    let imagesHealthy = true;
    let repairs = 0;
    return {
        get repairs() { return repairs; },
        imagesFailing(v) { imagesHealthy = !v; },
        async send(text) {
            const r = await t.sendText(() => link.write("text"), text);
            if (r.ok) { consecutiveTextFailures = 0; return r; }
            consecutiveTextFailures++;
            if (repair && consecutiveTextFailures >= 2 && imagesHealthy) {
                repairs++;
                link.declareContainers();
                t.forgetText();     // nothing we "sent" was ever drawn
                consecutiveTextFailures = 0;
            }
            return r;
        },
    };
}

/** The reported session: link drops, comes back, containers do not. */
async function afterAContainerLoss(t, link, opts) {
    const subs = makeSubtitleSender(t, link, opts);
    await subs.send("before the drop");
    await settle();
    link.disconnect(); link.reconnect(); link.loseContainer();

    let landed = 0;
    for (const line of ["line one", "line two", "line three", "line four"]) {
        const r = await subs.send(line);
        await settle();
        if (r.ok) landed++;
    }
    return { landed, repairs: subs.repairs };
}

def("a lost container is repaired, so text comes back with the images", async ({ make }) => {
    // Images resume on their own after a reconnect; text does not, because the
    // container it addresses is gone. Both runs see the identical link.
    const without = await afterAContainerLoss(make().t, make().link, { repair: false });
    const a = make();
    const withRepair = await afterAContainerLoss(a.t, a.link, { repair: true });

    return {
        pass: without.landed === 0 && withRepair.landed >= 2 && withRepair.repairs === 1,
        detail: `declared once: ${without.landed}/4 lines — text is dead for the rest of the session; ` +
                `re-declared on evidence: ${withRepair.landed}/4 after ${withRepair.repairs} repair(s)`,
    };
});

def("a bad link is not mistaken for a lost container", async ({ make }) => {
    // Same symptom, different cause: every write fails. Re-declaring containers
    // here fixes nothing and costs a write on a queue that is already losing.
    const { t, link } = make({ failRate: 1 });
    const subs = makeSubtitleSender(t, link);
    subs.imagesFailing(true);
    for (const line of ["a", "b", "c", "d", "e"]) { await subs.send(line); await settle(); }
    return {
        pass: subs.repairs === 0,
        detail: subs.repairs === 0
            ? "no repair attempted while images were failing too"
            : `${subs.repairs} pointless container write(s) onto a failing link`,
    };
});

def("a long session holds its failure rate without drifting", async ({ make }) => {
    const { t, link } = make({ failRate: 0.25, imageMs: 2200 });
    for (let i = 0; i < 200; i++) { t.sendImage(() => link.write("image"), { i }); await wait(8000); }
    await settle();
    const delivered = t.stats.imageOk / (t.stats.imageOk + t.stats.imageFail);
    return {
        pass: delivered > 0.95 && t.depth === 0,
        detail: `${(delivered * 100).toFixed(1)}% of frames delivered with a 25% per-write failure rate`,
    };
});

// ------------------------------------------------------------------ run

const DEADLINE_MS = 15_000;   // retry budget + one text write, generously

/**
 * The transport as `main.ts` shipped it, so the scenarios can be run against
 * BOTH and the difference is a measurement rather than a claim.
 *
 * Faithful to four things it actually did: hand back the tail of the queue
 * rather than the caller's own op, resolve from inside the callback (so a throw
 * strands the caller), record the de-duplication key before the write, and keep
 * every queued frame however stale.
 */
function createLegacyTransport() {
    let tail = Promise.resolve();
    let depth = 0;
    let lastText = null;
    const stats = { imageOk: 0, imageFail: 0, imageDropped: 0, textOk: 0, textFail: 0,
        attempts: 0, retries: 0, consecutiveImageFailures: 0, lastImageOkAt: 0 };

    const enqueue = (fn) => {
        depth++;
        tail = tail.then(() => fn()).catch(() => {}).finally(() => { depth--; });
        return tail;                       // the TAIL, not this op
    };

    return {
        enqueue,
        abandonQueued() { /* there was no such thing */ },
        forgetText() { lastText = null; },
        async sendImage(send, payload) {
            return new Promise((resolve) => {
                enqueue(async () => {
                    const started = Date.now();
                    let attempt = 0;
                    const tried = [];
                    while (attempt < 3) {
                        attempt++;
                        stats.attempts++;
                        // No try/catch: a throw escapes and `resolve` below is
                        // never reached.
                        const ok = (await send(payload)) !== false;
                        tried.push(ok ? "ok" : "fail");
                        if (ok) {
                            stats.imageOk++;
                            resolve({ ok: true, attempts: attempt, tried });
                            return;
                        }
                        if (Date.now() - started >= ms(5000)) break;
                        if (attempt < 3) await wait(350);
                    }
                    stats.imageFail++;
                    stats.consecutiveImageFailures++;
                    resolve({ ok: false, attempts: attempt, tried });
                });
            });
        },
        async sendText(send, text) {
            const wanted = text || " ";
            if (wanted === lastText) return { ok: true, reason: "duplicate" };
            lastText = wanted;             // recorded BEFORE the write
            return new Promise((resolve) => {
                enqueue(async () => {
                    const ok = (await send(wanted)) !== false;
                    if (ok) stats.textOk++; else stats.textFail++;
                    resolve({ ok });
                });
            });
        },
        get depth() { return depth; },
        get generation() { return 0; },
        stats,
    };
}
const { createBleTransport } = await load("bletransport.ts");

let failures = 0;
console.log("\n  BLE link simulation — modelled link, time scaled 1:100\n");
/**
 * Let every queued write finish.
 *
 * Waits for the queue to be EMPTY and stay empty — an earlier version treated
 * "depth unchanged" as quiet, which is exactly what a long write looks like,
 * and cut four scenarios off mid-flight.
 */
async function settle(maxMs = 8000) {
    const until = Date.now() + maxMs;
    let quiet = 0;
    while (Date.now() < until && quiet < 6) {
        await new Promise((r) => setTimeout(r, 4));
        quiet = (currentTransport?.depth ?? 0) === 0 ? quiet + 1 : 0;
    }
}
let currentTransport = null;

const MODES = [
    ["shipped today", createLegacyTransport],
    ["this branch  ", (o) => createBleTransport(o)],
];
const results = {};
for (const [label, factory] of MODES) {
  results[label] = [];
  for (const c of cases) {
    const make = (linkOpts) => {
        const link = makeLink(linkOpts);
        const t = factory({ sleep: wait, retryDelayMs: 350 });
        currentTransport = t;
        return { t, link };
    };
    let r;
    try {
        r = await c.fn({ make });
    } catch (e) {
        r = { pass: false, detail: `threw: ${e.message}` };
    }
    results[label].push(r);
  }
}

for (const c of cases) console.log();
console.log("  " + "scenario".padEnd(58) + MODES.map(([l]) => l).join("  "));
console.log("  " + "-".repeat(58 + 30));
cases.forEach((c, i) => {
    const cells = MODES.map(([l]) => (results[l][i].pass ? "  ok         " : "  FAIL       "));
    console.log("  " + c.name.slice(0, 56).padEnd(58) + cells.join(""));
});
const now = results["this branch  "];
failures = now.filter((r) => !r.pass).length;
const was = results["shipped today"].filter((r) => !r.pass).length;
console.log();
for (let i = 0; i < cases.length; i++) {
    if (!results["shipped today"][i].pass && now[i].pass) {
        console.log(`  fixed: ${cases[i].name}`);
        console.log(`         was: ${results["shipped today"][i].detail}`);
        console.log(`         now: ${now[i].detail}`);
    }
}
console.log(`\n  shipped today ${cases.length - was}/${cases.length}   this branch ${cases.length - failures}/${cases.length}\n`);
fs.rmSync(TMP, { recursive: true, force: true });
process.exit(failures ? 1 : 0);
