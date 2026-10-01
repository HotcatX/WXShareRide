# 个人拼车计次

当前由 PostgreSQL 的 `ride_completions` 保存每次完成凭证；个人次数直接查询凭证，不再维护云函数内的用户计数台账。生产切换见[切库记录](backend-cutover-2026-09-30.md)，表结构与接口见[数据库说明](../services/backend/SCHEMA.md)。

## 计数口径

- 同一行程、同一账号只计一次，以 `(ride_id, user_id)` 唯一约束去重；保留首次记录的司机或乘客角色。
- 新行程由内部任务在最后一个出发站时间严格过期后，从 `open` 变为 `closed`。至少有一名有效司机和一名有效乘客时，才为这些账号写入个人完成凭证。
- 一名乘客占多个座位仍只计一次。未接单请求、司机独行、取消和删除的行程不产生新的个人完成次数。
- `closed` 表示计划时间已过，不代表已核实实际到达或付款。旧协议中的 `past` / `close` 由兼容层转换。
- 已保存的完成凭证独立于当前成员关系。后续退出或成员变化不扣除历史完成次数，也不改变凭证中的首次角色；凭证本身不授予行程成员权限。

## 执行、原子性与重试

[内部关闭任务](../services/backend/src/rides/completion.ts)由 active 后端主进程每分钟调度；每批默认最多 100 条，按行程加锁，多个执行者跳过彼此已锁的记录。客户端没有推进生命周期的接口。

行程关闭、业务事件、个人完成凭证和公开统计增量在同一事务提交。重复执行不会重新关闭行程，凭证冲突也不会重复计次；已导入凭证保留原有角色及未知时间。缺少该 AppID 的公开统计基线时，整个关闭批次回滚并等待重试。

个人计次与首页公开服务人次口径不同：个人计次要求司机与乘客配对，每账号一次；公开人次有司机时为 `min(5, 1 + 有效乘客座位数合计)`，司机独行可增加 1，无司机求车增加 0。两项均不能替代[回访结果](ride-research-data-contract.md)。

## 页面与接口

`GET /api/v1/me/statistics` 返回本人 `all`、`driver`、`passenger` 的 `completedTrips`、`ratingCount`、`averageRating`、`weightedRating`。没有评分时均分为 `null`；评分与完成次数各自从事实表查询。

公开行程投影带当前司机的 `driverStatistics`，无司机为 `null`。已授权参与者的私有资料投影包含其当前角色统计；不会因统计字段额外开放联系方式或任意账号查询。旧页面所用 `rideStats.completedDriverTrips` / `completedPassengerTrips` 由兼容层映射同一结果。

路线详情显示“已发车 X 次 · 评分 X”。缺少次数或有效评分时显示“无”，真实零次显示“0 次”；评分优先加权平均分，再回退普通均分。统计查询失败不阻止查看路线。

## 历史与验证边界

历史 `_rideCompletionV1` 已按迁移规则转换成完成凭证；缺失的旧计数时间和事件保持未知，不补造。旧 `syncTripStatus`、`syncMyTripStatus` 和一次性回填入口已退役，不再作为当前操作指南。[原回填记录](https://github.com/HotcatX/WXShareRide/blob/b8af79069735e921e36a6165d9f5acc1dbc88809/docs/ride-completion-stats.md)仅用于解释历史数据。

当前测试入口为 `services/backend/test/rides-completion.test.ts`、`services/backend/test/statistics.integration.test.ts` 和 `services/backend/test/migration-completions.test.ts`。本次文档整理核对了源码与引用；未重新执行数据库任务或线上补计。
