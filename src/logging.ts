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

import { createRecorder, analyse, formatReport, isResumable } from "./telemetry";
import * as store from "./store";

const $ = (id) => document.getElementById(id);
const KEY = "trickplayer.telemetry";
// Read by `ui.ts` STRAIGHT FROM THE STORE at boot rather than through this
// module, so that a launch which is not logging never loads the recorder.
const LOGGING_KEY = "trickplayer.logging";

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
  <button class="btn-secondary" id="tlm-formats">Which image formats work? (~20s)</button>
  <button class="btn-secondary" id="tlm-probe">Sweep payload sizes (~1 min)</button>
  <button class="btn-secondary" id="tlm-prep">Time the prepare path (no glasses needed)</button>
  <button class="btn-secondary" id="tlm-report">Generate report</button>
  <button class="btn-secondary" id="tlm-copy">Copy report</button>
  <button class="btn-secondary" id="tlm-json">Copy raw JSON</button>
  <button class="btn-danger" id="tlm-reset">Discard session</button>
  <button class="btn-link" id="tlm-hide">Hide this panel (keep recording)</button>
  <button class="btn-link" id="tlm-stop">Stop logging</button>
  <pre id="tlm-out" class="tlm-out"></pre>
</div>`;

let recorder = null;
let started = false;
let running = false;
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
/**
 * How much of a session is worth carrying across a relaunch.
 *
 * The ring buffer holds 20,000 events, which at roughly 200 bytes each is
 * megabytes — too much to push through the host bridge every fifteen seconds.
 * The newest events are the ones that explain what just went wrong, and MARKS
 * are kept whole regardless: they are small, and they are what turns a silence
 * into a measurable gap. Dropping them would lose the outage while keeping the
 * writes either side of it.
 */
const PERSIST_MAX_EVENTS = 4000;

/**
 * And a cap on marks, because a session now OUTLIVES the launch.
 *
 * A heartbeat every five seconds is 720 marks an hour, and the session
 * accumulates across every relaunch until it is discarded — so without a
 * ceiling the thing being written through the bridge every fifteen seconds
 * grows without bound. 4,000 is about five hours of heartbeat, which is longer
 * than any session anyone is going to sit through, and the newest are kept
 * because they are the ones next to whatever just went wrong.
 */
const PERSIST_MAX_MARKS = 4000;

function persistable() {
    const s = recorder.session(device());
    if (s.events.length > PERSIST_MAX_EVENTS) {
        s.events = s.events.slice(-PERSIST_MAX_EVENTS);
        s.truncated = true;
    }
    if (s.marks.length > PERSIST_MAX_MARKS) {
        s.marks = s.marks.slice(-PERSIST_MAX_MARKS);
        s.truncated = true;
    }
    return s;
}

function persist() {
    if (discarded || !recorder || !running) return;
    // Through the STORE, not localStorage. A packaged app discards its own
    // browser storage on relaunch — the same thing that used to lose the Plex
    // sign-in — so a tester who hit a disconnect lost the recording of the
    // disconnect, which is the only part anyone wanted.
    store.writeBulk(KEY, JSON.stringify(persistable())).catch((e) =>
        console.warn("[telemetry] could not persist:", e?.message || e));
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
export async function enableLogging(engine, { resume = true } = {}) {
    if (started) { showPanel(); return recorder; }
    started = true;
    running = true;

    // Remembered, so the next launch records without being asked. A tester who
    // turned logging on wants the session that spans the crash, and a crash is
    // precisely when nobody is there to press the button again.
    store.setItem(LOGGING_KEY, "1");

    let resumeFrom = null;
    if (resume) {
        try {
            const prev = JSON.parse((await store.readBulk(KEY)) || "null");
            if (isResumable(prev)) resumeFrom = prev;
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
    // With the timer's LATENESS, measured rather than inferred. The host keeps
    // the WebView "visible" while the phone is asleep — a session spent almost
    // entirely with the screen off recorded every write as foreground — so
    // `document.hidden` cannot say when Android started throttling us. A
    // five-second heartbeat that arrives sixty seconds late can.
    let lastTickAt = Date.now();
    setInterval(() => {
        if (!running) return;
        const at = Date.now();
        const lagMs = Math.max(0, at - lastTickAt - 5000);
        lastTickAt = at;
        recorder.tick({ ...engine.playbackState(), lagMs });
    }, 5000);
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

    $("tlm-stop").onclick = () => {
        // Otherwise it is on for ever: enabling it now outlives the launch, so
        // there has to be something that undoes that. The session is left in
        // storage — stopping is not discarding, and the report is still there
        // to copy next time.
        persist();
        running = false;
        store.removeItem(LOGGING_KEY);
        engine.setEventSink(null);
        engine.setWorkObserver(null);
        engine.setLifecycleObserver(null);
        engine.setLinkObserver(null);
        $("tlm-panel").classList.add("hidden");
        console.log("[telemetry] logging stopped; it will not resume on the next launch");
    };

    $("tlm-formats").onclick = async () => {
        // The fastest useful thing on this panel. A session where every
        // synthetic payload landed and every real frame failed could not say
        // which of three differences was responsible; this answers it outright.
        const btn = $("tlm-formats");
        if (engine.playbackState?.()?.playing) {
            $("tlm-hint").textContent = "Pause playback first — this sends nine frames of its own.";
            return;
        }
        btn.disabled = true;
        $("tlm-hint").textContent = "Trying each image encoding on the glasses…";
        try {
            recorder.mark("format-probe-start");
            const rs = await engine.probeFormats();
            recorder.mark("format-probe-end");
            $("tlm-hint").textContent = rs.map((r) => r.error
                ? `${r.format}: could not encode (${r.error})`
                : `${r.format} ${r.kb}KB: ${r.ok}/${r.of} accepted` +
                  (r.ok ? ` @ ${Math.round(r.writeMs)}ms` : ` (${r.reason || "no reason"})`)
            ).join("  ·  ");
        } catch (e) {
            $("tlm-hint").textContent = `Format probe failed: ${e.message}`;
        } finally {
            btn.disabled = false;
            refresh(engine);
        }
    };

    $("tlm-probe").onclick = async () => {
        const btn = $("tlm-probe");
        // The sweep is twenty image writes and twenty text writes on a serial
        // link, which is the better part of a minute. Started during playback
        // it does not corrupt the measurement so much as sit in front of
        // everything the player wants to send — a session reported "text only
        // started appearing after about a minute", and that minute was this.
        if (engine.playbackState?.()?.playing) {
            $("tlm-hint").textContent =
                "Pause playback first — the sweep would queue in front of it for a minute.";
            return;
        }
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
        store.clearBulk(KEY);
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
