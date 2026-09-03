# Deploying Webhook Fortress

Free-tier target: **Render** (Docker web service) for the receiver, **Neon** for
Postgres. `render.yaml` in the repo root is the blueprint.

The database is deliberately *not* declared in the blueprint. Render's own free
Postgres expires, and losing the inbox is the single failure this project exists
to prevent, so the data lives somewhere that outlasts the app.

> This is not a serverless app. The worker is a long-lived loop polling Postgres
> and the retry schedule lives in `next_retry_at`, so Vercel, Netlify, Cloudflare
> Workers and Lambda cannot run it. It needs a host that keeps a process alive.

---

## 1. Generate the two secrets

```bash
openssl rand -hex 32   # WEBHOOK_SECRET   -- the sender signs with this
openssl rand -hex 32   # ADMIN_API_TOKEN  -- guards /admin/*
```

Keep both. Production **refuses to boot** without them, and refuses a
`WEBHOOK_SECRET` that is under 32 characters or looks like the `.env.example`
placeholder — a correct HMAC keyed with a public secret verifies nothing.

## 2. Create the database (Neon)

1. Sign up at <https://neon.tech> and create a project (free tier, no expiry).
2. Copy the connection string. **Append `?sslmode=require`** if it is not
   already there:

   ```
   postgres://user:password@ep-xxx.region.aws.neon.tech/neondb?sslmode=require
   ```

Managed Postgres refuses plaintext connections. The `pg` driver reads `sslmode`
straight from the URL, so no code or config change is needed.

Nothing else to do here — the receiver runs its own migrations at boot, before
it opens the listener.

## 3. Deploy the receiver (Render)

1. Push this branch to GitHub.
2. Render → **New → Blueprint** → select the repo. It reads `render.yaml`.
3. Render prompts for the three values marked `sync: false`:

   | variable | value |
   |---|---|
   | `DATABASE_URL` | the Neon string from step 2, with `?sslmode=require` |
   | `WEBHOOK_SECRET` | the first `openssl rand -hex 32` |
   | `ADMIN_API_TOKEN` | the second `openssl rand -hex 32` |

4. Deploy. Watch the logs for, in order:

   ```
   MIGRATION_APPLIED    001_init.sql
   MIGRATION_APPLIED    002_admin_auth_events.sql
   RECOVERY_COMPLETED   reclaimed=0
   SERVER_STARTED       port=10000
   ```

   `RECOVERY_COMPLETED` before `SERVER_STARTED` is the point: nothing a previous
   process left behind is still in flight by the time traffic is accepted.

Everything else in `render.yaml` is fixed configuration — read the comments
there, each one explains why the value is what it is.

## 4. Verify the deployment

```bash
BASE=https://your-service.onrender.com
TOKEN=your-admin-token
SECRET=your-webhook-secret

curl -s $BASE/health                                    # {"status":"ok",...}
curl -s -o /dev/null -w '%{http_code}\n' $BASE/admin/stats          # 401
curl -s -H "x-admin-token: $TOKEN" $BASE/admin/stats | head -c 200  # 200
curl -s -o /dev/null -w '%{http_code}\n' -X POST $BASE/admin/chaos/reset  # 404

BODY='{"eventId":"deploy-check-1","eventType":"order.created","sequence":1,"timestamp":"2026-01-01T00:00:00.000Z","data":{"amount":1}}'
SIG=$(printf '%s' "$BODY" | openssl dgst -sha256 -hmac "$SECRET" -r | cut -d' ' -f1)
curl -s -X POST $BASE/webhooks/events \
  -H 'content-type: application/json' -H "x-webhook-signature: $SIG" -d "$BODY"   # 202
```

`404` on the chaos route is the one to check twice: it means the remote SIGKILL
and remote TRUNCATE endpoints were never registered.

Then open `$BASE/` for the dashboard. It will show the lock screen — paste the
admin token once and it is remembered in that browser.

---

## Things that will bite you

**The free web service sleeps** after ~15 minutes idle, and the first request
after that takes ~30s while the container cold-starts. This is survivable here
in a way it would not be for most apps: retry schedules live in the database,
not in timers, so a sleeping receiver wakes up, runs startup recovery, and
drains whatever accumulated. A sender delivering during the cold start may time
out and retry — which the inbox absorbs as a duplicate.

**`HEALTH_MAX_BACKLOG` is set to 0 on purpose.** Render restarts a service whose
health check returns non-2xx, so a backlog-driven `503` would turn a slow queue
into a restart loop. `/health` stays pure liveness here; watch
`webhook_backlog_events` from `/metrics` instead.

**`PG_POOL_MAX` is 5, not the default 20.** Free Postgres tiers cap connections,
and Render runs the old and new instance concurrently during a deploy — so
budget for two receivers' worth of pool.

**You cannot run `npm run test:hostile` against this deployment.** It needs the
chaos endpoints, and `NODE_ENV=production` refuses to start with
`CHAOS_ENABLED=true`. That is working as designed — the hostility test SIGKILLs
the process, which belongs on your machine, not on a public URL. Run it locally
against `docker compose up`. If you specifically want a remote chaos demo,
deploy a second throwaway service with `NODE_ENV=development`, and do not point
anything real at it.

**Set `autoDeploy` yourself.** The blueprint ships with `autoDeploy: false` so a
push does not redeploy a live receiver out from under in-flight events. Turn it
on in the Render dashboard once you are happy.
