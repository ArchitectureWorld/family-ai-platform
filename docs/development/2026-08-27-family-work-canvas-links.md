# Family Work → Canvas execution links

WP5 为 Family `WorkConversation` 增加薄外部执行链接，不改变两端权威：Family 只保存 Canvas Workflow/根 Session ResourceRef、Deep Link、source sequence 与状态；Canvas 保存 Family Work 来源投影，不读取 Family SQLite，也不复制完整聊天历史。

## API

```text
POST   /api/v1/work-conversations/{workRef}/execution-links
GET    /api/v1/work-conversations/{workRef}/execution-links
DELETE /api/v1/work-conversations/{workRef}/execution-links/{linkRef}
```

浏览器命令只提交 idempotencyKey 与已选择 message/attachment ref。Family 服务端读取 Work title/goal/summary/lastSequence，签发短时 ActorContext，将附件转换为无 `localPath` 的 AssetRef，再调用 Canvas `/api/v1/integrations/family-workflows`。

Schema V10 新增 `work_external_links`。同一 idempotencyKey/相同 payload 重放返回原链接；不同 payload 返回冲突；同一 active Canvas Workflow 不重复。解除关联会清空 Family Deep Link，但不删除 Family Work 或 Canvas Workflow。

`FAMILY_AI_CANVAS_BASE_URL` 只接受可信内部 HTTP origin：主机 loopback，或 approved container profile 下的 `canvas` service name。错误响应不转发 Canvas 原始正文。

Member Web 提供“在超级画板中展开 / 打开已有画板 / 解除关联”。本地 Local Alpha 的 Canvas Account projection 使用 Canvas 配置的 `APP_OWNER_ID`，真实 Family principal URI 仍保存在 Canvas integration provenance；这不构成多用户生产身份映射。
