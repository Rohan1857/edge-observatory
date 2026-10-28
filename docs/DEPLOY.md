# Deployment

The root `wrangler.free.example.jsonc` configures one Worker, a SQLite Durable Object per site, D1 and R2. The DuckDB archive Worker is optional. Check Cloudflare resource pricing before creating hosted storage.

## Configuration

Build the static assets and copy the example to a private config:

```sh
npm ci
npm run build
cp wrangler.free.example.jsonc wrangler.jsonc
```

On PowerShell, use `Copy-Item wrangler.free.example.jsonc wrangler.jsonc` for the last command. The destination is gitignored.

Create a D1 database named `edge-observatory` and an R2 bucket named `edge-observatory-data` in the target Cloudflare account. Update the private config with the returned database ID, your Worker name, `APP_HOST` and `COMPAT_ENDPOINT`. The latter should point to `https://<your-host>/api/event`.

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
