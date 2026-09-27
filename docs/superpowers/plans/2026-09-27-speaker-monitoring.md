# 三台 Wi-Fi 与 Family Admin 监测实施计划

Spec: ../specs/2026-09-27-speaker-monitoring-design.md

## 全局约束

保留 root 工作区四份未提交改动和现网 Schema15 数据。Family 分支直接面向 main；Speaker 使用独立本地分支。密钥/完整Flash/运行快照在仓库外私密保存。新端口同时登记 service-ports.json 与 .md。Gateway 不引入第二套设备权威和数据库。行为修改先失败测试；不重写现有音频路径。

1. **基线与恢复**：确认部署镜像/manifest，归并 authority 与本地文档；只停 Family，离线完整备份，按原镜像 WAL 恢复，保存 receipt，恢复现网健康。根工作区保持原状。
2. **DIY Wi-Fi**：共享WSS链路适配原NVS，DIY增加INFO身份、WSS收发与播放背压；Linux WifiAudio支持48kHz DIY、V4 runner输出可验证心跳。测试/三板构建。此任务不直接操作设备。
3. **状态采集**：固定registry映射，读USB、systemd状态和白名单运行字段；测试PID/身份/过期/错误投影，原子输出私密状态文件及systemd单元。
4. **Family接入**：contracts、config、管理员API、安全投影与新设备tab；测试权限、家庭隔离、过期、不泄露私密字段、UI刷新退出；不触碰生产DB。
5. **现场集成**：核查空闲端口、登记双台账；备份DIY Flash、保护式app-only刷写和配网、部署独立语音服务；安装采集器，Family镜像只读挂载采集目录并配置绑定家庭。
6. **验收和归并**：完整必要检查、真实三台无线状态与Admin浏览器验收、审查差异；直接main PR归并基线与监测；明确任何物理未覆盖项。

任务2、3、4共享上述唯一JSON协议且文件所有权不同，可并行。Root负责部署、台账和跨仓库文档；子任务禁止自行改生产服务/凭据/端口。
