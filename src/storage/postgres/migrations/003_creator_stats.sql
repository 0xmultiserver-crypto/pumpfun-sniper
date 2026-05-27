-- Creator Stats table for tracking creator wallet performance
CREATE TABLE IF NOT EXISTS creator_stats (
  wallet VARCHAR(64) PRIMARY KEY,
  total_launches INT NOT NULL DEFAULT 0,
  total_sl_hits INT NOT NULL DEFAULT 0,
  total_tp_hits INT NOT NULL DEFAULT 0,
  avg_survival_seconds FLOAT NOT NULL DEFAULT 0,
  score INT NOT NULL DEFAULT 50,
  last_updated BIGINT NOT NULL
);
