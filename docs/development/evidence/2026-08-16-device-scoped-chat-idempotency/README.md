# B2 device 级幂等脱敏证据 bundle

本目录固化行为证据 HEAD
`c59cd3f2c8ed0bc813ff0506f4dd120f66b5d27d` 的 R3 关键纯文本证据。
路径全部为稳定仓库相对路径，文件哈希见 `manifest.json`。

## 包含

- 脱敏的 19-step 真实浏览器旅程；
- 两轮消息前、刷新后、Gateway 重启后、第三轮、Work 页和返回
  Chat 的无正文可访问性快照；
- Gateway 重启与随机 loopback 端口重解析摘要；
- console/page-error 零字节哈希；
- 最终 Person/Assistant `3 + 3` 数据库聚合、敏感临时物清理与证据
  runtime 销毁摘要；
- 正式 `127.0.0.1:8790` 的完整 before/after 身份摘要。

## 不包含

本 bundle 不复制 runtime Compose、数据库、Token、Cookie、配对码、handoff
fragment、绝对私有路径、原始网络响应或消息正文。它不能证明整个临时
runtime 没有秘密，只证明固化文件通过显式敏感词扫描。

R3 当次临时 allowlist 共 42 份 `0600` 公开证据；本目录只固化其中
关键的脱敏纯文本子集，不声称 42 份临时文件可长期取得。

## 截图边界

当次临时截图 `family-ai-b2-browser-r3-c59cd3f2.png` 已独立目检，无错误
overlay，SHA-256 为
`16e8c06c18b7af1f0985047dd34be91567add3d3a78c9f774b3d731789b272ae`。
二进制截图未进入 Git，不承诺本次会话结束后仍可取；其结论由本目录的
脱敏旅程、快照与哈希记录支撑。

## 身份证明边界

候选镜像身份依据 manifest source commit、OCI revision、image ID、archive
hash 和 build-input tree 的交叉一致。`/health` 响应 SHA-256 只用于对比正式
`8790` before/after，不单独作为候选镜像证明。

R3 的临时 curl capture wrapper 已删除，不能再做逐字节复审。后续 final
retained runtime 若采用同类编排，必须保留不含敏感材料的 wrapper
SHA-256 与脱敏源码证据。
