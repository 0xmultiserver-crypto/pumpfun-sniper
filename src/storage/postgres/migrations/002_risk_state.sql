-- 002_risk_state.sql
-- Risk state persistence table.
-- Stores JSON blobs keyed by string, used by risk controls
-- (daily loss guard, creator blacklist, cooldown manager)
-- to persist state across restarts.

BEGIN;

CREATE TABLE IF NOT EXISTS risk_state (
    key         VARCHAR(64) PRIMARY KEY,
    value       JSONB       NOT NULL,
    updated_at  BIGINT      NOT NULL
);

INSERT INTO schema_migrations (version, name)
VALUES (2, '002_risk_state')
ON CONFLICT (version) DO NOTHING;

COMMIT;
