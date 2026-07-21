# Family AI Platform 架构文档

本目录是 `family-ai-platform` 后续开发的**唯一权威架构入口**。

## 文档层级

1. [`00-family-ai-platform-stable-architecture.md`](./00-family-ai-platform-stable-architecture.md)：当前稳定总架构与系统边界；
2. [`01-identity-and-binding.md`](./01-identity-and-binding.md)：Family、Person、Identity、EntryBinding、Device 与 AssistantAssignment；
3. [`02-chat-work-domain.md`](./02-chat-work-domain.md)：Chat / Work 双模型、归档、转换和上下文边界；
4. [`03-single-gateway-concurrency.md`](./03-single-gateway-concurrency.md)：单 Gateway、并行输入输出和局部有序执行；
5. [`04-multi-terminal-strategy.md`](./04-multi-terminal-strategy.md)：Web、iOS、HarmonyOS 与 DIY 的 1+N 多终端策略。

## 文档权威性

- 本目录记录已经确认并稳定的架构结论；
- `docs/reviews/` 记录阶段性 Review、风险和建议，不直接替代本目录；
- `docs/archive/` 保存讨论过程中形成的原始文档，不作为新开发的直接实现规格；
- Foundation 设计、实现计划和验收记录继续保留在原有 `docs/superpowers/`、`docs/development/` 与 `docs/acceptance/` 目录。

## 当前开发基线

```text
main
└── Gateway Foundation
    ├── 单 Gateway 容器
    ├── SQLite
    ├── 设备 Token Hash 认证
    ├── Conversation / Message 基础能力
    ├── Provider Adapter SDK
    ├── 幂等与事务持久化
    └── Docker 一键验收
```

Foundation 是消息可靠性与 Provider 接入的技术内核，但当前 `members / devices / conversations` 仍属于 Foundation 阶段的最小模型。下一轮正式开发必须先依据本目录建立 Family、Person、统一身份、Chat / Work 和多终端领域底座，不得直接把验收模型固化为正式产品模型。

## 开发规则

开始任何新的功能分支前，必须：

1. 从最新 `main` 创建独立分支；
2. 明确变更对应本目录中的哪一项架构；
3. 发现冲突时先更新架构文档并完成 Review，再修改代码；
4. 不为未来不确定的集群化、微服务或复杂权限提前引入基础设施；
5. 第一版继续采用单 Gateway、单数据库、模块化单体。
