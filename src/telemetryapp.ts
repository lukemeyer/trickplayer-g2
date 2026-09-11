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
const recorder = createRecorder();

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
    return import("./ui");
}

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
function persist() {
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
    try { localStorage.removeItem(KEY); } catch (e) {}
    location.reload();
};

// A session recovered from a previous run is worth more than this one, which
// has not happened yet — offer it rather than silently overwriting it.
try {
    const prev = JSON.parse(localStorage.getItem(KEY) || "null");
    if (prev?.events?.length) {
        $("tlm-out").textContent =
            `A previous session of ${prev.events.length} operations was recovered.\n` +
            `It is still here until you discard it.\n\n` + formatReport(prev);
    }
} catch (e) { /* nothing recoverable */ }

refresh();

/**
 * `?probe=1` runs the sweep on load and prints the report to the console.
 *
 * For driving this from a harness rather than a fingertip: the EvenHub
 * simulator has no pointer into the webview, and neither does a phone sitting
 * on a desk being watched over adb. Everything the button does, without one.
 */
if (new URLSearchParams(location.search).has("probe")) {
    setTimeout(() => $("tlm-probe").click(), 2500);
    setTimeout(() => $("tlm-report").click(), 90_000);
}

// Last, so the recorder and the link observer are attached before the app has
// a chance to send anything.
mountProductionApp().then(() => {
    $("tlm-hint").textContent =
        "Play something on the glasses for a few minutes, then generate the report. " +
        "Five minutes is enough to be useful; fifteen gives better tail estimates.";
    refresh();
}).catch((e) => {
    $("tlm-hint").textContent = `Could not load the app: ${e.message}`;
});
