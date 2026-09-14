// @ts-nocheck
//
// The link recorder, attachable to a RUNNING app.
//
// It used to be a separate page, and reaching it meant `location.href = ...`.
// On the glasses that is not a navigation, it is the end of the app: the G2
// prompts "End this feature", tears down the startup containers, and the image
// container never comes back — every subsequent write is refused instantly
// while text carries on, which is exactly the session a beta sent back (0 sent,
// 20 failed, every write 0ms). Discard did the same thing for the same reason.
//
// So nothing here navigates. The panel is injected into the live document and
// the recorder is attached to the engine that is already running. The app never
// unloads, so the host never has cause to end it.
//
// What is recorded is still the real app: the real scene pacing, the real
// payload sizes, the real retry policy. A measurement of a cut-down player
// would be a measurement of the wrong thing.

import { createRecorder, analyse, formatReport } from "./telemetry";
import * as store from "./store";

const $ = (id) => document.getElementById(id);
const KEY = "trickplayer.telemetry";

/**
 * The panel, as markup.
 *
 * Here rather than in a page, because two entry points render it and a second
 * copy would drift the first time either changed.
 */
const PANEL = `
<div class="section" id="tlm-panel">
  <h2>Link telemetry</h2>
  <p class="text-muted" id="tlm-hint">Recording. Play something for a few minutes, then generate the report.</p>
  <div class="control-row"><span>Session</span><span id="tlm-elapsed">—</span></div>
  <div class="control-row"><span>Operations recorded</span><span id="tlm-count">0</span></div>
  <div class="control-row"><span>Images</span><span id="tlm-images">—</span></div>
  <div class="control-row"><span>Queue depth</span><span id="tlm-depth">0</span></div>
  <div class="control-row"><span>Saved state</span><span id="tlm-store">—</span></div>
  <button class="btn-secondary" id="tlm-probe">Sweep payload sizes (~1 min)</button>
  <button class="btn-secondary" id="tlm-prep">Time the prepare path (no glasses needed)</button>
  <button class="btn-secondary" id="tlm-report">Generate report</button>
  <button class="btn-secondary" id="tlm-copy">Copy report</button>
  <button class="btn-secondary" id="tlm-json">Copy raw JSON</button>
  <button class="btn-danger" id="tlm-reset">Discard session</button>
  <button class="btn-link" id="tlm-hide">Hide this panel</button>
  <pre id="tlm-out" class="tlm-out"></pre>
</div>`;

let recorder = null;
let started = false;
let discarded = false;
let lastReport = "";

function device() {
    return {
        device: {
            ua: navigator.userAgent.slice(0, 120),
            screen: `${screen.width}x${screen.height}`,
            memoryGb: navigator.deviceMemory ?? null,
        },
    };
}

/**
 * Persist as we go.
 *
 * A session that ends because the WebView was killed is exactly the session
 * worth having, and it is the one an in-memory buffer loses. On a timer rather
 * than per event, so recording does not become the thing being measured.
 *
 * The `discarded` guard is load-bearing: a discard used to reload, a reload
 * fires `pagehide`, and `pagehide` persisted the very session being thrown
 * away. Nothing reloads now, but the guard stays — every write goes through
 * here, so one check closes all of them.
 */
function persist() {
    if (discarded || !recorder) return;
    try {
        localStorage.setItem(KEY, JSON.stringify(recorder.session(device())));
    } catch (e) {
        // Quota: the session is long enough already. Stop growing it rather
        // than throwing away what is there.
        console.warn("[telemetry] could not persist:", e.message);
    }
}

function refresh(engine) {
    if (!recorder || !$("tlm-elapsed")) return;
    const s = recorder.session();
    const images = s.events.filter((e) => e.kind === "image");
    const sent = images.filter((e) => e.ok).length;
    $("tlm-elapsed").textContent = `${(s.durationMs / 60000).toFixed(1)} min`;
    $("tlm-count").textContent = String(recorder.count);
    $("tlm-images").textContent = images.length
        ? `${sent} sent / ${images.length - sent} not`
        : "—";
    $("tlm-depth").textContent = String(engine.bleDepth());
    // Polled rather than set once: the store hydrates asynchronously during
    // boot, so reading it the moment the flow loads always says "not loaded".
    $("tlm-store").textContent = !store.isReady()
        ? "loading…"
        : store.isHostBacked()
            ? "kept by the host — survives a relaunch"
            : "browser only — forgotten in a packaged app";
}

async function copy(text, label) {
    try {
        await navigator.clipboard.writeText(text);
        $("tlm-hint").textContent = `${label} copied to the clipboard.`;
    } catch (e) {
        // No clipboard permission, or no clipboard at all. Select it instead so
        // it can be copied by hand — a report nobody can get off the device is
        // not a report.
        $("tlm-out").textContent = text;
        const r = document.createRange();
        r.selectNodeContents($("tlm-out"));
        getSelection().removeAllRanges();
        getSelection().addRange(r);
        $("tlm-hint").textContent = `Clipboard unavailable — ${label} is selected, copy it by hand.`;
    }
}

/**
 * Start recording, in place.
 *
 * @param engine the already-imported `main.ts`. Passed in rather than imported
 *   so this works both for the app that is running and for the telemetry page,
 *   which imports the engine itself for ordering reasons.
 * @param opts.resume pick up a previous session from storage (the default).
 */
export function enableLogging(engine, { resume = true } = {}) {
    if (started) { showPanel(); return recorder; }
    started = true;

    let resumeFrom = null;
    if (resume) {
        try {
            const prev = JSON.parse(localStorage.getItem(KEY) || "null");
            if (prev?.events?.length) resumeFrom = prev;
        } catch (e) { /* nothing recoverable */ }
    }

    recorder = createRecorder({ resume: resumeFrom });
    if (resumeFrom) {
        recorder.mark("page-reloaded", {
            // Android discarded the page rather than merely hiding it.
            discarded: document.wasDiscarded === true,
            priorMs: resumeFrom.durationMs,
        });
    }

    // Every sink reads the VARIABLE, not the recorder it was installed with, so
    // Discard can swap in a fresh one without re-wiring the engine — and
    // without the reload that swapping used to require.
    engine.setEventSink((e) => recorder.event(e));
    engine.setWorkObserver((e) => recorder.event(e));
    engine.setLifecycleObserver((what, detail) => recorder.mark(what, detail));
    engine.setLinkObserver((link) => {
        recorder.setContext({ conn: link.connectType, wearing: link.isWearing });
        recorder.mark("link", link);
    });

    // The two states every number has to be read against. Foreground/background
    // is the one the host changes underneath us, and it is where the complaints
    // come from; the link's own account of itself explains the rest.
    recorder.setContext({ foreground: !document.hidden });
    document.addEventListener("visibilitychange", () => {
        const foreground = !document.hidden;
        recorder.setContext({ foreground });
        recorder.mark(foreground ? "foreground" : "background");
    });

    // The Page Lifecycle events, which are the ones that actually fire when a
    // phone sleeps: `freeze` means timers are about to stop, `resume` that they
    // started again. Without these a multi-minute outage has no label on either
    // end.
    for (const name of ["freeze", "resume", "pageshow", "pagehide"]) {
        window.addEventListener(name, (e) => {
            recorder.mark(name, name === "pageshow" ? { persisted: !!e.persisted } : {});
            if (name === "freeze" || name === "pagehide") persist();
        });
    }

    /**
     * Proof of life every 5s.
     *
     * This is what makes a frozen stream visible at all: operation records say
     * something happened, and the complaint is that nothing did. A span with no
     * ticks is a page that was not running; a span with ticks and no images
     * while the app believed it was playing is the pipeline stopping.
     */
    setInterval(() => recorder.tick(engine.playbackState()), 5000);
    setInterval(persist, 15000);
    window.addEventListener("beforeunload", persist);

    mountPanel(engine);
    return recorder;
}

function showPanel() {
    const p = $("tlm-panel");
    if (p) p.classList.remove("hidden");
}

function mountPanel(engine) {
    if (!$("tlm-panel")) {
        const holder = document.createElement("div");
        holder.innerHTML = PANEL;
        document.body.insertBefore(holder.firstElementChild, document.body.firstChild);
    }
    showPanel();

    setInterval(() => refresh(engine), 1000);

    $("tlm-report").onclick = () => {
        const s = recorder.session(device());
        lastReport = formatReport(s);
        $("tlm-out").textContent = lastReport;
        // Also to the console, which is how it comes off a device that has no
        // clipboard the wearer can reach — `adb logcat`, or the simulator's
        // /api/console.
        console.log("\n" + lastReport + "\n");
    };
    $("tlm-copy").onclick = () =>
        copy(lastReport || formatReport(recorder.session(device())), "Report");
    $("tlm-json").onclick = () =>
        copy(JSON.stringify(recorder.session(device())), "Raw session JSON");
    $("tlm-hide").onclick = () => $("tlm-panel").classList.add("hidden");

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
            refresh(engine);
        }
    };

    $("tlm-prep").onclick = async () => {
        // Deliberately usable with nothing connected. The prepare tail was the
        // largest unexplained number in a hardware session, and needing a
        // paired link to measure it made it the hardest one to reproduce.
        const btn = $("tlm-prep");
        btn.disabled = true;
        $("tlm-hint").textContent = "Preparing synthetic frames…";
        try {
            recorder.mark("prep-probe-start");
            const r = await engine.probePrepare();
            recorder.mark("prep-probe-end");
            $("tlm-hint").textContent =
                `${r.runs} frames: p50 ${r.p50}ms, p90 ${r.p90}ms, max ${r.max}ms ` +
                `(${(r.sourceBytes / 1024).toFixed(1)}KB in, ${(r.outBytes / 1024).toFixed(1)}KB out). ` +
                `Decoders ${r.decodeMaxDelta === null ? "n/a" : r.decodeMaxDelta === 0
                    ? "agree exactly" : `DIFFER by up to ${r.decodeMaxDelta}/255`}. ` +
                `Our ${r.pngBitDepth}-bit PNG ${r.pngReadsBack === null ? "unchecked"
                    : r.pngReadsBack === 0 ? "reads back exactly"
                    : `READS BACK WRONG (${r.pngReadsBack})`}. ` +
                `Generate the report for the per-phase split.`;
        } catch (e) {
            $("tlm-hint").textContent = `Prepare probe failed: ${e.message}`;
        } finally {
            btn.disabled = false;
            refresh(engine);
        }
    };

    $("tlm-reset").onclick = () => {
        // In place. This used to reload with a marker in the query string, and
        // on the glasses a reload ends the app: the containers went with it and
        // the picture never came back. Nothing needs reloading — the sinks read
        // a variable, so a fresh recorder is a new session.
        discarded = true;
        try { localStorage.removeItem(KEY); } catch (e) {}
        recorder = createRecorder();
        recorder.setContext({ foreground: !document.hidden });
        recorder.mark("session-discarded");
        discarded = false;
        lastReport = "";
        $("tlm-out").textContent = "";
        $("tlm-hint").textContent = "Session discarded. Recording a fresh one.";
        refresh(engine);
    };
}
