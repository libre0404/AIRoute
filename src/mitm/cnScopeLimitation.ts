/**
 * MITM Scope Limitation — Region-based restrictions for AIRROUTE_REGION=cn
 *
 * When operating in the CN region, the MITM proxy infrastructure must comply
 * with 《网络安全法》, 《数据安全法》, and 《个人信息保护法》.
 *
 * This module provides:
 *   1. CN-specific bypass domains (government, banking, payment, identity)
 *   2. MITM feature gating (some features blocked in CN region)
 *   3. Scope validation before MITM activation
 *   4. DNS resolver override (avoid 8.8.8.8 in CN)
 */

import { logMitmOperation } from "./mitmAuditLogger";

// ── CN-specific bypass domains ──
// These domains MUST NEVER be intercepted, even if the user adds them as targets.
// The MITM proxy must always bypass these, ensuring no sensitive government/banking/
// payment traffic is ever decrypted or inspected.

export const CN_BYPASS_DOMAINS: readonly string[] = [
  // ── Government ──
  "*.gov.cn",
  "*.gov.com.cn",
  "*.gjb.cn",          // 军队
  "*.mca.gov.cn",      // 民政
  "*.mps.gov.cn",      // 公安
  "*.court.gov.cn",    // 法院
  "*.procuratorate.gov.cn", // 检察院
  "*.npc.gov.cn",      // 人大
  "*.cppcc.gov.cn",    // 政协
  "*.most.gov.cn",     // 科技部
  "*.miit.gov.cn",     // 工信部
  "*.cac.gov.cn",      // 网信办
  "*.samr.gov.cn",     // 市场监管
  "*.cbirc.gov.cn",    // 银保监

  // ── Banking ──
  "*.icbc.com.cn",     // 工商银行
  "*.ccb.com",         // 建设银行
  "*.boc.cn",          // 中国银行
  "*.abchina.com",     // 农业银行
  "*.bankcomm.com",    // 交通银行
  "*.psbc.com",        // 邮储银行
  "*.cgbchina.com.cn", // 广发银行
  "*.cmbchina.com",    // 招商银行
  "*.spdb.com.cn",     // 浦发银行
  "*.cebnet.com.cn",   // 光大银行
  "*.cib.com.cn",      // 兴业银行
  "*.pab.com.cn",      // 平安银行
  "*.hzbank.com.cn",   // 杭州银行

  // ── Payment ──
  "pay.weixin.qq.com",     // 微信支付
  "*.weixin.qq.com",       // 微信
  "*.weixin.qq.com.cn",
  "alipay.com",            // 支付宝
  "*.alipay.com",
  "*.alipayobjects.com",
  "epay.163.com",          // 网易支付
  "*.unionpay.com",        // 银联
  "*.unionpaysecure.com",
  "*.95516.com",           // 银联在线

  // ── Identity & Social Credit ──
  "*.nid.gov.cn",          // 全国身份证
  "*.chsi.com.cn",         // 学信网
  "*.12333.gov.cn",        // 社保
  "*.si.gov.cn",           // 社保查询
  "*.health.gov.cn",       // 卫健委
  "*.nhc.gov.cn",          // 国家卫健委

  // ── Telecom (carrier billing) ──
  "*.189.cn",              // 中国电信
  "*.10000.com",
  "*.chinamobile.com",     // 中国移动
  "*.10086.cn",
  "*.chinaunicom.com",     // 中国联通
  "*.10010.com",

  // ── Tax ──
  "*.chinatax.gov.cn",     // 税务总局
  "*.ntax.gov.cn",

  // ── Stock ──
  "*.sse.com.cn",          // 上交所
  "*.szse.cn",             // 深交所
  "*.neeq.com.cn",         // 新三板
  "*.csrc.gov.cn",         // 证监会
];

// ── MITM features blocked in CN region ──
// These features are NOT available when AIRROUTE_REGION=cn due to compliance concerns.

export const CN_BLOCKED_MITM_FEATURES: ReadonlySet<string> = new Set([
  // TPROXY transparent decrypt can intercept ANY traffic — too broad for CN compliance
  "tproxy-decrypt",

  // Dynamic CA that signs any SNI is a security risk in regulated environments
  "dynamic-ca-unrestricted",
]);

// ── MITM features restricted (requires explicit opt-in) in CN region ──

export const CN_RESTRICTED_MITM_FEATURES: ReadonlyMap<string, string> = new Map([
  [
    "tls-fingerprint-spoofing",
    "TLS fingerprint spoofing may violate provider ToS. Set MITM_CN_ALLOW_TLS_SPOOFING=1 to enable.",
  ],
  [
    "global-fetch-patching",
    "Global fetch patching affects ALL outbound traffic. Set MITM_CN_ALLOW_GLOBAL_FETCH_PATCH=1 to enable.",
  ],
  [
    "upstream-ca-trust",
    "Adding custom upstream CA trusts affects ALL outbound connections. Set MITM_CN_ALLOW_UPSTREAM_CA=1 to enable.",
  ],
]);

/**
 * Check if a domain should be bypassed in the CN region.
 * Matches against CN_BYPASS_DOMAINS patterns (supports leading wildcards).
 */
export function isCnBypassDomain(hostname: string): boolean {
  if (process.env.AIRROUTE_REGION !== "cn") return false;

  const lower = hostname.toLowerCase();

  for (const pattern of CN_BYPASS_DOMAINS) {
    if (pattern.startsWith("*.")) {
      const suffix = pattern.substring(2); // Remove "*."
      if (lower === suffix || lower.endsWith("." + suffix)) {
        return true;
      }
    } else {
      if (lower === pattern || lower.endsWith("." + pattern)) {
        return true;
      }
    }
  }

  return false;
}

/**
 * Validate whether a requested MITM operation is allowed in the CN region.
 * Returns { allowed: true } or { allowed: false, reason: string }.
 */
export function validateMitmScopeForCn(options: {
  operation: string;
  targets?: string[];
  features?: string[];
}): { allowed: boolean; reason?: string; blockedTargets?: string[] } {
  if (process.env.AIRROUTE_REGION !== "cn") {
    return { allowed: true };
  }

  const { operation, targets = [], features = [] } = options;

  // ── Check blocked features ──
  for (const feature of features) {
    if (CN_BLOCKED_MITM_FEATURES.has(feature)) {
      logMitmOperation({
        operation: "scope-violation",
        targets,
        status: "blocked",
        reason: `Feature "${feature}" is blocked in CN region`,
      });
      return {
        allowed: false,
        reason: `MITM feature "${feature}" is blocked in AIRROUTE_REGION=cn for compliance. ` +
          `See src/mitm/cnScopeLimitation.ts for details.`,
      };
    }
  }

  // ── Check restricted features (require explicit opt-in) ──
  for (const feature of features) {
    const restriction = CN_RESTRICTED_MITM_FEATURES.get(feature);
    if (restriction) {
      const envVar = `MITM_CN_ALLOW_${feature.replace(/-/g, "_").toUpperCase()}`;
      if (process.env[envVar] !== "1") {
        logMitmOperation({
          operation: "scope-violation",
          targets,
          status: "blocked",
          reason: `Feature "${feature}" requires opt-in: ${restriction}`,
        });
        return {
          allowed: false,
          reason: restriction,
        };
      }
    }
  }

  // ── Check target domains ──
  const blockedTargets: string[] = [];
  for (const target of targets) {
    if (isCnBypassDomain(target)) {
      blockedTargets.push(target);
    }
  }

  if (blockedTargets.length > 0) {
    logMitmOperation({
      operation: "scope-violation",
      targets: blockedTargets,
      status: "blocked",
      reason: "Target domain(s) are in CN bypass list — interception not allowed",
    });
    return {
      allowed: false,
      reason: `The following target domains are protected in CN region and cannot be intercepted: ` +
        blockedTargets.join(", "),
      blockedTargets,
    };
  }

  // ── Validate operation ──
  const blockedOps = ["tproxy-decrypt"];
  if (blockedOps.includes(operation)) {
    logMitmOperation({
      operation: "scope-violation",
      status: "blocked",
      reason: `Operation "${operation}" is blocked in CN region`,
    });
    return {
      allowed: false,
      reason: `MITM operation "${operation}" is blocked in AIRROUTE_REGION=cn for compliance.`,
    };
  }

  return { allowed: true };
}

/**
 * Get the recommended DNS resolver for the current region.
 * In CN region, use AliDNS (223.5.5.5) instead of Google DNS (8.8.8.8).
 */
export function getRegionDnsResolver(): string {
  if (process.env.AIRROUTE_REGION === "cn") {
    // AliDNS — Alibaba Cloud public DNS, fast and reliable in mainland China
    return "223.5.5.5";
  }
  // Default: Google DNS
  return "8.8.8.8";
}

/**
 * Get the merged bypass list (default + CN-specific).
 */
export function getMergedBypassList(existingBypass: string[]): string[] {
  if (process.env.AIRROUTE_REGION !== "cn") {
    return existingBypass;
  }

  // Merge CN-specific bypass domains into the existing list
  const merged = new Set([...existingBypass, ...CN_BYPASS_DOMAINS]);
  return Array.from(merged);
}
