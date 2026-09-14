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
const recorder = enableLogging(engine);

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
