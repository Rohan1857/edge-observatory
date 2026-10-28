-- Local-only fixture; this domain deliberately cannot represent a real site.
INSERT INTO sites (domain, timezone, allowed_hostnames)
VALUES ('portfolio.example', 'UTC', '["portfolio.example"]')
ON CONFLICT(domain) DO NOTHING;
