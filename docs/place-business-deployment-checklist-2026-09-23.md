# 地点推荐业务账本部署清单

当前部署状态以[2026-09-24 后台部署记录](backend-deployment-2026-09-24.md)为准：采集服务器、五个业务函数、`getTripList` 和 `statistics` 已更新，客户端台账写入已禁止，真实定时触发已送达合成业务事实。本文保留依赖顺序与验证要求，不再表示这些后台功能仍待部署。

## 2026-09-24 地点增补（后台已部署）

固定目录升级为 `places-v2`，在原八项后增加 Inwood、中城、下城、Queens，保留 Fort Lee／哥大等原有顺序。小程序地点配置即使云端尚无新字段，也会补齐这四项；支持英文别名 Midtown、Lower Manhattan 和中文皇后区，LIC 与法拉盛保持独立。

发布顺序仍为先更新独立采集服务的 `place-catalog.cjs`、`validation.mjs`、`places.mjs`，再部署 `getTripList/index.js` 及五处业务函数目录副本，最后上传小程序。旧采集服务的 area 校验不认识四个新增 ID，因此服务端必须先就绪，避免新地点事件被拒绝。2026-09-24 晚间部署已完成上述后台更新，实际运行校验器已接受四个新增 ID；此次后台操作不包含小程序正式发布。

本清单最初对应 2026-09-23 的本地代码复核，当时因电脑锁定未能完成业务函数部署。该阻碍现已解除；`getTripDetail` 旧等待任务已查不到，本次实际只读调用成功且包含 `__dataGeneratedAt`，未重发旧任务。具体部署方式、问题修复及收尾结果见上述最新记录。

## 已核验的代码约束

- `createTrip`、`joinTrip`、`tripManage`、`syncTripStatus`、`syncMyTripStatus` 均在业务事务内写 `TripActions`。账本失败使业务事务回滚；退出、剔除、删除与成员索引同步提交。状态转为过往时，平台服务数量与状态、账本一同提交。
- 五处 `businessLedger.js` 字节相同；五处 `placeCatalog.js` 与 `utils/placeCatalog.js` 字节相同。`statistics/businessOutbox.js` 与 `tripManage/businessOutbox.js` 字节相同。
- 消费器只读取 `deliveryState=pending` 的不可变事实，按 `createdAt` 排序，单次最多 10 条。没有时间水位，因此迟提交且时间更早的事件不会丢失。
- 数据库批次上限为 **112 KiB**；HTTPS 发送器、业务接收路由与 Caddy 请求体上限为 **128 KiB**。普通 `/v1/batches` 仍保持 **64 KiB**。历史导出文件仍为最多 10 条、56 KiB。
- 发送器总网络期限为 **6.5 秒**；回复最多 8 KiB。超时、非 200、无效 JSON 或 `ok!==true` 均不确认消息。新一次重试使用新 HMAC nonce，但相同事件 ID 和事件字节。
- ACK 必须为有效结构且只包含本次发送的事件 ID。只把收到确认的行标记为 delivered；部分 ACK、部分数据库确认失败或函数超时后的重试，由接收端事件 ID 去重。重复 ID 内容不一致由服务器拒绝。
- `statistics` 的五分钟分支只接受当前调用上下文解析得到的 `TCB_SOURCE=wx_trigger`、没有 `WX_OPENID/WX_FROM_OPENID`，以及事件 `Type=Timer/timer`、`TriggerName=placeBusinessFiveMinutes`。不读取客户端传入的上下文、`process.env` 或 SDK 进程全局身份作为 timer 授权。
- 五分钟业务同步与平台首页统计分支分开。原 `syncPublicStatsReplica` 的 `publicStatsHourly` 定时器和签名转发继续保留，不把首页统计重复执行为每五分钟一次。
- 前一轮线上函数信息读取已确认上述五个业务函数为 Active、Node.js 16.13、15 秒。`statistics/config.json` 明确为 15 秒。15 秒是执行预算而非网络成功保证；数据库慢、服务器慢或预算耗尽时，未确认的记录留在 pending。

## 上线前信任边界（已在本次部署验证）

**`TripActions` 必须禁止小程序客户端写入，建议客户端读写均禁止。** 云函数服务端 SDK 写入仍需可用。

`statistics` 将该集合中的 pending 记录作为可信业务事实签名转发。若普通客户端可直接写该集合，攻击者可伪造 actorOpenid、成员与行程快照，即使服务器 HMAC 验证通过，事实也不可信。

最初 `describeCollection` 仅返回索引，不能证明权限受控。2026-09-24 晚间已在控制台把原所有者读写规则改为所有客户端禁止读写并读回确认；实际客户端写入被拒绝（`-502003`），服务端业务函数写入的合成事实已成功同步。已建索引 `idx_place_outbox_pending`（`deliveryState:1, createdAt:1`）继续保留。当前及历史客户端兼容范围详见[部署记录中的权限复核](backend-deployment-2026-09-24.md#tripactions-权限)。

## 依赖与部署顺序

### 1. 接收端与集合先准备

1. 核验上述集合权限、集合存在及 pending 索引；保留云端现有业务数据。
2. 独立服务器先完成 SQLite 备份、schema 4、业务接收端及 Caddy 路由升级。验证 `/healthz`、HMAC 授权、重复事件 ACK 和 128 KiB 业务请求体规则；验证分析数据接口仍拒绝超过 64 KiB。
3. 确认服务器与 `statistics` 使用现有匹配的桥接密钥；不得在日志或文档中输出密钥。后端与集合准备未完成前，不切业务入口。

### 2. 更新 statistics，最后开启五分钟触发器

增量部署顺序：

1. `cloudfunctions/statistics/businessOutbox.js`
2. `cloudfunctions/statistics/placesSync.js`
3. `cloudfunctions/statistics/handler.js`
4. `cloudfunctions/statistics/index.js`
5. 更新并读回实际平台配置：timeout=15，新增 `placeBusinessFiveMinutes`，表达式 `0 */5 * * * * *`。

`handler.js` 在加载时就依赖 `placesSync.js`，`placesSync.js` 又依赖 `businessOutbox.js`，必须先部署依赖。`index.js` 最后接入同步器。**上传 config.json 文件本身不证明平台定时器已创建**，需要实际触发器信息或执行日志核验。

保留已部署的 `participation.secret.json`、`sync.secret` 及现有授权、首页统计文件。优先增量部署；若完整部署，必须通过既有安全打包流程保留私密文件，不得直接用缺少私密文件的本地目录覆盖。保留 `syncPublicStatsReplica` 的整点 25 分定时触发器。

### 3. 五个业务函数各自先 helper、后 index

对下列每个函数，都按 **`placeCatalog.js` → `businessLedger.js` → `index.js`** 顺序增量部署：

| 函数 | 切入后新增的事实 |
| --- | --- |
| `createTrip` | 发布、服务端确定的成员与座位初值 |
| `joinTrip` | 加入、前后成员与剩余座位 |
| `tripManage` | 接单、退出、剔除、删除；删除前快照仍保留 |
| `syncTripStatus` | 状态变化与对应快照 |
| `syncMyTripStatus` | 用户相关行程状态变化与对应快照 |

五个函数之间无需依赖调用；一次只切一个入口并读回 Active、15 秒。旧行程没有 businessVersion 时首次事实从版本 1 开始。`tripManage/businessOutbox.js` 是共享源码副本，业务入口并不引用它，生产消费器使用的是 `statistics/businessOutbox.js`。

全部入口切换完成前是覆盖不完整的过渡窗口，应记录切换时间，研究统计不要声称该窗口已有完整生命周期。当前没有行程修改价格/路线的云端接口，本次不能宣称捕获了不存在的修改行为。

### 4. 最后更新体验版

服务端准备好后再编译、检查新地点选择与统计事件，上传体验版。正式发布需单独按已有发布流程处理；本清单不授权或宣称正式版发布。

## 部署验证状态与后续检查

- `getTripDetail` 旧等待任务不再存在；已通过真实只读响应验证，未重复发起部署。
- `TripActions` 规则已读回，客户端写入拒绝和服务端写入成功已验证。
- 五个业务入口、`getTripList` 与 `statistics` 新文件已部署；最终函数状态、超时与实际触发器配置读回以[最新部署记录](backend-deployment-2026-09-24.md)为准。
- 已上传五分钟触发器，并在 `2026-09-25T03:40Z` 实际送达三条精确识别的合成事实；这证明一次真实链路成功，不替代持续积压监测或所有故障情形验证。
- 接收端失败或网络不确定时 pending 保留、恢复后仅确认相同事件，以及接收端重复 ACK 行为的线上链路核验。
- 若进行业务写入验证，只使用已确认隔离的测试记录；不能仅凭“来自开发者工具”猜测 synthetic 状态。不得修改普通用户的真实行程来测试。
- 清理自己创建的合成测试事实及本地私密导出临时文件，保留云端真实行程与正式账本。
- 当前 bootstrap 是幸存记录的部分历史快照，来源为 `legacy_snapshot`，不等于完整历史加入/退出事件，也不计作过去的选择次数。新公共地点批准后不会回写历史圈层；后续有效业务可使用新的公共地点归属。

本地事务、重试、删除快照、真实序列化器与真实接收端校验器、旧记录未知值、批次大小与权限分支已有对应自动测试。上述线上部署、权限和真实定时链路已有实际证据；精确探针清理与最终收尾状态集中记录在[最新部署记录](backend-deployment-2026-09-24.md)，不由本清单推定小程序已经正式发布。
