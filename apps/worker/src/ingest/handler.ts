import { notifyCapped } from "../alerts";
import type { Env, Site } from "../env";
import { siteByDomain } from "../sites";
import { isBot, pagePath, sessionAttrs } from "./enrich";
import { clientIp, hostnameAllowed, ipBlocked } from "./ip";
import { parsePlausiblePayload, PayloadError } from "./plausible";
import { parseQwaPayload } from "./qwa";
import type { RawEvent, SiteEvent } from "./types";
import { salts, utcDay, visitorId } from "./visitor";

const DEFAULT_CAP = 3_000_000;
/** A site's daily event cap (0 = none). */
export const capFor = (env: Env, site: Site) => {
  const requested = site.daily_cap ?? (Number(env.DEFAULT_DAILY_CAP) || DEFAULT_CAP);
  return env.QUERY_MODE === "sqlite" ? Math.min(requested > 0 ? requested : 1000, 1000) : requested;
};

// Sites that hit their cap today, remembered per isolate so further events are dropped before reaching storage.
// The cap is part of the key: raising a site's limit (picked up within a minute) lets its events through again.
const cappedToday = new Map<number, string>();
const capKey = (env: Env, site: Site, nowMs: number) => `${utcDay(nowMs)}|${capFor(env, site)}`;

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "POST, OPTIONS",
  "access-control-allow-headers": "content-type",
  "access-control-expose-headers": "retry-after",
};

export function corsPreflight(): Response {
  return new Response(null, { status: 204, headers: { ...CORS, "access-control-max-age": "86400" } });
}

type Ctx = { waitUntil(p: Promise<unknown>): void };

/** POST /api/event: Plausible-compatible endpoint. */
export const handlePlausibleEvent = (req: Request, env: Env, ctx: Ctx) => handleEvent(req, env, ctx, parsePlausiblePayload);

/** POST /e: the QWA tracker's endpoint. */
export const handleQwaEvent = (req: Request, env: Env, ctx: Ctx) => handleEvent(req, env, ctx, parseQwaPayload);

/** Acknowledge after storage; failed persistence is safe for the client to retry with the same ID. */
async function handleEvent(req: Request, env: Env, _ctx: Ctx, parse: (body: unknown) => RawEvent): Promise<Response> {
  let raw: RawEvent;
  try {
    const reader = req.body?.getReader();
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    if (reader) {
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          bytes += value.byteLength;
          if (bytes > 16_384) {
            await reader.cancel();
            return new Response("payload too large", { status: 413, headers: CORS });
          }
          chunks.push(value);
        }
      } finally { reader.releaseLock(); }
    }
    const body = new Uint8Array(bytes);
    let offset = 0;
    for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.byteLength; }
    raw = parse(JSON.parse(new TextDecoder().decode(body)));
  } catch (e) {
    const msg = e instanceof PayloadError ? e.message : "invalid JSON";
    return new Response(JSON.stringify({ errors: { request: msg } }), { status: 400, headers: { ...CORS, "content-type": "application/json" } });
  }
  // Emergency stop: answer as normal, store nothing.
  if (env.INGEST_PAUSED === "1") return new Response("ok", { status: 202, headers: CORS });
  try {
    await ingest(raw, req, env);
  } catch (err) {
    console.error(JSON.stringify({ event: "ingest_failed", error: err instanceof Error ? err.message : "unknown" }));
    return new Response("storage unavailable", { status: 503, headers: { ...CORS, "retry-after": "1" } });
  }
  return new Response("ok", { status: 202, headers: CORS });
}

/** Shared by both front doors (compat and, later, the QWA tracker). */
export async function ingest(raw: RawEvent, req: Request, env: Env): Promise<void> {
  const ua = req.headers.get("user-agent") ?? "";
  if (isBot(ua)) return;
  const ip = clientIp(req);
  const nowMs = Date.now();
  const { current, previous } = await salts(env.DB, nowMs);
  const kind = raw.name === "pageview" ? "pageview" : raw.name === "engagement" ? "engagement" : "custom";
  const cf = req.cf as IncomingRequestCfProperties | undefined;
  const session = sessionAttrs(raw, ua, cf);

  for (const domain of raw.domains.slice(0, 5)) {
    const site = await siteByDomain(env, domain);
    if (!site) continue;
    if (!hostnameAllowed(raw.url.hostname, site.allowed_hostnames)) continue;
    if (ipBlocked(ip, site.ip_blocklist)) continue;
    if (cappedToday.get(site.id) === capKey(env, site, nowMs)) continue;

    const ev: SiteEvent = {
      ...(raw.eventId !== undefined ? { eventId: raw.eventId } : {}),
      ts: Math.floor(nowMs / 1000),
      kind,
      name: raw.name,
      hostname: raw.url.hostname.toLowerCase(),
      path: pagePath(raw),
      props: raw.props,
      scrollDepth: raw.scrollDepth,
      engagedMs: raw.engagedMs,
      interactive: raw.interactive,
      visitor: await visitorId(current, site.id, ip, ua),
      prevVisitor: previous ? await visitorId(previous, site.id, ip, ua) : null,
      via: raw.via,
      vitals: raw.vitals ?? null,
      session,
    };
    const result = await env.SITE.get(env.SITE.idFromName(String(site.id))).ingest(site.id, ev, capFor(env, site));
    if (result === "capped" || result === "capped-first") cappedToday.set(site.id, capKey(env, site, nowMs));
    if (result === "capped-first") {
      console.warn("daily event cap reached", site.domain, capFor(env, site));
      await notifyCapped(env, site, capFor(env, site), utcDay(nowMs)).catch((e) => console.error("cap email failed", e));
    }
  }
}
