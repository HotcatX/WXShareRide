# 研究采集客户端与当前集成

截至2026-09-23，`config/research.js` 已启用 `https://collect.linkx.ink/v1/batches`，develop/trial/release均100%。版本 `2026.09.23.3` 已上传并覆盖体验版，尚未正式发布；接收器为 `linkx-research-collector:20260923-expanded`，统一云入口为 `statistics`，实际超时15秒。本轮按用户要求在微信开发者工具编译及实际运行验收，`urlCheck=true`，未进行真机测试。当前部署、验证和清理结果以[扩展采集实现记录](../docs/expanded-collection-2026-09-23.md)为准。

`app.js` 已接入前后台与页面生命周期，登录路径通知身份变化；`utils/researchParticipation.js` 持有单例SDK并管理状态、技术启用、token和上传调度。没有新增独立入口、隐私同意弹窗、报名或设置页；已有隐私说明已更新，历史页已接入用户要求的是/否回访弹层。`confirmed`与用途版本字段表示可信服务端技术授权，不是明确研究同意或报名证据。

## 身份、模式与停止

develop/trial请求 `collectionMode:'test'`，release省略该字段，云桥为两者使用不同HMAC账号作用域。接收器固定参与者类型，客户端核对服务端返回的synthetic类型；测试与真实授权不能互换，`eligible_real_events` / `eligible_real_batches`排除测试记录。test是请求的命名空间，不是服务器对微信构建渠道的证明。

只有登录身份、可信active授权、用途版本匹配且前台状态成立才入队。首次服务端状态none可后台activate，revoked不自动重新启用。SDK的 `setSession()` 只能由可信桥响应适配器调用；SDK用于隔离的原始账号标识与token仅在内存使用，不进入研究正文、持久队列或普通日志。`statistics`可信云上下文另将OpenID关联到服务端账号映射，供受限内部`operational_events`联查；研究导出仍使用不含OpenID的`eligible_real_events`，内部数据库不称匿名。token缺失/过期时不能上传，服务端仍校验签名、到期时间和当前grant状态。

切账号、模式、参与者、grant或状态版本时清旧队列，迟到ACK不能恢复旧状态。重启后须重新确认相同授权才能恢复持久队列；token不从存储恢复。`clearSession()` / SDK `withdraw()` 只代表本地停止和清理尝试，不代表服务端停止已完成。

用户停止请求沿用既有客服入口，管理员核验后使用[私有停止工具](../services/research-collector/ops/stop-collection.md)完成真实命名空间的服务端withdraw。工具没有新增产品界面，也不负责test命名空间清理。存储清理失败、服务端超时或CAS冲突不能宣称完成。

## 当前事件与发送限制

当前已接入出行 `page_view`、用户主动选择明确日期的 `search_submitted`、渲染后的 `result_set_rendered` / `list_snapshot`。结果快照最多附50条候选，只有`candidatesComplete=true`才表示完整；自动加载不冒充显式搜索，失败或未显示的迟到结果不冒充零供给或展示。

`rideTelemetry.js`已接入卡片至少一半可见持续1秒的`result_card_visible`、`trip_card_clicked`、同次访问去重的`detail_viewed`及复制操作的`contact_action`；不发送联系方式。详情先加载、授权后就绪时，仅在同账号仍停留原页的条件下补记。`rideDiagnostics.js`记录允许列表内的`service_request`和清理后的`client_error`，有前台限额，不是全部调用日志。

`researchFollowup.js`在合资格历史列表中记录`followup_presented` / `followup_answer` / `followup_dismissed`。司机与乘客按不同结果口径回答是/否，关闭不计作否；本机每前台一次、每24小时一次，回答入持久队列成功后才标已答。只记录可解析的牌面参考价`listed_reference`，没有金额输入，不将其称为实际成交价。候选资格、跨设备去重边界及各事件语义见[扩展采集实现记录](../docs/expanded-collection-2026-09-23.md)。

事件严格白名单见 `researchSchema.js`；未知字段、伪造业务成功事实、自由文本、联系方式、住宅地址和坐标均拒绝。事件ID是无个人含义的不透明标识，不能将电话号码等编码后塞入ID。

SDK的 `enqueue()` 只持久化，不发网络请求。集成manager在前台有事件时调度：首批尽快，后续空闲时合批，发送间隔至少15秒；每个前台会话最多40次请求。重复应用onShow不会重置前台额度。App.onHide只尝试一次受现有限额约束的flush并停止计时，不保证后台完成或定时上传。

队列最多500条、256KiB、7天，容量包括不可变待发正文；超限拒绝最新事件并计数。每批最多50条、完整UTF-8 JSON不超过64KiB。持久化失败暂停采集/上传；`getStatus()`只返回计数、退避和安全错误状态。事件TTL在恢复、入队和flush时惰性清理，小程序关闭后不能保证第7天准点物理删除；旧待发批次任一事件过期时整批丢弃，不能改同一batchId的部分正文重传。

研究上传失败保留本地队列并退避重试，**不回CloudBase逐事件写入**。CloudBase仅用于研究状态、技术启用/关闭和按需token续期；公开统计读取失败才走 `statistics({action:'publicStats'})` fallback。这两个失败处理路径不同。

## ACK与失败处理

`wx.request`发送已持久化的原始JSON字符串，token只置于Authorization头。batchId、正文和SHA256首次发送前固化；丢ACK、重启或更换token后原字节重传。SHA256用于完整性核对，不是身份认证。

仅HTTP200且ok、batchId、payloadHash、eventCount全部匹配才整批出队；`duplicate=true`也确认成功。无响应、超时、部分/错误ACK均不能当成功。请求期间新入队事件不会被该ACK删除。

- 401：SDK清内存token并保留原批；manager有待传事件时按需刷新状态/token，至少30秒刷新冷却，不因空闲token到期轮询。
- 403：本地停采清队列，重新确认服务端状态；不能用旧授权自动重开。
- 409/422：持久化停止标记，不改正文重传或循环请求。
- 429/5xx、网络失败、错误ACK：保存退避状态，遵守Retry-After，指数退避带抖动，同时受15秒间隔和40次前台额度限制；后台不唤醒。

## 测试与已读回证据

本地验证入口：

```sh
node --test tests/research-client.test.cjs tests/research-participation.test.cjs tests/ride-telemetry.test.cjs tests/ride-diagnostics.test.cjs tests/research-followup.test.cjs tests/trip-history-followup.test.cjs
```

构造器支持注入config、wx、storage、transport、clock和随机数用于隔离测试；即使注入transport，endpoint仍须通过HTTPS域名校验。不得把私钥、admin token或真实用户token放进客户端或fixture。旧 `tests/research-live-smoke.cjs` 的loopback注入只证明SDK/接收器协议，不能代替微信HTTPS验收。

当前`.3`已在开发者工具验证卡片可见、点击、详情、联系复制路径及合成历史行程的yes/no回访，实际HTTPS入库及OpenID内部关联成功；回访附牌面参考价。测试后恢复临时调用替身和本地回访状态，待传队列为0，清理9个synthetic批次/76条测试事件，真实事件数量保持不变。根测试682项通过，新增冷启动详情授权回归及协议一致性28项通过，生产镜像测试32项通过；详细口径、控制台遗留基础库异常和清理范围见[当前记录](../docs/expanded-collection-2026-09-23.md)。此前`.2`的三类事件及断网/丢ACK验收保留在[历史阶段记录](../docs/research-rollout-2026-09-23.md)。

历史准备态曾默认关闭、endpoint为空、每前台只尝试一次且间隔5分钟；这些已被当前集成和限额替代。是/否回访现已接入，但属于用户自报；核心业务提交outbox与可信履约证明仍未接入，不能由浏览、复制或系统结束状态推导真实成行。
