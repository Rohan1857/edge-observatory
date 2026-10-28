# Verification report

Verified locally on2026-10-28, Windows, Node22.22.3/npm11.14.1, Wrangler4.154.0. The delivered profile uses native SQLite; no paid query Worker is required. Cloud deployment is excluded by the owner's local-R2 decision.

| Check | Command | Result |
|---|---|---|
| Installation | npm ci; targeted dependency updates and lock refresh | Passed |
| Application types | npm run typecheck | Passed, three workspaces |
| Integration types | npm run typecheck:integration | Passed |
| Worker unit tests | npm test -w apps/worker | 84 passed |
| Query tests | npm test -w apps/query | 13 passed;1 optional fixture-generator test skipped |
| Dashboard tests | npm test -w apps/web | 13 passed |
| Tracker tests | npm test -w packages/tracker | 17 passed |
| Workers-runtime integration | npm run test:runtime | 28 passed |
| Production frontend | npm run build | Passed |
| Free Worker bundle | npm run build:worker | Passed dry-run; no paid service binding |
| Local migrations/fixture | npm run db:local; npm run seed:local | Passed |
| HTTP integration | npm run smoke | Passed;20 duplicate deliveries produce1 native SQLite pageview |
| Dependency audit | npm audit | Zero reported vulnerabilities |
| Lint | No lint script configured | Not claimed |
| Cloud deployment/live smoke | Not executed | Local-only decision |

Total:155 passing tests and1 intentionally skipped optional SQL-fixture generator. The generator is not an application test bypass. Runtime tests use actual local SQLite Durable Objects and R2, with fault injection at external write boundaries.

## Failure and recovery evidence

Tests cover duplicate contention, object eviction, visitor/site isolation, daily salt transition, transactional insert rollback, logical receipt expiry, R2 flush failure/retry and a gated archive write interleaved with successful and failed ingestion. Reporting tests cover safe SQL filters, all traffic metrics, timezone grouping, empty data, percentile interpolation/ranking, midnight-crossing metric groups and refusal to persist unavailable history as zero rollups.

## Issues resolved

Persistence failures previously returned a false202. Added bounded stream reads and awaited storage. Added transactional receipts and tracker event IDs. Fixed Windows child-process startup, a newly tracked site's missing unflushed overview data, JSON-percentile ordering before conversion, dropped event-only grouping keys, rollback erasing flush generations, and incomplete historical rollups becoming permanent zeros. Regression tests were observed failing before these fixes.

## Demonstration and boundaries

The dashboard screenshot is from the local application; portfolio.example traffic is synthetic. Private local data is in .wrangler. Detailed reporting covers30 days; historical Parquet drilldowns require the optional archive engine.72-hour receipt lifetime does not guarantee matching after identity changes or multiple salt rotations. Cleanup occurs on flush. Accepted-event caps do not cap all requests or account-wide billing.

No remote Access login, remote R2 consistency, production quota, sustained-load, throughput or uptime result is claimed. Deployment examples omit local authentication bypasses. Remote setup requires explicit authorization, D1/R2 resources and Cloudflare Access configuration; no cloud resources were created.
