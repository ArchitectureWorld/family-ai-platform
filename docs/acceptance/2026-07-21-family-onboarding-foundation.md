# Family Onboarding Foundation 小白验收

- 日期：2026-07-21
- 范围：Foundation Hardening、一个家庭多成员、首次建家、Admin / Personal 双入口
- 运行边界：本机 development 模式，`127.0.0.1:8790`

## 验收目标

本轮确认 Gateway 可以稳定解析：家庭、Person、Device 和当前入口类型。

```text
同一个家庭创建者 Person
├── 家庭管理 Entry Session
│   ├── audience: family_admin
│   └── 默认 Agent: 家庭管家
└── 个人空间 Entry Session
    ├── audience: personal
    └── 默认 Agent: 个人助理
```

两套入口共用同一个 Person 和 Device，但 Session、权限、默认 Agent 和页面状态相互独立。

## 一条命令

先同步分支：

```bash
git switch feat/family-onboarding-foundation
git pull --ff-only origin feat/family-onboarding-foundation
```

在仓库根目录执行：

```bash
./scripts/verify-foundation.sh
```

该命令会在固定 Node 22.16.0 Docker 环境中安装锁定依赖，运行全部测试、类型检查和构建，自动验证旧消息内核和新建家流程，最后清空自动测试数据并启动一套空白 Gateway。

打开脚本最后输出的本机地址。

## 浏览器操作

### 1. 创建家庭

页面标题应为：

```text
家庭 AI 初始化与入口验收台
```

填写家庭名称、管理员姓名和当前设备名称，点击“创建家庭并进入门户”。

### 2. 检查双入口

应看到：

```text
家庭管理
默认连接：家庭管家
```

```text
个人空间
默认连接：个人助理
```

### 3. 验证家庭管理

进入“家庭管理”，确认：

- audience 是 `family_admin`；
- 家庭、Person 和 Device 信息正确；
- 默认 Agent 是“家庭管家”；
- 页面存在家庭成员管理区域。

新增一位成人、孩子或长辈。新成员应显示“个人助理”和“等待本人认领入口”。管理员可以创建成员和分配个人助理，但不会自动获得该成员的私人入口。

### 4. 验证个人空间

返回门户并进入“个人空间”，确认：

- audience 是 `personal`；
- Person 与家庭管理相同；
- Device 与家庭管理相同；
- Session Ref 与家庭管理不同；
- 默认 Agent 是“个人助理”；
- 页面没有家庭成员管理区域。

### 5. 刷新和重启

刷新浏览器，两张入口卡片应继续出现。

再执行：

```bash
docker compose --env-file .runtime/config/compose.env restart gateway
```

等待数秒后刷新。家庭、成员和两套入口应继续存在。

## 通过标准

- [ ] 首次进入是空白建家向导；
- [ ] 同一数据库只能成功建家一次；
- [ ] 创建者只生成一个 Person；
- [ ] 同一 Device 上有两套不同 Session；
- [ ] 家庭管理连接家庭管家；
- [ ] 个人空间连接个人助理；
- [ ] Admin 可以新增成员；
- [ ] 新成员不会继承管理员的私人入口；
- [ ] Personal 入口没有家庭管理能力；
- [ ] 刷新和 Gateway 重启后状态保留；
- [ ] 页面和日志不显示敏感凭证、SQL、堆栈或本机绝对路径。

## 停止与重置

停止但保留数据：

```bash
./scripts/dev-down.sh
```

删除一次性开发数据库和入口状态：

```bash
./scripts/dev-reset.sh
```

本轮没有正式账号恢复。浏览器清除 Session 后，开发验收需要重置并重新建家。

本轮不包含 Chat、Work、手机号认领、密码登录、多家庭切换、真实 Provider、局域网、公网或 TLS。
