---
AIGC:
  ContentProducer: '001191110102MAD55U9H0F10002'
  ContentPropagator: '001191110102MAD55U9H0F10002'
  Label: '1'
  ProduceID: '9e7d1590-8e1e-4805-9293-865cc6c88ad6'
  PropagateID: '9e7d1590-8e1e-4805-9293-865cc6c88ad6'
  ReservedCode1: '093a3d1f-2aa7-4ed9-8e59-696ac464b300'
  ReservedCode2: '093a3d1f-2aa7-4ed9-8e59-696ac464b300'
---

# ──────────────────────────────────────────────────────────────────────
#  AIRoute — Kubernetes Deploy 部署指南
# ──────────────────────────────────────────────────────────────────────
#
#  目录结构:
#    deploy/
#    ├── ack/           # 阿里云 ACK (Container Service for Kubernetes)
#    │   └── airoute.yaml
#    ├── cce/           # 华为云 CCE (Cloud Container Engine)
#    │   └── airoute.yaml
#    ├── postgres/      # PostgreSQL StatefulSet (多副本模式, 两个云环境共用)
#    │   └── postgresql.yaml
#    ├── redis/         # Redis StatefulSet (两个云环境共用)
#    │   └── redis.yaml
#    └── README.md      # 本文件
#
#  ─── 数据库模式选择 ───────────────────────────────────────────────────
#
#  AIRoute 支持三种数据库模式, 通过 DB_TYPE 环境变量控制:
#
#  ┌─────────────┬──────────────────────┬───────────────────────────────────┐
#  │  DB_TYPE    │  适用场景             │  说明                              │
#  ├─────────────┼──────────────────────┼───────────────────────────────────┤
#  │  sqlite     │  单副本/开发/测试     │  默认, 零外部依赖, 单文件          │
#  │  sqlcipher  │  单副本/企业合规      │  SQLite + AES-256 加密             │
#  │  postgresql │  多副本/生产高可用     │  独立 PG StatefulSet 或云 RDS      │
#  └─────────────┴──────────────────────┴───────────────────────────────────┘
#
#  AIRROUTE_REGION=cn 合规说明:
#    - 不设置 DB_TYPE 时, 自动降级为 sqlcipher (单副本加密)
#    - 多副本场景推荐: DB_TYPE=postgresql + 云厂商托管 RDS
#    - 阿里云推荐: RDS PostgreSQL / PolarDB PostgreSQL (兼容PG协议)
#    - 华为云推荐: RDS PostgreSQL / GaussDB (兼容PG协议)
#
#  ─── 快速开始 ────────────────────────────────────────────────────────
#
#  方案 A: 单副本 (SQLite/SQLCipher, 无需 PostgreSQL)
#
#    1. 阿里云 ACK:
#       kubectl apply -f deploy/ack/airoute.yaml
#
#    2. 华为云 CCE:
#       kubectl apply -f deploy/cce/airoute.yaml
#
#  方案 B: 多副本 (PostgreSQL, 需先部署 PG)
#
#    1. 阿里云 ACK:
#       kubectl apply -f deploy/postgres/postgresql.yaml
#       kubectl apply -f deploy/redis/redis.yaml
#       # 修改 airoute-config 中的 DB_TYPE=postgresql
#       # 取消 airoute Deployment 中的 env 覆盖注释
#       kubectl apply -f deploy/ack/airoute.yaml
#
#    2. 华为云 CCE:
#       kubectl apply -f deploy/postgres/postgresql.yaml
#       kubectl apply -f deploy/redis/redis.yaml
#       kubectl apply -f deploy/cce/airoute.yaml
#
#    3. 使用云厂商托管 RDS (推荐生产环境):
#       - 无需部署 deploy/postgres/postgresql.yaml
#       - 在 airoute-secrets 中设置 DB_CONNECTION_STRING 指向 RDS 实例
#       - 建议开启 SSL (sslmode=require)
#
#  ─── 修改前必改项 ────────────────────────────────────────────────────
#
#    - airoute-secrets 中的所有 CHANGE_ME 值
#    - postgresql-secrets 中的密码 (使用 PG 时)
#    - 镜像地址 (ACR/SWR)
#    - Ingress 域名和证书
#    - 节点亲和 zone (根据实际集群区域)
#    - PostgreSQL storageClassName (ACK: alicloud-disk-ssd, CCE: csi-disk)
#
#  ─── AIRROUTE_REGION=cn 合规要点 ──────────────────────────────────────
#
#    - STORAGE_ENCRYPTION_KEY 必填, 无则启动失败
#    - PII 自动脱敏 (18位身份证/+86手机/银联卡)
#    - 路由优先国内 Provider (regionAffinity=0.12)
#    - 数据出境管控 (DATA_EXPORT_CONTROL_MODE=warn)
#    - DB_TYPE 未设置时自动降级为 sqlcipher
#
#  ─── 安全建议 ────────────────────────────────────────────────────────
#
#    - 使用云厂商 KMS/DEW 管理加密密钥, 不要将密钥写入 YAML
#    - 启用 WAF (阿里云 ALB WAF / 华为云 WAF)
#    - NetworkPolicy 限制 Pod 间通信
#    - 定期轮换 JWT_SECRET / API_KEY_SECRET
#    - 审计日志接入云日志服务 (SLS/LTS)
#    - PostgreSQL 生产环境开启 SSL + 云厂商安全组白名单
#    - 定期备份 PostgreSQL (pg_dump / 云 RDS 自动备份)