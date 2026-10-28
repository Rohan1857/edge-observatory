# Deployment

The root `wrangler.free.example.jsonc` configures one Worker, a SQLite Durable Object per site and D1. It has no R2, paid query Worker or observability binding. Before creating resources, confirm that the account is on Workers Free; the example config cannot change or enforce the account's subscription plan.

Workers Free, SQLite Durable Objects and D1 stop serving requests or writes when their free quotas are exhausted. R2 uses metered billing beyond its included allowance, so it is excluded from this profile. See Cloudflare's [Workers](https://developers.cloudflare.com/workers/platform/pricing/), [Durable Objects](https://developers.cloudflare.com/durable-objects/platform/pricing/), [D1](https://developers.cloudflare.com/d1/platform/pricing/) and [R2](https://developers.cloudflare.com/r2/pricing/) pricing documentation.

## Configuration

Build the static assets and copy the example to a private config:

```sh
npm ci
npm run build
cp wrangler.free.example.jsonc wrangler.jsonc
```

On PowerShell, use `Copy-Item wrangler.free.example.jsonc wrangler.jsonc` for the last command. The destination is gitignored.

Create one D1 database named `edge-observatory`. Update the private config with the returned database ID, your Worker name, `APP_HOST` and `COMPAT_ENDPOINT`. The latter should point to `https://<your-host>/api/event`. Keep `ARCHIVE_MODE=disabled` and omit `r2_buckets`; do not create an R2 bucket for this profile.

Use one synthetic site initially. The example defaults to 100 accepted events per site per day and keeps detail for 30 days. Site-specific caps can override the default within SQLite's hard limit of 1,000 per day. Cleanup removes expired detail during maintenance. Queries and failed requests remain subject to platform limits.

Configure a hostname for the Worker and protect the dashboard with Cloudflare Access. Keep `/t.js` and `/e` public so browsers can send events. If using Plausible-compatible scripts, also leave `/js/*` and `/api/event` public.

Set the secrets using the Access team domain, application audience and administrator email:

```sh
npx wrangler secret put ACCESS_TEAM_DOMAIN -c wrangler.jsonc
npx wrangler secret put ACCESS_AUD -c wrangler.jsonc
npx wrangler secret put BOOTSTRAP_ADMINS -c wrangler.jsonc
```

The Worker validates Access JWTs as well as relying on the Access application. Keep `DEV_USER_EMAIL` and `DEMO` out of this configuration.

## Apply and deploy

```sh
npx wrangler d1 migrations apply edge-observatory --remote -c wrangler.jsonc
npx wrangler deploy --dry-run -c wrangler.jsonc
npx wrangler deploy -c wrangler.jsonc
```

Use these commands for the SQLite profile. The `npm run deploy` script deploys the optional query Worker as well.

After deployment, check that `/t.js` is public, the dashboard requires Access sign-in, and a newly added site's events appear in its reports.

## Google data

Open **Admin → Google** to connect Search Console and PageSpeed. Enable the Search Console, PageSpeed Insights and Chrome UX Report APIs in a Google Cloud project. Create a service account, upload its JSON key through the dashboard, and grant that account Restricted access to each Search Console property.

Add a PageSpeed API key restricted to the PageSpeed Insights and Chrome UX Report APIs. Credentials saved through the dashboard are stored in D1. Alternatively, set the Worker secrets `GOOGLE_SERVICE_ACCOUNT` and `GOOGLE_API_KEY`; these take precedence over saved values.

## Email alerts

The SQLite profile disables historical anomaly jobs. The optional archive profile retains anomaly detection and email support. To configure sending there, onboard a sending domain in Cloudflare Email Sending, add an `EMAIL` send-email binding and set `ALERT_FROM`. Review existing mail DNS records before changing them. The dashboard has a test email action under **Admin → Alerts**.

For existing Plausible trackers or historical imports, see [migration](MIGRATING.md).
