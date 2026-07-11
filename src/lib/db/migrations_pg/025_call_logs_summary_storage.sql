-- 025_call_logs_summary_storage.sql (PostgreSQL Override)
-- Rebuild call_logs for PostgreSQL: store summary metadata only.
-- Differences from SQLite version:
--   - ALTER TABLE RENAME → full transaction with DROP at end
--   - INSERT OR REPLACE → INSERT ... ON CONFLICT DO UPDATE
--   - json_valid/json_object/json_extract/json_remove → jsonb_typeof/ jsonb_build_object / ->>/#-
--   - SUBSTR() → SUBSTRING()
--   - INTEGER DEFAULT 0 for boolean flags → SMALLINT (PG convention)

BEGIN;

-- Drop old indexes first
DROP INDEX IF EXISTS idx_cl_combo_target;
DROP INDEX IF EXISTS idx_call_logs_request_type;
DROP INDEX IF EXISTS idx_call_logs_requested_model;
DROP INDEX IF EXISTS idx_cl_status;
DROP INDEX IF EXISTS idx_cl_timestamp;

-- Rename legacy table
ALTER TABLE call_logs RENAME TO call_logs_v1_legacy;

-- Create new table with PG-native types
CREATE TABLE call_logs (
  id TEXT PRIMARY KEY,
  timestamp TEXT NOT NULL,
  method TEXT,
  path TEXT,
  status INTEGER,
  model TEXT,
  requested_model TEXT,
  provider TEXT,
  account TEXT,
  connection_id TEXT,
  duration INTEGER DEFAULT 0,
  tokens_in INTEGER DEFAULT 0,
  tokens_out INTEGER DEFAULT 0,
  tokens_cache_read INTEGER DEFAULT NULL,
  tokens_cache_creation INTEGER DEFAULT NULL,
  tokens_reasoning INTEGER DEFAULT NULL,
  cache_source TEXT DEFAULT 'upstream',
  request_type TEXT,
  source_format TEXT,
  target_format TEXT,
  api_key_id TEXT,
  api_key_name TEXT,
  combo_name TEXT,
  combo_step_id TEXT,
  combo_execution_key TEXT,
  error_summary TEXT,
  detail_state TEXT DEFAULT 'none',
  artifact_relpath TEXT,
  artifact_size_bytes INTEGER DEFAULT NULL,
  artifact_sha256 TEXT DEFAULT NULL,
  has_request_body SMALLINT DEFAULT 0,
  has_response_body SMALLINT DEFAULT 0,
  has_pipeline_details SMALLINT DEFAULT 0,
  request_summary TEXT
);

-- Migrate data from legacy table.
-- In PG, INSERT ... ON CONFLICT DO UPDATE replaces SQLite's INSERT OR REPLACE.
INSERT INTO call_logs (
  id, timestamp, method, path, status, model, requested_model, provider,
  account, connection_id, duration, tokens_in, tokens_out, tokens_cache_read,
  tokens_cache_creation, tokens_reasoning, cache_source, request_type,
  source_format, target_format, api_key_id, api_key_name, combo_name,
  combo_step_id, combo_execution_key, error_summary, detail_state,
  artifact_relpath, artifact_size_bytes, artifact_sha256,
  has_request_body, has_response_body, has_pipeline_details, request_summary
)
SELECT
  id, timestamp, method, path, status, model, requested_model, provider,
  account, connection_id,
  COALESCE(duration, 0),
  COALESCE(tokens_in, 0),
  COALESCE(tokens_out, 0),
  tokens_cache_read,
  tokens_cache_creation,
  tokens_reasoning,
  COALESCE(cache_source, 'upstream') AS cache_source,
  request_type, source_format, target_format, api_key_id, api_key_name,
  combo_name, combo_step_id, combo_execution_key,
  CASE
    WHEN error IS NULL OR TRIM(CAST(error AS TEXT)) = '' THEN NULL
    WHEN LENGTH(CAST(error AS TEXT)) > 4000 THEN SUBSTRING(CAST(error AS TEXT), 1, 4000)
    ELSE CAST(error AS TEXT)
  END AS error_summary,
  CASE
    WHEN artifact_relpath IS NOT NULL AND TRIM(artifact_relpath) != '' THEN 'ready'
    WHEN COALESCE(request_body, '') != '' OR COALESCE(response_body, '') != '' OR COALESCE(error, '') != ''
      THEN 'legacy-inline'
    ELSE 'none'
  END AS detail_state,
  NULLIF(TRIM(artifact_relpath), '') AS artifact_relpath,
  NULL AS artifact_size_bytes,
  NULL AS artifact_sha256,
  CASE WHEN request_body IS NOT NULL AND TRIM(request_body) != '' THEN 1 ELSE 0 END AS has_request_body,
  CASE WHEN response_body IS NOT NULL AND TRIM(response_body) != '' THEN 1 ELSE 0 END AS has_response_body,
  COALESCE(has_pipeline_details, 0) AS has_pipeline_details,
  CASE
    WHEN request_type = 'search' AND request_body IS NOT NULL
      AND jsonb_typeof(request_body::jsonb) = 'object'
    THEN jsonb_build_object(
        'query',
        COALESCE(request_body::jsonb->>'query', ''),
        'filters',
        COALESCE(
          request_body::jsonb - 'query' - 'provider',
          '{}'::jsonb
        )
      )::text
    ELSE NULL
  END AS request_summary
FROM call_logs_v1_legacy
ON CONFLICT (id) DO UPDATE SET
  timestamp = EXCLUDED.timestamp,
  method = EXCLUDED.method,
  path = EXCLUDED.path,
  status = EXCLUDED.status,
  model = EXCLUDED.model,
  requested_model = EXCLUDED.requested_model,
  provider = EXCLUDED.provider,
  account = EXCLUDED.account,
  connection_id = EXCLUDED.connection_id,
  duration = EXCLUDED.duration,
  tokens_in = EXCLUDED.tokens_in,
  tokens_out = EXCLUDED.tokens_out,
  tokens_cache_read = EXCLUDED.tokens_cache_read,
  tokens_cache_creation = EXCLUDED.tokens_cache_creation,
  tokens_reasoning = EXCLUDED.tokens_reasoning,
  cache_source = EXCLUDED.cache_source,
  request_type = EXCLUDED.request_type,
  source_format = EXCLUDED.source_format,
  target_format = EXCLUDED.target_format,
  api_key_id = EXCLUDED.api_key_id,
  api_key_name = EXCLUDED.api_key_name,
  combo_name = EXCLUDED.combo_name,
  combo_step_id = EXCLUDED.combo_step_id,
  combo_execution_key = EXCLUDED.combo_execution_key,
  error_summary = EXCLUDED.error_summary,
  detail_state = EXCLUDED.detail_state,
  artifact_relpath = EXCLUDED.artifact_relpath,
  artifact_size_bytes = EXCLUDED.artifact_size_bytes,
  artifact_sha256 = EXCLUDED.artifact_sha256,
  has_request_body = EXCLUDED.has_request_body,
  has_response_body = EXCLUDED.has_response_body,
  has_pipeline_details = EXCLUDED.has_pipeline_details,
  request_summary = EXCLUDED.request_summary;

-- Recreate indexes
CREATE INDEX idx_cl_timestamp ON call_logs(timestamp);
CREATE INDEX idx_cl_status ON call_logs(status);
CREATE INDEX idx_call_logs_requested_model ON call_logs(requested_model);
CREATE INDEX idx_call_logs_request_type ON call_logs(request_type);
CREATE INDEX idx_cl_combo_target
  ON call_logs(combo_name, combo_execution_key, timestamp);

-- Drop legacy table (SQLite doesn't do this but PG should for cleanliness)
DROP TABLE IF EXISTS call_logs_v1_legacy;

COMMIT;
