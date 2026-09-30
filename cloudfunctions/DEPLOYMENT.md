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

## 已归档到 Git 历史的旧查询源码

`getAddressList`、`getHomeTripList`、`getMyTripHistory`、`getTripDetail`、`getTripList`、`getUserInfo`、`getUserInfoByOpenids` 的本地实现及只测试这些实现的专项已移除；源码仍可从上述固定 Git 提交和私有恢复包核对。

这次仅清理本地源码，**没有删除或修改云端这 7 个函数**。`2026-09-30T05:18:48Z` 的实际代码核验显示它们仍为 Active，并保留 CloudBase 只读实现，没有部署维护阻断。它们读取冻结后的旧库，不属于完成 authority 握手后的正式 5.1.0 server 路径，也不是 PostgreSQL 故障时的 fallback；旧函数名的客户端协议不能作为重新部署旧实现的理由。后续是否停用这些云端旧读入口需要独立处理。

`getPublicStats` 继续保留：它只以固定 `publicStats` action 转发到 `statistics`，最终读取同一 PostgreSQL，并保留真实包装器契约测试。它不属于本次归档的旧库查询实现，也不加入正常全量部署清单。

## TEMPORARY FALLBACK — 同一 PostgreSQL 的兼容路径

`backend` 的登录和有限兼容桥、`statistics` 的公开统计与账号桥继续服务已发布客户端，不能因删除旧 writer 而一并移除。`marketApi` 正常入口只加载 PostgreSQL 只读兼容 `publicRelay.js`；未被入口加载的旧 CloudBase 写入、公开查询、社区及网站管理模块和旧配置副本已从本地树移除，可从上述固定 Git 提交和私有恢复包核对。这次清理没有部署云函数或改动网站、管理站；当前服务器上的市场、社区、管理 API 及旧公开 HTTP 协议的同 PG relay 继续保留。上述仍部署的旧库查询入口与此同 PG 兼容路径不同，不属于正常部署白名单。

`cleanupMarketImagesDaily`、`placeBusinessFiveMinutes`、`publicStatsHourly` 已停用，正常部署配置中不再声明这些触发器。原始导出、恢复包与迁移工作记录不随源码退役删除，不为旧实现新增开关。

PostgreSQL 接受第一笔业务写入后，不能回退到 CloudBase 写入、恢复旧写权限或重新启用上述函数。修复及 fallback 必须连接同一个 PostgreSQL 主库，避免产生两份业务数据。
