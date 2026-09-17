// @ts-nocheck
//
// Which of a Plex server's addresses to use, and when to ask again (F-016).
//
// plex.tv hands back several connections per server — the LAN address, a public
// one, usually a relay — and which of them works depends entirely on where the
// phone is. The G2 build used to pick one when the server was chosen and keep
// it for ever. Chosen at home, that was the LAN address, so the moment the
// phone left the house every request went to a private IP that no longer
// existed, and the server simply "did not load". A VPN fixed it, which is the
// tell: the saved address was only reachable from inside the network.
//
// Pure apart from the probe, which is injected, so the policy can be tested
// without a network (tools/route-check.mjs).

/**
 * `192.168.1.10` or `192-168-1-10.<hash>.plex.direct` — the second is what
 * plex.tv actually returns once HTTPS is requested, and a check for dotted
 * private addresses never matched it. That is how "prefer the LAN route"
 * silently became "take whichever route happened to be listed first".
 */
const PRIVATE = /\/\/(?:10|192[.-]168|172[.-](?:1[6-9]|2\d|3[01]))[.-]/;

/** Saved records predate the route flags, so strings are still accepted. */
export function normaliseRoutes(raw) {
    return (Array.isArray(raw) ? raw : [])
        .filter(Boolean)
        .map((r) => typeof r === "string"
            ? { uri: r, local: PRIVATE.test(r), relay: false }
            : { uri: r.uri, local: !!r.local || PRIVATE.test(r.uri || ""), relay: !!r.relay })
        .filter((r) => r.uri);
}

/** Lower is better: LAN, then a direct public route, then a relay. */
export function rank(route) {
    return route.local ? 0 : route.relay ? 2 : 1;
}

/** The best route WITHOUT a network — only good for a first guess. */
export function staticBest(routes) {
    return [...routes].sort((a, b) => rank(a) - rank(b))[0] || null;
}

/**
 * Fire the probe at every route at once, and pick from what answers.
 *
 * Probing in order means waiting out a dead LAN address's whole timeout before
 * anything else is tried — which, off the home network, is exactly the case
 * that matters. Racing means the public route answers in a few hundred
 * milliseconds even while the LAN probe is still hanging.
 *
 * The first responder does not simply win (F-016 rule 2): a relay can beat a
 * LAN address that was 20ms behind it, and relays are bandwidth-limited. So
 * once something answers, wait a short grace window for anything better
 * ranked, then take the best. A local answer ends the race immediately — there
 * is nothing better to wait for.
 *
 * @param probe  (uri) => Promise<boolean>
 * @returns {route, ms, tried} — `route` is null when nothing answered.
 */
export async function raceRoutes(routes, { probe, timeoutMs = 8000, graceMs = 600, now = Date.now } = {}) {
    const started = now();
    const answered = [];
    if (!routes.length) return { route: null, ms: 0, tried: 0 };

    return await new Promise((resolve) => {
        let settled = false;
        let pending = routes.length;
        let graceTimer = null;

        const finish = () => {
            if (settled) return;
            settled = true;
            clearTimeout(overall);
            clearTimeout(graceTimer);
            answered.sort((a, b) => rank(a.route) - rank(b.route) || a.ms - b.ms);
            resolve({ route: answered[0]?.route || null, ms: answered[0]?.ms ?? now() - started,
                tried: routes.length, answered: answered.length });
        };
        const overall = setTimeout(finish, timeoutMs);

        for (const route of routes) {
            Promise.resolve()
                .then(() => probe(route.uri))
                .catch(() => false)
                .then((ok) => {
                    pending--;
                    if (settled) return;
                    if (ok) {
                        answered.push({ route, ms: now() - started });
                        if (rank(route) === 0) return finish();
                        if (!graceTimer) graceTimer = setTimeout(finish, graceMs);
                    }
                    if (pending === 0) finish();
                });
        }
    });
}
