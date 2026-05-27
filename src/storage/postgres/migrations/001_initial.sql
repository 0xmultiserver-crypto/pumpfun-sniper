-- 001_initial.sql
-- Initial schema for pumpfun sniper persistence layer.
-- All financial bigint values stored as NUMERIC(20,0).
-- All timestamps are TIMESTAMPTZ.

BEGIN;

-- ================================================================
-- TRADES
-- ================================================================
CREATE TABLE IF NOT EXISTS trades (
    id              TEXT        PRIMARY KEY,
    mint            TEXT        NOT NULL,
    side            TEXT        NOT NULL CHECK (side IN ('BUY', 'SELL')),
    status          TEXT        NOT NULL,
    amount_sol      NUMERIC(20,0) NOT NULL,
    amount_tokens   NUMERIC(20,0) NOT NULL,
    signature       TEXT,
    slot            BIGINT,
    submitted_at    TIMESTAMPTZ NOT NULL,
    confirmed_at    TIMESTAMPTZ,
    failure_reason  TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_trades_mint       ON trades (mint);
CREATE INDEX IF NOT EXISTS idx_trades_status     ON trades (status);
CREATE INDEX IF NOT EXISTS idx_trades_submitted  ON trades (submitted_at);
CREATE INDEX IF NOT EXISTS idx_trades_signature  ON trades (signature);

-- ================================================================
-- TRADE PAIRS  (entry + exit linked by FK)
-- ================================================================
CREATE TABLE IF NOT EXISTS trade_pairs (
    id              TEXT        PRIMARY KEY,
    mint            TEXT        NOT NULL,
    entry_trade_id  TEXT        NOT NULL REFERENCES trades(id),
    exit_trade_id   TEXT        REFERENCES trades(id),
    entry_price_sol NUMERIC(20,0) NOT NULL,
    exit_price_sol  NUMERIC(20,0),
    pnl_sol         NUMERIC(20,0),
    pnl_percent     DOUBLE PRECISION,
    exit_reason     TEXT,
    duration_ms     BIGINT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_trade_pairs_mint        ON trade_pairs (mint);
CREATE INDEX IF NOT EXISTS idx_trade_pairs_entry       ON trade_pairs (entry_trade_id);
CREATE INDEX IF NOT EXISTS idx_trade_pairs_exit        ON trade_pairs (exit_trade_id);
CREATE INDEX IF NOT EXISTS idx_trade_pairs_created     ON trade_pairs (created_at);

-- ================================================================
-- SIGNALS
-- ================================================================
CREATE TABLE IF NOT EXISTS signals (
    id          TEXT        PRIMARY KEY,
    type        TEXT        NOT NULL CHECK (type IN ('LAUNCH', 'MOMENTUM', 'MIGRATION', 'LIQUIDITY_PHASE')),
    mint        TEXT        NOT NULL,
    timestamp   TIMESTAMPTZ NOT NULL,
    slot        BIGINT,
    data        JSONB       NOT NULL DEFAULT '{}'::jsonb,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_signals_mint      ON signals (mint);
CREATE INDEX IF NOT EXISTS idx_signals_type      ON signals (type);
CREATE INDEX IF NOT EXISTS idx_signals_timestamp ON signals (timestamp);
CREATE INDEX IF NOT EXISTS idx_signals_data      ON signals USING gin (data);

-- ================================================================
-- TOKEN METADATA
-- ================================================================
CREATE TABLE IF NOT EXISTS token_metadata (
    mint        TEXT    PRIMARY KEY,
    name        TEXT    NOT NULL,
    symbol      TEXT    NOT NULL,
    uri         TEXT,
    decimals    INTEGER NOT NULL DEFAULT 9,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_token_metadata_symbol ON token_metadata (symbol);

-- ================================================================
-- TOKEN AUTHORITY
-- ================================================================
CREATE TABLE IF NOT EXISTS token_authority (
    mint                      TEXT    PRIMARY KEY,
    mint_authority             TEXT,
    freeze_authority           TEXT,
    mint_authority_revoked     BOOLEAN NOT NULL DEFAULT false,
    freeze_authority_revoked   BOOLEAN NOT NULL DEFAULT false,
    created_at                 TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ================================================================
-- CREATORS
-- ================================================================
CREATE TABLE IF NOT EXISTS creators (
    address           TEXT        PRIMARY KEY,
    first_seen        TIMESTAMPTZ NOT NULL,
    total_launches    INTEGER     NOT NULL DEFAULT 0,
    rug_count         INTEGER     NOT NULL DEFAULT 0,
    blacklisted       BOOLEAN     NOT NULL DEFAULT false,
    blacklist_reason  TEXT,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_creators_blacklisted  ON creators (blacklisted) WHERE blacklisted = true;
CREATE INDEX IF NOT EXISTS idx_creators_first_seen   ON creators (first_seen);
CREATE INDEX IF NOT EXISTS idx_creators_rug_count    ON creators (rug_count);

-- ================================================================
-- TELEMETRY EVENTS
-- ================================================================
CREATE TABLE IF NOT EXISTS telemetry_events (
    id          TEXT        PRIMARY KEY,
    level       TEXT        NOT NULL,
    message     TEXT        NOT NULL,
    timestamp   TIMESTAMPTZ NOT NULL,
    context     JSONB       NOT NULL DEFAULT '{}'::jsonb,
    module      TEXT,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_telemetry_level      ON telemetry_events (level);
CREATE INDEX IF NOT EXISTS idx_telemetry_timestamp  ON telemetry_events (timestamp);
CREATE INDEX IF NOT EXISTS idx_telemetry_module     ON telemetry_events (module);
CREATE INDEX IF NOT EXISTS idx_telemetry_context    ON telemetry_events USING gin (context);

-- ================================================================
-- LIFECYCLE EVENTS
-- ================================================================
CREATE TABLE IF NOT EXISTS lifecycle_events (
    id              TEXT        PRIMARY KEY,
    service         TEXT        NOT NULL,
    from_status     TEXT        NOT NULL,
    to_status       TEXT        NOT NULL,
    timestamp       TIMESTAMPTZ NOT NULL,
    error           TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_lifecycle_service    ON lifecycle_events (service);
CREATE INDEX IF NOT EXISTS idx_lifecycle_timestamp  ON lifecycle_events (timestamp);
CREATE INDEX IF NOT EXISTS idx_lifecycle_to_status  ON lifecycle_events (to_status);

-- ================================================================
-- SCHEMA MIGRATIONS TRACKER
-- ================================================================
CREATE TABLE IF NOT EXISTS schema_migrations (
    version     INTEGER     PRIMARY KEY,
    name        TEXT        NOT NULL,
    applied_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO schema_migrations (version, name)
VALUES (1, '001_initial')
ON CONFLICT (version) DO NOTHING;

COMMIT;
