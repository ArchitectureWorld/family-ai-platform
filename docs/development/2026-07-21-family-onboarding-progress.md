# Family Onboarding Foundation 开发进度

- 分支：`feat/family-onboarding-foundation`
- PR：`#4`
- 当前阶段：TDD GREEN 与 CI 验证

## 已进入分支

- Foundation Public Error 与 production 组合边界；
- Migration V2；
- Family / Person / Membership / Device / Entry / Assignment 领域对象；
- 一次性建家 API；
- Admin / Personal 两套独立入口 Session；
- 家庭管家与个人助理分离路由；
- 家庭成员管理与 audience 权限隔离；
- 双入口浏览器验收台；
- 自动 API 验收脚本和小白验收文档。

## 当前门禁

正在生成并提交新仓库自己的 `package-lock.json`，随后运行固定 Node 22.16.0 下的：

```text
npm ci
npm run check
Docker build
Foundation acceptance
Family onboarding acceptance
```

PR 在 CI、Docker 自动验收和目标主机浏览器验收全部通过前保持 Draft。
