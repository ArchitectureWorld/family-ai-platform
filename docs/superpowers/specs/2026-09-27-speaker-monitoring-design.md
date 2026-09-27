# 三台智能音箱 Wi-Fi 与管理员监测

用户已确认三台设备（DIY N16R8、BOX-3、微雪音频板），要求全部接入 Wi-Fi，监测仅显示于 Family Admin 的设备管理，并授权整理未归并的现网 Family Agent Authority 基线。沿用现有家庭 Wi-Fi，保持设备身份、令牌、服务与会话隔离。USB用于供电和维护。

## 基线与边界

Family 新任务分支直接基于 origin/main，纳入现网 Schema 15 完整代码与本地 main 独有的两份设计文档；保留原工作区四份未提交文件。现网库仅通过匹配镜像自带受保护恢复工具恢复，不降级 Schema、不手工删除 sidecar。Gateway 继续作为唯一家庭身份、设备和权限权威。观测音箱记录不自动创建认证 Device、Entry 或成员。

BOX-3/微雪保持 V5，DIY 保持 V4、16 kHz 录音、48 kHz 播放、无 AEC 的能力，在原有硬件上添加 Wi-Fi/WSS 和常驻 Linux 语音入口。不得将 DIY 显示为 V5 全双工。家庭音频保留于 Linux/LAN，新增 DIY 默认使用本地语音识别与合成。此次不调整现有两台的语音后端。

## 状态边界

Linux 采集器每 5 秒生成原子 JSON 文件。Gateway 只读挂载所在目录，以家庭管理员 Entry Session 鉴权后提供只读 API；服务端配置明确绑定允许查看的 FamilyRef。不得挂载 Docker socket 或给 Gateway 主机管理权限。不得复制原始 status.json；只有白名单字段可跨边界。

快照协议：`{protocolVersion:1,sampledAt:ISO8601,speakers:Speaker[]}`，文件最大 64 KiB，设备最多 32 台。Speaker 字段：

| 字段 | 类型 |
|---|---|
| speakerId | 12 位小写十六进制硬件观察标识；不是认证凭据 |
| displayName / room | 有界字符串（最多80字符） / 字符串或 null |
| board | diy-n16r8 / esp32-s3-box3 / waveshare-audio |
| usbConnected | boolean |
| transport | wifi / usb / unknown |
| serviceState | running / stopped / not_configured / unknown |
| linkState | connected / disconnected / unknown |
| phase | waiting_for_wake / listening / processing / speaking / muted / starting / reconnecting / stopped / not_configured / unknown |
| runtimeUpdatedAt | ISO8601 或 null |
| firmware | 有界字符串或 null |
| volumePercent | 0..100 整数或 null |
| capabilities | `{wifi:boolean,aec:boolean,duplex:boolean}` |
| problemCode | null / service_stopped / telemetry_stale / telemetry_unavailable / identity_mismatch / disconnected / upstream_unavailable |

Gateway 配置 `FAMILY_AI_SPEAKER_MONITOR_FILE` 与 `FAMILY_AI_SPEAKER_MONITOR_FAMILY_REF` 必须一起配置。API `GET /api/v1/admin/speakers` 返回上述安全投影及 `sourceState: ready|stale|unavailable|not_configured`；无数据时 sampledAt 为 null，speakers 为空。拒绝过大、格式错误、未来异常时间和重复设备；丢弃额外字段而非传递。快照超过30秒视为过期，过期设备不能继续显示正常连接/活跃语音。运行状态需与当前服务PID和设备ID匹配，文件mtime不能替代运行心跳。

不包含音频、转写、声纹姓名、成员ID、会话、令牌、URL凭据、绝对私有路径或原始错误信息。旧错误字段可能残留，应按当前 phase 判断状态。文件缺失和权限问题返回通用状态，不暴露路径。

## 管理界面

沿用当前原生 JS Admin，在设备页展示三台名称、板型、房间、Wi-Fi/USB、语音阶段、固件、音量、能力和采样时间。5秒刷新；切页销毁定时器，忽略迟到请求，认证失效清除旧数据。中文文本明确区分 USB 插入、无线连接、语音运行和采集过期，不仅使用颜色。无控制/刷机/重启按钮。

## 验收

授权与家庭隔离、隐私投影、缺失/损坏/过期数据、UI生命周期有测试。三板构建与主机回归通过。DIY刷写前保存完整Flash，核对实际MAC，仅写兼容原分区的应用区，不擦NVS/eFuse；独立Wi-Fi令牌不进入Git或日志。物理验证三台WSS身份与麦克风帧，DIY验证48kHz播放；不能用接口或构建成功替代设备验收。监测要有实际管理员浏览器、普通成员拒绝和过期展示证据。
