-- 023_fix_memory_fts_uuid.sql (PostgreSQL Override)
-- PostgreSQL equivalent: tsvector already handles the rowid mismatch natively.
-- In PG, there is no implicit rowid column — the id TEXT (UUID) column IS the primary key,
-- and tsvector doesn't need a separate INTEGER join key.
--
-- This migration simply ensures the tsvector triggers are set up correctly for
-- automatic index maintenance.

-- Step 1: Add a SERIAL memory_id column for consistent integer reference
-- This mirrors the SQLite migration's intent but uses PG's SERIAL type.
ALTER TABLE memories ADD COLUMN IF NOT EXISTS memory_id SERIAL;

-- Step 2: Create a unique index on memory_id
CREATE UNIQUE INDEX IF NOT EXISTS idx_memories_memory_id ON memories(memory_id);

-- Step 3: Drop old triggers if they exist (from a previous PG migration attempt)
DROP TRIGGER IF EXISTS memory_tsvector_update ON memories;
DROP FUNCTION IF EXISTS memories_tsvector_trigger();

-- Step 4: Create a trigger function that updates the tsvector column
-- This replaces SQLite's FTS5 triggers with PG's trigger-based tsvector maintenance.
-- Note: If using the GENERATED ALWAYS STORED column (from 022 PG override),
-- this trigger is technically redundant but kept for compatibility with code
-- that might manually update the tsvector column.
CREATE OR REPLACE FUNCTION memories_tsvector_trigger()
RETURNS trigger AS $$
BEGIN
  NEW.content_tsvector :=
    to_tsvector('simple', coalesce(NEW.content, '') || ' ' || coalesce(NEW.key, ''));
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Step 5: Create the trigger
CREATE TRIGGER memory_tsvector_update
  BEFORE INSERT OR UPDATE OF content, key ON memories
  FOR EACH ROW
  WHEN (pg_trigger_depth() = 0)  -- Prevent recursive trigger calls
  EXECUTE FUNCTION memories_tsvector_trigger();

-- Step 6: Backfill tsvector for existing rows (in case 022's GENERATED column wasn't applied)
UPDATE memories
SET content_tsvector = to_tsvector('simple', coalesce(content, '') || ' ' || coalesce(key, ''))
WHERE content_tsvector IS NULL;
