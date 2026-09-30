# 云函数部署边界

正常部署仅允许根 `cloudbaserc.json` 中的 `backend`、`statistics`、`marketApi`、`webHouseShare`。`backend` 和 `statistics` 使用 `server` authority；`marketApi` 和 `webHouseShare` 必须使用已审定的 PostgreSQL 兼容入口。部署前核对实际源码与目标环境，不能从整个 `cloudfunctions` 目录批量部署。

## TEMPORARY FALLBACK — 仅供恢复核对

以下旧入口的源码暂留作迁移恢复资料，生产已停用；不要重新部署、恢复旧定时器或把它们加入正常部署清单：

- `createTrip`、`joinTrip`、`tripManage`
- `updateUser`
- `syncTripStatus`、`syncMyTripStatus`
- `cleanupMarketImages`、`syncPublicStatsReplica`

`login`、`clearUserNotifications`、`rideDemand`、`referralApi` 的旧实现已从当前源码树移除，可在 [a82f73b 的 cloudfunctions](https://github.com/HotcatX/WXShareRide/tree/a82f73b/cloudfunctions) 和私有切库恢复包中核对。本地源码清理没有删除线上维护入口；其拒写行为继续保留，不应从历史版本重新部署旧实现。

旧版 `marketApi` 的 CloudBase 写入实现同样属于临时恢复资料；正常目录必须使用 PostgreSQL 兼容入口才能部署。其他旧查询函数仍用于历史兼容，不属于正常部署白名单。

`cleanupMarketImagesDaily`、`placeBusinessFiveMinutes`、`publicStatsHourly` 已停用，配置中不再声明这些触发器。保留的源码、恢复包与迁移工作记录在观察完成后统一清理，不为它们新增开关。

PostgreSQL 接受第一笔业务写入后，不能回退到 CloudBase 写入、恢复旧写权限或重新启用上述函数。修复及 fallback 必须连接同一个 PostgreSQL 主库，避免产生两份业务数据。
