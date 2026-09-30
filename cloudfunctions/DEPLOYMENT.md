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

## 旧查询入口的 PostgreSQL 兼容升级

这 7 个入口的旧 CloudBase 查询实现已归档到上述固定 Git 提交和私有恢复包。保留函数名是为了服务真实旧调用者；新实现只读取当前 PostgreSQL，不恢复旧库读写实现。

`getAddressList` 已于 `2026-09-30T21:56:01Z` 完成独立生产升级和实际代码读回，固定转发公开 `/api/v1/locations`。四种原地址类型的真实 SCF 调用通过，返回原 `success/id/addressList` 合同；包只有 3 个公开文件，无 SDK、密钥或 CloudBase 查询，超时为 15 秒，不安装依赖。它不是业务故障时的旧库 fallback。

其余 6 个入口的新适配器目前仅完成源码和本地验证，**尚未部署**。它们由 `services/backend/scripts/sync-cloud-queries.mjs` 从 `compat/query-bridge.js` 和可信 `backend/context.js` 生成；`--check` 验证副本，不手改生成文件。每个部署包仅含 5 个公开文件及一个独立的 `query-bridge.secret`。这个叶密钥只能签名该函数对应的只读 action，不能登录、修改业务或调用其他 action；私钥只在受保护的部署目录中注入，不能提交、上传到小程序或放入普通批量部署配置。

部署顺序是先验证新业务服务的有限只读桥，再逐函数核对环境、代码摘要及现有配置，单独部署并读回。旧请求仅在可信微信上下文中关联现有账号，沿用当前资料、成员和文件权限；超出完整响应上限或无法安全投影时明确要求新版客户端，不回读冻结 CloudBase 或返回伪造空列表。当前这 6 个云端旧实现仍读取冻结库，不属于正式 5.1.0 server 路径，不能删除尚有消费者的函数名。

`getPublicStats` 继续保留：它只以固定 `publicStats` action 转发到 `statistics`，最终读取同一 PostgreSQL，并保留真实包装器契约测试。它不属于本次归档的旧库查询实现，也不加入正常全量部署清单。

## TEMPORARY FALLBACK — 同一 PostgreSQL 的兼容路径

`backend` 的登录和有限兼容桥、`statistics` 的公开统计与账号桥继续服务已发布客户端，不能因删除旧 writer 而一并移除。`marketApi` 正常入口只加载 PostgreSQL 只读兼容 `publicRelay.js`；未被入口加载的旧 CloudBase 写入、公开查询、社区及网站管理模块和旧配置副本已从本地树移除，可从上述固定 Git 提交和私有恢复包核对。此前模块清理没有改动网站、管理站；当前服务器上的市场、社区、管理 API 及旧公开 HTTP 协议的同 PG relay 继续保留。尚未升级的旧库查询入口与此同 PG 兼容路径不同；7 个查询函数均通过独立受控部署处理，不属于正常批量部署白名单。

`cleanupMarketImagesDaily`、`placeBusinessFiveMinutes`、`publicStatsHourly` 已停用，正常部署配置中不再声明这些触发器。原始导出、恢复包与迁移工作记录不随源码退役删除，不为旧实现新增开关。

PostgreSQL 接受第一笔业务写入后，不能回退到 CloudBase 写入、恢复旧写权限或重新启用上述函数。修复及 fallback 必须连接同一个 PostgreSQL 主库，避免产生两份业务数据。
