-- 075_api_key_self_service_usage_scopes.sql (PostgreSQL Override)
-- Backfill self-service own-usage visibility for existing API keys.
-- Differences from SQLite version:
--   - json_array() → jsonb_build_array()
--   - json_valid() → jsonb_typeof() IS NOT NULL check
--   - json_type() → jsonb_typeof()
--   - json_insert() with '$[#]' → || operator for array append
--   - json_each() → jsonb_array_elements()
--   - INSERT OR IGNORE → INSERT ... ON CONFLICT DO NOTHING
--   - datetime('now') → CURRENT_TIMESTAMP

BEGIN;

-- Ensure key_value table exists (idempotent)
CREATE TABLE IF NOT EXISTS key_value (
  namespace TEXT NOT NULL,
  key TEXT NOT NULL,
  value TEXT NOT NULL,
  PRIMARY KEY (namespace, key)
);

-- Step 1: Set scopes to a new array ['self:usage'] for keys with NULL/empty/invalid/non-array scopes.
-- Guard: only run if backfill has not been marked done.
UPDATE api_keys
SET scopes = jsonb_build_array('self:usage')::text
WHERE NOT EXISTS (
    SELECT 1
    FROM key_value
    WHERE namespace = 'apiKeySelfService'
      AND key = 'usageScopesBackfilled'
  )
  AND (
    scopes IS NULL
    OR TRIM(scopes) = ''
    OR scopes::jsonb IS NULL
    OR jsonb_typeof(scopes::jsonb) != 'array'
  );

-- Step 2: Append 'self:usage' to existing valid JSON arrays that lack it.
-- In PG: (scopes::jsonb || '["self:usage"]'::jsonb) concatenates a new element.
UPDATE api_keys
SET scopes = (
    scopes::jsonb || jsonb_build_array('self:usage')
  )::text
WHERE NOT EXISTS (
    SELECT 1
    FROM key_value
    WHERE namespace = 'apiKeySelfService'
      AND key = 'usageScopesBackfilled'
  )
  AND scopes IS NOT NULL
  AND TRIM(scopes) != ''
  AND jsonb_typeof(scopes::jsonb) = 'array'
  AND NOT EXISTS (
    SELECT 1
    FROM jsonb_array_elements(scopes::jsonb) AS elem
    WHERE elem::text = '"self:usage"'
  );

-- Mark backfill as done
INSERT INTO key_value (namespace, key, value)
VALUES ('apiKeySelfService', 'usageScopesBackfilled', CURRENT_TIMESTAMP::text)
ON CONFLICT (namespace, key) DO NOTHING;

COMMIT;
