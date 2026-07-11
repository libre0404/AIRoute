-- 022_add_memory_fts5.sql (PostgreSQL Override)
-- Full-Text Search using tsvector/GIN indexes instead of SQLite FTS5.
-- PostgreSQL provides superior full-text search via tsvector columns and GIN indexes.

-- Some legacy databases may have version 015 marked as applied but still be missing the
-- base memories table. Recreate the table defensively here.
CREATE TABLE IF NOT EXISTS memories (
  id TEXT PRIMARY KEY,
  api_key_id TEXT NOT NULL,
  session_id TEXT,
  type TEXT NOT NULL CHECK(type IN ('factual', 'episodic', 'procedural', 'semantic')),
  key TEXT,
  content TEXT NOT NULL,
  metadata TEXT,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  expires_at TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_memories_api_key ON memories(api_key_id);
CREATE INDEX IF NOT EXISTS idx_memories_session ON memories(session_id);
CREATE INDEX IF NOT EXISTS idx_memories_type ON memories(type);
CREATE INDEX IF NOT EXISTS idx_memories_expires ON memories(expires_at);

-- Add tsvector column for full-text search
-- Uses 'simple' config for Chinese+English mixed content; switch to 'zhparser' or
-- 'pg_jieba' for Chinese word segmentation if available.
ALTER TABLE memories ADD COLUMN IF NOT EXISTS content_tsvector tsvector
  GENERATED ALWAYS AS (to_tsvector('simple', coalesce(content, '') || ' ' || coalesce(key, ''))) STORED;

-- GIN index for fast tsvector queries
CREATE INDEX IF NOT EXISTS idx_memories_content_tsvector ON memories USING GIN(content_tsvector);
