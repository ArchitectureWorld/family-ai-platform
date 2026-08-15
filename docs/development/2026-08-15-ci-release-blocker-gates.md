# A4 CI 与可交付镜像阻断门禁

日期：2026-08-15

## 范围

本任务只建立 CI 拓扑、生产依赖审计、source-derived capability/build-input receipt、不可变镜像三文件 artifact 和隔离容器附件重启 smoke。未触碰正式 `127.0.0.1:8790`，未修改 Provider/Hermes 架构，也未执行 retained runtime 切换。

## RED

- `memberCacheModel.test.ts` 证明运行时没有导出 IndexedDB version，opener 仍引用私有字面常量；
- `test-ci-compose-smoke.sh` 证明 workflow 缺少四个独立 job；
- `test-build-gateway-image.sh` 证明 wrapper、两层 capability 输入和 build-input tree validator 尚不存在。

这些失败均发生在 Docker 构建前，不依赖 daemon 不可用或 YAML 解析器缺失。

## 实现契约

- `MEMBER_CACHE_DATABASE_VERSION` 是 opener 与 release capability 的单一客户端版本来源，数值仍为 2；
- Schema registry 从 V3 连续到 V9，release capability 独立描述当前 V9/client V2；
- canonical tree hash 纳入 `runtime-build` 与 `quality-tool`，排除明确 allowlist 的 `docs-only`；
- Docker build/runtime stage 固定 `linux/amd64` 官方 Node 22.16.0 platform digest；builder 使用固定 Debian snapshot 与精确 `python3/make/g++/git` 版本；
- wrapper 从 exact commit 的 detached clean worktree 构建，并以 source-derived labels、image ID、archive SHA 和 manifest 逐项闭环；
- CI 下游 runner 只加载上游三文件 artifact，不重新构建或拉取 foundation tag。

## 验证记录

- 聚焦 RED：PASS；缺少 export、四 job、wrapper/validator 均以预期断言失败。
- 聚焦 GREEN：PASS；client cache 14 项、CI 静态契约、capability/build-input fixture 全绿。
- `npm ci`：PASS；从 `package-lock.json` 安装 142 个 package。
- `npm run check`：PASS；94 个测试文件、919 项通过，0 失败、0 跳过；脚本静态门禁、类型检查和构建通过。
- `npm audit --omit=dev --audit-level=high`：PASS；production graph 为 0 vulnerability。
- `docker compose config --quiet`：PASS；使用临时空 env file，不读取仓库正式 runtime。
- 不可变 Docker build / container smoke：在最终提交 SHA 上执行并作为 PR 证据；本文不预写尚未产生的 image ID/archive hash。
- 浏览器：A4 不改变产品 UI，仍会在最终 artifact 的隔离 runtime 上复验既有三轮消息旅程；自动 CI 不新增浏览器 job。
- 正式服务 / 真实 Provider：SKIP；A4 禁止触碰正式服务，且无 Provider 行为变化。
