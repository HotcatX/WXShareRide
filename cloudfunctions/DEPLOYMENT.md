# 云函数部署边界

正常部署仅允许根 `cloudbaserc.json` 中的 `backend`、`statistics`、`marketApi`、`webHouseShare`。`backend` 和 `statistics` 使用 `server` authority；`marketApi` 和 `webHouseShare` 必须使用已审定的 PostgreSQL 兼容入口。部署前核对实际源码与目标环境，不能从整个 `cloudfunctions` 目录批量部署。

## 已退役的 CloudBase 写入实现

以下旧入口的实现已从当前源码树移除，生产继续保留维护拒写入口；不要重新部署旧实现、恢复旧定时器或把它们加入正常部署清单：

- `createTrip`、`joinTrip`、`tripManage`
- `login`、`updateUser`、`clearUserNotifications`
- `rideDemand`、`referralApi`
- `syncTripStatus`、`syncMyTripStatus`
- `cleanupMarketImages`、`syncPublicStatsReplica`

恢复核对使用 [a82f73b 的 cloudfunctions](https://github.com/HotcatX/WXShareRide/tree/a82f73b/cloudfunctions) 和私有切库恢复包。本地源码清理没有删除线上维护入口；其拒写行为继续保留，不应从历史版本重新部署旧实现。迁移收据和历史业务事件的 synthetic fixtures 继续用于验证当前 PostgreSQL 与采集器的兼容性，不包含可运行的旧库 writer。

## TEMPORARY FALLBACK — 同一 PostgreSQL 的兼容路径

`backend` 的登录和有限兼容桥、`statistics` 的公开统计与账号桥继续服务已发布客户端，不能因删除旧 writer 而一并移除。旧版 `marketApi` 的 CloudBase 写入实现暂留作恢复资料，正常入口只能使用 PostgreSQL 只读兼容 relay；本轮没有清理旧网站和管理站实现。其他旧查询函数仍用于历史兼容，不属于正常部署白名单。

`cleanupMarketImagesDaily`、`placeBusinessFiveMinutes`、`publicStatsHourly` 已停用，正常部署配置中不再声明这些触发器。原始导出、恢复包与迁移工作记录不随源码退役删除，不为旧实现新增开关。

PostgreSQL 接受第一笔业务写入后，不能回退到 CloudBase 写入、恢复旧写权限或重新启用上述函数。修复及 fallback 必须连接同一个 PostgreSQL 主库，避免产生两份业务数据。
