# Running several organisations on one domain

Three companies, three portals, one droplet, one domain:

| URL | Tenant | Port | Database | Code |
|---|---|---|---|---|
| `nowhrms.com` | Rad (existing) | 3000 | `hrms` | `/srv/hrms` — unchanged |
| `skntheory.nowhrms.com` | SKN Theory | 3001 | its own | `/srv/tenants/skntheory` |
| `movment.nowhrms.com` | Movment | 3002 | its own | `/srv/tenants/movment` |

Each tenant is a separate process with its own `.env`, its own database and its
own uploads directory. Nothing is shared.

## Why subdomains and not `nowhrms.com/skntheory`

Path prefixes were the original request, and they are possible, but on one
origin the three portals fight each other:

- The session cookie is `app_session_id` at `path: "/"` in every copy of this
  codebase. Three portals on one origin share one cookie jar, so signing in to
  one signs you out of the others. Fixing that means making the cookie name and
  path configurable in `backend/_core/cookies.ts` and rebuilding all three.
- `localStorage` is per origin too, so the `theme` key and anything else cached
  there is shared between companies.
- An XSS in one company's portal could read another's `localStorage` and call
  its API.

Subdomains give each organisation its own origin, which removes all three
problems at the browser level. They also need **no application code changes**:
no `base` in `vite.config.ts`, no `<Router base>`, no rewritten API URLs. Only
nginx and DNS. The domain is still one domain, with one certificate per
subdomain.

## Files here

| File | What it is |
|---|---|
| `setup-tenant.sh` | One-time provisioning for a new organisation |
| `deploy-tenant.sh` | Pull, build, restart, health-check one tenant |
| `enable-ssl-tenant.sh` | Get the certificate and switch that tenant to HTTPS |
| `hrms-tenant@.service` | systemd **template** unit — one file serves every tenant |
| `nginx-tenant-http.conf` | nginx site, plain HTTP — goes in first |
| `nginx-tenant.conf` | nginx site, HTTPS — swapped in after certbot |
| `env.example` | Per-tenant environment |

`hrms-tenant@.service` is a template, so `systemctl restart hrms-tenant@movment`
works without a second unit file ever being written.

### Why there are two nginx configs

nginx refuses to load a config whose `ssl_certificate` file is missing, and it
checks every enabled site. Enabling the HTTPS config before certbot has issued
anything would therefore fail `nginx -t` **server-wide** — blocking every
reload, and stopping nginx from starting after a reboot. That would take
`nowhrms.com` down along with the new tenant.

So a tenant goes up on plain HTTP first, certbot proves the domain against that
running site, and only then does `enable-ssl-tenant.sh` swap in the HTTPS
config. Same two-phase pattern the original portal used.

## Adding an organisation

```bash
sudo bash /srv/hrms/backend/deploy/tenants/setup-tenant.sh skntheory 3001 \
     https://github.com/radproduction/skntheory-hrms-backend.git \
     https://github.com/AsadKhan2951/skntheory-hrms-portal.git
```

That clones both repositories, creates the uploads directory, installs the
systemd unit and writes the nginx site — then stops and prints what is left,
because the next steps need values only you have:

1. Fill in `/srv/tenants/skntheory/backend/.env` — `MONGODB_URI`, `JWT_SECRET`,
   `OFFICE_LAT`, `OFFICE_LNG`, `OFFICE_RADIUS_KM`. Take them from that
   project's Vercel environment variables so the existing data and sessions
   carry over.
2. Add an A record `skntheory.nowhrms.com` → the droplet, and wait for
   `dig +short skntheory.nowhrms.com` to answer.
3. `sudo systemctl enable hrms-tenant@skntheory`
4. `sudo bash deploy-tenant.sh skntheory` — builds and starts it on HTTP
5. `sudo bash enable-ssl-tenant.sh skntheory` — certificate, then HTTPS

Step 5 has to come after step 4: certbot proves the domain against the site
that is already serving on port 80.

## The repositories

Every organisation uses the same split layout: backend and frontend are
separate repositories under different GitHub accounts, checked out side by side
under `/srv/tenants/<name>/`.

| Tenant | Backend | Frontend |
|---|---|---|
| heard (Rad) | `radproduction/hrms-portal-backend` | `AsadKhan2951/hrms-portal-frontend` |
| skntheory | `radproduction/skntheory-hrms-backend` | `AsadKhan2951/skntheory-hrms-portal` |
| movment | `radproduction/movment-hrms-backend` | `AsadKhan2951/movment-hrms-frontend` |

Because the two accounts differ, each clone may ask for its own credentials and
only one GitHub identity is stored at a time. Clone both by hand first if that
gets in the way; `setup-tenant.sh` skips anything already cloned.

## Prerequisites you have to sort out first

**Their environment values live in Vercel.** Neither folder has a `.env`. Pull
`MONGODB_URI`, `JWT_SECRET` and the office geofence out of each project's
Vercel settings. A fresh `JWT_SECRET` is safe but signs everyone out; password
hashes are stored separately and are unaffected.

**`OFFICE_LAT` / `OFFICE_LNG` / `OFFICE_RADIUS_KM` differ per company.** Copying
Rad's values would place the geofence over the wrong building and break
check-in for that organisation.

## Memory

The droplet is 2 GB with 2 GB of swap, and a vite build here is ~3500 modules.
It handles one build comfortably and will not survive two at once, so deploy
tenants one after another. Three idle Node processes are fine; the builds are
the pinch point. `deploy-tenant.sh` caps the heap at 1536 MB for this reason.

Watch it during the first two deploys:

```bash
free -h
systemctl status hrms-tenant@skntheory --no-pager
```

If builds start failing on memory, build elsewhere and rsync `dist/` up, or
resize the droplet.

## The existing Rad portal is untouched

`nowhrms.com` keeps `hrms-backend.service`, `/srv/hrms`, and its split
backend/frontend repository layout. It is live, so it is deliberately left
alone rather than migrated as part of this. It can be folded into this scheme
later — the only real change is moving it behind `heard.nowhrms.com` — with no
downtime, once the two new tenants are proven.
