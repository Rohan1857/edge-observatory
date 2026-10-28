import { afterEach, describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import { applyD1Migrations, createExecutionContext, evictDurableObject, reset, runInDurableObject, waitOnExecutionContext } from "cloudflare:test";
import type { Env } from "../src/env";
import type { SiteEvent } from "../src/ingest/types";
import { parquetReadObjects } from "hyparquet";
import { dayKey } from "@qwa/shared";
import { api, INTERNAL_USER } from "../src/api";
import type { LiveFiles } from "../../query/src/index";

const bindings = env as unknown as Env;
afterEach(async () => { await reset(); });
const event = (id = "receipt_1", visitor = 11): SiteEvent => ({
  eventId: id, ts: Math.floor(Date.now() / 1000), kind: "pageview", name: "pageview", hostname: "example.com", path: "/",
  props: {}, scrollDepth: null, engagedMs: null, interactive: true, visitor, prevVisitor: null, via: "qwa",
  session: { referrer: "", source: "Direct", channel: "Direct", utm_source: "", utm_medium: "", utm_campaign: "", utm_content: "", utm_term: "", country: "IN", region: "", city: "", browser: "Chrome", browser_version: "", os: "Linux", os_version: "", device: "Desktop" },
});
const site = (id = 1) => bindings.SITE.get(bindings.SITE.idFromName(String(id)));
async function count(id = 1) {
  return runInDurableObject(site(id), async (_instance, state) => state.storage.sql.exec<{ n: number }>("SELECT COUNT(*) n FROM events").one().n);
}

describe("durable analytics receipts", () => {
  it("keeps an intervening successful write dirty when a later transaction rolls back", async () => {
    await site().ingest(1, event());
    await evictDurableObject(site());
    await runInDurableObject(site(), async (instance, state) => {
      const bucket = (instance as unknown as { env: Env }).env.DATA!;
      const original = bucket.put;
      let release!: () => void, entered!: () => void;
      const gate = new Promise<void>((resolve) => { release = resolve; });
      const ready = new Promise<void>((resolve) => { entered = resolve; });
      let first = true;
      bucket.put = (async (...args: Parameters<R2Bucket["put"]>) => {
        if (first) { first = false; entered(); await gate; }
        return original.apply(bucket, args);
      }) as R2Bucket["put"];
      try {
        const flushing = instance.flush();
        await ready;
        await instance.ingest(1, event("second"));
        state.storage.sql.exec("CREATE TRIGGER fail_event BEFORE INSERT ON events BEGIN SELECT RAISE(ABORT, 'injected'); END");
        await expect(instance.ingest(1, event("third"))).rejects.toThrow("injected");
        state.storage.sql.exec("DROP TRIGGER fail_event");
        release();
        await flushing;
        expect(state.storage.sql.exec<{ n: number }>("SELECT COUNT(*) n FROM meta WHERE key LIKE 'dirty:%'").one().n).toBe(1);
      } finally { release(); bucket.put = original; }
    });
  });
  it("includes unflushed data in a newly created site's overview", async () => {
    const migrations = (env as unknown as { TEST_MIGRATIONS: Parameters<typeof applyD1Migrations>[1] }).TEST_MIGRATIONS;
    await applyD1Migrations(bindings.DB, migrations);
    await bindings.DB.prepare("INSERT INTO sites(id, domain, timezone) VALUES(99, 'new.example', 'UTC')").run();
    await site(99).ingest(99, event());
    const day = new Date().toISOString().slice(0, 10);
    const ctx = createExecutionContext();
    const response = await api.fetch(new Request(`http://localhost/overview?from=${day}&to=${day}&cfrom=${day}&cto=${day}`), {
      ...bindings, [INTERNAL_USER]: { id: 1, email: "test@example.com", name: "Test", role: "admin" },
      QUERY: { async query(_id: number, _tz: string, _spec: unknown, live?: LiveFiles) {
        // Model the RPC transport, reading the real Parquet emitted by SiteDO.
        let pageviews = 0;
        for (const [key, buffer] of Object.entries(live?.files ?? {})) {
          if (key.includes("pageviews/") && buffer) pageviews += (await parquetReadObjects({ file: { byteLength: buffer.byteLength, slice: (s, e) => buffer.slice(s, e) } })).length;
        }
        return { rows: [{ pageviews, visitors: pageviews, visits: pageviews, events: 0, bounce_rate: 100, visit_duration: 0 }] };
      } },
    } as unknown as Env, ctx);
    await waitOnExecutionContext(ctx);
    expect(response.status).toBe(200);
    const body = await response.json() as { sites: { current: { pageviews: number }[] }[] };
    expect(body.sites[0].current[0].pageviews).toBe(1);
  });
  it("retains deduplication after object eviction", async () => {
    const ev = event();
    await site().ingest(1, ev);
    await evictDurableObject(site());
    expect(await site().ingest(1, ev)).toBe("duplicate");
    expect(await count()).toBe(1);
  });
  it("rolls back the receipt and session if the event insert fails", async () => {
    await runInDurableObject(site(), async (_instance, state) => {
      state.storage.sql.exec("CREATE TRIGGER fail_event BEFORE INSERT ON events BEGIN SELECT RAISE(ABORT, 'injected event failure'); END");
    });
    // Catch inside the object: workerd's RPC rejection telemetry otherwise reports
    // the deliberately injected exception as an unhandled runtime error.
    await runInDurableObject(site(), async (instance) => {
      await expect(instance.ingest(1, event())).rejects.toThrow("injected event failure");
    });
    await runInDurableObject(site(), async (_instance, state) => {
      expect(state.storage.sql.exec<{ n: number }>("SELECT COUNT(*) n FROM receipts").one().n).toBe(0);
      expect(state.storage.sql.exec<{ n: number }>("SELECT COUNT(*) n FROM sessions").one().n).toBe(0);
      state.storage.sql.exec("DROP TRIGGER fail_event");
    });
    expect(await site().ingest(1, event())).toBe("ok");
    expect(await count()).toBe(1);
  });
  it("accepts an expired receipt as a new delivery and purges old receipts", async () => {
    await site().ingest(1, event());
    await runInDurableObject(site(), async (_instance, state) => {
      state.storage.sql.exec("UPDATE receipts SET expires_at = 0");
    });
    expect(await site().ingest(1, event())).toBe("ok");
    expect(await count()).toBe(2);
    await runInDurableObject(site(), async (_instance, state) => { state.storage.sql.exec("UPDATE receipts SET expires_at = 0"); });
    await site().flush();
    await runInDurableObject(site(), async (_instance, state) => {
      expect(state.storage.sql.exec<{ n: number }>("SELECT COUNT(*) n FROM receipts").one().n).toBe(0);
    });
  });
  it("keeps dirty data after R2 failure and successfully retries the flush", async () => {
    await site().ingest(1, event());
    await runInDurableObject(site(), async (instance, state) => {
      const bucket = (instance as unknown as { env: Env }).env.DATA!;
      const original = bucket.put;
      bucket.put = async () => { throw new Error("injected R2 outage"); };
      try { await expect(instance.flush()).rejects.toThrow("injected R2 outage"); }
      finally { bucket.put = original; }
      expect(state.storage.sql.exec<{ n: number }>("SELECT COUNT(*) n FROM meta WHERE key LIKE 'dirty:%'").one().n).toBe(1);
    });
    expect((await site().flush()).days).toHaveLength(1);
  });
  it("stores one event for twenty concurrent duplicate requests", async () => {
    const ev = event();
    const results = await Promise.all(Array.from({ length: 20 }, () => site().ingest(1, ev)));
    expect(results.filter((r: string) => r === "ok")).toHaveLength(1);
    expect(results.filter((r: string) => r === "duplicate")).toHaveLength(19);
    expect(await count()).toBe(1);
  });
  it("keeps site and visitor receipt scopes independent", async () => {
    await site().ingest(1, event());
    await site().ingest(1, event("receipt_1", 22));
    await site(2).ingest(2, event());
    expect(await count()).toBe(2);
    expect(await count(2)).toBe(1);
  });
  it("checks duplicate receipts before rejecting the daily cap", async () => {
    const ev = event();
    await site().ingest(1, ev, 1);
    expect(await site().ingest(1, ev, 1)).toBe("duplicate");
    expect(await site().ingest(1, event("receipt_2"), 1)).toBe("capped-first");
  });
  it("recognises the previous salt identity after a daily rotation", async () => {
    await site().ingest(1, event());
    expect(await site().ingest(1, { ...event("receipt_1", 22), prevVisitor: 11 })).toBe("duplicate");
  });
  it("flushes a deduplicated event exactly once into real R2 Parquet", async () => {
    const ev = event();
    await site().ingest(1, ev);
    await site().ingest(1, ev);
    await site().flush();
    const obj = await bindings.DATA!.get(dayKey(1, "pageviews", new Date(ev.ts * 1000).toISOString().slice(0, 10)));
    const buffer = await obj!.arrayBuffer();
    const rows = await parquetReadObjects({ file: { byteLength: buffer.byteLength, slice: (s, e) => buffer.slice(s, e) } });
    expect(rows).toHaveLength(1);
  });
});
