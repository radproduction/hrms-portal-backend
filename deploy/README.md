# Deploying Rad HRMS to a DigitalOcean droplet

One droplet serves everything from a single domain:

```
https://nowhrms.com/            → frontend SPA   (nginx, static files)
https://nowhrms.com/api/…       → backend        (proxy → 127.0.0.1:3000)
https://nowhrms.com/uploads/…   → uploaded files (proxy → backend)
https://nowhrms.com/socket.io/  → realtime       (proxy, websocket upgrade)
```

MongoDB stays on Atlas. Nothing about the database moves.

## Why one domain

The Vercel + Railway split forced `SameSite=None` session cookies and a
permissive CORS setup, which is what made the app CSRF-exposed. Same origin
means `SameSite=Lax`, no CORS, and no `VITE_API_URL` to keep in sync.

## Layout on the server

```
/srv/hrms/backend        backend checkout, builds to dist/
/srv/hrms/frontend       frontend checkout, builds to dist/ (nginx root)
/srv/hrms/backend/.env   secrets, root-owned, chmod 600
/var/lib/hrms/uploads    avatars and employee documents (survives deploys)
```

Uploads live **outside** the checkout on purpose. `deploy.sh` does a
`git reset --hard`, which would wipe anything inside it.

## First-time setup

1. Create an Ubuntu 24.04 droplet (2 GB RAM is plenty for 14 users).
2. Point an `A` record for the domain at the droplet's IP and wait for it to
   resolve — certbot fails otherwise.
3. SSH in as root and run:

   ```bash
   git clone https://github.com/radproduction/hrms-portal-backend.git /tmp/hrms
   bash /tmp/hrms/deploy/setup-server.sh nowhrms.com
   ```

   This installs Node 22, nginx, certbot and ufw, adds a 2 GB swapfile, clones
   both repos, creates the `hrms` service user, obtains the TLS certificate and
   installs the systemd unit.

   The domain is optional. Omit it to provision now and serve over plain HTTP
   on the droplet IP, then attach the domain later:

   ```bash
   sudo bash /srv/hrms/backend/deploy/enable-ssl.sh nowhrms.com
   ```

   `www` is handled automatically when it resolves to the same droplet: it goes
   into the certificate and is redirected to the bare domain, so the session
   cookie only ever exists on one host.

4. Create the environment file:

   ```bash
   sudo -u hrms cp /srv/hrms/backend/deploy/env.example /srv/hrms/backend/.env
   sudo nano /srv/hrms/backend/.env
   sudo chown hrms:hrms /srv/hrms/backend/.env && sudo chmod 600 /srv/hrms/backend/.env
   ```

   Carry `MONGODB_URI` and `JWT_SECRET` over from Railway unchanged. Reusing
   `JWT_SECRET` keeps everyone signed in through the cutover; changing it logs
   everyone out.

5. **Allow the droplet's IP in Atlas** → Network Access → Add IP Address.
   Skipping this is the single most common way this migration appears to
   "work" while every screen shows empty data — `connectToMongoDB()` logs the
   failure and the app keeps serving empty results instead of erroring.

6. Deploy:

   ```bash
   sudo bash /srv/hrms/backend/deploy/deploy.sh
   ```

## Routine deploys

```bash
sudo bash /srv/hrms/backend/deploy/deploy.sh          # main
sudo BRANCH=some-branch bash /srv/hrms/backend/deploy/deploy.sh
```

It pulls both repos, rebuilds, restarts the service, reloads nginx and fails
loudly if the backend does not come back up.

## Checks after deploying

```bash
sudo systemctl status hrms-backend
sudo journalctl -u hrms-backend -f
```

Look for `[Uploads] serving /var/lib/hrms/uploads` and
`[MongoDB] Connected successfully` in the log. If the uploads path reads
anything else, `UPLOADS_DIR` did not reach the process.

In the browser:

- log in, confirm the session survives a refresh (cookie is `Lax` + `Secure`)
- upload a payslip PDF, then download it back
- open two accounts and check a notification arrives live (websocket)
- Admin → Advanced Reports → pick an employee and a month

## Cutover

1. Deploy and test on the droplet while Railway/Vercel are still live.
2. Repoint the Wingman desktop agent at
   `https://nowhrms.com/api/wingman/clock`. The Vercel proxy function
   (`frontend/api/wingman/clock.ts`) has no equivalent here and is not needed —
   the backend has always exposed that route itself.
3. Move any existing uploads across, if they still exist on the Railway volume:

   ```bash
   # from a machine with access to both
   scp -r ./railway-uploads/* root@DROPLET_IP:/var/lib/hrms/uploads/
   ssh root@DROPLET_IP 'chown -R hrms:hrms /var/lib/hrms/uploads'
   ```

4. Switch DNS, watch the logs, then shut down the Railway service and the
   Vercel project.

## Backups

Atlas handles the database. The uploads directory does not back itself up:

```bash
# nightly, keep 14 days
0 2 * * * tar -czf /var/backups/hrms-uploads-$(date +\%F).tar.gz -C /var/lib/hrms uploads \
          && find /var/backups -name 'hrms-uploads-*.tar.gz' -mtime +14 -delete
```

## TLS renewal

certbot installs its own systemd timer. Confirm with:

```bash
sudo systemctl list-timers | grep certbot
sudo certbot renew --dry-run
```
