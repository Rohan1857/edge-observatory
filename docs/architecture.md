# Architecture

The default configuration runs the API and dashboard on one Worker. Each site has a SQLite Durable Object; D1 stores shared metadata and daily totals, and R2 stores event archives.

```mermaid
flowchart LR
  T[Browser tracker] --> W[Worker API]
  W --> D[Site Durable Object]
  D --> S[(SQLite)]
  D --> R[(R2 Parquet archives)]
  W --> M[(D1 metadata and totals)]
  U[React dashboard] --> W
```

## Transactional ingestion

A per-site Durable Object owns sessionization. One SQLite transaction commits the session, event, optional receipt and durable dirty marker. Storage failure returns 503. Receipts include visitor identity and event ID; checking the previous daily identity handles salt rotation while bounding linkability and deduplication scope.

SQL cannot interleave inside a synchronous transaction. R2 flushes can interleave with ingestion: each dirty day therefore has a generation, and flush only clears an unchanged generation. Rollback restores the prior transaction generation map without erasing unrelated successful writes. Archive failures retain local data and dirty markers for retry.

## Reporting

The shared query compiler targets DuckDB or native SQLite. The default SQLite profile executes queries inside the Durable Object. Metric families join against the union of their grouping keys, preserving event-only buckets across session boundaries. Validated dimensions and quoted filter values prevent arbitrary SQL exposure.

SQLite aggregates Web Vitals samples; the Durable Object interpolates p75. Percentile groups are sorted and limited after numeric conversion. Time bucketing uses explicit timezone-offset segments. Query streams pull one result at a time.

## Storage and retention

SQLite owns recent detail, sessions and receipts. D1 holds metadata and completed daily totals. R2 stores Parquet archives. Detailed retention is 30 days; SQLite drilldowns do not query older archives. Rollups start at fully retained local days and skip partial results so missing history stays distinguishable from zero traffic.

Duplicate receipts expire after 72 hours. Matching uses the current and previous daily visitor identities, so identity changes or later salt rotations can cause a retry to count again. Expired records are removed during archive flushes.

Production identity uses validated Cloudflare Access JWTs. The deployment example omits local bypass flags. Requests are limited to 16 KiB and the default cap is 1,000 accepted events per site per day. Queries and rejected requests still use resources, so this is not an account-wide spending limit. A busy site's ingestion and queries share one Durable Object.
