-- 103_strip_legacy_combo_config_keys.sql (PostgreSQL Override)
-- One-shot sweep over combos.data to remove v3.8.31-era config keys.
-- Differences from SQLite version:
--   - json_remove(data, '$.config.k1', ..., '$.config.k12') → iterative #- operator
--     (PG's jsonb #- path removes one key at a time; chain calls in PL/pgSQL for clarity)
--   - json_each(data, '$.config') AS cfg WHERE cfg.key IN (...) →
--     jsonb_each(data::jsonb->'config') AS kv WHERE kv.key IN (...)
--   - Uses PL/pgSQL DO block for the multi-key removal to keep it readable

BEGIN;

-- Strip 12 known removed keys from any persisted combo config.
-- PG's jsonb #- '{config,key}' operator removes one key per call.
-- We chain 12 removals in a single UPDATE SET expression.
UPDATE combos
SET data = (
  data::jsonb
  #- '{config,queueDepth}'
  #- '{config,fallbackDelayMs}'
  #- '{config,handoffProviders}'
  #- '{config,maxComboDepth}'
  #- '{config,manifestRouting}'
  #- '{config,complexityAwareRouting}'
  #- '{config,pipeline_enabled}'
  #- '{config,pipelineConcurrency}'
  #- '{config,shadowRouting}'
  #- '{config,evalRouting}'
  #- '{config,resetAwareEnabled}'
  #- '{config,resetAwareWindow}'
)::text
WHERE EXISTS (
  SELECT 1
  FROM jsonb_each(data::jsonb->'config') AS kv
  WHERE kv.key IN (
    'queueDepth',
    'fallbackDelayMs',
    'handoffProviders',
    'maxComboDepth',
    'manifestRouting',
    'complexityAwareRouting',
    'pipeline_enabled',
    'pipelineConcurrency',
    'shadowRouting',
    'evalRouting',
    'resetAwareEnabled',
    'resetAwareWindow'
  )
);

COMMIT;
