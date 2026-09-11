// @ts-nocheck
//
// The telemetry page: the production app, recording.
//
// It deliberately reuses `ui.ts` and `main.ts` unchanged rather than
// reimplementing a cut-down player. A measurement of a different code path
// would be a measurement of the wrong thing — the point is to characterise the
// link as the real app drives it, with the real scene pacing, the real payload
// sizes and the real retry policy.
//
// All this file adds is: attach the recorder, stamp the ambient state that
// every record has to be read against, and render the report at the end.

import { createRecorder, analyse, formatReport } from "./telemetry";

const $ = (id) => document.getElementById(id);
const KEY = "trickplayer.telemetry";
// Pick the previous session up rather than starting a new one: a sleep that
// discards the page is exactly what needs measuring, and a fresh recorder would
// drop it into the crack between two sessions.
let resumeFrom = null;
if (new URLSearchParams(location.search).has("discarded")) {
    // Arrived here from Discard. Clear again on the way IN as well as on the
    // way out, so a write that slipped through the unload handlers cannot
    // resurrect the session.
    try { localStorage.removeItem(KEY); } catch (e) {}
    // And strip the marker immediately. Left in the address bar it is a trap:
    // the phone reloads this page on its own, and every one of those reloads
    // would wipe the session that had been recorded since — which looks exactly
    // like telemetry that never records anything.
    const keep = new URLSearchParams(location.search);
    keep.delete("discarded");
    history.replaceState(
        null, "", location.pathname + (keep.toString() ? `?${keep}` : ""),
    );
} else {
    try {
        const prev = JSON.parse(localStorage.getItem(KEY) || "null");
        if (prev?.events?.length) resumeFrom = prev;
    } catch (e) { /* nothing recoverable */ }
}

const recorder = createRecorder({ resume: resumeFrom });
if (resumeFrom) {
    recorder.mark("page-reloaded", {
        // Android discarded the page rather than merely hiding it.
        discarded: document.wasDiscarded === true,
        priorMs: resumeFrom.durationMs,
    });
}

/**
 * Borrow the production page's markup rather than copying it.
 *
 * The flow — panels, ids, option controls — lives in index.html, and a second
 * copy here would drift the first time either changed, which is exactly how a
 * "diagnostic build" stops measuring the thing that ships. So the real page is
 * fetched, its body injected, and only then is the app imported: by the time
 * `ui.ts` and `main.ts` run, the DOM they expect is present.
 *
 * Dynamic import is what makes the ordering work — a static one is hoisted and
 * would run before any of this.
 */
async function mountProductionApp() {
    const html = await (await fetch(new URL("./index.html", location.href))).text();
    const body = html.slice(html.indexOf("<body>") + 6, html.indexOf("</body>"));
    // Drop the page's own script tags; this page loads the modules itself.
    $("tlm-app").innerHTML = body.replace(/<script[\s\S]*?<\/script>/g, "");
}

// ORDER MATTERS, and getting it wrong cost a session of "images never send":
// main.ts captures its DOM references at module scope, so it has to be imported
// AFTER the markup exists. Mount, then engine, then sink, then the app.
await mountProductionApp();
const engine = await import("./main");
engine.setEventSink((e) => recorder.event(e));

// The two states every number has to be read against. Foreground/background is
// the one the host changes underneath us, and it is where the complaints come
// from; the link's own account of itself explains the rest.
recorder.setContext({ foreground: !document.hidden });
document.addEventListener("visibilitychange", () => {
    const foreground = !document.hidden;
    recorder.setContext({ foreground });
    recorder.mark(foreground ? "foreground" : "background");
});

// The Page Lifecycle events, which are the ones that actually fire when a phone
// sleeps: `freeze` means timers are about to stop, `resume` that they started
// again. Without these a multi-minute outage has no label on either end.
for (const name of ["freeze", "resume", "pageshow", "pagehide"]) {
    window.addEventListener(name, (e) => {
        recorder.mark(name, name === "pageshow" ? { persisted: !!e.persisted } : {});
        if (name === "freeze" || name === "pagehide") persist();
    });
}

// The app's own idea of what it is doing, so "the page was alive and still sent
// nothing" can be told apart from "the app had stopped on purpose".
engine.setLifecycleObserver((what, detail) => recorder.mark(what, detail));

/**
 * Proof of life every 5s.
 *
 * This is what makes a frozen stream visible at all: operation records say
 * something happened, and the complaint is that nothing did. A span with no
 * ticks is a page that was not running; a span with ticks and no images while
 * the app believed it was playing is the pipeline stopping, which is ours.
 */
setInterval(() => recorder.tick(engine.playbackState()), 5000);
engine.setLinkObserver((link) => {
    recorder.setContext({ conn: link.connectType, wearing: link.isWearing });
    recorder.mark("link", link);
});

/**
 * Persist as we go.
 *
 * A session that ends because the WebView was killed is exactly the session
 * worth having, and it is the one an in-memory buffer loses. Written on a timer
 * rather than per event so recording does not become the thing being measured.
 */
/**
 * Set by Discard, and checked here rather than only at the call sites.
 *
 * Discarding reloads the page, and a reload fires `pagehide` and
 * `beforeunload` — both of which persist. So deleting the key and reloading
 * wrote the very session being discarded straight back, and it came back
 * looking like the button did nothing. Every write goes through this function,
 * so one guard here closes all of them.
 */
let discarded = false;

function persist() {
    if (discarded) return;
    try {
        localStorage.setItem(KEY, JSON.stringify(recorder.session(device())));
    } catch (e) {
        // Quota: the session is long enough already. Stop growing it rather
        // than throwing away what is there.
        console.warn("[telemetry] could not persist:", e.message);
    }
}
setInterval(persist, 15000);
window.addEventListener("beforeunload", persist);

function device() {
    return {
        device: {
            ua: navigator.userAgent.slice(0, 120),
            screen: `${screen.width}x${screen.height}`,
            memoryGb: navigator.deviceMemory ?? null,
        },
    };
}

// --- the panel ---------------------------------------------------------

function refresh() {
    const s = recorder.session();
    const images = s.events.filter((e) => e.kind === "image");
    const sent = images.filter((e) => e.ok).length;
    $("tlm-elapsed").textContent = `${(s.durationMs / 60000).toFixed(1)} min`;
    $("tlm-count").textContent = String(recorder.count);
    $("tlm-images").textContent = images.length
        ? `${sent} sent / ${images.length - sent} not`
        : "—";
    $("tlm-depth").textContent = String(engine.bleDepth());
}
setInterval(refresh, 1000);

let lastReport = "";

$("tlm-report").onclick = () => {
    const s = recorder.session(device());
    lastReport = formatReport(s);
    $("tlm-out").textContent = lastReport;
    // Also to the console, which is how it comes off a device that has no
    // clipboard the wearer can reach — `adb logcat`, or the simulator's
    // /api/console.
    console.log("\n" + lastReport + "\n");
};

async function copy(text, label) {
    try {
        await navigator.clipboard.writeText(text);
        $("tlm-hint").textContent = `${label} copied to the clipboard.`;
    } catch (e) {
        // A WebView may refuse the clipboard. Select it instead so a long-press
        // can copy, and say so rather than failing silently.
        $("tlm-out").textContent = text;
        const r = document.createRange();
        r.selectNodeContents($("tlm-out"));
        getSelection().removeAllRanges();
        getSelection().addRange(r);
        $("tlm-hint").textContent = `Clipboard unavailable — ${label} is selected, copy it by hand.`;
    }
}

$("tlm-copy").onclick = () => copy(lastReport || formatReport(recorder.session(device())), "Report");
$("tlm-json").onclick = () =>
    copy(JSON.stringify(recorder.session(device())), "Raw session JSON");

$("tlm-probe").onclick = async () => {
    const btn = $("tlm-probe");
    btn.disabled = true;
    $("tlm-hint").textContent = "Sweeping payload sizes over the link…";
    try {
        recorder.mark("probe-start");
        await engine.probeLink();
        recorder.mark("probe-end");
        $("tlm-hint").textContent = "Sweep done — generate the report.";
    } catch (e) {
        $("tlm-hint").textContent = `Sweep failed: ${e.message}`;
    } finally {
        btn.disabled = false;
        refresh();
    }
};

$("tlm-reset").onclick = () => {
    discarded = true;
    try { localStorage.removeItem(KEY); } catch (e) {}
    // Belt and braces: if anything still writes on the way out, the reload
    // lands on a page that will not resume from it either.
    //
    // KEEP the existing query string. Rebuilding the URL from pathname alone
    // dropped ?play=1, so discarding a session silently stopped playback and
    // looked like image sending had broken outright — the measurement tool
    // disabling the thing being measured.
    const q = new URLSearchParams(location.search);
    q.set("discarded", "1");
    location.replace(`${location.pathname}?${q}`);
};

refresh();

/**
 * `?play=1` starts the first playable item and leaves it running.
 *
 * The measurement worth having is a long unattended one: put the glasses on,
 * load this, come back in fifteen minutes. It is also the only way to exercise
 * the SCENE PIPELINE headlessly — the sweep talks to the transport directly and
 * would not have caught a pipeline that dies on its first frame, which is
 * exactly the bug that made this page look broken while the sweep looked fine.
 */
async function autoPlay() {
    const ui = await import("./ui");
    const item = await ui.firstPlayable();
    if (!item) { $("tlm-hint").textContent = "Nothing playable to measure."; return; }
    $("tlm-hint").textContent = `Playing "${item.title}" — leave it running.`;
    recorder.mark("autoplay", { title: item.title });
}

/**
 * `?probe=1` runs the sweep on load and prints the report to the console.
 *
 * For driving this from a harness rather than a fingertip: the EvenHub
 * simulator has no pointer into the webview, and neither does a phone sitting
 * on a desk being watched over adb. Everything the button does, without one.
 */
if (new URLSearchParams(location.search).has("play")) setTimeout(autoPlay, 2500);
if (new URLSearchParams(location.search).has("probe")) {
    setTimeout(() => $("tlm-probe").click(), 2500);
    setTimeout(() => $("tlm-report").click(), 90_000);
}

// Last, so the recorder and the link observer are attached before the app can
// send anything.
import("./ui").then(() => {
    $("tlm-hint").textContent =
        "Play something on the glasses for a few minutes, then generate the report. " +
        "Five minutes is enough to be useful; fifteen gives better tail estimates.";
    refresh();
}).catch((e) => {
    $("tlm-hint").textContent = `Could not load the app: ${e.message}`;
});
