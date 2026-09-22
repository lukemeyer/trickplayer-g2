// Every key the app reads or writes must be one the store HYDRATES.
//
// `store.getItem` answers from an in-memory map filled at boot by walking a
// fixed KEYS list. A key missing from that list therefore writes fine, reads
// back fine for the rest of the session, and is silently empty after a
// relaunch — which looks exactly like "the setting didn't save" and can only
// be found by relaunching. It has cost this project two settings already: the
// two debug switches, and then very nearly the glare ceiling.
//
// So: resolve every getItem/setItem call site to a literal key and check it is
// listed. Bulk keys are exempt — readBulk/writeBulk go to the host store
// directly and are not hydrated on purpose, because they are too big.
//
//   node tools/store-check.mjs
//
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SRC = path.join(ROOT, "src");
const files = fs.readdirSync(SRC).filter((f) => f.endsWith(".ts"));
const text = Object.fromEntries(files.map((f) => [f, fs.readFileSync(path.join(SRC, f), "utf8")]));

// --- the hydrated list
const storeSrc = text["store.ts"];
const keysBlock = storeSrc.slice(storeSrc.indexOf("const KEYS = ["), storeSrc.indexOf("];", storeSrc.indexOf("const KEYS = [")));
// Only the entries: the block also carries prose in comments, and a quoted
// phrase in a comment is not a key.
const KEYS = [...keysBlock.matchAll(/"(trickplayer\.[^"]+)"/g)].map((m) => m[1]);

// --- const name -> literal, across every file
const consts = new Map();
for (const [, src] of Object.entries(text)) {
    for (const m of src.matchAll(/const\s+([A-Z][A-Z0-9_]*)\s*=\s*"(trickplayer\.[^"]+)"/g)) {
        consts.set(m[1], m[2]);
    }
}

// --- call sites, excluding the store's own implementation
const bulk = new Set();
const used = [];
for (const [file, src] of Object.entries(text)) {
    if (file === "store.ts") continue;
    for (const m of src.matchAll(/\b(?:store\.)?(getItem|setItem|readBulk|writeBulk)\(\s*("trickplayer\.[^"]+"|[A-Z][A-Z0-9_]*)/g)) {
        const raw = m[2];
        const key = raw.startsWith('"') ? raw.slice(1, -1) : consts.get(raw);
        if (!key) continue;                       // a const we cannot resolve; not a key literal
        if (m[1] === "readBulk" || m[1] === "writeBulk") bulk.add(key);
        else used.push({ file, key, via: raw });
    }
}

const checks = [];
const missing = used.filter((u) => !KEYS.includes(u.key));
checks.push({
    name: "every key read or written is hydrated at boot",
    pass: missing.length === 0,
    detail: missing.length
        ? missing.map((u) => `${u.file} uses ${u.key} (${u.via}) — not in KEYS`).join("; ")
        : `${new Set(used.map((u) => u.key)).size} keys, all listed`,
});

const unused = KEYS.filter((k) => !used.some((u) => u.key === k));
checks.push({
    name: "no hydrated key is dead",
    pass: unused.length === 0,
    detail: unused.length ? `never read or written: ${unused.join(", ")}` : `${KEYS.length} keys, all in use`,
});

checks.push({
    name: "bulk keys are deliberately NOT hydrated",
    pass: [...bulk].every((k) => !KEYS.includes(k)),
    detail: bulk.size
        ? `bulk: ${[...bulk].join(", ")}`
        : "no bulk keys found",
});

console.log("\n  Store keys\n");
let bad = 0;
for (const c of checks) {
    if (!c.pass) bad++;
    console.log(`  ${c.pass ? "ok  " : "FAIL"}  ${c.name}`);
    console.log(`        ${c.detail}`);
}
console.log(`\n  ${checks.length - bad}/${checks.length} checks pass\n`);
process.exit(bad ? 1 : 0);
