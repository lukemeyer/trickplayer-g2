// @ts-nocheck
//
// A copy of the console, kept in memory so a phone can read it.
//
// Every diagnostic this app writes goes to `console`, and on a phone that is
// nowhere: there is no devtools window behind a pair of glasses, and the one
// status message that says "see the console" was asking for something the
// reader could not do. A beta tester's only route was to plug the phone into a
// laptop, which is not a thing anyone does mid-session.
//
// So the lines are kept, and the telemetry panel renders them.
//
// Installed as early as the app has any module at all, because the messages
// worth reading are the ones from boot — the bridge failing to wire up happens
// seconds before anyone thinks to turn logging on, and a recorder that only
// starts when asked would have missed exactly the thing it was opened for.

/** Enough to cover a launch and a few minutes; older lines fall off the front. */
const MAX_LINES = 400;

const lines = [];
const listeners = new Set();
let installed = false;

/** The real console, kept so the mirror cannot call itself. */
const original = {};

// The glasses' serial number identifies a specific piece of hardware owned by
// a specific person, and these lines are written to be copied to a clipboard
// and pasted into a bug report. We never read `sn` ourselves — but the SDK and
// the host log objects we did not choose, and this is the last point before
// those become a shareable block of text. Redacted here rather than trusted
// not to appear.
const SECRET_KEYS = /^(sn|serial|serialnumber|serialno|devicesn|deviceserial|imei|mac|macaddress)$/i;
const SECRET_IN_TEXT =
    /("?\b(?:sn|serial(?:_?number)?|deviceSn|imei|mac(?:_?address)?)"?\s*[:=]\s*)"?([A-Za-z0-9][A-Za-z0-9:_-]{3,})"?/gi;

// A MAC needs no label to be a MAC, and it identifies the hardware just as
// well as a serial does.
const BARE_MAC = /\b(?:[0-9a-f]{2}:){5}[0-9a-f]{2}\b/gi;

function redactText(s) {
    return s
        .replace(SECRET_IN_TEXT, (_m, label) => `${label}[redacted]`)
        .replace(BARE_MAC, "[redacted]");
}

function stringify(arg) {
    if (typeof arg === "string") return redactText(arg);
    if (arg instanceof Error) return redactText(String(arg.message));
    try {
        const s = JSON.stringify(arg, (key, value) =>
            SECRET_KEYS.test(key) ? "[redacted]" : value);
        // `undefined` stringifies to undefined, not to a string.
        return s === undefined ? redactText(String(arg)) : redactText(s);
    } catch (e) {
        // Circular, or a host object that refuses to be serialised.
        return redactText(String(arg));
    }
}

function record(level, args) {
    const at = new Date();
    const clock = `${String(at.getHours()).padStart(2, "0")}:` +
        `${String(at.getMinutes()).padStart(2, "0")}:` +
        `${String(at.getSeconds()).padStart(2, "0")}`;
    // `console.error("failed: " + err.message, err)` is the house style, and
    // rendering both parts prints the message twice. Drop a part that the line
    // already says.
    const parts = [];
    for (const arg of args) {
        const piece = stringify(arg);
        if (!piece) continue;
        if (parts.some((p) => p.includes(piece))) continue;
        parts.push(piece);
    }
    const text = parts.join(" ");
    lines.push({ level, clock, text });
    while (lines.length > MAX_LINES) lines.shift();
    for (const fn of listeners) {
        // A listener that throws must not break logging, and must not stop the
        // real console being written to either.
        try { fn(); } catch (e) { /* ignore */ }
    }
}

/**
 * Start copying the console. Safe to call more than once.
 *
 * The original is always called, so this changes what is KEPT and never what
 * is printed — a laptop attached to the phone still sees exactly what it did.
 */
export function installConsoleMirror() {
    if (installed || typeof console === "undefined") return;
    installed = true;
    for (const level of ["log", "info", "warn", "error"]) {
        const fn = console[level];
        if (typeof fn !== "function") continue;
        original[level] = fn;
        console[level] = function (...args) {
            try { record(level, args); } catch (e) { /* never break the console */ }
            return original[level].apply(console, args);
        };
    }
}

/** Everything kept so far, oldest first. */
export function consoleLines() {
    return lines.slice();
}

/** As one block of text, which is what a phone can put on a clipboard. */
export function consoleText() {
    return lines
        .map((l) => `${l.clock} ${l.level === "log" ? "" : l.level.toUpperCase() + " "}${l.text}`)
        .join("\n");
}

/** Called whenever a line arrives. Returns an unsubscribe. */
export function onConsoleLine(fn) {
    listeners.add(fn);
    return () => listeners.delete(fn);
}

/**
 * Whether lines are being KEPT.
 *
 * Capture starts at import and the flow decides a moment later, once the store
 * has hydrated. That window exists because the messages worth having are the
 * ones from boot — the bridge failing to wire up happens seconds before anyone
 * could have chosen anything — and the preference lives in the host store,
 * which is not readable that early. So the buffer fills for about a second and
 * is then either kept or thrown away.
 */
let keeping = true;

export function isMessageLogging() {
    return installed && keeping;
}

/**
 * Keep recording, or stop and forget what was recorded.
 *
 * Off is not "stop writing new lines": it restores the real console and drops
 * everything already held, so a launch where nobody asked for this leaves
 * nothing behind to be copied anywhere.
 */
export function setMessageLogging(on) {
    keeping = !!on;
    if (keeping) {
        installConsoleMirror();
        return;
    }
    lines.length = 0;
    if (!installed) return;
    for (const level of Object.keys(original)) console[level] = original[level];
    installed = false;
}

// Installed on IMPORT, not by a call from the flow. `import` declarations are
// hoisted above every statement in the importing module, so a call there would
// run after the engine had already been evaluated — and the ordering is the
// whole point. Import this module first and it is recording before anything
// else exists.
installConsoleMirror();
