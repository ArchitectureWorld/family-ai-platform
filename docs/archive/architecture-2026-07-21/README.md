# 2026-07-21 原始架构文档归档

本目录保存 `family-ai-platform-all-architecture-docs.zip` 中的原始 Markdown 文档，目的是保留讨论过程和历史措辞。

这些文档不是后续开发的直接权威规格。发生冲突时，以 `docs/architecture/` 中的稳定架构为准。

## 归档内容

- `family-ai-platform-chat-work-architecture.md`
- `terminal-design/README.md`
- `terminal-design/00-multi-terminal-development-master.md`
- `terminal-design/01-web-terminal-development.md`
- `terminal-design/02-ios-terminal-development.md`
- `terminal-design/03-harmonyos-terminal-development.md`
- `terminal-design/04-diy-hardware-terminal-development.md`

## 与稳定文档相比的主要修正

稳定架构在保留原始方向的基础上，进一步明确：

- 单 Gateway 同时支持并行输入、执行和输出；
- 只在同一上下文 Lane 内保持有序；
- 客户端不能自行决定 `person_id`；
- HomeChatStream 归属于 Person，不永久绑定具体 Provider；
- Provider Session 不是平台上下文真相来源；
- Foundation 的 `member / conversation` 是验证模型，不直接作为正式领域模型；
- 多端同步需要事件、Outbox 和 Sync Cursor；
- 下一阶段先建设 Identity / Family 与 Chat / Work 领域底座。
