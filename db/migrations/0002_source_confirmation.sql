ALTER TABLE quiet_watcher.watches
  ADD COLUMN IF NOT EXISTS source_domain text,
  ADD COLUMN IF NOT EXISTS source_url text,
  ADD COLUMN IF NOT EXISTS pending_state jsonb,
  ADD COLUMN IF NOT EXISTS pending_fingerprint text;

UPDATE quiet_watcher.watches
SET criteria = criteria || jsonb_build_object('targetCurrency', 'USD')
WHERE kind = 'price_drop'
  AND criteria ? 'targetPrice'
  AND NOT (criteria ? 'targetCurrency');

UPDATE quiet_watcher.watches AS w
SET (source_url, source_domain) = (
  SELECT
    regexp_replace(o.source_url, '[?#].*$', ''),
    lower(substring(o.source_url FROM 'https?://([^/:?#]+)'))
  FROM quiet_watcher.observations AS o
  WHERE o.watch_id = w.id
  ORDER BY o.observed_at DESC
  LIMIT 1
)
WHERE w.current_state IS NOT NULL
  AND w.source_url IS NULL
  AND EXISTS (
    SELECT 1
    FROM quiet_watcher.observations AS o
    WHERE o.watch_id = w.id
  );
