// Does the route race pick the address that actually works from where the
// phone is? F-016, against fake networks.
//
//   node tools/route-check.mjs
//
import ts from "typescript";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "routes-"));
for (const f of ["plexroutes", "plexaccount", "plexsource", "timeline", "subtitles"]) {
    const js = ts.transpileModule(fs.readFileSync(path.join(ROOT, "src", `${f}.ts`), "utf8"),
        { compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.ESNext } })
        .outputText.replace(/from\s+"\.\/([A-Za-z0-9_-]+)"/g, 'from "./$1.mjs"');
    fs.writeFileSync(path.join(TMP, `${f}.mjs`), js);
}
const { createPlexAccount } = await import(pathToFileURL(path.join(TMP, "plexaccount.mjs")).href);
const { normaliseRoutes, raceRoutes, staticBest } =
    await import(pathToFileURL(path.join(TMP, "plexroutes.mjs")).href);

// What plex.tv returns with includeHttps=1&includeRelay=1 — dashed hostnames.
const LAN = { uri: "https://192-168-1-10.abc123.plex.direct:32400", local: true, relay: false };
const WAN = { uri: "https://203-0-113-7.abc123.plex.direct:32400", local: false, relay: false };
const RELAY = { uri: "https://198-51-100-2.abc123.plex.direct:8443", local: false, relay: true };

/** A network: uri -> ms until it answers, or null for never. */
const net = (answers) => (uri) => new Promise((resolve) => {
    const ms = answers[uri];
    if (ms == null) return;                       // hangs, like a private IP off-LAN
    setTimeout(() => resolve(true), ms);
});

const checks = [];
const def = (name, fn) => checks.push({ name, fn });

def("away from home: the dead LAN address does not hold up the public one", async () => {
    // The reported bug. The LAN route never answers off the home network;
    // probing in order would wait out its whole timeout first.
    const t0 = Date.now();
    const r = await raceRoutes([LAN, WAN, RELAY],
        { probe: net({ [WAN.uri]: 120, [RELAY.uri]: 60 }), timeoutMs: 8000, graceMs: 300 });
    const took = Date.now() - t0;
    return { pass: r.route?.uri === WAN.uri && took < 1500,
        detail: `picked ${r.route?.uri.split("//")[1].split(".")[0]} in ${took}ms (relay answered first)` };
});

def("at home: the LAN address wins even when the relay is faster", async () => {
    const r = await raceRoutes([RELAY, WAN, LAN],
        { probe: net({ [LAN.uri]: 80, [WAN.uri]: 60, [RELAY.uri]: 20 }), graceMs: 300 });
    return { pass: r.route?.uri === LAN.uri, detail: `picked ${r.route?.local ? "LAN" : "not LAN"}` };
});

def("a LAN answer ends the race at once — nothing better to wait for", async () => {
    const t0 = Date.now();
    const r = await raceRoutes([LAN, WAN],
        { probe: net({ [LAN.uri]: 30, [WAN.uri]: 5000 }), graceMs: 2000, timeoutMs: 8000 });
    const took = Date.now() - t0;
    return { pass: r.route?.local && took < 500, detail: `${took}ms` };
});

def("only the relay reaches: relay is used rather than nothing", async () => {
    const r = await raceRoutes([LAN, WAN, RELAY],
        { probe: net({ [RELAY.uri]: 90 }), graceMs: 200, timeoutMs: 3000 });
    return { pass: r.route?.relay === true, detail: r.route ? "relay" : "nothing" };
});

def("nothing answers: says so within the timeout instead of hanging", async () => {
    const t0 = Date.now();
    const r = await raceRoutes([LAN, WAN], { probe: net({}), timeoutMs: 400 });
    const took = Date.now() - t0;
    return { pass: r.route === null && took < 900 && r.tried === 2,
        detail: `null after ${took}ms, ${r.tried} tried` };
});

def("a probe that throws counts as no answer, not a crash", async () => {
    const r = await raceRoutes([LAN, WAN], {
        probe: (u) => u === LAN.uri ? Promise.reject(new TypeError("Failed to fetch"))
                                    : Promise.resolve(true), graceMs: 100 });
    return { pass: r.route?.uri === WAN.uri, detail: r.route?.uri || "null" };
});

def("saved string routes: a dashed private IP is recognised as local", async () => {
    // Why the old code picked the wrong one: it only looked for "//192.168.".
    const got = normaliseRoutes([WAN.uri, LAN.uri, "http://10.0.0.5:32400", "https://172-20-0-3.x.plex.direct:32400"]);
    const locals = got.filter((r) => r.local).map((r) => r.uri);
    return { pass: locals.length === 3 && !got[0].local && staticBest(got).uri === LAN.uri,
        detail: `${locals.length} local of ${got.length}; first guess ${staticBest(got).local ? "LAN" : "WAN"}` };
});

// ------------------------------------------------------- the account itself
//
// The race picking well is half of it. The other half is the account USING it:
// before the first request of a session, when the address in use stops
// answering, and — when nothing answers at all — after asking plex.tv whether
// the server's addresses have changed.

/**
 * A fake world. `reachable` is the set of hosts the phone can reach right now;
 * everything else hangs until aborted, which is what a private IP does from
 * outside the house. plex.tv is always reachable.
 */
function world({ reachable, plexTvRoutes }) {
    const calls = [];
    const fetchFn = (url, init = {}) => {
        calls.push(url);
        if (url.startsWith("https://plex.tv/api/v2/resources")) {
            return Promise.resolve(new Response(JSON.stringify([{
                clientIdentifier: "srv", name: "Home", provides: "server", accessToken: "tok",
                connections: plexTvRoutes,
            }]), { status: 200 }));
        }
        const host = url.split("/")[2];
        if (!reachable.has(host)) {
            return new Promise((_, reject) => init.signal?.addEventListener("abort",
                () => reject(Object.assign(new Error("aborted"), { name: "AbortError" }))));
        }
        if (url.endsWith("/identity")) return Promise.resolve(new Response("{}", { status: 200 }));
        if (world.httpError) return Promise.resolve(new Response("nope", { status: 401 }));
        return Promise.resolve(new Response(JSON.stringify({ MediaContainer: { Directory: [] } }),
            { status: 200 }));
    };
    return { calls, fetchFn };
}
const host = (r) => r.uri.split("/")[2];

async function withWorld(w, fn) {
    const real = globalThis.fetch;
    globalThis.fetch = w.fetchFn;
    try { return await fn(); } finally { globalThis.fetch = real; }
}

def("a server saved at home loads away from home — the reported bug", async () => {
    // Saved exactly as the old build saved it: the LAN route as serverUrl,
    // routes as bare strings.
    const w = world({ reachable: new Set([host(WAN)]) });
    const acct = createPlexAccount({ provider: "plex", id: "srv", name: "Home",
        accountToken: "a", serverToken: "tok", serverUrl: LAN.uri, routes: [LAN.uri, WAN.uri] });
    const t0 = Date.now();
    const roots = await withWorld(w, () => acct.listRoots());
    return {
        pass: roots.length >= 2 && acct.serverUrl === WAN.uri && Date.now() - t0 < 10000,
        detail: `listed ${roots.length} roots via ${acct.serverUrl.split("//")[1].split(".")[0]} ` +
            `in ${Date.now() - t0}ms`,
    };
});

def("leaving home mid-session: the next request races and carries on", async () => {
    const reachable = new Set([host(LAN), host(WAN)]);
    const w = world({ reachable });
    const acct = createPlexAccount({ provider: "plex", id: "srv", name: "Home",
        accountToken: "a", serverToken: "tok", routes: [LAN, WAN] });
    await withWorld(w, () => acct.listRoots());
    const atHome = acct.serverUrl;
    reachable.delete(host(LAN));                       // walked out of the door
    await withWorld(w, () => acct.listRoots());
    return { pass: atHome === LAN.uri && acct.serverUrl === WAN.uri,
        detail: `home ${atHome === LAN.uri ? "LAN" : "?"} -> away ${acct.serverUrl === WAN.uri ? "internet" : acct.serverUrl}` };
});

def("an HTTP error is the server answering — it does not trigger a re-race", async () => {
    const w = world({ reachable: new Set([host(LAN), host(WAN)]) });
    const acct = createPlexAccount({ provider: "plex", id: "srv", name: "Home",
        accountToken: "a", serverToken: "tok", routes: [LAN, WAN] });
    await withWorld(w, () => acct.listRoots());
    const probesBefore = w.calls.filter((u) => u.endsWith("/identity")).length;
    world.httpError = true;
    let threw = "";
    try { await withWorld(w, () => acct.listRoots()); } catch (e) { threw = e.message; }
    world.httpError = false;
    const probesAfter = w.calls.filter((u) => u.endsWith("/identity")).length;
    return { pass: /HTTP 401/.test(threw) && probesAfter === probesBefore,
        detail: `${threw || "no error"}; ${probesAfter - probesBefore} extra probe(s)` };
});

def("the public IP changed: routes are refreshed from plex.tv, not given up on", async () => {
    // A saved internet route encodes the home's public IP, and those change.
    const NEW_WAN = { uri: "https://203-0-113-99.abc123.plex.direct:32400", local: false, relay: false };
    const w = world({ reachable: new Set([host(NEW_WAN)]), plexTvRoutes: [LAN, NEW_WAN] });
    const acct = createPlexAccount({ provider: "plex", id: "srv", name: "Home",
        accountToken: "a", serverToken: "tok", routes: [LAN, WAN] });
    const roots = await withWorld(w, () => acct.listRoots());
    return { pass: roots.length >= 2 && acct.serverUrl === NEW_WAN.uri,
        detail: `now using ${acct.serverUrl.split("//")[1].split(".")[0]}` };
});

def("Remote Access off: it says why instead of spinning", async () => {
    // What the reporter's server may well be doing — only the LAN address is
    // published, so off-network there is genuinely nothing to reach.
    const w = world({ reachable: new Set(), plexTvRoutes: [LAN] });
    const acct = createPlexAccount({ provider: "plex", id: "srv", name: "Home",
        accountToken: "a", serverToken: "tok", routes: [LAN] });
    let msg = "";
    try { await withWorld(w, () => acct.listRoots()); } catch (e) { msg = e.message; }
    return { pass: /Couldn't reach Home/.test(msg) && /Remote Access/.test(msg) && /VPN/.test(msg),
        detail: msg.slice(0, 120) };
});

let bad = 0;
console.log("\n  Plex route race (F-016)\n");
for (const c of checks) {
    let r;
    try { r = await c.fn(); } catch (e) { r = { pass: false, detail: `threw: ${e.message}` }; }
    if (!r.pass) bad++;
    console.log(`  ${r.pass ? "ok  " : "FAIL"}  ${c.name}\n        ${r.detail}`);
}
console.log(`\n  ${checks.length - bad}/${checks.length} checks pass\n`);
fs.rmSync(TMP, { recursive: true, force: true });
process.exit(bad ? 1 : 0);
