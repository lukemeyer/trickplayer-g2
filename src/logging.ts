// @ts-nocheck
//
// Debugging tools, attachable to a RUNNING app.
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
//
// TWO SEPARATE THINGS live here, and both are off until someone asks:
//
//   Message log     a copy of the console, so a phone can read it
//   Capture report  the link recorder, its probes, and the report
//
// They used to be one switch that turned itself on the moment the panel was
// opened. Most people who open this are looking, not measuring, and recording
// a stranger's whole session to answer "what does this button do" is not a
// reasonable default. Each is now a deliberate start, remembered across
// launches so that the session spanning a crash is still captured.

import { createRecorder, analyse, formatReport, isResumable } from "./telemetry";
import * as store from "./store";
import { consoleText, setMessageLogging, isMessageLogging } from "./consolemirror";

const $ = (id) => document.getElementById(id);
const KEY = "trickplayer.telemetry";
// Both read by `ui.ts` STRAIGHT FROM THE STORE at boot rather than through this
// module, so a launch with neither switched on never loads any of this.
export const MESSAGES_KEY = "trickplayer.logMessages";
export const REPORT_KEY = "trickplayer.reportSession";

/**
 * A report session stops itself after this long.
 *
 * Chosen from what the real ones look like: hardware sessions in this project
 * have run two to eight minutes, and the longest deliberate test — the locked
 * sweep — is about five. Half an hour is several times any of them, and past
 * that the report is not more informative, only longer: percentiles stop
 * moving and the interesting minute is buried. The real case this guards is
 * someone starting a session, getting distracted, and carrying an unbounded
 * recording around for a day.
 *
 * It is one constant on purpose. If a soak test ever needs longer, raise it
 * here rather than removing the cap.
 */
const MAX_SESSION_MS = 30 * 60 * 1000;

/**
 * The panel, as markup.
 *
 * Here rather than in a page, because two entry points render it and a second
 * copy would drift the first time either changed.
 */
const PANEL = `
<dialog class="settings-dialog" id="tlm-panel">
  <div class="dialog-card">
    <div class="dialog-head">
      <h2>Debugging tools</h2>
      <button class="icon-btn" id="tlm-close" aria-label="Close debugging tools" title="Close">✕</button>
    </div>
    <p class="text-muted">No logs are ever sent unless you copy and send them manually.</p>
    <p class="text-muted tlm-status" id="tlm-hint"></p>

    <h3>Message log</h3>
    <p class="text-muted">A copy of everything the app logs.</p>
    <div class="form-row tlm-row">
      <button class="btn-secondary btn-inline" id="tlm-messages-toggle">▶ Start logging</button>
      <button class="btn-secondary btn-inline tlm-end hidden" id="tlm-copy-console">📋 Copy messages</button>
    </div>
    <div id="tlm-messages-body" class="hidden">
      <p class="text-muted tlm-relaunch">To log from app startup, relaunch the app.</p>
      <pre id="tlm-console" class="tlm-out tlm-console"></pre>
    </div>

    <h3>Capture report</h3>
    <p class="text-muted">Records what goes over the link, so a report can explain it. Stops on its own after 30 minutes.</p>
    <div class="form-row tlm-row">
      <button class="btn-secondary btn-inline" id="tlm-report-toggle">▶ Start capture</button>
    </div>
    <div id="tlm-report-body" class="hidden">
      <p class="text-muted tlm-relaunch">To record from app startup, relaunch the app.</p>

      <div class="tlm-stats">
        <div class="tlm-stat"><span class="tlm-stat-label">Session</span><span class="tlm-stat-value" id="tlm-elapsed">0:00</span></div>
        <div class="tlm-stat"><span class="tlm-stat-label">Operations</span><span class="tlm-stat-value" id="tlm-count">0</span></div>
        <div class="tlm-stat"><span class="tlm-stat-label">Images</span><span class="tlm-stat-value" id="tlm-images">0</span></div>
        <div class="tlm-stat"><span class="tlm-stat-label">Failed images</span><span class="tlm-stat-value" id="tlm-failed">0</span></div>
        <div class="tlm-stat"><span class="tlm-stat-label">Queue</span><span class="tlm-stat-value" id="tlm-depth">0</span></div>
        <div class="tlm-stat"><span class="tlm-stat-label">Storage</span><span class="tlm-stat-value" id="tlm-store">—</span></div>
      </div>

      <h3>Tests</h3>
      <div class="form-row tlm-row tlm-testrow">
        <select id="tlm-test" aria-label="Test to run"></select>
        <button class="btn-secondary btn-inline" id="tlm-run">Run test</button>
      </div>

      <h3>Report</h3>
      <div class="form-row tlm-row">
        <button class="btn-secondary btn-inline" id="tlm-report">📄 Generate</button>
        <button class="btn-secondary btn-inline" id="tlm-copy">📋 Copy</button>
        <button class="btn-secondary btn-inline" id="tlm-json">{ } Copy JSON</button>
      </div>
      <pre id="tlm-out" class="tlm-out hidden"></pre>
    </div>

    <!-- Below the line, because it reaches across both of the above. -->
    <hr class="tlm-divider" />
    <div class="form-row tlm-row">
      <button class="btn-danger btn-inline" id="tlm-reset">🗑 Delete logs</button>
    </div>
  </div>
</dialog>`;

let recorder = null;
let wired = false;        // engine sinks attached
let running = false;      // a report session is recording
let discarded = false;
let lastReport = "";
let engineRef = null;
let mounted = false;
let sessionDeadline = 0;

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

// ------------------------------------------------------------------- tests
//
// One at a time, chosen from a list rather than offered as a wall of buttons.
// Several of these send twenty-odd writes down a serial link, and two of them
// running at once measures neither: the second one queues behind the first and
// reports the wait as the link being slow.

const TESTS = [
    {
        id: "formats",
        label: "Which image formats work? (~20s)",
        needsPaused: "Pause playback first — this sends nine frames of its own.",
        busy: "Trying each image encoding on the glasses…",
        async run(engine) {
            recorder.mark("format-probe-start");
            const rs = await engine.probeFormats();
            recorder.mark("format-probe-end");
            return rs.map((r) => r.error
                ? `${r.format}: could not encode (${r.error})`
                : `${r.format} ${r.kb}KB: ${r.ok}/${r.of} accepted` +
                  (r.ok ? ` @ ${Math.round(r.writeMs)}ms` : ` (${r.reason || "no reason"})`)
            ).join("  ·  ");
        },
    },
    {
        id: "probe",
        label: "Sweep payload sizes (~1 min)",
        // Started during playback the sweep does not corrupt the measurement so
        // much as sit in front of everything the player wants to send — a
        // session reported "text only started appearing after about a minute",
        // and that minute was this.
        needsPaused: "Pause playback first — the sweep would queue in front of it for a minute.",
        busy: "Sweeping payload sizes over the link…",
        async run(engine) {
            recorder.mark("probe-start");
            await engine.probeLink();
            recorder.mark("probe-end");
            return "Sweep done — generate the report.";
        },
    },
    {
        id: "lockprobe",
        label: "Sweep with the phone LOCKED (~5 min)",
        busy: "Locked sweep starting…",
        // Nobody can watch a panel on a locked phone, so it counts down, runs
        // on its own, and leaves the report ready to copy on unlocking.
        async run(engine) {
            for (let n = 20; n > 0; n--) {
                setHint(`Lock the phone now — sweep starts in ${n}s. ` +
                    `Keep the glasses on; unlock in about 5 minutes.`);
                await new Promise((r) => setTimeout(r, 1000));
            }
            recorder.mark("locked-sweep-start");
            await engine.probeLockedLink();
            recorder.mark("locked-sweep-end");
            persist();
            generateReport();
            return "Locked sweep done — the report is below. Copy it.";
        },
    },
    {
        id: "prep",
        // Deliberately usable with nothing connected. The prepare tail was the
        // largest unexplained number in a hardware session, and needing a
        // paired link to measure it made it the hardest one to reproduce.
        label: "Time the prepare path (no glasses needed)",
        busy: "Preparing synthetic frames…",
        async run(engine) {
            recorder.mark("prep-probe-start");
            const r = await engine.probePrepare();
            recorder.mark("prep-probe-end");
            return `${r.runs} frames: p50 ${r.p50}ms, p90 ${r.p90}ms, max ${r.max}ms ` +
                `(${(r.sourceBytes / 1024).toFixed(1)}KB in, ${(r.outBytes / 1024).toFixed(1)}KB out). ` +
                `Decoders ${r.decodeMaxDelta === null ? "n/a" : r.decodeMaxDelta === 0
                    ? "agree exactly" : `DIFFER by up to ${r.decodeMaxDelta}/255`}. ` +
                `Our ${r.pngBitDepth}-bit PNG ${r.pngReadsBack === null ? "unchecked"
                    : r.pngReadsBack === 0 ? "reads back exactly"
                    : `READS BACK WRONG (${r.pngReadsBack})`}. ` +
                `Generate the report for the per-phase split.`;
        },
    },
];

/** Which tests have been run this session, and which one is going now. */
const testsRun = new Set();
let runningTest = null;

function renderTests() {
    const sel = $("tlm-test");
    if (!sel) return;
    const keep = sel.value;
    sel.innerHTML = "";
    for (const t of TESTS) {
        const opt = document.createElement("option");
        opt.value = t.id;
        // The state belongs on the option, because the whole point of the list
        // is knowing what you have already done without re-reading the hint.
        const state = runningTest === t.id ? " — running…" : testsRun.has(t.id) ? " — ran" : "";
        opt.textContent = `${t.label}${state}`;
        sel.appendChild(opt);
    }
    if (keep) sel.value = keep;
    const run = $("tlm-run");
    if (run) {
        run.disabled = runningTest !== null;
        run.textContent = runningTest ? "Running…" : "Run test";
    }
}

/**
 * Run one test by name.
 *
 * Exported because the telemetry PAGE drives these from the address bar, and
 * it used to do it by clicking buttons that no longer exist. A named call
 * survives the panel being rearranged; `$("tlm-probe").click()` did not.
 */
export function runTest(id) {
    const sel = $("tlm-test");
    if (sel) sel.value = id;
    return runSelectedTest(id);
}

/** Generate the report now — also for the page's harness flags. */
export function generateReportNow() {
    generateReport();
    return lastReport;
}

/** Whatever the panel is currently saying. */
export function hintText() {
    return $("tlm-hint")?.textContent || "";
}

/** True while a test is still going, so a harness can wait for it. */
export function isTestRunning() {
    return runningTest !== null;
}

async function runSelectedTest(forceId) {
    if (runningTest || !recorder) return;
    const t = TESTS.find((x) => x.id === (forceId ?? $("tlm-test").value));
    if (!t) return;
    if (t.needsPaused && engineRef.playbackState?.()?.playing) {
        setHint(t.needsPaused);
        return;
    }
    runningTest = t.id;
    renderTests();
    setHint(t.busy);
    try {
        setHint(await t.run(engineRef));
        testsRun.add(t.id);
    } catch (e) {
        setHint(`${t.label} failed: ${e.message}`);
    } finally {
        runningTest = null;
        renderTests();
        refresh();
    }
}

// ------------------------------------------------------------------ panel

function setHint(text) {
    const el = $("tlm-hint");
    if (el) el.textContent = text;
}

function clock(ms) {
    const total = Math.max(0, Math.round(ms / 1000));
    return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

/**
 * What the storage card says, short enough for a card and long enough to act
 * on somewhere else.
 *
 * The card has room for one word, and one word cannot carry "this recording
 * will be gone when the app relaunches". So the colour and the word go on the
 * card, and the sentence goes to the message log — which is the thing that
 * gets copied when someone asks for help.
 */
function storageState() {
    if (!store.isReady()) {
        return { word: "Loading…", tone: "warn", full: "Storage is still hydrating." };
    }
    if (store.isHostBacked()) {
        return { word: "Kept", tone: "ok", full: "Storage is kept by the host — it survives a relaunch." };
    }
    return {
        word: "Browser", tone: "bad",
        full: "Storage is browser-only — in a packaged app this recording is forgotten on relaunch.",
    };
}

let lastStorageFull = null;

function refresh() {
    if (!mounted) return;
    renderConsole();

    const logging = isMessageLogging();
    setHidden("tlm-messages-body", !logging);
    setHidden("tlm-copy-console", !logging);
    $("tlm-messages-toggle").textContent = logging ? "■ Stop logging" : "▶ Start logging";

    setHidden("tlm-report-body", !running);
    $("tlm-report-toggle").textContent = running ? "■ Stop capture" : "▶ Start capture";
    if (!running || !recorder) return;

    const s = recorder.session();
    const images = s.events.filter((e) => e.kind === "image");
    const sent = images.filter((e) => e.ok).length;
    $("tlm-elapsed").textContent = clock(s.durationMs);
    $("tlm-count").textContent = String(recorder.count);
    $("tlm-images").textContent = String(sent);
    $("tlm-failed").textContent = String(images.length - sent);
    $("tlm-depth").textContent = String(engineRef.bleDepth());

    // Polled rather than set once: the store hydrates asynchronously during
    // boot, so reading it the moment the flow loads always says "not loaded".
    const st = storageState();
    const el = $("tlm-store");
    el.textContent = st.word;
    el.className = `tlm-stat-value tlm-${st.tone}`;
    // Said once per change, into the log that gets copied. A colour on a card
    // is not something anyone can paste into a bug report.
    if (st.full !== lastStorageFull) {
        lastStorageFull = st.full;
        console.log(`[telemetry] ${st.full}`);
        recorder.setContext({ storage: st.word });
    }
}

function setHidden(id, hidden) {
    const el = $(id);
    if (el) el.classList.toggle("hidden", hidden);
}

/**
 * Draw the mirrored console.
 *
 * Only redraws when the text has actually changed: this runs on the same
 * one-second tick as the rest of the panel, and rewriting a 400-line block
 * every second would fight the user for the scroll position.
 */
let lastConsoleText = null;
function renderConsole() {
    const el = $("tlm-console");
    if (!el || !isMessageLogging()) return;
    const text = consoleText();
    if (text === lastConsoleText) return;
    lastConsoleText = text;
    // Measured BEFORE the content is replaced — writing textContent resets the
    // scroll, so asking afterwards always answers "at the top".
    const wasAtBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
    el.textContent = text || "Nothing logged yet.";
    // Newest last, so follow the tail — unless the reader has scrolled up to
    // look at something, in which case leave them where they are.
    if (wasAtBottom) el.scrollTop = el.scrollHeight;
}

async function copy(text, label) {
    try {
        await navigator.clipboard.writeText(text);
        setHint(`${label} copied to the clipboard.`);
    } catch (e) {
        // No clipboard permission, or no clipboard at all. Select it instead so
        // it can be copied by hand — a report nobody can get off the device is
        // not a report.
        const out = $("tlm-out");
        out.textContent = text;
        setHidden("tlm-out", false);
        const r = document.createRange();
        r.selectNodeContents(out);
        getSelection().removeAllRanges();
        getSelection().addRange(r);
        setHint(`Clipboard unavailable — ${label} is selected, copy it by hand.`);
    }
}

function generateReport() {
    if (!recorder) return;
    lastReport = formatReport(recorder.session(device()));
    $("tlm-out").textContent = lastReport;
    setHidden("tlm-out", false);
    // Also to the console, which is how it comes off a device that has no
    // clipboard the wearer can reach — `adb logcat`, or the simulator's
    // /api/console.
    console.log("\n" + lastReport + "\n");
}

// -------------------------------------------------------- the two switches

/** Turn the message log on or off, and remember which. */
function toggleMessages() {
    const on = !isMessageLogging();
    setMessageLogging(on);
    store.setItem(MESSAGES_KEY, on ? "1" : "0");
    lastConsoleText = null;
    // The relaunch caveat is already printed under the switch; saying it
    // twice on one screen reads as two different instructions.
    setHint(on ? "Logging messages." : "Message log stopped and cleared.");
    refresh();
}

/**
 * Start recording the link.
 *
 * @param opts.resume pick up a previous session from storage (the default).
 */
export async function startReportSession(engine, { resume = true, announce = true } = {}) {
    if (running) return recorder;
    engineRef = engine;
    running = true;
    discarded = false;
    sessionDeadline = Date.now() + MAX_SESSION_MS;
    store.setItem(REPORT_KEY, "1");

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

    wireEngine(engine);
    if (announce) {
        setHint("Recording. Play something for a few minutes, then generate the report.");
    }
    refresh();
    return recorder;
}

/**
 * Stop recording.
 *
 * The session is LEFT in storage — stopping is not discarding, and the report
 * is still there to generate and copy afterwards.
 */
export function stopReportSession(reason = "") {
    if (!running) return;
    persist();
    running = false;
    store.setItem(REPORT_KEY, "0");
    if (engineRef) {
        engineRef.setEventSink(null);
        engineRef.setWorkObserver(null);
        engineRef.setLifecycleObserver(null);
        engineRef.setLinkObserver(null);
    }
    setHint(reason || "Capture stopped. The recording is kept — generate the report to read it.");
    refresh();
    console.log(`[telemetry] capture stopped${reason ? `: ${reason}` : ""}`);
}

/**
 * Wire the engine's sinks, once per launch.
 *
 * Every sink reads the VARIABLE, not the recorder it was installed with, so
 * Discard can swap in a fresh one without re-wiring the engine — and without
 * the reload that swapping used to require.
 */
function wireEngine(engine) {
    engine.setEventSink((e) => running && recorder.event(e));
    engine.setWorkObserver((e) => running && recorder.event(e));
    engine.setLifecycleObserver((what, detail) => running && recorder.mark(what, detail));
    engine.setLinkObserver((link) => {
        if (!running) return;
        recorder.setContext({ conn: link.connectType, wearing: link.isWearing });
        recorder.mark("link", link);
    });
    if (wired) return;
    wired = true;

    // The two states every number has to be read against. Foreground/background
    // is the one the host changes underneath us, and it is where the complaints
    // come from; the link's own account of itself explains the rest.
    recorder.setContext({ foreground: !document.hidden });
    document.addEventListener("visibilitychange", () => {
        if (!running) return;
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
            if (!running) return;
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
     *
     * With the timer's LATENESS, measured rather than inferred. The host keeps
     * the WebView "visible" while the phone is asleep — a session spent almost
     * entirely with the screen off recorded every write as foreground — so
     * `document.hidden` cannot say when Android started throttling us. A
     * five-second heartbeat that arrives sixty seconds late can.
     */
    let lastTickAt = Date.now();
    setInterval(() => {
        if (!running) return;
        const at = Date.now();
        const lagMs = Math.max(0, at - lastTickAt - 5000);
        lastTickAt = at;
        recorder.tick({ ...engine.playbackState(), lagMs });
        // The cap. Checked on the heartbeat rather than by its own timer,
        // because a timer that has been throttled for an hour fires late — and
        // late is exactly the case this exists for.
        if (Date.now() >= sessionDeadline) {
            stopReportSession(`Stopped automatically after ${MAX_SESSION_MS / 60000} minutes.`);
        }
    }, 5000);
    setInterval(persist, 15000);
    window.addEventListener("beforeunload", persist);
}

// ------------------------------------------------------------ entry points

/** Open the panel. Starts nothing — that is what the two buttons are for. */
export function openDebugPanel(engine) {
    engineRef = engine;
    mountPanel(engine);
    showPanel();
    // The opening line has to describe what is ACTUALLY on. A session restored
    // from the last launch is already recording by the time anyone opens this,
    // and greeting them with "nothing is being recorded" is the panel lying
    // about the one thing it exists to report.
    const on = [
        isMessageLogging() ? "logging messages" : null,
        running ? "capturing a report" : null,
    ].filter(Boolean);
    setHint(on.length ? `Currently ${on.join(" and ")}.` : "");
    refresh();
}

/**
 * Put back whatever was switched on last launch.
 *
 * Called at boot by the flow, and only when the store says one of the two is
 * on — a launch with neither never imports this module at all.
 */
export async function restoreFromPreferences(engine) {
    engineRef = engine;
    if (store.getItem(MESSAGES_KEY) === "1") setMessageLogging(true);
    if (store.getItem(REPORT_KEY) === "1") {
        await startReportSession(engine, { announce: false });
    }
}

function showPanel() {
    const p = $("tlm-panel");
    if (p && typeof p.showModal === "function") {
        if (!p.open) p.showModal();
    } else if (p) {
        p.classList.remove("hidden");
    }
}

function hidePanel() {
    const p = $("tlm-panel");
    if (p && typeof p.close === "function") {
        if (p.open) p.close();
    } else if (p) {
        p.classList.add("hidden");
    }
}

function mountPanel(engine) {
    if (mounted) return;
    if (!$("tlm-panel")) {
        const holder = document.createElement("div");
        holder.innerHTML = PANEL;
        document.body.appendChild(holder.firstElementChild);
    }
    mounted = true;

    $("tlm-close").onclick = hidePanel;
    $("tlm-panel").onclick = (e) => {
        if (e.target === $("tlm-panel")) hidePanel();
    };

    $("tlm-messages-toggle").onclick = toggleMessages;
    $("tlm-report-toggle").onclick = () => {
        if (running) stopReportSession();
        else startReportSession(engine).catch((e) => setHint(`Could not start: ${e.message}`));
    };

    renderTests();
    $("tlm-run").onclick = () => runSelectedTest();

    $("tlm-report").onclick = generateReport;
    $("tlm-copy").onclick = () =>
        copy(lastReport || formatReport(recorder.session(device())), "Report");
    $("tlm-json").onclick = () =>
        copy(JSON.stringify(recorder.session(device())), "Raw session JSON");
    // The point of the mirror: a tester can get the messages OFF the phone
    // and into a bug report without attaching it to a laptop.
    $("tlm-copy-console").onclick = () => copy(consoleText(), "Messages");

    $("tlm-reset").onclick = () => {
        // EVERYTHING this panel has accumulated, both halves of it — the stored
        // report session and the captured messages. It sits below the divider
        // because it is not part of either section; it empties both.
        //
        // In place. This used to reload with a marker in the query string, and
        // on the glasses a reload ends the app: the containers went with it and
        // the picture never came back. Nothing needs reloading — the sinks read
        // a variable, so a fresh recorder is a new session.
        discarded = true;
        store.clearBulk(KEY);
        recorder = createRecorder();
        recorder.setContext({ foreground: !document.hidden });
        recorder.mark("logs-deleted");
        discarded = false;

        // The message buffer too. Off-then-on clears it and leaves capture
        // running exactly as it was, so deleting does not silently stop it.
        if (isMessageLogging()) {
            setMessageLogging(false);
            setMessageLogging(true);
        }
        lastConsoleText = null;
        lastStorageFull = null;

        lastReport = "";
        $("tlm-out").textContent = "";
        setHidden("tlm-out", true);
        testsRun.clear();
        sessionDeadline = Date.now() + MAX_SESSION_MS;
        renderTests();
        setHint("Logs deleted.");
        refresh();
    };

    setInterval(refresh, 1000);
}
