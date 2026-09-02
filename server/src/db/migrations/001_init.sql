-- =============================================================================
-- Webhook Fortress -- core schema
-- The database is the source of truth. Every correctness guarantee in this
-- system is anchored to a constraint declared here, not to application logic.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- webhook_events: the durable inbox. One row per UNIQUE logical event.
-- UNIQUE(event_id) is what makes at-least-once delivery safe: 50 concurrent
-- deliveries of the same eventId collapse into exactly one row.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS webhook_events (
    id                    BIGSERIAL PRIMARY KEY,
    event_id              TEXT        NOT NULL UNIQUE,
    event_type            TEXT        NOT NULL,
    sequence              BIGINT      NOT NULL,
    event_timestamp       TIMESTAMPTZ NOT NULL,
    payload               JSONB       NOT NULL,
    status                TEXT        NOT NULL DEFAULT 'RECEIVED',
    received_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
    processed_at          TIMESTAMPTZ,
    processing_attempts   INTEGER     NOT NULL DEFAULT 0,
    processing_started_at TIMESTAMPTZ,
    last_error            TEXT,
    next_retry_at         TIMESTAMPTZ,
    delivery_count        INTEGER     NOT NULL DEFAULT 1,
    first_delivery_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_delivery_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT webhook_events_status_check CHECK (status IN (
        'RECEIVED', 'PROCESSING', 'PROCESSED', 'RETRY_PENDING', 'FAILED', 'DEAD_LETTERED'
    )),
    CONSTRAINT webhook_events_attempts_check CHECK (processing_attempts >= 0),
    CONSTRAINT webhook_events_delivery_count_check CHECK (delivery_count >= 1)
);

-- Claim query index: "give me work that is due".
CREATE INDEX IF NOT EXISTS idx_webhook_events_claimable
    ON webhook_events (status, next_retry_at NULLS FIRST, received_at);
-- Lease-reaper index: "which PROCESSING rows are stale?"
CREATE INDEX IF NOT EXISTS idx_webhook_events_processing_started
    ON webhook_events (processing_started_at) WHERE status = 'PROCESSING';
CREATE INDEX IF NOT EXISTS idx_webhook_events_status ON webhook_events (status);
CREATE INDEX IF NOT EXISTS idx_webhook_events_received_at ON webhook_events (received_at DESC);
CREATE INDEX IF NOT EXISTS idx_webhook_events_sequence ON webhook_events (sequence);

-- ---------------------------------------------------------------------------
-- processed_results: the actual BUSINESS EFFECT.
-- UNIQUE(event_id) is the second, independent safety net. Even if the
-- application logic were wrong, the database physically cannot record the same
-- business effect twice.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS processed_results (
    id             BIGSERIAL PRIMARY KEY,
    event_id       TEXT        NOT NULL UNIQUE
                   REFERENCES webhook_events (event_id) ON DELETE RESTRICT,
    result_type    TEXT        NOT NULL,
    processed_data JSONB       NOT NULL,
    attempt_number INTEGER     NOT NULL DEFAULT 1,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_processed_results_created_at ON processed_results (created_at DESC);

-- ---------------------------------------------------------------------------
-- webhook_attempts: append-only audit trail of every DELIVERY (HTTP request
-- that reached the endpoint) and every PROCESSING attempt. This is what makes
-- a retry storm explainable after the fact.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS webhook_attempts (
    id             BIGSERIAL PRIMARY KEY,
    event_id       TEXT        NOT NULL,
    attempt_number INTEGER     NOT NULL,
    source         TEXT        NOT NULL,
    status         TEXT        NOT NULL,
    error_message  TEXT,
    attempted_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT webhook_attempts_source_check CHECK (source IN ('DELIVERY', 'PROCESSING', 'RECOVERY', 'ADMIN_REPLAY'))
);

CREATE INDEX IF NOT EXISTS idx_webhook_attempts_event_id ON webhook_attempts (event_id, attempted_at);
CREATE INDEX IF NOT EXISTS idx_webhook_attempts_source_status ON webhook_attempts (source, status);

-- ---------------------------------------------------------------------------
-- dead_letter_events: permanently failed events. Nothing is ever discarded.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS dead_letter_events (
    id                BIGSERIAL PRIMARY KEY,
    original_event_id TEXT        NOT NULL UNIQUE
                      REFERENCES webhook_events (event_id) ON DELETE RESTRICT,
    event_type        TEXT        NOT NULL,
    payload           JSONB       NOT NULL,
    failure_reason    TEXT        NOT NULL,
    total_attempts    INTEGER     NOT NULL,
    dead_lettered_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    replayed_at       TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_dead_letter_events_at ON dead_letter_events (dead_lettered_at DESC);

-- ---------------------------------------------------------------------------
-- security_events: rejected requests (bad/missing signature, bad payload).
-- Rejected traffic is recorded HERE and never in webhook_events -- that
-- separation is what verification query 7 proves.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS security_events (
    id                 BIGSERIAL PRIMARY KEY,
    reason             TEXT        NOT NULL,
    claimed_event_id   TEXT,
    signature_present  BOOLEAN     NOT NULL DEFAULT false,
    signature_fp       TEXT,
    remote_ip          TEXT,
    detail             TEXT,
    created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT security_events_reason_check CHECK (reason IN (
        'MISSING_SIGNATURE', 'INVALID_SIGNATURE', 'MALFORMED_SIGNATURE',
        'INVALID_JSON', 'SCHEMA_INVALID', 'BODY_TOO_LARGE'
    ))
);

CREATE INDEX IF NOT EXISTS idx_security_events_created_at ON security_events (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_security_events_reason ON security_events (reason);

-- ---------------------------------------------------------------------------
-- updated_at maintenance
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION webhook_events_touch_updated_at() RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = now();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_webhook_events_updated_at ON webhook_events;
CREATE TRIGGER trg_webhook_events_updated_at
    BEFORE UPDATE ON webhook_events
    FOR EACH ROW EXECUTE FUNCTION webhook_events_touch_updated_at();
