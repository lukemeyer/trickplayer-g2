// @ts-nocheck
//
// The telemetry PAGE — the browser entry point.
//
// It exists for testing from a desktop or a phone browser, where a URL is the
// natural way to reach something. In the packaged app the recorder is reached
// by a button instead and nothing navigates, because on the glasses a
// navigation ends the app (see src/logging.ts).
//
// All this file does is get the production markup and the engine in place, then
// hand off to the same module the in-app button uses. The harness flags below
// are its real remaining job: the simulator has no pointer into the webview, so
// everything a finger would do has to be reachable from the address bar.

import { enableLogging } from "./logging";

const $ = (id) => document.getElementById(id);

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
// AFTER the markup exists. Mount, then engine, then the recorder, then the app.
await mountProductionApp();
const engine = await import("./main");
// `?fresh=1` starts a new session instead of resuming the stored one. A harness
// run that resumes whatever the last run left behind cannot attribute a single
// number in its own report.
const recorder = await enableLogging(engine, { resume: !flags0().has("fresh") });
function flags0() { return new URLSearchParams(location.search); }

/** `?play=1` starts the first playable item and leaves it running. */
async function autoPlay() {
    const ui = await import("./ui");
    const item = await ui.firstPlayable();
    if (!item) { $("tlm-hint").textContent = "Nothing playable to measure."; return; }
    $("tlm-hint").textContent = `Playing "${item.title}" — leave it running.`;
    recorder.mark("autoplay", { title: item.title });
}

/**
 * The harness flags. For driving this from a script rather than a fingertip:
 * the EvenHub simulator has no pointer into the webview, and neither does a
 * phone sitting on a desk being watched over adb.
 */
const flags = new URLSearchParams(location.search);
if (flags.has("play")) setTimeout(autoPlay, 2500);

/**
 * `?stuck=1` reproduces a measured freeze: the host pauses playback and never
 * sends us back. What should happen is the watchdog noticing that the page is
 * visible while playback is wanted, and resuming without being told.
 */
if (flags.has("stuck")) {
    setTimeout(() => { engine.simulateHostPause(); }, 20000);
}

/**
 * `?notext=1` reproduces the other half: images come back and text does not,
 * because a dropped link took the container with it and nothing re-declares it.
 */
if (flags.has("notext")) {
    setTimeout(() => { engine.simulateContainerLoss(); }, 25000);
}

/**
 * `?noimage=1` reproduces the hardware that rejected our frames: image writes
 * answer `sendFailed` until the encoding ladder reaches a format it accepts.
 * Run with `&probe=1` to drive it from the sweep.
 */
/** `?wedgetest=1` runs the full prove -> wedge -> recover sequence, then reports. */
if (flags.has("wedgetest")) {
    setTimeout(async () => {
        await engine.reproduceImageWedge();
        $("tlm-report").click();
    }, 4000);
}

/** `?stubborntest=1`: a wedge rebuilds cannot clear, which lifts by itself. */
if (flags.has("stubborntest")) {
    setTimeout(async () => {
        await engine.reproduceStubbornWedge();
        $("tlm-report").click();
    }, 4000);
}

/** `?locksweep=1` presses the locked-sweep button — for checking the flow, not locking. */
if (flags.has("locksweep")) {
    setTimeout(() => $("tlm-lockprobe").click(), 3000);
}

if (flags.has("noimage")) {
    engine.simulateImageRejection(flags.get("noimage") || "rgba");
}

if (flags.has("formats")) {
    setTimeout(() => $("tlm-formats").click(), 2500);
}

/**
 * `?noimage=1` reproduces the ten-minute wedge: every image `sendFailed` for good
 * while text keeps landing, until the page is successfully rebuilt.
 */
if (flags.has("noimage")) {
    setTimeout(() => { engine.simulateImageWedge(); }, 25000);
}

if (flags.has("probe")) {
    setTimeout(() => $("tlm-probe").click(), 2500);
    setTimeout(() => $("tlm-report").click(), 90_000);
}

/**
 * `?prep=1` times the prepare path and prints the phase split to the console.
 * Needs no link, so unlike every other flag here it is fully meaningful in the
 * simulator.
 */
if (flags.has("prep")) {
    setTimeout(async () => {
        $("tlm-prep").click();
        while ($("tlm-prep").disabled) await new Promise((r) => setTimeout(r, 100));
        console.log("[prep-probe]", $("tlm-hint").textContent);
    }, 2500);
}

/**
 * `?quality=lighter|lightest` prepares frames at that picture level and puts
 * the last one on the glasses — to look at what the ladder sends, not guess.
 */
if (flags.get("quality")) {
    setTimeout(async () => {
        const q = engine.forcePictureQuality(flags.get("quality"));
        const r = await engine.probePrepare({ runs: 4, sendLast: true });
        console.log(`[quality-probe] ${q}: ${(r.outBytes / 1024).toFixed(1)}KB prepared, p50 ${r.p50}ms`);
    }, 3000);
}

// Last, so the recorder is attached before the app can send anything.
import("./ui").then(() => {
    // The markup came across with the "Connect with logging" buttons in it, and
    // here the recorder is already on. Nothing to go to.
    for (const btn of document.querySelectorAll("[data-logging]")) {
        btn.remove();
    }
}).catch((e) => {
    $("tlm-hint").textContent = `Could not load the app: ${e.message}`;
});
