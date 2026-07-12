import { createRequire } from "node:module";
import { createBetterSqliteAdapter } from "./betterSqliteAdapter";
import {
  createNodeSqliteAdapterFromDatabase,
  type NodeSqliteDatabaseLike,
} from "./nodeSqliteShared";
import { tryOpenSqlcipher } from "./sqlcipherAdapter";
import type { SqliteAdapter, SqliteDriverKind } from "./types";

const _require = createRequire(import.meta.url);

declare global {
  var __AIRouteSqlJsAdapters: Map<string, SqliteAdapter> | undefined;
}

function getSqlJsCache(): Map<string, SqliteAdapter> {
  if (!globalThis.__AIRouteSqlJsAdapters) {
    globalThis.__AIRouteSqlJsAdapters = new Map();
  }
  return globalThis.__AIRouteSqlJsAdapters;
}

/**
 * Resolve the database type from environment.
 * Priority: DB_TYPE env var > AIRROUTE_REGION=cn defaults to sqlcipher > 'sqlite'
 */
export function resolveDbType(): SqliteDriverKind | "sqlite" {
  const dbType = process.env.DB_TYPE;
  if (dbType) {
    const normalized = dbType.toLowerCase().trim();
    if (normalized === "sqlcipher" || normalized === "postgresql") return normalized;
    if (normalized === "sqlite") return "sqlite";
  }

  // For China region, default to sqlcipher for enterprise compliance
  if (process.env.AIRROUTE_REGION === "cn") {
    // Only default to sqlcipher if SQLCIPHER_KEY is provided
    if (process.env.SQLCIPHER_KEY) return "sqlcipher";
  }

  return "sqlite";
}

/**
 * Tenta abrir com better-sqlite3, SQLCipher e node:sqlite sincronamente.
 * Retorna null se todos falharem.
 *
 * Ordem: sqlcipher (se DB_TYPE=sqlcipher) → better-sqlite3 → node:sqlite
 */
export function tryOpenSync(
  filePath: string,
  options?: Record<string, unknown>
): SqliteAdapter | null {
  const dbType = resolveDbType();

  // SQLCipher: encrypted SQLite (takes priority when requested)
  if (dbType === "sqlcipher") {
    try {
      const adapter = tryOpenSqlcipher(filePath, options);
      if (adapter) return adapter;
    } catch (err) {
      // SQLCipher was requested but failed — rethrow with context
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(
        `[DB] SQLCipher driver requested (DB_TYPE=sqlcipher) but failed to initialize:\n  ${msg}\n` +
          `  Install @aspect-build/sqlcipher or set SQLCIPHER_EXTENSION_PATH.`
      );
    }
  }

  // better-sqlite3: rápido, nativo — skip em Bun
  if (!process.versions.bun) {
    try {
      const BetterSqlite = _require("better-sqlite3") as {
        new (p: string, o?: object): import("better-sqlite3").Database;
      };
      const db = new BetterSqlite(filePath, options);
      return createBetterSqliteAdapter(db);
    } catch {
      // continua para próximo driver
    }
  }

  // node:sqlite: built-in desde Node 22.5 — skip em Bun
  if (!process.versions.bun) {
    const [maj, min] = (process.versions.node ?? "0.0").split(".").map(Number);
    if (maj > 22 || (maj === 22 && min >= 5)) {
      try {
        const { DatabaseSync } = _require("node:sqlite") as {
          DatabaseSync: new (p: string) => NodeSqliteDatabaseLike;
        };
        const db = new DatabaseSync(filePath);
        return createNodeSqliteAdapterFromDatabase(db, filePath);
      } catch {
        // continua
      }
    }
  }

  return null;
}

/**
 * Pré-inicializa sql.js para um filePath.
 * Armazena em globalThis para acesso posterior via getSqlJsAdapter().
 * Idempotente — seguro chamar múltiplas vezes.
 */
export async function preInitSqlJs(filePath: string): Promise<SqliteAdapter> {
  const cache = getSqlJsCache();
  const existing = cache.get(filePath);
  if (existing) return existing;

  const { createSqlJsAdapter } = await import("./sqljsAdapter");
  const adapter = await createSqlJsAdapter(filePath);
  cache.set(filePath, adapter);
  return adapter;
}

/** Retorna adapter sql.js pré-inicializado ou null se ainda não inicializado. */
export function getSqlJsAdapter(filePath: string): SqliteAdapter | null {
  return getSqlJsCache().get(filePath) ?? null;
}

/**
 * Factory assíncrona completa: tenta todos os drivers em cascata.
 * Ordem: sqlcipher (if DB_TYPE=sqlcipher) → better-sqlite3 → node:sqlite → sql.js
 *        postgresql (if DB_TYPE=postgresql) — separate path, ignores filePath
 */
export async function openDatabaseAsync(
  filePath: string,
  options?: Record<string, unknown>
): Promise<SqliteAdapter> {
  const dbType = resolveDbType();

  // PostgreSQL: entirely separate path, ignores filePath
  if (dbType === "postgresql") {
    const { createPgAdapter } = await import("./pgAdapter");
    const adapter = await createPgAdapter(options?.connectionString as string | undefined);
    console.log(`[DB] Driver: postgresql | database: ${adapter.name}`);
    return adapter;
  }

  // SQLite-family: try sync drivers first, then async sql.js
  const sync = tryOpenSync(filePath, options);
  if (sync) {
    console.log(`[DB] Driver: ${sync.driver} | file: ${filePath}`);
    return sync;
  }

  console.warn("[DB] Synchronous drivers unavailable — falling back to sql.js (WASM)");
  const adapter = await preInitSqlJs(filePath);
  console.log(`[DB] Driver: sql.js | file: ${filePath}`);
  return adapter;
}
