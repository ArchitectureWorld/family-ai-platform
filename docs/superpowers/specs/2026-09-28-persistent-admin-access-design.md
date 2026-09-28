# 持续有效的管理员入口设计

## 状态与意图

用户于 2026-09-28 明确要求执行：管理员会话和一次性激活码都不按时间过期。这里的“不按时间过期”指 Gateway 不再因创建时间拒绝管理员会话或尚未使用的激活码。一次性、主动替换、退出、撤销、错误尝试锁定仍是有效的失效原因。浏览器清除 Cookie 后需要再次激活；浏览器存储策略不由 Gateway 保证。

本设计只改变正式 Family Admin Web 的管理员身份机制。个人/成员 Session、配对码、附件 TTL、Provider/Federation 短期上下文均不变。保持单 Gateway、单业务数据库、现有 HTTPS 入口与 Origin/CSRF 边界，不新增网络端口或开发 Preview 捷径。

## 已验证的现状

- 初次建家为 admin/personal 同时写入 30 天到期时间；现网管理员会话在 2026-09-26 已转为 expired，当前有效管理员会话为零。
- 生产激活脚本生成五分钟、单次使用的 10 字符短码，受保护目录仅保存加盐 Hash；生成脚本只校验管理员文件结构，不校验其会话是否仍有效。
- 激活接口把受保护管理员 Entry 的同一个 sessionRef/token 写给每个浏览器；没有单独的错误尝试计数。
- Admin Web 目前用 Secure、HttpOnly、SameSite=Strict 的 Session Cookie；浏览器丢失 Cookie 后需重新激活。

## 方案

### 1. 会话状态

为避免改动当前 V15 的精确 Schema 指纹和保留运行时恢复链，管理员新会话在现有 `expires_at` 字段写入固定的兼容上界 `9999-12-31T23:59:59.999Z`。Gateway 不再为管理员会话设置 30 天或其他日常使用期限；实际失效由主动退出、Session/Binding/Device 撤销控制。固定上界只是一种旧 Schema 编码形式，不作为对浏览器凭据永久保存的承诺。个人会话继续使用原固定期限和原认证 SQL。所有写入上界的代码必须先确认 audience=`family_admin`；测试在多年后验证管理员仍可用、个人仍过期。无 Schema 变化，也不调整 migration 或正式发布恢复工具。

现有 expired 或 revoked 行不自动变回 active。即使其旧 token 仍在受保护文件中，也不能凭旧行直接获得管理员 API 权限。部署时由受控本机 operator 恢复过程验证受保护文件与数据库 Hash、现存管理员绑定、设备和家庭状态，拒绝 revoked 记录，签发新的管理员 operator Entry，原子更新受保护入口文件；失败不得留下可被误认为有效的新入口。该过程记录不含秘密的操作证据，必须有备份和恢复路径。

### 2. 浏览器激活

受保护 operator Entry 只用于激活时证明管理员根授权，不直接装进浏览器。每次成功激活都产生新的 32-byte 随机浏览器 Entry token 和独立 sessionRef，绑定同一个现有管理员 Entry binding，管理员兼容上界；浏览器 Cookie 仅含该次会话的材料。旧管理员浏览器会话不因新浏览器激活而被替换。管理员退出只撤销当前浏览器会话并清除 Cookie；设备撤销会阻断所有相关会话。每次管理请求继续校验当前 session、binding、device、audience 和同源防护。

管理员 Cookie 使用现有 Secure、HttpOnly、SameSite=Strict 约束；为跨浏览器重启保持登录，可设置持久 Cookie 并在已认证的管理访问中刷新。Cookie 被用户或浏览器清除时需再次激活；这不改变服务器会话的无时间上限规则。不得写入 localStorage、URL、公开 API、日志或审计正文。

### 3. 无时间上限的一次性激活码

新签发的激活记录使用版本 2：保留 issuedAt、salt、codeHash、failedAttempts，不含 expiresAt。短码保持现有 `XXXXX-XXXXX` 格式，只有当前受保护记录有效。重新生成会替换旧记录；成功激活以跨进程互斥的原子消费使其恰好只能用一次。每个记录最多允许 10 次格式正确但不匹配的提交；第 10 次起锁定该记录，必须由 operator 重新生成。失败计数写入受保护文件并跨重启保留；互斥故障/进程崩溃必须 fail-closed。原版本 1 记录维持其原到期规则，不因升级复活。

激活接口保持精确 Origin、Sec-Fetch-Site、统一失败响应、加盐 Hash 和常量时间比较。生成命令在写新码前检查受保护 operator Entry 仍可用于激活，拒绝向已失效 Entry 生成无效短码。短码仅输出到本机 operator stdout，不进入 Git、台账或应用日志。

### 4. 运维与兼容

部署前后记录正式 runtime/image/PID/端口身份、数据库副本及受保护目录备份；先在隔离环境做 migration、激活、刷新、浏览器重启、退出、撤销、错误锁定和恢复演练，再按正式发布门禁切换。现网已过期的管理员会话和短码只能在受控恢复时由新材料替换。不得改写旧会话状态来绕过校验，不得自动恢复被撤销设备。

## 验收

- 管理员会话跨 30 天和更晚时钟仍可用；个人会话照原规则过期；撤销/退出立即拒绝，重启 Gateway 后状态保持。
- 两个浏览器激活得到不同 sessionRef/token；退出其中一个不影响另一个；受保护 operator token 不出现在浏览器响应或 Cookie。
- 新激活码在超过五分钟后仍可用；第一次成功后重放失败；替换旧码、十次错误锁定、跨进程并发与崩溃残留均 fail-closed；旧 V1 过期码仍拒绝。
- 脚本拒绝失效 operator Entry；恢复流程只接受已过期但未撤销且 Hash 匹配的管理员根材料，并签发新会话。
- npm check、可交付 Docker 构建、隔离 dev-up/acceptance、浏览器两轮/刷新/重启/第三轮、现网入口与回滚演练分别提供真实结果；未执行项标 SKIP。
