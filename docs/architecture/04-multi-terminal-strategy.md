# 1+N 多终端稳定策略

## 1. 总体原则

`family-ai-platform` 采用 `1+N`：

- `1`：统一平台对象、身份、协议、同步、权限和验收标准；
- `N`：针对不同终端形态的独立交互实现。

当前终端包括：Web、iOS、HarmonyOS 和 DIY Hardware。

统一的是 Person、EntryBinding、Device、AssistantAssignment、HomeChatStream、WorkConversation、Message、Event、Memory、Task 和 Permission。

差异化的是输入方式、输出形式、页面布局、信息密度、设备能力、隐私等级、通知和后台能力。

## 2. 终端能力模型

平台不能只根据平台名称硬编码全部行为。每个设备注册能力描述：

```json
{
  "terminal_type": "mobile",
  "platform": "ios",
  "capabilities": {
    "screen": "full",
    "text_input": true,
    "voice_input": true,
    "voice_output": true,
    "camera": true,
    "file_upload": true,
    "touch": true,
    "push_notification": true,
    "background_execution": "limited"
  }
}
```

Gateway 根据设备能力与权限上下文决定输出长度和格式、文件与卡片能力、语音输出、二次确认、敏感信息显示和结果分发目标。

## 3. Web

定位：全功能个人工作台、复杂 Work 主终端、文件处理终端和家庭 AI 管理入口。

一级结构：

```text
Chat
Work
管理（仅授权成员）
```

第一版负责：

- 完整 Chat；
- Work Conversation 列表和内容；
- 文件上传、预览和归属；
- Chat 转 Work；
- 执行过程、阶段结论和待确认项；
- 家庭成员、入口绑定、设备和个人助理管理；
- 基础运行状态与安全事件查看。

Web 不应变成仪表盘堆叠页面，Chat 核心仍然是自然对话。

## 4. iOS

定位：第一优先个人随身入口、默认 Chat、轻量 Work、通知确认和现场采集。

第一版支持文字、语音、图片、相机、基础文件、Chat / Work 同步、推送、快速确认、分享到 Chat 或指定 Work、系统认证、通知隐私和远程解绑。

不复制 Web 的复杂多栏和完整管理后台。

## 5. HarmonyOS

定位与 iOS 同级。

第一版先完成与 iOS 一致的个人入口闭环，再逐步增强多设备接续。

第一阶段包括手机端 Chat / Work、通知与状态同步，并与 Web、iOS 使用同一 Person 和领域对象。

后续再探索手机到平板继续 Work、服务卡片、手表快速确认、大屏结果展示和多设备输入输出接续。

## 6. DIY Hardware

DIY 是场景化、语音优先的受限入口，不是缩小版 Web。

### 6.1 个人设备

```text
device_id
→ Person DeviceBinding
→ HomeChatStream
→ Personal Assistant
```

### 6.2 家庭共享设备

```text
device_id
→ Family DeviceBinding
→ 当前 Person 识别或选择
→ 家庭公共上下文或个人上下文
```

身份不明确时不能恢复私人 Work。

### 6.3 第一版职责

设备本地负责唤醒词、录音、LED / 小屏、按键、网络管理、简单缓存和播放。

平台或局域网服务负责语音识别、TTS、身份解析、Chat / Work、Agent、记忆和设备管理。

接入路径：

```text
DIY Device
→ Family AI Gateway
→ Identity / Device Resolve
→ Chat or Work
→ Personal Assistant
→ Output Adapter
```

DIY 不直接连接 Hermes，也不在 ESP32 上运行复杂 Agent。

## 7. Connection 与页面状态

Connection 只表示设备当前如何进入平台，不代表对话对象。

```text
Connection
- connection_id
- device_id
- channel_type
- connected_at
- last_seen_at
```

终端状态恢复优先级：

```text
用户明确指定对象
→ 当前设备最后打开对象
→ Person 最近活动对象
→ 默认 Chat
```

用户刚在一个终端打开某个 Work，不应强制其他终端自动跳转。

## 8. 多端同步

服务端负责消息序列、已读状态、Work 状态、Operation / Execution 状态、通知、设备来源、同步 Cursor 和缺失事件补拉。

终端本地缓存不是最终权威。

第一版建议：

```text
REST 查询与命令
+ SSE 实时事件
+ Push Notification 唤醒移动端
```

DIY 可以使用适合硬件的连接通道，但最终映射到相同领域事件。

## 9. 输出适配

| 终端 | 输出策略 |
|---|---|
| Web | 完整文本、表格、文件、执行过程和操作面板 |
| iOS | 小屏友好、卡片、快速操作和通知 |
| HarmonyOS | 与 iOS 对齐，后续增加服务卡片和设备接续 |
| DIY Voice | 简短口语、单重点和分轮播报 |
| DIY Small Screen | 状态、关键结论和确认按钮 |

输出适配只改变表达形式和交互，不修改业务事实。

## 10. 文件与内容目标

移动端和 Web 的分享、拍照、语音和文件输入必须让用户确认目标：

```text
发送到 Chat
发送到指定 Work Conversation
```

文件归属：

```text
Person Private
Family Shared
Conversation Scoped
Temporary
```

共享设备不能默认访问 `Person Private` 文件。

## 11. 弱网与离线

所有终端统一支持本地草稿、`client_message_id`、发送状态、失败重试、逻辑消息去重、登录与设备失效、网络恢复后按 Cursor 同步。

离线时不能显示为 Agent 已收到。具有时效或高风险的操作在恢复网络后需要重新确认。

## 12. 开发顺序

```text
统一领域与同步协议
→ Web 参考入口和管理能力
→ iOS
→ HarmonyOS
→ DIY 个人终端
→ 家庭共享终端增强
```

Web 是验证完整领域对象和管理关系的最低成本参考终端。移动端和硬件应在统一协议稳定后开发，避免各端自行定义身份和会话。

## 13. 统一验收

### 身份

- 所有终端解析到同一 Person；
- 解绑后访问失效；
- 共享设备身份不明时不泄露私人数据。

### Chat

- 所有个人终端显示同一个 HomeChatStream；
- 同时输入顺序稳定；
- DailyEpisode 不破坏连续体验。

### Work

- Conversation 列表一致；
- 同一 Work 可跨端继续；
- 不同 Work 不串上下文；
- 长任务状态可跨端查看和确认。

### 输出

- 每个终端收到适合自身能力的表达；
- 复杂内容自然引导到完整终端；
- 敏感信息遵守 Device 与 Permission Context。

## 14. 最终原则

> 所有终端接入同一个 Gateway 和同一套 Family / Person / Chat / Work 对象。终端不是独立的数据孤岛，而是同一家庭 AI 状态在不同场景下的交互投影。
