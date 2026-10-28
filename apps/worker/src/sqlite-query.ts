import { validateSpec, type Metric, type QueryResult, type QuerySpec } from "@qwa/shared";
import { buildSql } from "../../query/src/sql";
import { addDays, dayLabel, localMidnight, offsetSegments } from "../../query/src/tz";
import { fillBuckets, fillPeriods } from "../../query/src/shape";

export const DETAIL_RETENTION_DAYS = 30;
const PERCENTILES: Metric[] = ["inp", "lcp", "cls", "ttfb", "fcp", "inp_delay", "inp_processing", "inp_presentation"];

/** Native SQLite does the scan and aggregation. Only bounded vital arrays need JS interpolation. */
export function querySqlite(sql: SqlStorage, timezone: string, input: QuerySpec): QueryResult {
  const started = Date.now();
  const spec = validateSpec(input);
  const from = spec.since ?? localMidnight(timezone, spec.from);
  const to = spec.until ?? localMidnight(timezone, addDays(spec.to, 1));
  if (!Number.isFinite(from) || !Number.isFinite(to) || from >= to || to - from > 366 * 86_400) throw new Error("reports must cover 1 to 366 days");
  const plan = buildSql({ spec, from, to, segments: offsetSegments(timezone, from, to),
    files: { sessions: [], pageviews: [], engagement: [], custom: [] }, approximate: false, dialect: "sqlite" });
  let rows = sql.exec<Record<string, string | number | null>>(plan.sql).toArray();
  for (const row of rows) for (const metric of spec.metrics) {
    if (!PERCENTILES.includes(metric)) continue;
    const values = (JSON.parse(String(row[metric] ?? "[]")) as unknown[])
      .filter((value): value is number => typeof value === "number" && Number.isFinite(value)).sort((a, b) => a - b);
    if (!values.length) { row[metric] = null; continue; }
    const position = (values.length - 1) * 0.75;
    const low = Math.floor(position), high = Math.ceil(position);
    const value = values[low] + (values[high] - values[low]) * (position - low);
    row[metric] = metric === "cls" ? Math.round(value) / 1000 : Math.round(value);
  }
  const key = plan.key;
  if (key && !["day", "hour", "quarter_hour", "week", "month", "weekhour"].includes(key) && PERCENTILES.includes(spec.metrics[0])) {
    const metric = spec.metrics[0];
    rows.sort((a, b) => {
      if (a[metric] === null && b[metric] !== null) return 1;
      if (b[metric] === null && a[metric] !== null) return -1;
      return Number(b[metric] ?? 0) - Number(a[metric] ?? 0) || String(a[key]).localeCompare(String(b[key]));
    });
    rows = rows.slice(0, spec.limit ?? 100);
  }
  if (key === "hour" || key === "quarter_hour") rows = fillBuckets(rows, spec, key, timezone, from, to);
  else if (key === "day" || key === "week" || key === "month") {
    rows = rows.map((row) => ({ ...row, [key]: dayLabel(Number(row[key])) }));
    rows = fillPeriods(rows, spec, key);
  }
  const cutoff = Date.now() / 1000 - DETAIL_RETENTION_DAYS * 86_400;
  const retentionFrom = addDays(new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(cutoff * 1000)), 1);
  return { rows, meta: { from: spec.from, to: spec.to, timezone, ms: Date.now() - started, files: 0,
    engine: "sqlite", retentionFrom, partial: from < cutoff } };
}
