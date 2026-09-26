# 数据采集客户端

`config/analytics.js` 是唯一客户端采集配置。`app.js` 将前后台、页面显示和登录身份变化交给 `analyticsSession.js`；后者持有一个 `analyticsClient.js` 实例，管理服务端授权、上传调度和账号切换。`tripFollowup.js` 管理历史行程的是／否回访，`analyticsSchema.js` 校验事件，`hash.js` 提供无状态哈希工具。没有新增按钮、授权弹窗或独立设置页。

当前 HTTPS 接口仍为 `https://collect.linkx.ink/v1/batches`，各构建渠道配置为 100%。源码改名不代表小程序发布已经完成；部署状态看 [后端部署记录](../docs/backend-foundation-deployment-2026-09-25.md)。

## 身份和存量兼容

只有已登录、前台运行、可信服务端 active 授权且用途版本匹配时才入队。CloudBase `statistics` 暂时仍是会话授权入口；它使用可信微信上下文关联 OpenID，客户端传入的 OpenID 不构成认证。客户端的账号标识和 token 仅在内存使用，不进入事件正文、持久队列或普通日志。内部数据可通过受限账号映射联查 OpenID，因此不能称匿名数据。

develop/trial 请求 `collectionMode:'test'`，release 使用真实命名空间。服务端返回的类型必须与请求模式一致，测试和正式授权不能互换。首次状态为 none 时可自动启用；revoked 不自动重新启用。`confirmed` 表示服务端技术授权，不是额外用户报名证据。

`compat/analyticsLegacy.js` 集中保留上线版本的队列键、待撤回键和 wire purpose/notice 值，带有 `TEMPORARY COMPATIBILITY` 注释。模块不包含第二套身份或状态。不能仅因文件改名或新版本发布就改这些值，否则会遗失离线队列或使现有授权失效。下一版正式发布并验证正常后，还须确认旧队列、待撤回操作与服务端授权已显式迁移，才可删除兼容模块。

切换账号、模式、参与者、grant 或状态版本时清理旧队列；迟到 ACK 不得恢复旧状态。重启只在重新确认相同授权后恢复队列，token 不从存储恢复。待撤回操作保留原请求编号重试，不因重启丢失或撤回其他账号。用户停止请求沿用既有客服入口，由管理员在服务端处理；本地清理成功不等于服务端停止成功。

## 事件和发送

- 页面与搜索：`page_view`、明确日期的 `search_submitted`、实际渲染的 `result_set_rendered` / `list_snapshot`。自动加载不冒充搜索；失败结果不冒充零供给。
- 行程行为：`rideTelemetry.js` 记录可见卡片、点击、详情和联系操作，不发送联系方式。曝光要求卡片至少一半可见并持续 1 秒。
- 地点选择：`placePickerTelemetry.js` 记录打开、展示、选择和手动输入结果，携带地点 ID、位置和推荐版本。
- 回访：`tripFollowup.js` 记录展示、是／否回答和关闭。关闭不算否；牌面价格标作 `listed_reference`，不称实际成交价。持久事件队列接收成功后才标记已答。
- 诊断：`rideDiagnostics.js` 只记录操作白名单内请求和清理后的客户端错误，并有每次前台上限，不等于完整计费请求日志。

`analyticsSchema.js` 使用字段白名单，拒绝自由文本、联系方式、住宅地址、坐标和伪造业务成功事件。行程提交事实由服务端业务日志产生，不能用曝光、联系、系统结束状态或回访代替可信履约记录。

回访在历史页成功渲染后进行，评分跳转优先。候选须能确认本人创建/参与，状态为已结束、最近7天内，并达到“末次出发后4小时”和“纽约次日09:00”中较晚的时间；取消、删除、缺失或身份/时间不明的记录不进入候选。每次前台最多一次，同一参与者本机每24小时最多一次；跨设备不承诺绝无重复，分析通过稳定followupId关联。司机的“是”表示至少接送过一名乘客（driver_any_passenger），乘客的“是”表示本次预订至少一人实际乘车（respondent_booking），不能推成整车结果。没有金额输入，缺失回答/关闭均不能当“否”。

入队仅写本地存储。首批尽快发送，其余事件合批，至少间隔 15 秒，每次前台最多 40 次上传；重复 onShow 不重置限额。onHide 只尝试一次受限 flush 并停止计时，不保证后台完成。

本地最多 500 条／256 KiB／7 天，每批最多 50 条／64 KiB，容量包含固定的待发正文。超限拒绝最新事件并计数。事件过期在恢复、入队和 flush 时清理；小程序关闭后没有后台定时清理保证。

## 确认与失败恢复

第一次发送前固定 batchId、原始 JSON 字节和 SHA256。丢 ACK、重启、刷新 token 后重传同一正文；SHA256 用于完整性校验，不是认证。只有 HTTP 200 且 ok、batchId、payloadHash、eventCount 全部匹配才整批出队，期间新加入的事件不被删除。

- 401：清内存 token，保留批次；需要上传时刷新会话，至少间隔 30 秒。
- 403：停止采集并清本地队列，重新确认服务端状态。
- 409／422：持久保存停止标记，不改正文反复重传。
- 超时、5xx、429、错误 ACK：保留队列并指数退避，遵守 Retry-After 与前台额度。

采集失败使用本地队列重试，不逐事件回写 CloudBase。公开统计读取的 CloudBase fallback 属于独立路径，不能与采集失败重试混为一谈。存储清理失败、服务端超时或状态冲突均不得宣称操作完成。

## 验证

```sh
node --test tests/analytics-client.test.cjs tests/analytics-session.test.cjs tests/ride-telemetry.test.cjs tests/ride-diagnostics.test.cjs tests/trip-followup.test.cjs tests/trip-history-followup.test.cjs
```

测试覆盖旧版持久队列原字节续传、待撤回操作重试、账号隔离、回访去重和事件协议。构造器允许注入配置、存储、传输、时钟与随机数。回归使用 `tests/analytics-*.test.cjs` 及采集服务 `test/`；一次性容器联调脚本已移除，协议测试不能代替小程序 HTTPS 验收。测试夹具和日志不得包含私钥、管理员 token 或真实用户 token。
