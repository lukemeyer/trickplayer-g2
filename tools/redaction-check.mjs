// Does the message log keep hardware identifiers out of what it hands over?
//
// The mirrored console exists to be COPIED — to a clipboard, into a bug report,
// to whoever is helping. That makes it the last point at which a device serial
// can quietly become someone else's problem. We never read `sn` ourselves, but
// the SDK and the host log objects we did not choose, so the guarantee has to
// live in the mirror rather than in a promise that nothing upstream will ever
// log the wrong thing.
//
// Run: npm run redaction-check

import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const out = join(mkdtempSync(join(tmpdir(), "redaction-")), "consolemirror.mjs");
execFileSync("npx", ["esbuild", "src/consolemirror.ts", "--bundle", "--format=esm",
    `--outfile=${out}`], { stdio: "pipe" });
const cm = await import(out);

// Quietened UNDER the mirror, not over it: importing the module already
// wrapped the console, so assigning no-ops on top would replace the wrapper
// and nothing would be recorded at all. Unwrap, silence, then wrap again.
const realLog = console.log, realWarn = console.warn, realError = console.error;
cm.setMessageLogging(false);
console.log = console.warn = console.error = () => {};
cm.setMessageLogging(true);

const SECRET = "G2ABC123456789";
const MAC = "aa:bb:cc:dd:ee:ff";

// Every shape we have actually seen, plus the ones the SDK's own types say are
// possible. `DeviceStatus` carries `sn`; `DeviceInfo` carries `sn` and `model`.
console.log("status", { sn: SECRET, connectType: "ble", batteryLevel: 88 });
console.log(`sn=${SECRET} connected`);
console.warn(`serial: ${SECRET}`);
console.error("deviceInfo", { device: { serialNumber: SECRET, model: "g2" } });
console.log(`address ${MAC}`);
console.log({ nested: { deep: { deviceSn: SECRET } } });
console.log(new Error(`link lost for sn=${SECRET}`));

const kept = cm.consoleText();
console.log = realLog; console.warn = realWarn; console.error = realError;

const leaks = [];
if (kept.includes(SECRET)) leaks.push(`serial "${SECRET}" survived redaction`);
if (kept.includes(MAC)) leaks.push(`MAC "${MAC}" survived redaction`);

// And the mirror must still be USEFUL — redacting the whole line would pass the
// test above and destroy the feature.
const checks = [
    ["the serial never appears", leaks.length === 0],
    ["the surrounding message is kept", kept.includes("connected") && kept.includes("deviceInfo")],
    ["other fields are kept", kept.includes("batteryLevel") && kept.includes("g2")],
    ["something was redacted", kept.includes("[redacted]")],
    // Off means off: no buffer left behind for anyone to copy.
    ["stopping clears what was held", (() => {
        cm.setMessageLogging(false);
        return cm.consoleText() === "";
    })()],
];

// Straight to stdout, deliberately. `console.log` is the thing under test and
// the last check hands it back to the mirror's saved original — which here is
// the no-op — so printing results through it silently discards them.
const say = (s) => process.stdout.write(`${s}\n`);

let bad = 0;
for (const [what, ok] of checks) {
    if (!ok) bad++;
    say(`  ${ok ? "ok  " : "FAIL"}  ${what}`);
}
for (const l of leaks) say(`        ${l}`);
say(`\n  ${checks.length - bad}/${checks.length} checks pass`);
process.exit(bad ? 1 : 0);
