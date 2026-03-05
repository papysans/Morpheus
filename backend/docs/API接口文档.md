# API 接口文档（单一数据源）

> 📅 创建日期: 2026-03-04  
> 📌 版本: V1.0  
> 🎯 目标: 作为后端 API 变更的唯一权威文档入口

---

## 使用规则

- 所有 API 变更必须先更新或同步更新本文件。
- 禁止在多个文档中维护冲突版本的接口定义。
- 每次接口变更请记录：
  - 路径与方法
  - 请求参数与响应结构
  - 鉴权要求
  - 兼容性影响
  - 关联 PR/Commit

---

## 接口索引

### Admin（v1 契约）

- Canonical API 路径前缀：`/api/admin/*`
- 本节为 Admin v1 契约定义，涉及 platform ops 的接口必须遵循以下规则。

#### 幂等（idempotency）

- 请求必须提供幂等键（idempotency key）。
- 缺失幂等键：返回 `400`。
- 同键异载荷（同一幂等键对应不同请求体）：返回 `422`。
- 同键请求处于处理中（processing conflict）：返回 `409`。
- 同键重放（replay）：返回首个响应（first response）。

#### 参数与字段约束

- 所有数量类字段必须满足 `non-negative`（非负）。
- `reason` 字段为 `required`（必填）。

#### 兼容性说明

- `canonical`、`idempotency`、`non-negative`、`reason` 约束视为 v1 稳定契约，新增接口不得绕过。

---

**最后更新**: 2026-03-04  
**文档版本**: V1.0
