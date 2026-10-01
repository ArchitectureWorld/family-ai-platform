# Family AI iOS Mobile Entry v1 实体机验收指南

本指南用于在真实 iPhone 上验收 Mobile Entry v1。全过程只使用合成家庭、合成成员和临时配对材料。不得把真实 Team ID、Bundle Identifier、Tailnet Host、Token、Device Credential、配对码或含秘密的截图提交到 Git、PR、Issue 或 CI。

## 1. 验收边界

本轮验证以下真实闭环：

```text
Tailscale Serve HTTPS
→ 扫码或手动短码配对
→ preview 确认
→ claim
→ Keychain 保存设备与 EntrySession
→ portal/context 个人首页
→ 杀进程恢复与 Session 续期
→ Face ID / 设备密码本机锁定
→ Gateway 离线
→ 管理员远程撤销
→ 本机解绑
```

Chat、Work、Push、TestFlight 和 App Store 不在本轮范围内。

## 2. Mac 与 Xcode 准备

- [ ] 使用可运行 iOS 17 Target 的稳定版 Xcode。
- [ ] 在 Xcode Settings → Accounts 中登录个人开发 Apple ID。
- [ ] 打开 `clients/ios/FamilyAI.xcodeproj`。
- [ ] Scheme 选择 `FamilyAI`，设备选择目标 iPhone。
- [ ] 不修改并提交 `Base.xcconfig` 中的本地签名值。

创建仅本机使用的配置：

```bash
cd clients/ios/Config
cp Local.example.xcconfig Local.xcconfig
```

在 `Local.xcconfig` 中填写当前开发者自己的 Team ID 和唯一 Bundle Identifier。确认该文件仍被 Git 忽略：

```bash
git check-ignore clients/ios/Config/Local.xcconfig
```

预期输出该文件路径。若无输出，停止验收，不要继续填写秘密。

## 3. iPhone 准备

- [ ] iPhone 系统版本不低于 iOS 17。
- [ ] 使用数据线或已配对的无线调试连接 Mac。
- [ ] 设置 → 隐私与安全性 → 开发者模式：开启并按系统要求重启。
- [ ] 首次安装时在 iPhone 上信任开发者。
- [ ] 设备已设置 Face ID；同时保留设备密码作为 fallback。
- [ ] iPhone 与 Gateway 主机登录同一受控 Tailscale 网络。

## 4. Gateway 与 Tailscale Serve HTTPS

Gateway 继续只监听本机回环地址，不允许直接发布到 LAN 或公网：

```text
127.0.0.1:8790
```

在 Gateway 主机上配置 Tailscale Serve，将 HTTPS 私网入口转发到 `http://127.0.0.1:8790`。禁止使用 Tailscale Funnel。

- [ ] Tailnet 节点名称不包含真实姓名、地址或其他个人信息。
- [ ] 没有把 `8790` 端口直接暴露到局域网或公网。
- [ ] Serve 地址为 HTTPS。
- [ ] Gateway 使用本轮合成验收数据。

在 iPhone Safari 中访问 Gateway health 地址：

```text
https://<synthetic-tailnet-host>/health
```

- [ ] Safari 显示健康响应。
- [ ] 证书有效，无 HTTP 降级或手工忽略证书警告。
- [ ] 关闭 Tailscale 后该私网地址不可达。

不要把实际 Host 粘贴到文档、PR 或截图。

## 5. 安装与权限

在 Xcode 中启用 Target 的 Automatic Signing，然后 Run 到真实 iPhone。

首次使用扫码：

- [ ] 系统显示中文摄像头用途说明。
- [ ] 允许摄像头后可以进入二维码扫描画面。
- [ ] 拒绝摄像头后显示权限拒绝状态、系统设置入口和手动输入备用入口。
- [ ] App 不要求照片权限。

本机锁定：

- [ ] 系统显示中文 Face ID 用途说明。
- [ ] Face ID 不可用时允许设备密码 fallback。
- [ ] 取消验证后仍停留在 locked 状态。

## 6. 扫码配对验收

由管理员为合成普通成员生成 5 分钟一次性配对二维码。

- [ ] 扫描符合 `familyai://pair#v=1&...` 的二维码。
- [ ] HTTP Gateway、带用户名密码、Path、Query 或 Fragment 的 Gateway 被本地拒绝。
- [ ] 过期二维码显示过期状态，可重新扫码。
- [ ] 无效二维码不泄露完整 QR Payload。
- [ ] preview 确认页显示家庭名称、成员名称、Gateway Host、当前 iPhone 名称和到期时间。
- [ ] 确认页不显示 Token、Device Credential 或完整内部 Ref。
- [ ] 用户确认后完成 claim 并进入真实个人首页。

网络状态不确定时：

- [ ] 在 claim 请求发出后中断网络。
- [ ] App 提供“使用相同认领材料重试”。
- [ ] 恢复网络后重试成功，Gateway 不创建重复设备绑定。

## 7. 手动短码配对验收

解绑后，由管理员重新生成短码。

- [ ] 手动页面只要求 Gateway HTTPS 地址和短配对码。
- [ ] 页面不要求或展示 `pairingRef` 输入框。
- [ ] preview 和确认对象与管理员选择的合成成员一致。
- [ ] claim 成功后进入同一真实个人首页。

## 8. 真实个人首页验收

首页信息必须全部来自 `portal/context`：

- [ ] 家庭名称。
- [ ] 成员名称。
- [ ] 家庭角色。
- [ ] 个人助理名称。
- [ ] 当前设备名称。
- [ ] Gateway 连接状态。
- [ ] Session 状态和最近同步时间。
- [ ] Chat 只显示“个人助理入口已建立 / Chat 服务将在下一阶段接入”。

确认不存在假对话、假 Agent 回复、Mock Work、假消息记录或离线消息队列。

## 9. Keychain 与进程恢复

- [ ] 配对完成后从 App Switcher 杀死 App。
- [ ] 重新启动后无需再次配对，能从 Keychain 恢复并读取真实上下文。
- [ ] 普通 logout 后设备授权保留，EntrySession 被清除。
- [ ] logout 后再次解锁可通过 deviceCredential 获取新 Session。
- [ ] App 的 UserDefaults、日志和截图中不存在 Credential、Token、Code 或 QR Payload。

不要导出或上传 Keychain 数据作为验收证据。

## 10. 本机锁定与隐私遮罩

默认策略为 5 分钟：

- [ ] App 进入后台前立即显示不透明隐私遮罩。
- [ ] App Switcher 预览不显示个人页面内容。
- [ ] 后台不超过 5 分钟，回前台直接恢复。
- [ ] 后台超过 5 分钟，回前台要求 Face ID 或设备密码。
- [ ] 验证取消后保持 locked。
- [ ] 设置中可切换立即锁定、5 分钟和关闭本地锁定。

## 11. Gateway 离线验收

在保持 iPhone 凭证不变的前提下停止 Gateway 或 Tailscale Serve：

- [ ] App 进入 offline，而不是 logout 或 needsPairing。
- [ ] installationId、设备授权和 Session 均保留。
- [ ] 仅展示最近一次成功同步的家庭显示名、成员显示名、角色、助理显示名、设备显示名和同步时间。
- [ ] 不展示 Token、配对材料、管理员数据或 Chat 消息。
- [ ] Gateway 恢复后点击重新连接，回到真实个人首页。

## 12. Session 续期验收

使用合成测试环境让当前 EntrySession 过期或由 Gateway 标记为失效：

- [ ] App 使用 Device Authorization 发起 renew。
- [ ] renew Header 不包含 Bearer EntrySession Header。
- [ ] 新 Session 完整写入后才替换旧 Session。
- [ ] 多个并发请求只触发一次 renew。
- [ ] renew 成功后个人首页恢复。
- [ ] Gateway 不可达时保留旧授权并进入 offline。

## 13. 管理员远程撤销验收

在 Web 管理端撤销当前合成设备：

- [ ] iPhone 下一次请求收到 `DEVICE_REVOKED`。
- [ ] App 清除设备授权和 EntrySession。
- [ ] App 显示设备授权已撤销，并返回配对入口。
- [ ] 原 Session 和 deviceCredential 均不能继续访问 Gateway。

## 14. 本机解绑验收

在设置中选择“解绑此设备”：

- [ ] 系统强制进行一次新的 Face ID 或设备密码验证。
- [ ] 取消验证不发送 unbind，也不删除凭证。
- [ ] 验证成功后服务端撤销设备。
- [ ] 服务端成功后本机清除 Gateway、设备和 Session 凭证，但可保留 installationId。
- [ ] App 返回配对入口。
- [ ] Gateway 不可达时不删除任何本机凭证，并给出可重试状态。

## 15. 验收记录模板

只记录结果，不粘贴秘密值：

```text
Xcode version:
iOS version:
Simulator build: PASS / FAIL
Unit tests: <passed>/<total>
UI tests: <passed>/<total>
Safari health check: PASS / FAIL
QR pairing: PASS / FAIL
Manual pairing: PASS / FAIL
Kill-and-restore: PASS / FAIL
Offline preservation: PASS / FAIL
Session renewal: PASS / FAIL
Remote revoke: PASS / FAIL
Local unbind: PASS / FAIL
Face ID / passcode fallback: PASS / FAIL
Privacy cover: PASS / FAIL
Remaining issues:
```

截图前必须检查状态栏、Host、二维码、配对码和页面内容；任何可能包含秘密的数据都必须裁掉或打码，并且默认不上传截图。
