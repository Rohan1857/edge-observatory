import { afterEach, describe, expect, it, vi } from "vitest";
import { env } from "cloudflare:workers";
import { applyD1Migrations, reset, runInDurableObject } from "cloudflare:test";
import { rollupSite } from "../src/rollup";
import type { Env } from "../src/env";
import type { SiteEvent } from "../src/ingest/types";
import { METRICS, type QueryResult, type QuerySpec } from "@qwa/shared";

afterEach(async () => { vi.restoreAllMocks(); await reset(); });
const bindings = env as unknown as Env;
const site = () => bindings.SITE.get(bindings.SITE.idFromName("free-query"));
const day = () => new Date().toISOString().slice(0, 10);
const query = (spec: Partial<QuerySpec>) => (site() as unknown as { query(tz: string, spec: QuerySpec): Promise<QueryResult> }).query("UTC", { from: day(), to: day(), metrics: ["pageviews"], ...spec });
const event = (over: Partial<SiteEvent> = {}): SiteEvent => ({
  ts: Math.floor(Date.now() / 1000), kind: "pageview", name: "pageview", hostname: "example.com", path: "/a", props: {},
  scrollDepth: null, engagedMs: null, interactive: true, visitor: 101, prevVisitor: null, via: "qwa",
  session: { referrer: "", source: "Direct", channel: "Direct", utm_source: "", utm_medium: "", utm_campaign: "", utm_content: "", utm_term: "", country: "IN", region: "", city: "", browser: "Chrome", browser_version: "", os: "Linux", os_version: "", device: "Desktop" }, ...over,
});

describe("free-tier native SQLite reporting", () => {
  it("ingests, deduplicates, queries and expires detail with archives explicitly disabled", async () => {
    vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-10-28T12:00:00Z"));
    await runInDurableObject(site(), async (instance, state) => {
      const config = (instance as unknown as { env: Env & { ARCHIVE_MODE?: string } }).env;
      const bucket = config.DATA;
      const previousMode = config.QUERY_MODE;
      config.ARCHIVE_MODE = "disabled";
      config.QUERY_MODE = "sqlite";
      delete (config as Partial<Env>).DATA;
      try {
        const ev = event({ eventId: "local-only" });
        expect(await instance.ingest(1, ev)).toBe("ok");
        expect(await instance.ingest(1, ev)).toBe("duplicate");
        await instance.ingest(1, event({ ts: Date.parse("2026-09-28T11:59:59Z") / 1000, visitor: 2 }));
        expect(await instance.flush()).toEqual({ days: [] });
        expect((await instance.query("UTC", { from: "2026-10-28", to: "2026-10-28", metrics: ["pageviews"] })).rows[0].pageviews).toBe(1);
        expect(state.storage.sql.exec<{ n: number }>("SELECT COUNT(*) n FROM events").one().n).toBe(1);
        expect(state.storage.sql.exec<{ n: number }>("SELECT COUNT(*) n FROM meta WHERE key LIKE 'dirty:%'").one().n).toBe(0);
        expect(await instance.compactClosedMonths(1)).toEqual([]);
        await instance.alarm();
        expect(await state.storage.getAlarm()).toBeGreaterThan(Date.now());
      } finally { config.DATA = bucket; config.QUERY_MODE = previousMode; delete config.ARCHIVE_MODE; }
    });
  });

  it("fails closed for a missing archive bucket instead of discarding dirty markers", async () => {
    await site().ingest(1, event());
    await runInDurableObject(site(), async (instance, state) => {
      const config = (instance as unknown as { env: Env }).env;
      const bucket = config.DATA;
      delete (config as Partial<Env>).DATA;
      try {
        await expect(instance.flush()).rejects.toThrow("archive bucket is not configured");
        expect(state.storage.sql.exec<{ n: number }>("SELECT COUNT(*) n FROM meta WHERE key LIKE 'dirty:%'").one().n).toBe(1);
      } finally { config.DATA = bucket; }
    });
  });

  it.each([
    ["UTC", "2026-10-28T00:00:00Z", "2026-09-28", false],
    ["UTC", "2026-10-28T00:00:00.500Z", "2026-09-28", false],
    ["UTC", "2026-10-28T12:00:00Z", "2026-09-29", true],
    ["Asia/Kolkata", "2026-10-27T18:30:00Z", "2026-09-28", false],
    ["America/New_York", "2026-10-28T12:00:00Z", "2026-09-29", true],
  ] as const)("reports the first fully retained day in %s at %s", async (timezone, now, retentionFrom, partial) => {
    vi.spyOn(Date, "now").mockReturnValue(Date.parse(now));
    const result = await (site() as unknown as { query(tz: string, spec: QuerySpec): Promise<QueryResult> }).query(timezone, {
      from: "2026-09-28", to: "2026-09-28", metrics: ["pageviews"],
    });
    expect(result.meta).toMatchObject({ engine: "sqlite", retentionFrom, partial, timezone });
  });

  it.each([[-1, true], [0, false], [1, false]] as const)("marks exact retention offset %s seconds as partial=%s", async (offset, partial) => {
    vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-10-28T12:00:00Z"));
    const cutoff = Date.parse("2026-09-28T12:00:00Z") / 1000;
    const result = await query({ from: "2026-09-28", to: "2026-09-28", since: cutoff + offset, until: cutoff + 3600 });
    expect(result.meta.partial).toBe(partial);
  });

  it("identifies a wholly expired report as incomplete even when it has no rows", async () => {
    vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-10-28T12:00:00Z"));
    const result = await query({ from: "2026-08-01", to: "2026-08-02" });
    expect(result.meta).toMatchObject({ partial: true, retentionFrom: "2026-09-29" });
    expect(result.rows[0].pageviews).toBe(0);
  });

  it("purges detail before the cutoff while retaining an event exactly at the cutoff", async () => {
    vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-10-28T12:00:00Z"));
    const cutoff = Date.parse("2026-09-28T12:00:00Z") / 1000;
    await site().ingest(1, event({ ts: cutoff - 1, visitor: 1, path: "/expired" }));
    await site().ingest(1, event({ ts: cutoff, visitor: 2, path: "/retained" }));
    await site().flush();
    await runInDurableObject(site(), async (_instance, state) => {
      expect(state.storage.sql.exec("SELECT path FROM events ORDER BY ts").toArray()).toEqual([{ path: "/retained" }]);
    });
  });

  it("ranks percentile groups by numbers before applying the result limit", async () => {
    for (const [path, lcp] of [["/fast", 900], ["/slow", 1000]] as const) {
      await site().ingest(1, event({ path }));
      await site().ingest(1, event({ path, kind: "engagement", name: "engagement", vitals: { pv: lcp, lcp, inp: 0, inp_target: "", inp_type: "", inp_delay: 0, inp_processing: 0, inp_presentation: 0, lcp_element: "img", cls: -1, ttfb: 0, fcp: 0 } }));
    }
    expect((await query({ metrics: ["lcp"], groupBy: "page", limit: 1 })).rows).toEqual([{ page: "/slow", lcp: 1000 }]);
  });
  it("preserves pageview buckets when a session started the previous day", async () => {
    const midnight = Date.parse(day()) / 1000;
    await site().ingest(1, event({ ts: midnight - 60 }));
    await site().ingest(1, event({ ts: midnight + 60 }));
    const result = await query({ metrics: ["visitors", "pageviews"], groupBy: "day" });
    expect(result.rows[0].pageviews).toBe(1);
  });
  it("does not turn missing expired detail into permanent zero-valued rollups", async () => {
    await applyD1Migrations(bindings.DB, (env as unknown as { TEST_MIGRATIONS: Parameters<typeof applyD1Migrations>[1] }).TEST_MIGRATIONS);
    const old = new Date(Date.now() - 60 * 86_400_000).toISOString().slice(0, 10);
    await bindings.DB.prepare("INSERT INTO sites(id,domain,timezone,created_at) VALUES(1,'old.example','UTC',?)").bind(old).run();
    await rollupSite({ ...bindings, QUERY_MODE: "sqlite" }, { id: 1, timezone: "UTC" } as never);
    const cutoff = new Date(Date.now() - 29 * 86_400_000).toISOString().slice(0, 10);
    expect((await bindings.DB.prepare("SELECT COUNT(*) n FROM daily_stats WHERE day < ?").bind(cutoff).first<{ n: number }>())!.n).toBe(0);
  });
  it("includes a fully retained boundary day when rolling up at midnight", async () => {
    vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-10-28T00:00:00Z"));
    await applyD1Migrations(bindings.DB, (env as unknown as { TEST_MIGRATIONS: Parameters<typeof applyD1Migrations>[1] }).TEST_MIGRATIONS);
    await bindings.DB.prepare("INSERT INTO sites(id,domain,timezone,created_at) VALUES(1,'old.example','UTC','2026-08-01')").run();
    const result = await rollupSite({ ...bindings, QUERY_MODE: "sqlite" }, { id: 1, timezone: "UTC" } as never);
    expect(result.from).toBe("2026-09-28");
    expect(result.days).toBe(30);
  });
  it("aggregates traffic and engagement without loading a WASM query engine", async () => {
    await site().ingest(1, event());
    await site().ingest(1, event({ path: "/b" }));
    await site().ingest(1, event({ kind: "custom", name: "Signup" }));
    await site().ingest(1, event({ kind: "engagement", name: "engagement", engagedMs: 5000, scrollDepth: 80 }));
    const result = await query({ metrics: ["visitors", "visits", "pageviews", "events", "bounce_rate", "views_per_visit", "scroll_depth", "time_on_page"] });
    expect(result.rows).toEqual([{ visitors: 1, visits: 1, pageviews: 2, events: 1, bounce_rate: 0, views_per_visit: 2, scroll_depth: 80, time_on_page: 5 }]);
  });
  it.each(["day", "hour", "quarter_hour", "week", "month", "weekhour", "source", "country", "page", "event"] as const)("supports grouping by %s", async (groupBy) => {
    await site().ingest(1, event());
    await site().ingest(1, event({ kind: "custom", name: "Signup" }));
    const result = await query({ groupBy, metrics: [groupBy === "event" ? "events" : "pageviews"] });
    expect(result.rows.length).toBeGreaterThan(0);
    expect(result.rows.reduce((sum, row) => sum + Number(row[groupBy === "event" ? "events" : "pageviews"]), 0)).toBe(1);
  });
  it("applies literal filters safely, including SQL metacharacters", async () => {
    await site().ingest(1, event());
    expect((await query({ filters: [["page", "contains", "' OR 1=1 --"]] })).rows[0].pageviews).toBe(0);
    expect((await query({ filters: [["page", "is", "/a"]] })).rows[0].pageviews).toBe(1);
  });
  it("computes interpolated p75 from each pageview's latest vital report", async () => {
    for (const [index, inp] of [100, 200, 300, 400].entries()) {
      await site().ingest(1, event({ visitor: index + 1 }));
      const v = { pv: index + 1, inp, inp_target: "button", inp_type: "click", inp_delay: 10, inp_processing: 20, inp_presentation: 30, lcp: 1000, lcp_element: "img", cls: 0, ttfb: 100, fcp: 500 };
      await site().ingest(1, event({ visitor: index + 1, kind: "engagement", name: "engagement", vitals: v }));
    }
    const result = await query({ metrics: ["inp", "measured_views", "cls"] });
    expect(result.rows).toEqual([{ inp: 325, measured_views: 4, cls: 0 }]);
  });
  it("returns valid values for every supported metric on an empty site", async () => {
    const result = await query({ metrics: [...METRICS] });
    expect(result.rows[0].pageviews).toBe(0);
    expect(result.rows[0].inp).toBeNull();
  });
});
