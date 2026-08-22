# HarmonyOS Mobile Entry Core TDD Evidence

- 日期：2026-07-25
- 分支：`feat/harmonyos-mobile-entry-foundation`
- 基线：`main @ 80107e10764bc0160bd977f3d8b8b8219b03c175`
- 范围：H0A pure core，不包含 DevEco / HAP 构建

## 1. 初始 RED

先创建以下行为测试：

```text
gatewayUrl.test.ts
pairing.test.ts
validation.test.ts
state.test.ts
credentials.test.ts
requests.test.ts
device.test.ts
```

执行：

```bash
node --experimental-strip-types --test clients/harmonyos/core/test/*.test.ts
```

观察结果：7 个测试文件均因对应 `src/*.ts` 模块不存在而失败，错误为 `ERR_MODULE_NOT_FOUND`。这确认测试不是在验证已有实现。

## 2. 第一轮 GREEN

实现：

```text
types.ts
validation.ts
gatewayUrl.ts
pairing.ts
state.ts
credentials.ts
requests.ts
device.ts
```

执行严格测试后：

```text
18 tests
18 passed
0 failed
```

覆盖：

- Gateway HTTPS Origin；
- QR 与手工配对码；
- strict Mobile Entry 响应；
- 稳定错误 code；
- Entry / Device Header 隔离；
- logout / unbind 生命周期；
- 离线、锁定、撤销状态；
- HarmonyOS 设备描述。

## 3. TypeScript 配置故障与修正

初始 `tsconfig.json` 使用：

```text
module = NodeNext
moduleResolution = NodeNext
verbatimModuleSyntax = true
lib = ES2022, DOM
```

`tsc` 正确暴露：

- 文件被当作 CommonJS，ESM export/import 触发 TS1286 / TS1287；
- `URLSearchParams.keys()` 缺少 `DOM.Iterable`。

修正为：

```text
module = ESNext
moduleResolution = Bundler
lib = ES2022, DOM, DOM.Iterable
```

随后 strict noEmit typecheck exit 0。

## 4. 认证矩阵 RED → GREEN

新增 `endpoints.test.ts`，先执行得到：

```text
ERR_MODULE_NOT_FOUND: src/endpoints.ts
```

实现 `MOBILE_ENDPOINTS`，固定每个端点唯一认证方式，特别是：

```text
POST /api/v1/mobile/session/logout
authentication = device
```

避免复制 iOS Draft 中已发现的 logout Header 偏差。

## 5. 平台误报 RED → GREEN

新增测试要求 HarmonyOS Portal Context 拒绝：

```text
terminalType = mobile
platform = ios
```

RED 结果为 `Missing expected exception`，证明原 parser 仍接受误分类。

实现平台不变量后，只有：

```text
terminalType = mobile
platform = harmonyos
```

可以进入 HarmonyOS authenticated 状态。

## 6. Operation Response RED → GREEN

测试先导入不存在的：

```ts
parseMobileOperationResponse()
```

RED 为缺失 export。实现后只接受：

```text
logged_out
revoked
```

未知状态被拒绝。

## 7. 最终本地验证

执行：

```bash
npx tsc -p clients/harmonyos/core/tsconfig.json
node --experimental-strip-types --test clients/harmonyos/core/test/*.test.ts
```

结果：

```text
TypeScript strict typecheck: exit 0
Tests: 21
Passed: 21
Failed: 0
Skipped: 0
```

## 8. 尚未取得的证据

当前环境未安装 DevEco Studio、HarmonyOS SDK、Hvigor 或真机工具，因此没有声称：

- ArkTS 编译通过；
- HAP 构建通过；
- Scan Kit / Asset Store / User Authentication 已接入；
- HarmonyOS 真机已通过。

这些证据属于 H0B，必须在对应环境中重新执行并写入独立记录。
