-- ---------------------------------------------------------------------------
-- Record rejected /admin/* requests in the same audit trail as rejected
-- deliveries. An attacker probing the admin API is security-relevant traffic,
-- and the Security view already exists to show exactly this.
-- ---------------------------------------------------------------------------

ALTER TABLE security_events DROP CONSTRAINT IF EXISTS security_events_reason_check;

ALTER TABLE security_events ADD CONSTRAINT security_events_reason_check CHECK (reason IN (
    'MISSING_SIGNATURE', 'INVALID_SIGNATURE', 'MALFORMED_SIGNATURE',
    'INVALID_JSON', 'SCHEMA_INVALID', 'BODY_TOO_LARGE',
    'ADMIN_TOKEN_MISSING', 'ADMIN_TOKEN_INVALID'
));
