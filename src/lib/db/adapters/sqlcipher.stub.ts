/**
 * Stub for @aspect-build/sqlcipher — the native SQLCipher binary is optional.
 *
 * This stub is loaded by Turbopack when the native package is not installed.
 * At runtime, `sqlcipherAdapter.ts` wraps the require() in a try/catch, so
 * this stub will simply throw, and the adapter will fall back to better-sqlite3.
 */

throw new Error(
  "@aspect-build/sqlcipher native binary is not installed. " +
    "Falling back to better-sqlite3 (unencrypted). " +
    "Install @aspect-build/sqlcipher for at-rest encryption."
);
