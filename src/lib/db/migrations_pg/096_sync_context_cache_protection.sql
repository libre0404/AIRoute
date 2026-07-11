-- 096_sync_context_cache_protection.sql (PostgreSQL Override)
-- Sync the context_cache_protection column with the JSON blob for existing combos.
-- Differences from SQLite version:
--   - json_extract(data, '$.context_cache_protection') → (data::jsonb->>'context_cache_protection')
--   - Cast result to integer for comparison with 1

BEGIN;

UPDATE combos
SET context_cache_protection = 1
WHERE (data::jsonb->>'context_cache_protection')::int = 1
  AND (context_cache_protection IS NULL OR context_cache_protection = 0);

COMMIT;
