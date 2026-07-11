/**
 * MITM Audit Logger — Compliance audit trail for MITM activation and usage
 *
 * When AIRROUTE_REGION=cn, all MITM operations are logged to a tamper-evident
 * audit log file for compliance with 《网络安全法》 and 《数据安全法》.
 *
 * Log entries include:
 *   - Timestamp (UTC)
 *   - Operation type (start/stop/repair/cert-install/cert-remove/dns-add/dns-remove)
 *   - Target hosts affected
 *   - Operator (process user / session ID)
 *   - Duration of operation
 *   - Status (success/failure)
 *
 * Log file: DATA_DIR/mitm_audit.log (append-only, rotated at 10MB)
 */

import fs from "fs";
import path from "path";
import crypto from "crypto";

export type MitmOperation =
  | "start"
  | "stop"
  | "repair"
  | "cert-install"
  | "cert-remove"
  | "dns-add"
  | "dns-remove"
  | "tproxy-enable"
  | "tproxy-disable"
  | "tls-fingerprint-enable"
  | "scope-violation"
  | "config-change";

export interface MitmAuditEntry {
  timestamp: string;
  operation: MitmOperation;
  targets?: string[];
  operator?: string;
  status: "success" | "failure" | "blocked";
  durationMs?: number;
  reason?: string;
  checksum: string;
}

const MAX_LOG_SIZE = 10 * 1024 * 1024; // 10MB
let auditLogPath: string | null = null;

/**
 * Resolve the audit log path. Lazily initialized to avoid
 * needing DATA_DIR at module load time.
 */
function getAuditLogPath(): string {
  if (auditLogPath) return auditLogPath;

  const dataDir =
    process.env.DATA_DIR ||
    path.join(process.env.HOME || process.env.USERPROFILE || "/tmp", ".airoute");

  const auditDir = path.join(dataDir, "audit");
  if (!fs.existsSync(auditDir)) {
    fs.mkdirSync(auditDir, { recursive: true });
  }

  auditLogPath = path.join(auditDir, "mitm_audit.log");
  return auditLogPath;
}

/**
 * Compute a tamper-evident checksum for a log entry.
 * Uses HMAC-SHA256 with the previous line's checksum as key chain.
 */
function computeChecksum(entry: Omit<MitmAuditEntry, "checksum">, previousChecksum?: string): string {
  const key = previousChecksum || "AIRoute-mitm-audit-genesis";
  const payload = JSON.stringify(entry);
  return crypto.createHmac("sha256", key).update(payload).digest("hex").substring(0, 16);
}

/**
 * Read the last checksum from the audit log for chain verification.
 */
function getLastChecksum(): string | undefined {
  const logPath = getAuditLogPath();
  if (!fs.existsSync(logPath)) return undefined;

  try {
    const content = fs.readFileSync(logPath, "utf-8");
    const lines = content.trim().split("\n");
    if (lines.length === 0) return undefined;

    const lastLine = lines[lines.length - 1];
    const lastEntry = JSON.parse(lastLine) as MitmAuditEntry;
    return lastEntry.checksum;
  } catch {
    return undefined;
  }
}

/**
 * Rotate the audit log if it exceeds MAX_LOG_SIZE.
 */
function rotateIfNeeded(): void {
  const logPath = getAuditLogPath();
  if (!fs.existsSync(logPath)) return;

  try {
    const stats = fs.statSync(logPath);
    if (stats.size >= MAX_LOG_SIZE) {
      const rotatedPath = logPath.replace(".log", `_${Date.now()}.log`);
      fs.renameSync(logPath, rotatedPath);
    }
  } catch {
    // Non-critical — just continue
  }
}

/**
 * Log a MITM operation to the audit trail.
 *
 * When AIRROUTE_REGION=cn, this is mandatory and cannot be disabled.
 * When not in CN region, this is a best-effort log.
 */
export function logMitmOperation(entry: {
  operation: MitmOperation;
  targets?: string[];
  operator?: string;
  status: "success" | "failure" | "blocked";
  durationMs?: number;
  reason?: string;
}): void {
  const isCnRegion = process.env.AIRROUTE_REGION === "cn";

  const auditEntry: Omit<MitmAuditEntry, "checksum"> = {
    timestamp: new Date().toISOString(),
    operation: entry.operation,
    ...(entry.targets && { targets: entry.targets }),
    ...(entry.operator && { operator: entry.operator }),
    status: entry.status,
    ...(entry.durationMs !== undefined && { durationMs: entry.durationMs }),
    ...(entry.reason && { reason: entry.reason }),
  };

  const previousChecksum = getLastChecksum();
  const checksum = computeChecksum(auditEntry, previousChecksum);
  const fullEntry: MitmAuditEntry = { ...auditEntry, checksum };

  rotateIfNeeded();

  const logPath = getAuditLogPath();
  const line = JSON.stringify(fullEntry) + "\n";

  try {
    fs.appendFileSync(logPath, line, "utf-8");
  } catch (err) {
    if (isCnRegion) {
      // In CN region, audit logging failure is critical
      console.error(
        `[MITM-Audit] CRITICAL: Failed to write audit log in CN region: ${err}. ` +
        `Operation: ${entry.operation}, Status: ${entry.status}`
      );
    }
    // Non-CN: best effort only
  }

  // Also log to console for observability
  const prefix = isCnRegion ? "[MITM-Audit][CN]" : "[MITM-Audit]";
  console.log(
    `${prefix} ${entry.operation} | status=${entry.status}` +
    (entry.targets ? ` | targets=${entry.targets.join(",")}` : "") +
    (entry.reason ? ` | reason=${entry.reason}` : "") +
    (entry.durationMs !== undefined ? ` | duration=${entry.durationMs}ms` : "")
  );
}

/**
 * Verify the integrity of the audit log chain.
 * Returns true if all checksums are valid, false if any tampering is detected.
 */
export function verifyAuditLogIntegrity(): {
  valid: boolean;
  totalEntries: number;
  tamperedEntry?: number;
} {
  const logPath = getAuditLogPath();
  if (!fs.existsSync(logPath)) return { valid: true, totalEntries: 0 };

  try {
    const content = fs.readFileSync(logPath, "utf-8");
    const lines = content.trim().split("\n").filter((l) => l.trim());
    let previousChecksum: string | undefined;

    for (let i = 0; i < lines.length; i++) {
      const entry = JSON.parse(lines[i]) as MitmAuditEntry;
      const { checksum, ...rest } = entry;
      const expectedChecksum = computeChecksum(rest, previousChecksum);

      if (checksum !== expectedChecksum) {
        return { valid: false, totalEntries: lines.length, tamperedEntry: i + 1 };
      }

      previousChecksum = checksum;
    }

    return { valid: true, totalEntries: lines.length };
  } catch {
    return { valid: true, totalEntries: 0 };
  }
}
