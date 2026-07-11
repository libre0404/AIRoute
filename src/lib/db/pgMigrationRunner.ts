/**
 * PostgreSQL Migration Runner
 *
 * Mirrors the SQLite migration runner (migrationRunner.ts) functionality
 * but uses PostgreSQL-native introspection (information_schema) instead
 * of SQLite PRAGMA/sqlite_master, and runs the SQL transpiler on each
 * migration before execution.
 *
 * Priorities:
 *   1. Check for a PG override file in migrations_pg/ (hand-authored)
 *   2. Fall back to auto-transpiled SQLite migration via pgSqlTranspiler
 *   3. Skip FTS5-only migrations (PG uses tsvector/GIN instead)
 *
 * Tracking table uses CURRENT_TIMESTAMP instead of datetime('now').
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import type { SqliteAdapter } from "./adapters/types";
import { transpileSqliteToPgV2 } from "./pgSqlTranspiler";

const isNodeTestRunnerChild = typeof process.env.NODE_TEST_CONTEXT === "string";

const console = {
  log: (...args: unknown[]) => {
    if (!isNodeTestRunnerChild) globalThis.console.log(...args);
  },
  warn: (...args: unknown[]) => {
    if (!isNodeTestRunnerChild) globalThis.console.warn(...args);
  },
  error: (...args: unknown[]) => {
    globalThis.console.error(...args);
  },
};

// ── Migrations directory resolution ──

function resolveMigrationsDir(): string {
  const configuredDir = process.env.AIRoute_MIGRATIONS_DIR;
  if (typeof configuredDir === "string" && configuredDir.trim().length > 0) {
    return path.resolve(configuredDir);
  }

  const checkLocations = (basePath: string) => {
    const locations = [
      path.join(basePath, "migrations"),
      path.join(basePath, "src", "lib", "db", "migrations"),
      path.join(basePath, "app", "src", "lib", "db", "migrations"),
    ];
    for (const loc of locations) {
      if (fs.existsSync(loc)) return loc;
    }
    return null;
  };

  try {
    let currentDir = path.dirname(fileURLToPath(import.meta.url));
    while (currentDir !== path.dirname(currentDir)) {
      const found = checkLocations(currentDir);
      if (found) return found;
      currentDir = path.dirname(currentDir);
    }
  } catch {
    // Fall through
  }

  // Fallback: relative to this file
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "migrations");
}

function resolvePgOverridesDir(): string {
  const configuredDir = process.env.AIRoute_PG_MIGRATIONS_DIR;
  if (typeof configuredDir === "string" && configuredDir.trim().length > 0) {
    return path.resolve(configuredDir);
  }
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "migrations_pg");
}

const MIGRATIONS_DIR = resolveMigrationsDir();
const PG_OVERRIDES_DIR = resolvePgOverridesDir();

// ── FTS5 migration versions that should be skipped on PG ──
// These create FTS5 virtual tables which have no PG equivalent.
// PG overrides in migrations_pg/ will use tsvector/GIN instead.
const FTS5_MIGRATION_VERSIONS = new Set(["022", "023"]);

// ── PG introspection (replaces PRAGMA/sqlite_master) ──

/**
 * Check if a table exists using information_schema.
 */
function pgHasTable(db: SqliteAdapter, tableName: string): boolean {
  const result = db.prepare(
    `SELECT COUNT(*) as cnt FROM information_schema.tables ` +
    `WHERE table_schema = 'public' AND table_name = $1`
  ).get(tableName) as { cnt: number } | undefined;
  return (result?.cnt ?? 0) > 0;
}

/**
 * Check if a column exists in a table using information_schema.
 */
function pgHasColumn(db: SqliteAdapter, tableName: string, columnName: string): boolean {
  const result = db.prepare(
    `SELECT COUNT(*) as cnt FROM information_schema.columns ` +
    `WHERE table_schema = 'public' AND table_name = $1 AND column_name = $2`
  ).get(tableName, columnName) as { cnt: number } | undefined;
  return (result?.cnt ?? 0) > 0;
}

/**
 * Ensure the migration tracking table exists (PG-compatible DDL).
 */
function ensureMigrationsTable(db: SqliteAdapter): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS _AIRoute_migrations (
      version TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
  `);
}

/**
 * Get all applied migration versions from the tracking table.
 */
function getAppliedVersions(db: SqliteAdapter): Set<string> {
  if (!pgHasTable(db, "_AIRoute_migrations")) return new Set();
  const rows = db.prepare("SELECT version FROM _AIRoute_migrations").all() as Array<{ version: string }>;
  return new Set(rows.map((r) => r.version));
}

/**
 * Get applied migration records for mismatch detection.
 */
function getAppliedRecords(db: SqliteAdapter): Array<{ version: string; name: string }> {
  if (!pgHasTable(db, "_AIRoute_migrations")) return [];
  return db.prepare("SELECT version, name FROM _AIRoute_migrations ORDER BY version").all() as Array<{
    version: string;
    name: string;
  }>;
}

/**
 * Get all migration files sorted by version number.
 */
function getMigrationFiles(): Array<{ version: string; name: string; path: string }> {
  if (!fs.existsSync(MIGRATIONS_DIR)) return [];

  return fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort()
    .map((filename) => {
      const match = filename.match(/^(\d+)_(.+)\.sql$/);
      if (!match) return null;
      return {
        version: match[1],
        name: match[2],
        path: path.join(MIGRATIONS_DIR, filename),
      };
    })
    .filter(Boolean) as Array<{ version: string; name: string; path: string }>;
}

/**
 * Check if a PG override file exists for this migration.
 * Override files follow the same naming convention but live in migrations_pg/.
 */
function getPgOverridePath(migration: { version: string; name: string }): string | null {
  const overridePath = path.join(PG_OVERRIDES_DIR, `${migration.version}_${migration.name}.sql`);
  return fs.existsSync(overridePath) ? overridePath : null;
}

/**
 * Read and transpile a migration SQL file for PostgreSQL.
 * Priority: PG override → auto-transpiled SQLite migration.
 */
function readMigrationSql(migration: { version: string; name: string; path: string }): {
  sql: string;
  source: "override" | "transpiled";
  warnings: string[];
} {
  // Check for PG override first
  const overridePath = getPgOverridePath(migration);
  if (overridePath) {
    const sql = fs.readFileSync(overridePath, "utf-8");
    console.log(`[PG-Migration] Using PG override for ${migration.version}_${migration.name}`);
    return { sql, source: "override", warnings: [] };
  }

  // Auto-transpile the SQLite migration
  const rawSql = fs.readFileSync(migration.path, "utf-8");
  const result = transpileSqliteToPgV2(rawSql);

  if (result.warnings.length > 0) {
    for (const w of result.warnings) {
      console.warn(`[PG-Migration] ${migration.version}_${migration.name}: ${w}`);
    }
  }

  return { sql: result.sql, source: "transpiled", warnings: result.warnings };
}

/**
 * Detect migration name mismatches (renumbering).
 */
function detectNameMismatches(
  applied: Array<{ version: string; name: string }>,
  files: Array<{ version: string; name: string }>
): Array<{ version: string; appliedName: string; diskName: string }> {
  const fileMap = new Map(files.map((f) => [f.version, f.name]));
  return applied
    .filter((a) => fileMap.has(a.version) && fileMap.get(a.version) !== a.name)
    .map((a) => ({
      version: a.version,
      appliedName: a.name,
      diskName: fileMap.get(a.version)!,
    }));
}

/**
 * Run all pending PostgreSQL migrations.
 *
 * Returns the number of migrations applied.
 */
export function runPgMigrations(db: SqliteAdapter, options?: { isNewDb?: boolean }): number {
  const isNewDb = options?.isNewDb === true;
  ensureMigrationsTable(db);

  const files = getMigrationFiles();
  if (files.length === 0) {
    console.log("[PG-Migration] No migration files found");
    return 0;
  }

  // ── Detect name mismatches ──
  const appliedRecords = getAppliedRecords(db);
  const mismatches = detectNameMismatches(appliedRecords, files);
  if (mismatches.length > 0) {
    console.error(
      `[PG-Migration] WARNING: ${mismatches.length} migration version(s) have been renumbered!`
    );
    for (const m of mismatches) {
      console.error(
        `  Version ${m.version}: applied as "${m.appliedName}" but disk has "${m.diskName}"`
      );
    }
  }

  // ── Determine pending migrations ──
  const applied = getAppliedVersions(db);
  const pending = files.filter((f) => !applied.has(f.version));

  if (pending.length === 0) {
    console.log("[PG-Migration] All migrations already applied");
    return 0;
  }

  console.log(`[PG-Migration] ${pending.length} pending migration(s) to apply`);

  // ── Safety check: mass migration detection ──
  const isTestEnvironment =
    process.env.NODE_ENV === "test" ||
    process.env.VITEST !== undefined;

  const maxPending = Number(process.env.AIRoute_MAX_PENDING_MIGRATIONS || "30");
  if (
    !isTestEnvironment &&
    !isNewDb &&
    applied.size > 0 &&
    maxPending > 0 &&
    pending.length > maxPending
  ) {
    console.error(
      `[PG-Migration] ABORT: ${pending.length} pending migrations on an existing database ` +
      `(threshold is ${maxPending}). This usually means the migration tracking table was wiped. ` +
      `Set AIRoute_MAX_PENDING_MIGRATIONS=0 to bypass.`
    );
    throw new Error(
      `PG Migration safety abort: ${pending.length} pending migrations (max ${maxPending})`
    );
  }

  // ── Apply pending migrations ──
  let appliedCount = 0;
  let skippedCount = 0;

  for (const migration of pending) {
    // Skip FTS5-only migrations (PG uses tsvector/GIN instead)
    if (FTS5_MIGRATION_VERSIONS.has(migration.version)) {
      const overridePath = getPgOverridePath(migration);
      if (!overridePath) {
        console.warn(
          `[PG-Migration] Skipping FTS5 migration ${migration.version}_${migration.name} ` +
          `(no PG override — PG uses tsvector/GIN for full-text search)`
        );
        // Record as applied so we don't keep trying
        db.prepare(
          "INSERT INTO _AIRoute_migrations (version, name) VALUES ($1, $2)"
        ).run(migration.version, `${migration.name}_fts5_skipped`);
        skippedCount++;
        continue;
      }
    }

    const { sql, source, warnings } = readMigrationSql(migration);

    try {
      db.transaction(() => {
        // Execute the (potentially transpiled) migration SQL
        db.exec(sql);

        // Record migration as applied
        db.prepare(
          "INSERT INTO _AIRoute_migrations (version, name) VALUES ($1, $2)"
        ).run(migration.version, migration.name);
      })();

      appliedCount++;
      console.log(
        `[PG-Migration] Applied ${migration.version}_${migration.name} ` +
        `(source: ${source}${warnings.length > 0 ? `, ${warnings.length} warning(s)` : ""})`
      );
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(
        `[PG-Migration] FAILED: ${migration.version}_${migration.name}: ${message}`
      );
      // If this is a FTS5 migration that failed, skip it
      if (/fts5|virtual table/i.test(message)) {
        console.warn(
          `[PG-Migration] FTS5-related error — marking as skipped. ` +
          `Consider providing a PG override.`
        );
        db.prepare(
          "INSERT INTO _AIRoute_migrations (version, name) VALUES ($1, $2)"
        ).run(migration.version, `${migration.name}_fts5_skipped`);
        skippedCount++;
        continue;
      }
      throw err;
    }
  }

  console.log(
    `[PG-Migration] Complete: ${appliedCount} applied, ${skippedCount} skipped`
  );
  return appliedCount;
}

/**
 * Check PG-specific health: verify the migration tracking table exists
 * and all expected migrations are applied.
 */
export function pgMigrationHealthCheck(db: SqliteAdapter): {
  healthy: boolean;
  appliedCount: number;
  pendingCount: number;
  lastApplied: string | null;
} {
  if (!pgHasTable(db, "_AIRoute_migrations")) {
    return { healthy: false, appliedCount: 0, pendingCount: 0, lastApplied: null };
  }

  const appliedVersions = getAppliedVersions(db);
  const files = getMigrationFiles();
  const pending = files.filter((f) => !appliedVersions.has(f.version));

  const lastRecord = getAppliedRecords(db).pop();

  return {
    healthy: pending.length === 0,
    appliedCount: appliedVersions.size,
    pendingCount: pending.length,
    lastApplied: lastRecord ? `${lastRecord.version}_${lastRecord.name}` : null,
  };
}
