CREATE SCHEMA IF NOT EXISTS quiet_watcher;

CREATE TABLE IF NOT EXISTS quiet_watcher.watches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  kind text NOT NULL CHECK (
    kind IN ('price_drop', 'ipo_pricing_window', 'clinical_trial_readout')
  ),
  query text NOT NULL,
  criteria jsonb NOT NULL DEFAULT '{}'::jsonb,
  recipient_email text NOT NULL,
  check_interval_minutes integer NOT NULL DEFAULT 15
    CHECK (check_interval_minutes >= 1),
  is_active boolean NOT NULL DEFAULT true,
  current_state jsonb,
  last_checked_at timestamptz,
  next_check_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS watches_due_idx
  ON quiet_watcher.watches (next_check_at)
  WHERE is_active;

CREATE TABLE IF NOT EXISTS quiet_watcher.observations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  watch_id uuid NOT NULL REFERENCES quiet_watcher.watches(id) ON DELETE CASCADE,
  fingerprint text NOT NULL,
  state jsonb NOT NULL,
  summary text NOT NULL,
  source_url text NOT NULL,
  source_title text NOT NULL,
  source_published_at timestamptz,
  observed_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS observations_watch_observed_idx
  ON quiet_watcher.observations (watch_id, observed_at DESC);

CREATE TABLE IF NOT EXISTS quiet_watcher.alert_outbox (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  watch_id uuid NOT NULL REFERENCES quiet_watcher.watches(id) ON DELETE CASCADE,
  observation_id uuid NOT NULL UNIQUE
    REFERENCES quiet_watcher.observations(id) ON DELETE CASCADE,
  recipient_email text NOT NULL,
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'sent')),
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  last_attempt_at timestamptz,
  last_error text,
  sent_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS alert_outbox_pending_idx
  ON quiet_watcher.alert_outbox (created_at)
  WHERE status = 'pending';
