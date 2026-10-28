# Contributing

Use Node.js 22 or newer. Follow the local setup in the [README](../README.md), then run `npm run verify` before opening a pull request.

Worker tests live in `apps/worker/test`; SQLite and storage integration tests are in `apps/worker/integration`. Other workspaces keep tests beside their source directories.

Add a regression test when fixing ingestion or reporting behaviour. D1 schema changes need a new numbered migration in `apps/worker/migrations`; leave existing migrations unchanged. Changes to the Parquet tables in `packages/shared/src/tables.ts` must account for existing archives.

Keep raw IP addresses and user agents out of stored events. Preserve third-party licences when changing tracker compatibility code.

Contributions are released under the MIT licence.
