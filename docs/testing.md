# Testing

Run the full check with Node.js 22 or newer:

```sh
npm ci
npm run verify
```

CI runs the same verification command on pushes and pull requests. It checks application and integration types, runs workspace tests and Workers-runtime integration tests, builds the tracker and dashboard, and bundles the SQLite Worker without deploying it.

A separate HTTP smoke job builds the application and runs `npm run smoke:ci`. The runner creates isolated local D1 and Durable Object storage, applies migrations, seeds one synthetic site, starts an R2-free Worker, waits for readiness and runs the HTTP assertions. It stops the server and removes the temporary state afterwards. CI uploads `.wrangler/smoke-http.log` if the job fails. No Cloudflare credentials or remote resources are used.

For a narrower check:

| Command | Checks |
| --- | --- |
| `npm test` | Worker, query, dashboard and tracker unit tests |
| `npm run test:runtime` | SQLite Durable Objects and R2 in the Workers test runtime |
| `npm run typecheck` | Application types |
| `npm run typecheck:integration` | Integration test types |
| `npm run build` | Tracker, dashboard and assembled static assets |
| `npm run build:worker` | Single-Worker deployment bundle, dry run |
| `npm audit` | Known dependency vulnerabilities |
| `npm run smoke:ci` | HTTP smoke against a fresh local server; run `npm run build` first |

## Ingestion and storage

The runtime tests cover concurrent duplicate deliveries, object eviction, visitor and site isolation, daily salt changes, transaction rollback, receipt expiry and R2 write failures. A gated R2 write also tests what happens when successful and failed ingests occur during an archive flush. SQLite-only tests remove the R2 binding and exercise ingestion, deduplication, queries, cleanup and alarm scheduling.

The HTTP smoke check needs a running local server. Follow the setup in the [README](../README.md), then run `npm run smoke` in a second terminal. It submits 20 copies of an event and expects one SQLite pageview. The site and traffic used for this check are synthetic.

## Reporting

Query tests cover filters, traffic metrics, timezones, percentile interpolation and ranking, events after a session crosses midnight, and incomplete historical rollups. The SQL fixture generator is optional and skipped in the normal test run.

Retention cases cover the second before, at and after the rolling cutoff; UTC and non-UTC midnights; wholly expired ranges; purge boundaries; and daily rollups at the cutoff. Dashboard tests render coverage warnings for both current and comparison periods. Tracker tests cover retries after HTTP and network failures, stable event IDs, permanent errors, exhausted retries, request timeouts, Retry-After bounds and the XHR fallback.

Storage integration tests run against the local Workers runtime. For a hosted installation, also check Access sign-in and event ingestion as described in the [deployment guide](DEPLOY.md).
