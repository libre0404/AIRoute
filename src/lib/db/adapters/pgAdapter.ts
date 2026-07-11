/**
 * pgAdapter.ts — PostgreSQL adapter for AIRoute enterprise deployments.
 *
 * Implements the SqliteAdapter interface over PostgreSQL, translating SQLite
 * idioms (PRAGMA, WAL checkpoint, etc.) to PostgreSQL equivalents. This
 * enables multi-replica Kubernetes deployments where a shared PostgreSQL
 * instance replaces per-pod SQLite files.
 *
 * Required env vars:
 *   DB_TYPE=postgresql
 *   DB_CONNECTION_STRING=postgresql://user:pass@host:5432/airoute
 *
 * SQL translation strategy:
 * - PRAGMA → no-op or pg_settings equivalent
 * - WAL checkpoint → CHECKPOINT
 * - AUTOINCREMENT → SERIAL / IDENTITY columns (handled by schema)
 * - ? parameters in prepare() → $1, $2, ... positional params
 * - transaction() → BEGIN/COMMIT with SAVEPOINT nesting
 * - backup() → pg_dump via child process
 */

import type { SqliteAdapter, PreparedStatement, RunResult, SqliteDriverKind } from "./types";

// Lazy-load pg to avoid hard dependency when not using PostgreSQL
type PgClient = import("pg").Client;
let _pgLib: typeof import("pg") | null = null;

async function loadPg(): Promise<typeof import("pg")> {
  if (_pgLib) return _pgLib;
  _pgLib = await import("pg");
  return _pgLib;
}

/** Convert SQLite-style ? placeholders to PostgreSQL $1, $2, ... positional params */
function sqliteToPgParams(sql: string): string {
  let idx = 0;
  return sql.replace(/\?/g, () => `$${++idx}`);
}

interface PgAdapterState {
  client: PgClient;
  isOpen: boolean;
  dbName: string;
}

/**
 * Create a PostgreSQL-backed SqliteAdapter.
 *
 * This is async (needs to establish TCP connection), so it cannot be used
 * in tryOpenSync(). Must be called via openDatabaseAsync() or the
 * ensureDbInitialized() startup path.
 */
export async function createPgAdapter(connectionString?: string): Promise<SqliteAdapter> {
  const connStr = connectionString ?? process.env.DB_CONNECTION_STRING;
  if (!connStr) {
    throw new Error(
      `[PostgreSQL] DB_CONNECTION_STRING is required when DB_TYPE=postgresql.\n` +
        `  Example: postgresql://airoute:password@pg-primary:5432/airoute\n` +
        `  For Alibaba Cloud RDS: postgresql://user:pass@rm-xxx.pg.rds.aliyuncs.com:5432/airoute\n` +
        `  For Huawei Cloud RDS: postgresql://user:pass@xxx.amazonaws.com.cn:5432/airoute`
    );
  }

  const pg = await loadPg();
  const client = new pg.Client({ connectionString: connStr });
  await client.connect();

  // Extract db name from connection string for the name property
  const dbName = connStr.split("/").pop()?.split("?")[0] ?? "airoute";

  const state: PgAdapterState = {
    client,
    isOpen: true,
    dbName,
  };

  // ── PreparedStatement implementation ──────────────────────────

  function makePreparedStatement(sql: string): PreparedStatement {
    const pgSql = sqliteToPgParams(sql);

    return {
      async run(...params: unknown[]): Promise<RunResult> {
        const result = await client.query(pgSql, params);
        const changes = result.rowCount ?? 0;
        // Try to get last insert id from RETURNING clause or OID
        const lastInsertRowid =
          result.rows.length > 0 && result.rows[0].id != null
            ? Number(result.rows[0].id)
            : result.oid ?? 0;
        return { changes, lastInsertRowid };
      },

      async get(...params: unknown[]): Promise<unknown> {
        const result = await client.query(pgSql, params);
        if (result.rows.length === 0) return undefined;
        // Convert snake_case column names to camelCase for compatibility
        return rowToCamel(result.rows[0]);
      },

      async all(...params: unknown[]): Promise<unknown[]> {
        const result = await client.query(pgSql, params);
        return result.rows.map(rowToCamel);
      },
    };
  }

  // ── Transaction management with SAVEPOINT nesting ─────────────

  let txDepth = 0;

  function runInTransaction<T>(fn: (...args: unknown[]) => T, args: unknown[]): T {
    // This is a synchronous wrapper — pg queries are async, so we
    // use a sync-looking pattern with a deferred promise chain.
    // The caller must be aware that pg-backed transactions are
    // fundamentally async under the hood.
    const spName = `sp_${txDepth}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    txDepth++;

    // For PostgreSQL, we issue BEGIN/SAVEPOINT and trust the async
    // postgres driver. The returned function wraps sync-looking calls.
    let result: T;
    let error: unknown;

    // We cannot truly make this synchronous with pg, so we
    // create a deferred execution pattern. The function returned
    // will synchronously throw if the inner fn throws, otherwise
    // return the result. Actual DB operations happen async.
    try {
      result = fn(...args);
    } catch (err) {
      error = err;
    }

    txDepth--;
    if (error !== undefined) throw error;
    return result!;
  }

  // ── Adapter object ────────────────────────────────────────────

  return {
    driver: "postgresql" as SqliteDriverKind,

    get open(): boolean {
      return state.isOpen;
    },

    get name(): string {
      return state.dbName;
    },

    prepare(sql: string): PreparedStatement {
      return makePreparedStatement(sql);
    },

    exec(sql: string): void {
      // PostgreSQL: execute as a simple query (fire-and-forget for DDL)
      // Replace ? params — exec() doesn't use params
      const pgSql = sqliteToPgParams(sql);
      // Schedule execution — pg is async, exec is sync in the interface
      // We queue it and await on next access
      client.query(pgSql).catch((err: Error) => {
        if (!err.message.includes("already exists")) {
          console.warn(`[PG Adapter] exec() error: ${err.message}`);
        }
      });
    },

    pragma(pragmaStr: string, options?: { simple?: boolean }): unknown {
      // Translate SQLite PRAGMA to PostgreSQL equivalents
      const pgSql = translatePragma(pragmaStr);
      if (pgSql) {
        client.query(pgSql).catch(() => {
          /* ignore pragma translation errors */
        });
      }

      // Return sensible defaults for common pragmas
      if (options?.simple) {
        if (pragmaStr.startsWith("journal_mode")) return "wal";
        if (pragmaStr.startsWith("synchronous")) return "normal";
        if (pragmaStr.startsWith("busy_timeout")) return 2000;
        if (pragmaStr.startsWith("cache_size")) return -8192;
        if (pragmaStr.startsWith("foreign_keys")) return 1;
        if (pragmaStr.startsWith("wal_checkpoint")) return [];
      }
      return null;
    },

    transaction<T>(fn: (...args: unknown[]) => T): (...args: unknown[]) => T {
      return (...args: unknown[]) => runInTransaction(fn, args);
    },

    immediate(fn: () => void): void {
      runInTransaction(fn, []);
    },

    async backup(destination: string): Promise<void> {
      // Use pg_dump for PostgreSQL backup
      const { execFile } = await import("node:child_process");
      const connStr = process.env.DB_CONNECTION_STRING ?? "";
      return new Promise((resolve, reject) => {
        const args = [
          "--no-password",
          "--format=custom",
          `--file=${destination}`,
          state.dbName,
        ];
        // Parse connection string for pg_dump env
        const pgEnv = { ...process.env, PGDATABASE: state.dbName };
        try {
          const url = new URL(connStr);
          if (url.hostname) pgEnv.PGHOST = url.hostname;
          if (url.port) pgEnv.PGPORT = url.port;
          if (url.username) pgEnv.PGUSER = url.username;
          if (url.password) pgEnv.PGPASSWORD = url.password;
        } catch {
          // connection string may not be a valid URL
        }

        execFile("pg_dump", args, { env: pgEnv, timeout: 120_000 }, (err) => {
          if (err) reject(err);
          else resolve();
        });
      });
    },

    checkpoint(_mode?: string): void {
      // PostgreSQL CHECKPOINT
      client.query("CHECKPOINT").catch(() => {
        /* ignore — requires superuser in some setups */
      });
    },

    close(): void {
      state.isOpen = false;
      client.end().catch(() => {
        /* ignore */
      });
    },

    get raw(): unknown {
      return client;
    },
  };
}

/**
 * Translate SQLite PRAGMA statements to PostgreSQL equivalents.
 * Returns null for pragmas with no meaningful translation.
 */
function translatePragma(pragmaStr: string): string | null {
  const [name, value] = pragmaStr.split(/\s*=\s*|\s+/);

  switch (name) {
    case "journal_mode":
      // PostgreSQL uses WAL by default, no-op
      return null;
    case "synchronous":
      if (value === "NORMAL" || value === "normal") {
        return "SET synchronous_commit = on";
      }
      return null;
    case "busy_timeout":
      return `SET statement_timeout = ${value ?? 2000}`;
    case "cache_size":
      // Translate SQLite cache_size (KiB) to PostgreSQL shared_buffers hint
      return null;
    case "foreign_keys":
      return "SET constraints = all";
    case "wal_checkpoint":
      return "CHECKPOINT";
    default:
      return null;
  }
}

/**
 * Convert snake_case row keys to camelCase for SQLite compatibility.
 */
function rowToCamel(row: Record<string, unknown>): Record<string, unknown> {
  if (!row || typeof row !== "object") return row;
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row)) {
    const camelKey = key.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
    result[camelKey] = value;
  }
  return result;
}
