import type { QueryResult, QuerySpec } from "@qwa/shared";
import type { Env } from "./env";
import type { LiveFiles } from "../../query/src/index";

export interface QueryBackend {
  query(siteId: number, timezone: string, spec: QuerySpec, live?: LiveFiles): Promise<QueryResult>;
  queryMany(siteId: number, timezone: string, items: { i: number; spec: QuerySpec }[], live?: LiveFiles): Promise<ReadableStream<Uint8Array>>;
}

/** The free profile sends queries to the site's native SQLite runtime; DuckDB remains optional. */
export function queries(env: Env): QueryBackend {
  if (env.QUERY_MODE !== "sqlite") {
    if (!env.QUERY) throw new Error("query backend is not configured");
    return env.QUERY;
  }
  const query = (siteId: number, timezone: string, spec: QuerySpec) => env.SITE.get(env.SITE.idFromName(String(siteId))).query(timezone, spec);
  return {
    query,
    async queryMany(siteId, timezone, items) {
      let index = 0;
      const encoder = new TextEncoder();
      return new ReadableStream<Uint8Array>({
        async pull(controller) {
          if (index >= items.length) { controller.close(); return; }
          const item = items[index++];
          let line: object;
          try { line = { i: item.i, result: await query(siteId, timezone, item.spec) }; }
          catch (error) { line = { i: item.i, error: error instanceof Error ? error.message : "query failed" }; }
          controller.enqueue(encoder.encode(`${JSON.stringify(line)}\n`));
        },
      });
    },
  };
}
