import type { QuerySpec } from "@qwa/shared";
import { addDays, hourLabel, quarterLabel, offsetAt } from "./tz";

export function fillBuckets(rows: Record<string, string | number | null>[], spec: QuerySpec, key: "hour" | "quarter_hour", tz: string, from: number, to: number) {
  const step = key === "hour" ? 3600 : 900;
  const label = key === "hour" ? hourLabel : quarterLabel;
  const byKey = new Map(rows.map((r) => [Number(r[key]), r]));
  const end = Math.min(to, Math.floor(Date.now() / 1000) + 1);
  const keys = new Set<number>();
  // Step through UTC time, so a day that changes the clocks gets its 23 or 25 hours.
  for (let t = Math.floor(from / step) * step; t < end; t += step) keys.add(Math.floor((Math.max(t, from) + offsetAt(tz, Math.max(t, from))) / step));
  for (const k of byKey.keys()) keys.add(k);
  const zero = Object.fromEntries(spec.metrics.map((m) => [m, 0]));
  return [...keys].sort((a, b) => a - b).map((k) => ({ ...(byKey.get(k) ?? zero), [key]: label(k) }));
}

/** Ensure every period in the range has a row (zeros where there was no traffic). */
export function fillPeriods(rows: Record<string, string | number | null>[], spec: QuerySpec, key: "day" | "week" | "month") {
  const byKey = new Map(rows.map((r) => [r[key] as string, r]));
  const out = [];
  for (let d = periodStart(spec.from, key); d <= spec.to; d = nextPeriod(d, key)) {
    out.push(byKey.get(d) ?? { [key]: d, ...Object.fromEntries(spec.metrics.map((m) => [m, 0])) });
  }
  return out;
}

function periodStart(date: string, key: "day" | "week" | "month"): string {
  if (key === "month") return `${date.slice(0, 7)}-01`;
  if (key === "week") {
    const dow = new Date(`${date}T00:00:00Z`).getUTCDay(); // 0 = Sunday
    return addDays(date, -((dow + 6) % 7));
  }
  return date;
}

function nextPeriod(date: string, key: "day" | "week" | "month"): string {
  if (key === "day") return addDays(date, 1);
  if (key === "week") return addDays(date, 7);
  const [y, m] = date.split("-").map(Number);
  return new Date(Date.UTC(y, m, 1)).toISOString().slice(0, 10);
}

