import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

const base = process.env.SMOKE_URL || "http://localhost:8787";
const browser = { "user-agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/130.0.0.0 Safari/537.36" };
const response = await fetch(`${base}/api/me`);
assert.equal(response.status, 200, "local authenticated API");
const me = await response.json();
const sites = me.sites || [];
const site = sites.find((s) => s.domain === "portfolio.example");
assert.ok(site, "run npm run seed:local before smoke");
assert.equal((await fetch(`${base}/`)).status, 200, "dashboard asset");
assert.equal((await fetch(`${base}/t.js`)).status, 200, "tracker asset");
const event = { s: site.domain, n: "pageview", u: `https://${site.domain}/smoke/${randomUUID()}`, id: randomUUID() };
const send = (body) => fetch(`${base}/e`, { method: "POST", headers: browser, body: JSON.stringify(body) });
const results = await Promise.all(Array.from({ length: 20 }, () => send(event)));
assert.ok(results.every((r) => r.status === 202), "concurrent duplicate delivery acknowledged");
assert.equal((await send({ ...event, id: "bad id" })).status, 400);
assert.equal((await send({ ...event, p: { oversized: "x".repeat(17_000) } })).status, 413);
const day = new Date().toISOString().slice(0, 10);
const queried = await fetch(`${base}/api/sites/${site.id}/query`, { method: "POST", headers: { "content-type": "application/json" },
  body: JSON.stringify({ from: day, to: day, metrics: ["pageviews"], filters: [["page", "is", new URL(event.u).pathname]] }) });
assert.equal(queried.status, 200, await queried.clone().text());
const data = await queried.json();
assert.equal(Number(data.rows[0]?.pageviews), 1, "SQLite observes one persisted logical pageview");
assert.equal(data.meta.engine, "sqlite", "the default profile uses native SQLite");
console.log(JSON.stringify({ status: "pass", checks: ["local authentication", "dashboard", "tracker", "20 duplicate deliveries", "invalid ID", "body bound", "native SQLite query = 1 pageview"], synthetic: true }, null, 2));
