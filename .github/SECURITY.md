# Security

Use GitHub's private vulnerability reporting if it is enabled for this repository. Avoid including credentials or visitor data in public issues.

## Design notes

- **Sign-in** is delegated to Cloudflare Access. The Worker verifies Access's JWT signature, issuer and audience on every API request, and maps the email to a QWA user. Unknown emails get no data.
- **Authorisation** is per site: viewers can only query sites they've been granted. Admin routes check the admin role.
- **Write requests** must be same-origin and JSON (blocks cross-site form posts).
- **Local-only switches:**
  - `DEV_USER_EMAIL` (skip Access) and `DEMO` (seed synthetic data) only take effect on `localhost`.
  - Never set either in a deployed Worker.
- **Visitor identity:**
  - visitors are a salted hash that changes daily, and old salts are deleted
  - IP addresses and user agents are used during ingestion and then discarded
