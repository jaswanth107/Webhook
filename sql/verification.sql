-- ============================================================================
-- Webhook Fortress -- correctness verification queries
--
--   docker compose exec -T db psql -U fortress -d webhook_fortress -f - < sql/verification.sql
--
-- scripts/verify-results.ts runs the same checks programmatically and turns
-- them into a PASS/FAIL report; this file is the raw SQL evidence.
-- ============================================================================

\echo '== QUERY 1: unique accepted events ============================='
SELECT COUNT(*) AS event_rows, COUNT(DISTINCT event_id) AS unique_event_ids
FROM webhook_events;

\echo '== QUERY 2: duplicate business effects (MUST be 0 rows) ========'
SELECT event_id, COUNT(*) AS effects
FROM processed_results
GROUP BY event_id
HAVING COUNT(*) > 1;

\echo '== QUERY 3: expected vs actual reconciliation =================='
SELECT
    (SELECT COUNT(*) FROM webhook_events)                                   AS unique_events_received,
    (SELECT COUNT(*) FROM webhook_events WHERE status = 'PROCESSED')        AS processed,
    (SELECT COUNT(*) FROM processed_results)                                AS business_effects,
    (SELECT COUNT(*) FROM webhook_events WHERE status = 'DEAD_LETTERED')    AS dead_lettered,
    (SELECT COUNT(*) FROM dead_letter_events)                               AS dead_letter_rows,
    (SELECT COUNT(*) FROM webhook_events)
      - (SELECT COUNT(*) FROM webhook_events WHERE status = 'PROCESSED')
      - (SELECT COUNT(*) FROM webhook_events WHERE status = 'DEAD_LETTERED') AS unexplained_events;

\echo '== QUERY 4: lost / stranded events (MUST be 0 rows) ============'
SELECT event_id, status, processing_attempts, next_retry_at, last_error
FROM webhook_events
WHERE status NOT IN ('PROCESSED', 'DEAD_LETTERED');

\echo '== QUERY 5: dead letter store =================================='
SELECT original_event_id, event_type, total_attempts, failure_reason, dead_lettered_at
FROM dead_letter_events
ORDER BY dead_lettered_at;

\echo '== QUERY 6: events that needed retries ========================='
SELECT event_id, processing_attempts, status, left(last_error, 60) AS last_error
FROM webhook_events
WHERE processing_attempts > 1
ORDER BY processing_attempts DESC, event_id;

\echo '== QUERY 7: security -- rejected traffic never reached the inbox '
SELECT
    (SELECT COUNT(*) FROM security_events)                                            AS rejected_requests,
    (SELECT COUNT(*) FROM security_events WHERE reason = 'INVALID_SIGNATURE')         AS invalid_signature,
    (SELECT COUNT(*) FROM security_events WHERE reason = 'MISSING_SIGNATURE')         AS missing_signature,
    (SELECT COUNT(*) FROM security_events WHERE reason IN ('INVALID_JSON','SCHEMA_INVALID')) AS bad_payload,
    (SELECT COUNT(*) FROM webhook_events e
       WHERE e.event_id LIKE 'evt_invalid%'
          OR e.event_id LIKE 'evt_missing%'
          OR e.event_id LIKE 'evt_tampered%'
          OR e.event_id LIKE 'evt_badschema%'
          OR e.event_id LIKE 'evt_badjson%')                                          AS accepted_invalid_events;

\echo '== QUERY 8: retry storm -- 50 deliveries, one effect ==========='
SELECT e.event_id, e.delivery_count, e.status, e.processing_attempts,
       (SELECT COUNT(*) FROM processed_results r WHERE r.event_id = e.event_id) AS business_effects
FROM webhook_events e
WHERE e.event_id = 'evt_storm_001';

\echo '== QUERY 9: duplicate deliveries per event ====================='
SELECT event_id, delivery_count, status,
       (SELECT COUNT(*) FROM processed_results r WHERE r.event_id = webhook_events.event_id) AS business_effects
FROM webhook_events
WHERE delivery_count > 1
ORDER BY delivery_count DESC
LIMIT 20;

\echo '== QUERY 10: crash recovery evidence ==========================='
SELECT event_id, attempt_number, status, error_message, attempted_at
FROM webhook_attempts
WHERE source = 'RECOVERY'
ORDER BY attempted_at
LIMIT 50;

\echo '== QUERY 11: PROCESSED without a business effect (MUST be 0) ==='
SELECT e.event_id
FROM webhook_events e
LEFT JOIN processed_results r ON r.event_id = e.event_id
WHERE e.status = 'PROCESSED' AND r.event_id IS NULL;

\echo '== QUERY 12: dead-lettered WITH a business effect (MUST be 0) =='
SELECT e.event_id
FROM webhook_events e
JOIN processed_results r ON r.event_id = e.event_id
WHERE e.status = 'DEAD_LETTERED';
