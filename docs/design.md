# Technical design

## Transactional ingestion

A per-site Durable Object owns sessionization. One SQLite transaction commits the session, event, optional receipt and durable dirty marker. Storage failure returns 503. Receipts include visitor identity and event ID; checking the previous daily identity handles salt rotation while bounding linkability and deduplication scope.

SQL cannot interleave inside a synchronous transaction. R2 flushes can interleave with ingestion: each dirty day therefore has a generation, and flush only clears an unchanged generation. Rollback restores the prior transaction generation map without erasing unrelated successful writes. Archive failures retain local data and dirty markers for retry.

## Reporting

The shared query compiler targets DuckDB or native SQLite. The default free profile executes SQLite inside the Durable Object. Metric families join against the union of their grouping keys, preserving event-only buckets across session boundaries. Validated dimensions and quoted filter values prevent arbitrary SQL exposure.

SQLite aggregates Web Vitals samples; the Durable Object interpolates p75. Percentile groups are sorted and limited after numeric conversion. Time bucketing uses explicit timezone-offset segments. Query streams pull one result at a time.

## Storage and retention

SQLite owns recent detail, sessions and receipts. D1 holds metadata and completed daily totals. R2 stores Parquet archives. Detailed retention is 30 days; free-profile drilldowns do not query older archives. Partial coverage is explicit. Rollups start at fully retained local days and refuse partial results rather than persisting fabricated historical zeros.

Production identity uses validated Cloudflare Access JWTs. Deployment examples omit local bypass flags. A 16 KiB body bound and 1000 accepted events/site/day constrain some resource use, but do not cap every request, query scan or account-wide charge. Per-site serialization favors explicit consistency over unlimited hot-site throughput. No production-load, uptime or zero-billing guarantee is claimed.
