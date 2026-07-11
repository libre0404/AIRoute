/**
 * sqlcipherAdapter.ts — SQLCipher (encrypted SQLite) adapter for AIRoute.
 *
 * Wraps @aspect-build/sqlcipher or better-sqlite3 with SQLCipher extension,
 * providing transparent at-rest encryption for the database file.
 * Falls back to better-sqlite3 if SQLCipher native binary is unavailable.
 *
 * Required env vars:
 *   DB_TYPE=sqlcipher
 *   SQLCIPHER_KEY=<hex-encoded 64-char key> or <passphrase>
 *   SQLCIPHER_KEY_FORMAT=hex | passphrase  (default: hex)
 *
 * When DB_TYPE=sqlcipher and SQLCIPHER_KEY is not set, startup will fail
 * with a clear error message. This is mandatory for AIRROUTE_REGION=cn
 * enterprise deployments per 《数据安全法》 compliance requirements.
 */

import { createRequire } from "node:module";
import type { SqliteAdapter, PreparedStatement, RunResult, SqliteDriverKind } from "./types";

const _require = createRequire(import.meta.url);

/**
 * SQLCipher is API-compatible with better-sqlite3 but requires PRAGMA key
 * before any read/write operation. This adapter wraps the SQLCipher database
 * and auto-applies the key pragma on open.
 */
export function createSqlcipherAdapter(
  db: import("better-sqlite3").Database,
  options?: { key?: string; keyFormat?: "hex" | "passphrase"; cipherCompatibility?: number }
): SqliteAdapter {
  // Apply SQLCipher key pragma immediately after opening
  if (options?.key) {
    if (options.keyFormat === "passphrase") {
      db.pragma(`key = '${options.key.replace(/'/g, "''")}'`);
    } else {
      // Default: hex format (0x prefix for hex keys)
      const hexKey = options.key.startsWith("0x") ? options.key : `0x${options.key}`;
      db.pragma(`key = "${hexKey}"`);
    }
  }

  // Set cipher compatibility version (default: 4 = SQLCipher 4.x)
  const cipherVersion = options?.cipherCompatibility ?? 4;
  db.pragma(`cipher_compatibility = ${cipherVersion}`);

  // Verify the database is readable (wrong key = error here)
  try {
    db.prepare("SELECT count(*) FROM sqlite_master").get();
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    db.close();
    throw new Error(
      `[SQLCipher] Failed to open database — key may be incorrect or database is not encrypted.\n` +
        `  Original error: ${msg}\n` +
        `  Check SQLCIPHER_KEY and SQLCIPHER_KEY_FORMAT environment variables.`
    );
  }

  return {
    driver: "sqlcipher" as SqliteDriverKind,

    get open() {
      return db.open;
    },

    get name() {
      return db.name;
    },

    prepare(sql: string): PreparedStatement {
      const stmt = db.prepare(sql);
      return {
        run(...params: unknown[]): RunResult {
          return stmt.run(...params) as unknown as RunResult;
        },
        get(...params: unknown[]): unknown {
          return stmt.get(...params);
        },
        all(...params: unknown[]): unknown[] {
          return stmt.all(...params);
        },
      };
    },

    exec(sql: string): void {
      db.exec(sql);
    },

    pragma(pragmaStr: string, options?: { simple?: boolean }): unknown {
      return db.pragma(pragmaStr, options);
    },

    transaction<T>(fn: (...args: unknown[]) => T): (...args: unknown[]) => T {
      return db.transaction(fn) as (...args: unknown[]) => T;
    },

    immediate(fn: () => void): void {
      (db.transaction(fn) as unknown as { immediate: () => void }).immediate();
    },

    async backup(destination: string): Promise<void> {
      await db.backup(destination);
    },

    checkpoint(mode = "TRUNCATE"): void {
      try {
        db.pragma(`wal_checkpoint(${mode})`);
      } catch {
        /* ignore */
      }
    },

    close(): void {
      db.close();
    },

    get raw() {
      return db;
    },
  };
}

/**
 * Try to open a SQLCipher database. Returns null if the native binary is unavailable.
 * Throws if SQLCIPHER_KEY is missing.
 */
export function tryOpenSqlcipher(
  filePath: string,
  options?: Record<string, unknown>
): SqliteAdapter | null {
  const key = (options?.key ?? process.env.SQLCIPHER_KEY) as string | undefined;
  const keyFormat = (options?.keyFormat ?? process.env.SQLCIPHER_KEY_FORMAT ?? "hex") as
    | "hex"
    | "passphrase";
  const cipherCompatibility = Number(
    options?.cipherCompatibility ?? process.env.SQLCIPHER_CIPHER_COMPATIBILITY ?? 4
  );

  if (!key) {
    throw new Error(
      `[SQLCipher] SQLCIPHER_KEY is required when DB_TYPE=sqlcipher.\n` +
        `  Generate a hex key: openssl rand -hex 32\n` +
        `  Then set SQLCIPHER_KEY=<hex_value> in your environment.`
    );
  }

  // Try loading @aspect-build/sqlcipher first
  try {
    const SqlcipherDB = _require("@aspect-build/sqlcipher") as {
      new (p: string, o?: object): import("better-sqlite3").Database;
    };
    const db = new SqlcipherDB(filePath, options);
    return createSqlcipherAdapter(db, {
      key,
      keyFormat,
      cipherCompatibility,
    });
  } catch {
    // Fall through to better-sqlite3 + extension approach
  }

  // Fallback: try loading better-sqlite3 and loading SQLCipher as extension
  try {
    const BetterSqlite = _require("better-sqlite3") as {
      new (p: string, o?: object): import("better-sqlite3").Database;
    };
    const db = new BetterSqlite(filePath, options);

    // Attempt to load SQLCipher as a runtime extension
    const extensionPath = process.env.SQLCIPHER_EXTENSION_PATH;
    if (extensionPath) {
      db.loadExtension(extensionPath);
      return createSqlcipherAdapter(db, {
        key,
        keyFormat,
        cipherCompatibility,
      });
    }

    // No extension path available — close and return null
    db.close();
  } catch {
    // Fall through
  }

  return null;
}
