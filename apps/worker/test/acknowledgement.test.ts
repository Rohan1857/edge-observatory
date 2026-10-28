import { afterEach, describe, expect, it, vi } from "vitest";
import { capFor, handleQwaEvent } from "../src/ingest/handler";
import { parseQwaPayload } from "../src/ingest/qwa";
import type { Env, Site } from "../src/env";

afterEach(() => vi.restoreAllMocks());
const event = { s: "example.com", n: "pageview", u: "https://example.com/", id: "event_001" };
const request = (body: string) => new Request("https://analytics.test/e", { method: "POST", body, headers: { "user-agent": "Mozilla/5.0 Chrome/130.0.0.0 Safari/537.36" } });
const ctx = { waitUntil(p: Promise<unknown>) { void p.catch(() => {}); } };

describe("durable acknowledgement", () => {
  it("cannot disable or raise the daily cap in the free profile", () => {
    for (const daily_cap of [null, 0, 50_000]) {
      expect(capFor({ QUERY_MODE: "sqlite" } as Env, { daily_cap } as Site)).toBe(1000);
    }
    expect(capFor({ QUERY_MODE: "sqlite" } as Env, { daily_cap: 100 } as Site)).toBe(100);
  });
  it("returns retryable 503 when storage is unavailable", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const unavailable = { DB: { prepare() { throw new Error("storage unavailable"); } } } as unknown as Env;
    const response = await handleQwaEvent(request(JSON.stringify(event)), unavailable, ctx);
    expect(response.status).toBe(503);
    expect(response.headers.get("retry-after")).toBe("1");
    expect(response.headers.get("access-control-expose-headers")?.toLowerCase()).toContain("retry-after");
  });
  it("rejects oversized bodies before parsing or storage", async () => {
    const response = await handleQwaEvent(request(JSON.stringify({ ...event, p: { large: "x".repeat(17_000) } })), {} as Env, ctx);
    expect(response.status).toBe(413);
  });
  it("enforces the byte limit on streaming bodies without Content-Length", async () => {
    const stream = new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode("x".repeat(17_000))); c.close(); } });
    const req = new Request("https://analytics.test/e", { method: "POST", body: stream, duplex: "half" } as RequestInit);
    expect((await handleQwaEvent(req, {} as Env, ctx)).status).toBe(413);
  });
  it.each(["", "bad id", "x".repeat(129), 123])("rejects malformed event ID %j", (id) => {
    expect(() => parseQwaPayload({ ...event, id })).toThrow();
  });
  it("preserves an event ID through parsing", () => {
    expect(parseQwaPayload(event)).toHaveProperty("eventId", "event_001");
  });
});
