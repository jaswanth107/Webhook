# 🛡 Webhook Fortress

A webhook receiver built for a sender you cannot trust and cannot control.

It accepts `POST /webhooks/events` from an external system that will, at some point,
deliver the same event fifty times in two seconds, deliver events out of order, forge
signatures, send garbage, and disappear mid-request — while the receiver itself is being
killed with `SIGKILL` halfway through a database write.

The product here is not the endpoint. **The product is the proof** that under all of
that, the database ends up in exactly one state:

> every valid event is accounted for **exactly once**, as either `PROCESSED` (with exactly
> one business effect) or `DEAD_LETTERED` (with its payload preserved) — with zero
> duplicates, zero unexplained losses, and zero rejected requests anywhere in the inbox.

`npm run test:hostile` sends 1,000 logical events under all of those conditions and then
proves that state with SQL.

---

## Table of contents

- [What it does](#what-it-does)
- [Architecture](#architecture)
- [Why idempotency matters](#why-idempotency-matters)
- [Database schema](#database-schema)
- [How duplicates are handled](#how-duplicates-are-handled)
- [Crash recovery](#crash-recovery)
- [Retry strategy](#retry-strategy)
- [Dead-letter handling](#dead-letter-handling)
- [Out-of-order events](#out-of-order-events)
- [HMAC security](#hmac-security)
- [How to run](#how-to-run)
- [How to run the hostility test](#how-to-run-the-hostility-test)
- [Testing with your own events](#testing-with-your-own-events)
- [Expected results](#expected-results)
- [API reference](#api-reference)
- [Dashboard](#dashboard)
- [Automated tests](#automated-tests)
- [Configuration](#configuration)
- [Admin API authentication](#admin-api-authentication)
- [Production safety guards](#production-safety-guards)
- [Key design decisions](#key-design-decisions)
- [Edge cases handled](#edge-cases-handled)
- [Project layout](#project-layout)

---

## What it does

| Hostile condition | How the system survives it |
|---|---|
| The same event delivered many times | `UNIQUE(event_id)` on the inbox + `INSERT … ON CONFLICT` — one row, always |
| 50 deliveries in 2 seconds | The unique index resolves the race; 1 delivery inserts, 49 get `200 duplicate` |
| Events arriving out of order | Each event is stored and processed independently; sequence is preserved, never required |
| Receiver killed mid-write | Business effect + status update share one transaction; startup recovery re-queues the rest |
| Invalid / tampered signature | Timing-safe HMAC-SHA256 over the raw body, verified **before** the body is parsed |
| Missing signature | `401`, logged to `security_events`, never written to the inbox |
| Temporary processing failure | Exponential backoff with jitter, retry schedule persisted in the database |
| Permanent processing failure | Dead-lettered after `MAX_PROCESSING_ATTEMPTS` with the full payload retained |
| Receiver restart | Recovery runs before the listener opens; retry state lives in Postgres, not in timers |
| Someone probing the admin API | Timing-safe token check, `401`, logged to `security_events` like any other rejection |
| Accepting deliveries but not draining them | `/health` reports the backlog and turns `503` past `HEALTH_MAX_BACKLOG` |

---

## Architecture

```
        External sender (untrusted, uncontrollable)
                        │  POST /webhooks/events
                        ▼
        ┌───────────────────────────────────┐
        │  1. RAW body captured (Buffer)    │   never re-serialised
        │  2. HMAC-SHA256 verify (timing-   │   401 → security_events
        │     safe) — before any parsing    │
        │  3. JSON parse + zod schema       │   400 → security_events
        │  4. INSERT … ON CONFLICT          │   ← the idempotency boundary
        │  5. COMMIT, then acknowledge      │   202 accepted / 200 duplicate
        └───────────────┬───────────────────┘
                        │  (fast ack; no business work on the request path)
                        ▼
              webhook_events  ── the durable inbox (source of truth)
                        │
        ┌───────────────┴───────────────────────────────┐
        │  Worker: claim with FOR UPDATE SKIP LOCKED    │
        │    BEGIN                                      │
        │      SELECT … FOR UPDATE                      │
        │      already PROCESSED? → stop                │
        │      run business logic                       │
        │      INSERT processed_results (UNIQUE)        │
        │      UPDATE status = 'PROCESSED'              │
        │    COMMIT      ← effect and status, together  │
        └───────┬───────────────────────┬───────────────┘
                │ success               │ failure
                ▼                       ▼
        processed_results        attempts < MAX ?
        (one row per event)      ├── yes → RETRY_PENDING, next_retry_at = now + backoff
                                 └── no  → dead_letter_events + status DEAD_LETTERED

        Lease reaper (every PROCESSING_TIMEOUT/2) and startup recovery return
        anything stuck in PROCESSING to the retry queue.
```

Every arrow that matters crosses a database constraint, not an application `if`.

---

## Why idempotency matters

Webhook delivery is **at-least-once**, never exactly-once, and that is not a bug in the
sender — it is unavoidable. The sender writes its event, calls you, and waits for a 2xx.
If your response is lost (you crashed after committing, the connection dropped, a load
balancer timed out), the sender cannot tell "you never got it" apart from "you got it and
the ack vanished". Its only safe move is to send it again.

So the sender's duty is *at least once*, and **the receiver's duty is to make the business
effect happen at most once**. Together those give exactly-once *effects* over an
at-least-once *channel*. That contract is the whole design:

```
one eventId  =  one row in webhook_events  =  at most one row in processed_results
```

`eventId` is the idempotency key, and it is enforced by the database, not by the process.

---

## Database schema

### `webhook_events` — the durable inbox
One row per **unique logical event**.

| column | purpose |
|---|---|
| `event_id` **UNIQUE** | the idempotency key — the single most important constraint in the system |
| `event_type`, `sequence`, `event_timestamp`, `payload` (JSONB) | the event as signed by the sender |
| `status` | `RECEIVED · PROCESSING · PROCESSED · RETRY_PENDING · FAILED · DEAD_LETTERED` (CHECK-constrained) |
| `processing_attempts` | incremented at **claim** time, so a crash still burns an attempt |
| `processing_started_at` | the processing **lease**; a stale lease means a crashed worker |
| `next_retry_at` | the retry schedule — in the database, so it survives a restart |
| `delivery_count`, `first_delivery_at`, `last_delivery_at` | how many HTTP deliveries this one event caused |
| `last_error`, `received_at`, `processed_at`, `created_at`, `updated_at` | observability |

### `processed_results` — the business effect
| column | purpose |
|---|---|
| `event_id` **UNIQUE** → `webhook_events` | the second, independent safety net |
| `result_type`, `processed_data` (JSONB), `attempt_number`, `created_at` | what was booked, and by which attempt |

Even if the application logic were wrong, **the database physically cannot record the same
business effect twice.**

### `webhook_attempts` — the audit trail
Append-only. `source` is `DELIVERY` (an HTTP request arrived), `PROCESSING` (a processing
attempt finished), `RECOVERY` (a stalled event was reclaimed) or `ADMIN_REPLAY`. This is
what makes a retry storm explainable after the fact.

### `dead_letter_events` — permanent failures
`original_event_id` **UNIQUE**, plus the full `payload`, `failure_reason`, `total_attempts`,
`dead_lettered_at`, `replayed_at`. Nothing is ever silently discarded.

### `security_events` — rejected traffic
Reason, signature fingerprint (never the signature or the secret), remote IP, byte count.
Rejected requests are recorded **here and nowhere else** — that separation is exactly what
verification query 7 proves.

---

## How duplicates are handled

The entire receive path's idempotency is one statement:

```sql
INSERT INTO webhook_events (event_id, event_type, sequence, event_timestamp, payload, status)
VALUES ($1, $2, $3, $4, $5::jsonb, 'RECEIVED')
ON CONFLICT (event_id) DO UPDATE
   SET delivery_count   = webhook_events.delivery_count + 1,
       last_delivery_at = now()
RETURNING *, (xmax = 0) AS inserted;
```

* **Atomic.** Not `SELECT` then `INSERT` — that has a race window between the two, and
  under a 50-request storm that window is hit constantly.
* **Self-reporting.** `xmax = 0` tells us whether the returned row came from the INSERT
  branch (a new event → `202 accepted`) or the UPDATE branch (a duplicate → `200 duplicate`).
* **Countable.** Duplicates are not thrown away, they are *counted*, so the dashboard can
  show "this event was delivered 50 times" instead of pretending it happened once.

Under concurrency Postgres serialises the conflicting inserts on the unique index: exactly
one transaction inserts, the rest take the update branch. No application lock is involved,
so it stays correct with multiple receiver processes.

An in-memory `Set` would fail every one of these: it is empty after a restart, it is not
shared between processes, and it is not consulted by the second worker that claims the
same event.

---

## Crash recovery

The hostility test kills the receiver with `SIGKILL` (`process.kill(pid, 'SIGKILL')` — no
handlers, no `finally`, no graceful shutdown, no COMMIT). Four moments matter:

| Crash point | What the database holds afterwards | What happens on restart |
|---|---|---|
| Before the inbox insert | nothing | The sender's retry delivers it again; it lands once |
| After the insert, before processing | event `RECEIVED` | The worker's claim query finds it — no repair needed |
| **During processing, before COMMIT** | event `PROCESSING`, **no** effect (rolled back) | Recovery returns it to `RETRY_PENDING`; it processes exactly once |
| After COMMIT | event `PROCESSED` + its effect | Nothing to do; a duplicate delivery answers `200 duplicate` |

There is deliberately **no** "effect written but status not updated" state, because those
two writes are the same transaction:

```
BEGIN
  SELECT … FOR UPDATE            -- serialise against other workers
  if already PROCESSED → stop    -- repeat work is a no-op
  run business logic
  INSERT processed_results       -- UNIQUE(event_id), ON CONFLICT DO NOTHING
  UPDATE status = 'PROCESSED'
COMMIT                           -- both, or neither
```

Two mechanisms bring interrupted work back:

* **Startup recovery** (`runStartupRecovery`) runs *before the HTTP listener opens*, so the
  receiver never serves traffic with orphaned work sitting in `PROCESSING`.
* **The lease reaper** runs every `PROCESSING_TIMEOUT_SECONDS / 2` while the process is
  alive, catching stalls (a hung downstream call) as well as crashes.

Both record a `RECOVERY` row in `webhook_attempts`, which is also the poison-pill guard: an
event that has interrupted the receiver more than `MAX_PROCESSING_ATTEMPTS` times is
dead-lettered instead of being allowed to crash-loop forever. (Interruptions are counted
separately from failures, because a killed process never gave the event a verdict.)

---

## Retry strategy

```
delay(attempt) = min(RETRY_BASE_DELAY_MS × 2^(attempt-1), RETRY_MAX_DELAY_MS) ± jitter
```

With the defaults (`base 1000ms`, `max attempts 5`): **1s → 2s → 4s → 8s**, then the fifth
failure dead-letters. Jitter (±20% by default) matters when a downstream outage fails a
thousand events at the same instant: without it every retry lands in the same millisecond
and recreates the herd that caused the outage.

Retry state is a **row**, not a timer:

* `status = 'RETRY_PENDING'`, `next_retry_at = <when>`, `last_error = <why>`
* the worker's claim query is simply *"what is due right now?"*

That is why retries survive a restart — a fresh process reads the schedule out of Postgres
and picks up exactly where the killed one left off. `setTimeout` state would have died with
the process.

Attempts are incremented **at claim time**, inside the same statement that takes the row,
so an event that kills the receiver cannot get an unlimited retry budget.

---

## Dead-letter handling

After `MAX_PROCESSING_ATTEMPTS` failures (or immediately, for a failure the handler marks
non-retryable), one transaction copies the event into `dead_letter_events` — full payload,
failure reason, attempt count — and flips the original to `DEAD_LETTERED`. The copy and the
status change commit together, so an event can never be marked dead without its payload
being preserved first.

Inspect them at `GET /admin/dead-letters` or on the dashboard's Dead Letters tab, and
replay one with `POST /admin/dead-letters/:eventId/retry`. Replay keeps the **original
`eventId`**, so `UNIQUE(event_id)` on `processed_results` still permits exactly one business
effect — a replayed event that succeeds cannot double-book.

---

## Out-of-order events

Sequence numbers are **recorded, never required**. The hostility test shuffles the entire
delivery stream (typically ~50% of all sequence pairs arrive inverted), and the receiver
accepts every event on arrival.

Rejecting `sequence 5` because `sequence 4` has not arrived would be a correctness
disaster: `4` may be delayed, retried, or genuinely lost, and holding `5` hostage converts
a delivery hiccup into permanent data loss. Instead each event is an independent,
self-contained fact; `sequence` is stored (indexed, displayed, queryable) so that a
consumer who *does* need ordering can sort by it after the fact — which is a read-side
concern, not a reason to drop writes.

---

## HMAC security

```
signature = HMAC_SHA256(raw_request_body, WEBHOOK_SECRET)   →   X-Webhook-Signature
```

1. **The raw bytes are what get verified.** The body is captured as a `Buffer` by a custom
   Fastify content-type parser. Parsing to an object and re-stringifying would change the
   bytes (key order, whitespace) and break valid deliveries.
2. **Verification comes before parsing.** An unverified body is hostile input; it is never
   `JSON.parse`d, never stored, and never logged.
3. **Comparison is timing-safe** (`crypto.timingSafeEqual`). `===` leaks how many leading
   bytes of a guess were right, which is enough to forge a signature byte by byte.
4. **`sha256=<hex>` and bare `<hex>` are both accepted**; anything that is not a 64-char hex
   digest is rejected as `MALFORMED_SIGNATURE` without touching the secret path.
5. **Failures are logged without leaking.** The log records a *fingerprint* (first 8 hex of
   SHA-256 of the supplied signature) and the body size — never the secret, never the
   expected signature, never the unverified payload.

| Condition | Response |
|---|---|
| Valid signature, new event | `202 {"status":"accepted","eventId":"…"}` |
| Valid signature, duplicate | `200 {"status":"duplicate","eventId":"…","eventStatus":"…","deliveryCount":n}` |
| Missing signature | `401 {"error":"Missing webhook signature","reason":"MISSING_SIGNATURE"}` |
| Invalid / tampered / wrong secret | `401 {"error":"Invalid webhook signature","reason":"INVALID_SIGNATURE"}` |
| Valid signature, invalid JSON | `400 {"error":"Invalid JSON body","reason":"INVALID_JSON"}` |
| Valid signature, schema violation | `400 {"error":"Invalid event payload","reason":"SCHEMA_INVALID","detail":"…"}` |
| Body over 1 MiB | `413 {"error":"Payload too large"}` |

---

## How to run

### With Docker (recommended — this is what the hostility test drives)

```bash
git clone <this repo> && cd webhook-fortress
cp .env.example .env          # already contains working defaults
docker compose up --build     # Postgres + receiver, migrations run on boot
```

* Dashboard → <http://localhost:3000>
* Health → <http://localhost:3000/health>
* Postgres → `localhost:5433` (`fortress` / `fortress` / `webhook_fortress`)

The database lives in a named volume (`fortress_pgdata`) and survives receiver restarts —
which is the point: killing the receiver must not lose a single event.

### Locally, without Docker for the app

```bash
docker compose up -d db       # just Postgres
npm install
npm run db:migrate
npm run dev                   # tsx watch on :3000
```

### npm scripts

| script | what it does |
|---|---|
| `npm run dev` | receiver in watch mode |
| `npm run build` / `npm start` | compile to `dist/` / run the compiled server |
| `npm run db:migrate` | apply SQL migrations (also runs automatically on boot) |
| `npm run db:reset` | truncate every event table |
| `npm run test:hostile` | **the full 1,000-event hostility test + verification** |
| `npm run send:1000` | just the hostile sender |
| `npm run send:event` | send **one event of your own**, signed, and watch what the database does with it |
| `npm run verify` | just the verification report against the current database |
| `npm run chaos` | focused crash/recovery test |
| `npm test` | automated test suite (39 tests) |
| `npm run lint` / `npm run typecheck` | TypeScript strict-mode check of every file |
| `npm run stack:up` / `stack:down` / `stack:logs` | docker compose helpers |

---

## How to run the hostility test

```bash
npm run test:hostile
```

That single command:

1. builds and starts the Docker stack, waits for `/health`
2. truncates the database
3. runs the hostile sender:
   * **1,000 unique logical events** (`evt_0001 … evt_0990`, plus the special ones below)
   * **deliberate duplicates** — `evt_0100` ×3, `evt_0200` ×5, `evt_0300` ×10
   * **a retry storm** — `evt_storm_001` delivered **50 times simultaneously** (<2s)
   * **out-of-order arrival** — the whole stream is shuffled with a seeded PRNG
   * **30 forged deliveries** — 10 wrong-secret signatures, 10 with no signature header,
     10 bodies modified after signing
   * **10 malformed deliveries** — 5 schema violations, 5 invalid JSON (all correctly signed)
   * **8 transient failures** — `evt_retry_001…008` fail twice, then succeed
   * **1 permanent failure** — `evt_dead_001` fails every attempt
   * **1 mid-flight `SIGKILL`** after 500 deliveries, while events are still processing;
     the sender keeps retrying through the outage exactly as a real sender would
4. waits for processing to settle
5. runs `scripts/verify-results.ts` and prints **PASS / FAIL**

Useful variants:

```bash
npm run test:hostile -- --no-docker          # against an already-running receiver
npm run test:hostile -- --events 200         # smaller run
npm run test:hostile -- --no-crash           # skip the mid-flight kill
npm run chaos -- --events 300 --crash-at 120 # focused crash test
npm run verify                               # re-verify without re-sending
```

Raw SQL evidence (12 queries, including all seven required ones):

```bash
docker compose exec -T db psql -U fortress -d webhook_fortress -f - < sql/verification.sql
```

---

## Testing with your own events

The hostility test uses generated traffic. To check the receiver against **your**
values, use the single-event sender — it signs the body correctly, delivers it, and then
follows the event through the database until it reaches a terminal state:

```bash
# from a file (missing fields are filled in for you)
cat > my-event.json <<'JSON'
{
  "eventId": "evt_mine_001",
  "eventType": "order.created",
  "sequence": 42,
  "data": { "orderId": "order_abc", "customerId": "cust_777", "amount": 2499.50 }
}
JSON
npm run send:event -- --file my-event.json --watch

# or inline
npm run send:event -- --id evt_mine_002 --type payment.captured --data '{"amount":99}' --watch
```

```
→ POST http://localhost:3000/webhooks/events
  eventId : evt_mine_001
  mode    : valid signature
  HTTP 202 ×1  {"status":"accepted","eventId":"evt_mine_001"}

  status          : PROCESSED
  attempts        : 1
  deliveries      : 1
  business effect : 1 (order.created.processed)
  timeline        :
     DELIVERY   ACCEPTED       #1
     PROCESSING SUCCESS        #1
  effect payload  : {"amount":2499.5,"eventId":"evt_mine_001","orderId":"order_abc",…}
```

### Reproducing each hostile condition with your own event

| what you want to check | command | expected |
|---|---|---|
| Duplicates / retry storm | `npm run send:event -- --file my-event.json --times 20 --concurrent --watch` | 1×`202`, 19×`200 duplicate`, `deliveries: 20`, **1** business effect |
| Forged signature | `npm run send:event -- --file my-event.json --bad-signature --watch` | `401`, and *"the receiver has NO record of this event"* |
| Missing signature | `npm run send:event -- --file my-event.json --no-signature --watch` | `401`, nothing in the inbox |
| Body modified after signing | `npm run send:event -- --file my-event.json --tamper` | `401 INVALID_SIGNATURE` |
| Invalid JSON (correctly signed) | `npm run send:event -- --raw broken.txt` | `400 INVALID_JSON` |
| Schema violation | `npm run send:event -- --raw no-event-id.json` | `400 SCHEMA_INVALID` |
| Transient failure → retries → success | add `"failUntilAttempt": 3` to `data` | `attempts: 3`, `PROCESSED`, **1** effect |
| Permanent failure → dead letter | add `"alwaysFail": true` to `data` | `DEAD_LETTERED` after 5 attempts, **0** effects |
| Non-retryable failure | add `"nonRetryable": true` to `data` | `DEAD_LETTERED` on attempt 1 |
| Crash mid-processing | `curl -XPOST localhost:3000/admin/chaos/crash` while events are in flight | recovered on restart, no duplicates |

`--raw` sends the file's bytes verbatim, which is what you want for malformed input —
`--file` deliberately fills in a missing `eventId`/`timestamp` for you, so it would never
produce a schema error.

The three failure-injection fields (`failUntilAttempt`, `alwaysFail`, `nonRetryable`) live
in `data` and only do anything while `SIMULATE_FAILURES=true`. With it off, your payload is
processed normally and those keys are ignored.

### Checking the result yourself

```bash
# the API the dashboard uses
curl -s localhost:3000/admin/events/evt_mine_001 | jq

# or straight from Postgres
docker compose exec -T db psql -U fortress -d webhook_fortress \
  -c "SELECT event_id, status, processing_attempts, delivery_count FROM webhook_events WHERE event_id='evt_mine_001';" \
  -c "SELECT * FROM processed_results WHERE event_id='evt_mine_001';" \
  -c "SELECT source, status, attempt_number, error_message FROM webhook_attempts WHERE event_id='evt_mine_001' ORDER BY id;"
```

Or open the event in the dashboard directly:
`http://localhost:3000/?view=events&event=evt_mine_001`

### Signing by hand

If you would rather drive it from curl or your own client, the signature is just an
HMAC-SHA256 of the exact bytes you send:

```bash
BODY='{"eventId":"evt_curl_1","eventType":"order.created","sequence":1,"timestamp":"2026-09-02T10:00:00.000Z","data":{"amount":10}}'
SIG=$(printf '%s' "$BODY" | openssl dgst -sha256 -hmac "$WEBHOOK_SECRET" -hex | awk '{print $NF}')
curl -X POST localhost:3000/webhooks/events \
  -H 'content-type: application/json' \
  -H "X-Webhook-Signature: $SIG" \
  -d "$BODY"
```

Sign the **raw bytes you actually transmit** — if your client reformats the JSON after you
sign it, the signature will (correctly) no longer match.

---

## Expected results

Actual output of `npm run test:hostile` on this implementation (one full run — the
crash-dependent numbers, such as how many events were mid-processing when the kill landed,
vary a little between runs; the correctness numbers never do):

```
==============================================================
WEBHOOK HOSTILITY TEST REPORT
==============================================================

Logical Valid Events Expected:      1000
Total HTTP Deliveries Sent:         1104
Unique Events Received:             1000
Deliveries Recorded (incl. dupes):  1079
Successfully Processed:             999
Business Effects (processed_results):999
Dead Letter Events:                 1
Duplicate Business Effects:         0
Unexplained/Lost Events:            0
Invalid Signature Events Accepted:  0
Rejected Requests Logged:           40
Retry Storm:                        50 deliveries -> 1 event row -> 1 business effect
Events Retried (attempts > 1):      22
Crash Recovery:                     PASS

--------------------------------------------------------------
CHECKS
--------------------------------------------------------------
 PASS  Q1  Unique events received                          1000
 PASS  Q1b No duplicate event rows                         1000 == 1000
 PASS  Q2  Duplicate business effects                      0 rows
 PASS  Q3  Expected vs actual reconciliation               0 unexplained
                                                           (999 processed + 1 dead-lettered of 1000)
 PASS  Q3b No unexpected events in the inbox               0 extras
 PASS  Q4  Lost / stranded events                          0 rows
 PASS  Q5  Dead-letter store holds the permanent failure   evt_dead_001
 PASS  Q6  Temporary failures were retried                 8 retried, 0 below expectation
 PASS  Q7  Invalid-signature events accepted               0
 PASS  Q7b Rejected requests were logged                   40
 PASS  Q8  Retry storm collapsed to one effect             50 -> 1 event row, 1 effect
 PASS  Q9  Deliberate duplicates -> one effect each        0 with >1 effect
 PASS  Q11 PROCESSED events all have a business effect     0 mismatches
 PASS  Q12 Dead-lettered events have NO business effect    0 rows
 PASS  Business effects == processed events                999
 PASS  Out-of-order delivery actually happened             53.5% of sampled pairs inverted
 PASS  Processing settled (no in-flight work left)         stable
 PASS  Crash recovery                                      killed after 500 deliveries,
                                                           back in 800ms, 13 events reclaimed

==============================================================
OVERALL RESULT: PASS
==============================================================

Attempt ledger (webhook_attempts):
  DELIVERY     ACCEPTED       991      DELIVERY     DUPLICATE      79
  PROCESSING   SUCCESS        999      PROCESSING   FAILED         21
  PROCESSING   DEAD_LETTERED  1        RECOVERY     RECLAIMED      13

Dead-letter contents:
  evt_dead_001 after 5 attempts -- Exhausted 5 processing attempts.
  Last error: Simulated permanent downstream failure for evt_dead_001 (attempt 5)
```

Reading the numbers:

* **1,104 HTTP requests → 1,000 event rows.** 1,079 recorded deliveries (the 79 extras are
  the deliberate duplicates, the storm, and sender retries during the crash window) plus 40
  rejected requests that never touched the inbox. A handful of requests got no response at
  all because the receiver was killed mid-request — the sender retried those, which is
  exactly how at-least-once delivery produces duplicates in the wild.
* **999 processed + 1 dead-lettered = 1,000.** Every valid event ends in exactly one
  terminal state. Nothing unexplained.
* **999 business effects for 999 processed events.** Not 1,000, not 1,080 — one per event.
* **13 events were mid-processing when the receiver was killed** and were reclaimed by
  startup recovery, then finished. None of them produced a second effect.
* **21 processing failures** = 8 transient events × 2 failed attempts + `evt_dead_001` × 5.

---

## API reference

| method | route | purpose |
|---|---|---|
| `POST` | `/webhooks/events` | the webhook endpoint (HMAC-verified) |
| `GET` | `/health` | liveness + readiness: `{"status","database","worker","backlog","byStatus"}`; `503` past `HEALTH_MAX_BACKLOG` |
| `GET` | `/metrics` | Prometheus text exposition — aggregates only, no payloads |
| `GET` | `/admin/stats` | dashboard counters |
| `GET` | `/admin/integrity` | live versions of the duplicate/lost-event queries |
| `GET` | `/admin/events` | `?status=&eventId=&eventType=&page=&limit=` |
| `GET` | `/admin/events/:eventId` | event + attempts + business effect + dead-letter record |
| `GET` | `/admin/dead-letters` | permanently failed events |
| `POST` | `/admin/dead-letters/:eventId/retry` | replay one (idempotency preserved) |
| `GET` | `/admin/security-events` | rejected requests with reasons |
| `POST` | `/admin/chaos/crash` | **test only** — `SIGKILL`s the receiver (`CHAOS_ENABLED`) |
| `POST` | `/admin/chaos/reset` | **test only** — truncates all tables (`CHAOS_ENABLED`) |

Both chaos routes are **not registered at all** unless `CHAOS_ENABLED=true`, so a
production deployment has no remote kill switch. (A test asserts this, and
`NODE_ENV=production` refuses to boot with `CHAOS_ENABLED=true` at all.)

Every `/admin/*` route requires `ADMIN_API_TOKEN` when it is set — see
[Admin API authentication](#admin-api-authentication). `/webhooks/events`, `/health` and
`/metrics` are never token-guarded.

`/metrics` is scrape-ready and carries the correctness invariants as alertable gauges:

```
webhook_duplicate_effects_total 0          # MUST be 0 -- an event acted on twice
webhook_processed_without_effect_total 0   # MUST be 0 -- marked done without doing it
webhook_backlog_events 0                   # accepting but not draining
webhook_events_by_status{status="DEAD_LETTERED"} 1
```

---

## Dashboard

<http://localhost:3000> — a dark infrastructure-console UI served by the receiver itself
(no build step, no framework).

* **Overview** — total received, processed, pending, retry-pending, dead letters, duplicate
  requests, invalid signatures; a live integrity panel running the correctness queries; a
  status breakdown; the latest events.
* **Events** — filter by status, search by `eventId`, paginate; columns for attempts,
  delivery count, timestamps and last error.
* **Event detail** (click any row) — full JSON payload, the processing timeline and retry
  history from `webhook_attempts`, errors, signature status, duplicate delivery count, and
  the recorded business effect. Deep-linkable: `?view=events&event=evt_retry_001`.
* **Dead Letters** — permanently failed events with a one-click **Retry**.
* **Security** — every rejected request, its reason and signature fingerprint, next to a
  counter proving none of them reached the inbox.

Auto-refreshes every 3s (toggleable), with loading, empty and error states throughout.

---

## Automated tests

```bash
npm test     # 57 tests, run against a dedicated `webhook_fortress_test` database
```

| file | covers |
|---|---|
| `tests/signature.test.ts` | valid / missing / wrong-secret / tampered / malformed signatures, `sha256=` prefix, rejections logged but never inserted, schema rejection |
| `tests/idempotency.test.ts` | same event twice; **50 simultaneous duplicates → 1 effect**; duplicate while processing; duplicate after processing; reprocessing cannot double-count; out-of-order sequences; two workers never claim the same row |
| `tests/retry.test.ts` | backoff maths and jitter bounds; transient failure retried then processed once; retry state survives a new worker instance; permanent failure dead-lettered with payload preserved; non-retryable failure dead-lettered immediately; dead-letter replay stays idempotent |
| `tests/crash-recovery.test.ts` | event persisted before the crash; `PROCESSING` rows reclaimed and finished exactly once; recovery audit rows; committed-effect-with-stale-status is not double-counted; lease expiry vs. healthy lease; poison-event dead-lettering; duplicate arriving after a crash |
| `tests/admin-api.test.ts` | health, filtering, pagination, event detail, stats, integrity, dead-letter listing, error shapes, chaos routes absent when disabled |
| `tests/hardening.test.ts` | admin token required/rejected/accepted (bearer and header), chaos routes guarded, rejected admin requests audited, webhook + health + metrics never blocked; `/health` backlog degradation; `/metrics` format and payload non-leakage; every production configuration guard |

The test database is created automatically; tests never touch the hostility-test data.

---

## Configuration

Copy `.env.example` → `.env`. Every variable is validated at boot (invalid config = refuse
to start, never "start insecurely").

| variable | default | meaning |
|---|---|---|
| `DATABASE_URL` | `postgres://fortress:fortress@localhost:5433/webhook_fortress` | Postgres connection |
| `PORT` / `HOST` | `3000` / `0.0.0.0` | listener |
| `WEBHOOK_SECRET` | — (**required**, min 8 chars; min 32 and non-placeholder in production) | HMAC shared secret |
| `SIGNATURE_HEADER` | `x-webhook-signature` | signature header name |
| `ADMIN_API_TOKEN` | unset (**required in production**, min 16 chars) | bearer token guarding `/admin/*`; unset leaves the admin API open |
| `TRUST_PROXY` | `false` | trust `X-Forwarded-For` for `request.ip` — only enable behind a real proxy |
| `HEALTH_MAX_BACKLOG` | `0` (disabled) | `/health` returns `503` once this many events sit outside a terminal state |
| `MAX_PROCESSING_ATTEMPTS` | `5` | failures before dead-lettering |
| `RETRY_BASE_DELAY_MS` | `1000` | backoff base |
| `RETRY_MAX_DELAY_MS` / `RETRY_JITTER_RATIO` | `60000` / `0.2` | backoff cap and jitter |
| `PROCESSING_TIMEOUT_SECONDS` | `30` | processing lease; longer means a crash takes longer to detect |
| `WORKER_BATCH_SIZE` / `WORKER_CONCURRENCY` / `WORKER_POLL_INTERVAL_MS` | `50` / `10` / `500` | worker throughput |
| `RECOVER_ALL_PROCESSING_ON_START` | `true` | single-instance fast recovery; set `false` for multiple receivers and rely on the lease |
| `LOG_LEVEL` | `info` | `debug\|info\|warn\|error\|silent` |
| `SIMULATE_FAILURES` | `true` in this repo | enables payload-driven failure injection — **`false` in production** |
| `CHAOS_ENABLED` | `true` in this repo | exposes the crash/reset endpoints — **`false` in production** |
| `SIMULATE_CRASH_EVENT` / `SIMULATE_CRASH_POINT` | unset | hard-kill the process when a specific eventId reaches a specific point |

`SIMULATE_CRASH_POINT` accepts `before_business_effect`,
`after_business_effect_before_commit` (default) and `after_commit` — the three interesting
crash windows, for reproducing a specific failure by hand:

```bash
SIMULATE_CRASH_EVENT=evt_0500 docker compose up
```

### Admin API authentication

`/admin/*` exposes every stored payload and can replay dead letters, so it is
token-guarded. Set `ADMIN_API_TOKEN` and every admin route — the chaos endpoints
included — requires it:

```bash
curl -H "Authorization: Bearer $ADMIN_API_TOKEN" localhost:3000/admin/stats
curl -H "x-admin-token: $ADMIN_API_TOKEN"        localhost:3000/admin/stats   # equivalent
```

Comparison is timing-safe, for the same reason the signature check is. Rejected admin
requests are written to `security_events` as `ADMIN_TOKEN_MISSING` / `ADMIN_TOKEN_INVALID`
and show up in the dashboard's Security view alongside rejected deliveries — someone
probing `/admin` is exactly the traffic that table exists to record.

Leaving the token unset keeps the API open, so a fresh clone and the hostility test work
with no setup; the receiver logs `ADMIN_API_UNPROTECTED` at boot when that is the case. It
is only a safe default because production refuses to start without a token (below). The
dashboard notices the first `401`, asks for the token once, and keeps it in `localStorage`
— never in the URL, where it would land in browser history and access logs.

`/health` and `/metrics` stay open: they carry aggregates only, never payloads or event ids.

### Production safety guards

`NODE_ENV=production` makes four configurations fatal at boot rather than merely
inadvisable. Each one looks like it is working while providing no protection at all, which
is worse than a receiver that refuses to start:

| refused in production | why |
|---|---|
| `CHAOS_ENABLED=true` | `/admin/chaos/crash` is a remote `SIGKILL` and `/admin/chaos/reset` is a remote `TRUNCATE` |
| `SIMULATE_FAILURES=true` | payload fields (`alwaysFail`, `nonRetryable`) could force failures from outside |
| `ADMIN_API_TOKEN` unset | the admin API would expose every stored webhook payload |
| a short or placeholder `WEBHOOK_SECRET` | a correct HMAC keyed with a public secret verifies nothing |

```
Unsafe production configuration:
  - CHAOS_ENABLED must be false in production -- it exposes a remote SIGKILL and a TRUNCATE endpoint
  - ADMIN_API_TOKEN is required in production -- /admin/* exposes every stored webhook payload
  - WEBHOOK_SECRET looks like the placeholder from .env.example -- generate a real one (openssl rand -hex 32)
```

`docker-compose.yml` therefore runs as `NODE_ENV=development`: it is the hostility-test
rig, which needs deterministic failures and the chaos endpoints, and it should not be able
to pretend otherwise. Generate real values for a real deployment:

```bash
openssl rand -hex 32   # WEBHOOK_SECRET
openssl rand -hex 32   # ADMIN_API_TOKEN
```

### Structured logging

One JSON object per line, with a canonical lifecycle vocabulary:
`WEBHOOK_RECEIVED · SIGNATURE_VALID · SIGNATURE_INVALID · SIGNATURE_MISSING · PAYLOAD_INVALID ·
EVENT_ACCEPTED · DUPLICATE_EVENT · EVENT_PROCESSING_STARTED · EVENT_PROCESSING_FAILED ·
RETRY_SCHEDULED · EVENT_PROCESSED · EVENT_DEAD_LETTERED · RECOVERY_STARTED ·
STALE_EVENT_RECOVERED · RECOVERY_COMPLETED · CHAOS_CRASH · ADMIN_UNAUTHORIZED ·
ADMIN_API_UNPROTECTED`

```json
{"level":"info","event":"EVENT_PROCESSED","ts":"2026-09-02T11:02:16.221Z","eventId":"evt_retry_001","attempt":3,"effectCreated":true}
```

Secrets are never logged — signatures appear only as an 8-character SHA-256 fingerprint.

---

## Key design decisions

**1. Why database-level idempotency.** The correctness of this system rests on constraints
(`UNIQUE(event_id)` twice over, `CHECK` on status, foreign keys), which hold no matter what
the application does — including crashing between two statements. Application logic can be
wrong; a unique index cannot.

**2. Why in-memory deduplication is insufficient.** A `Set` is empty after a restart (every
event replays), invisible to a second process (horizontal scaling silently double-counts),
and unbounded (a memory leak that grows with traffic). It also cannot participate in the
transaction that writes the business effect, so it can drift out of sync with the truth.

**3. How concurrency is handled.** Workers claim work with `FOR UPDATE SKIP LOCKED`, so two
workers never take the same row and a locked row never blocks the queue. Processing takes a
`SELECT … FOR UPDATE` row lock and re-checks the status inside the transaction. Duplicate
inserts are resolved by the unique index itself. **There is not a single in-memory lock in
the system**, which is what makes multiple receiver processes safe.

**4. How crashes are recovered.** The business effect and the status update share one
transaction, so there is no torn state to repair — only *unfinished* state. Startup
recovery (before the listener opens) plus a lease reaper (while running) return anything
stuck in `PROCESSING` to the retry queue, with a poison-pill guard for events that crash the
receiver repeatedly.

**5. Why event order is not assumed.** Ordering guarantees do not survive a network. A
receiver that requires order converts a delayed event into a permanent outage for every
event behind it. Each event is stored independently; `sequence` is preserved for consumers
that need it.

**6. Why the database is the source of truth.** Retry schedules, attempt counts, statuses
and leases are all rows. Nothing important lives in a `setTimeout`, a module-level variable
or a process's heap, because all three evaporate on `SIGKILL`. A brand-new process can
reconstruct the entire system state from Postgres alone — that is the definition of
crash-safe here.

**7. How dead letters prevent silent data loss.** "Give up" and "delete" are different
things. After the retry budget is spent, the event is copied — payload, failure reason,
attempt count — into `dead_letter_events` in the same transaction that marks it
`DEAD_LETTERED`, then surfaced in the API and dashboard and replayable on demand. The
verification suite asserts that a dead-lettered event has *no* business effect, so a failed
event is never half-applied.

**8. Why the ack is fast but never premature.** The endpoint does the minimum required for
durability — verify, validate, insert, commit — and only then answers. Business processing
happens asynchronously in the worker. The sender is never told "accepted" about an event
that is not already on disk, and never made to wait for downstream work.

---

## Edge cases handled

| Edge case | Behaviour | Proven by |
|---|---|---|
| Duplicate arrives while the original is processing | `200 duplicate` with `eventStatus: PROCESSING`; no second row, no second effect | `idempotency.test.ts` |
| Duplicate arrives after the original was processed | `200 duplicate` with `eventStatus: PROCESSED` | `idempotency.test.ts` |
| Duplicate arrives after a crash | Database state decides; the effect stays at one | `crash-recovery.test.ts` |
| Two requests insert the same event simultaneously | `UNIQUE(event_id)` resolves the race; 1 accepted, 49 duplicates | `idempotency.test.ts` (50 concurrent) |
| Crash after the business effect but before the response | Effect already committed; the retry finds `PROCESSED` and does nothing | `idempotency.test.ts`, `crash-recovery.test.ts` |
| Crash after persistence, before processing | Worker's claim query picks it up; recovery needs no repair | `crash-recovery.test.ts` |
| Invalid JSON with a valid signature | `400 INVALID_JSON`, logged to `security_events`, nothing inserted | `signature.test.ts` |
| Valid event with a missing `eventId` | `400 SCHEMA_INVALID` | `signature.test.ts` |
| Very large retry storm | 50 deliveries → 1 row → 1 effect, no unhandled DB errors | hostility test Q8 |
| Worker restart mid-retry | Retry schedule read back from `next_retry_at` | `retry.test.ts` |
| Transaction failure | Rollback; the event stays non-`PROCESSED` and is retried | by construction + `retry.test.ts` |
| Body over 1 MiB | `413`, logged as `BODY_TOO_LARGE` | `app.ts` error handler |
| Event that crashes the receiver every time | Dead-lettered after `MAX_PROCESSING_ATTEMPTS` interruptions | `crash-recovery.test.ts` |

---

## Project layout

```
server/src/
  config/        env.ts (zod-validated), dotenv.ts
  db/            pool.ts (transactions), migrate.ts, migrations/001_init.sql
  repositories/  eventRepository, resultRepository, attemptRepository,
                 deadLetterRepository, securityRepository, statsRepository
  services/      signature.ts, ingestion.ts, processor.ts, retryPolicy.ts,
                 businessHandler.ts, recovery.ts, chaos.ts
  workers/       eventWorker.ts (claim → process → retry/dead-letter loop)
  controllers/   webhookController.ts, adminController.ts
  routes/        index.ts
  utils/         logger.ts (structured), concurrency.ts
  types/         events.ts (zod schema + row types)
  app.ts         Fastify app: raw-body parser, error handling, static dashboard
  index.ts       boot: migrate → recover → listen → worker

scripts/
  send-1000-events.ts   the hostile sender (writes tmp/hostile-manifest.json)
  verify-results.ts     the verification report (exits non-zero on failure)
  hostile-test.ts       orchestrator for `npm run test:hostile`
  chaos-test.ts         focused crash/recovery test
  db-reset.ts           truncate helper
  lib/                  plan.ts (delivery plan), sender.ts (signing, pool, retries)

sql/verification.sql    the 12 verification queries as raw SQL
public/                 dashboard (index.html, styles.css, app.js)
tests/                  39 automated tests
Dockerfile              multi-stage build (build → prod deps → runtime, non-root)
docker-compose.yml      db + receiver, persistent volume, restart: unless-stopped
```

---

Built with Node.js 24, TypeScript (strict), Fastify 5, PostgreSQL 16 and `pg` with hand-written
SQL — chosen over an ORM precisely because the guarantees here live in `ON CONFLICT`,
`FOR UPDATE SKIP LOCKED` and explicit transaction boundaries, and those deserve to be read
literally rather than through an abstraction.
