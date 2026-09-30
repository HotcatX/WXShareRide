# 云函数部署边界

正常部署仅允许根 `cloudbaserc.json` 中的 `backend`、`statistics`、`marketApi`、`webHouseShare`。`backend` 和 `statistics` 使用 `server` authority；`marketApi` 和 `webHouseShare` 必须使用已审定的 PostgreSQL 兼容入口。部署前核对实际源码与目标环境，不能从整个 `cloudfunctions` 目录批量部署。

## 已退役的 CloudBase 写入实现

以下旧入口的实现已从当前源码树移除；其生产维护拒写函数也已于 `2026-09-30T23:37:33Z` 完成删除验收。不要重新部署旧实现、恢复旧定时器或把它们加入正常部署清单：

- `createTrip`、`joinTrip`、`tripManage`
- `login`、`updateUser`、`clearUserNotifications`
- `rideDemand`、`referralApi`
- `syncTripStatus`、`syncMyTripStatus`
- `cleanupMarketImages`、`syncPublicStatsReplica`

云函数实际由 24 个减至 12 个：正常部署的 4 个入口、下面的 7 个查询适配器，以及 `getPublicStats`。保留入口的代码、配置、版本、别名、触发器和 HTTP 绑定均经实际读回核对未变。本次仅删除上述函数，没有修改数据库、网关、容器或定时器。

历史核对使用 [a82f73b 的 cloudfunctions](https://github.com/HotcatX/WXShareRide/tree/a82f73b/cloudfunctions) 和私有切库恢复包，不能据此恢复旧库 writer。已拒写的更老客户端现在收到函数不存在，而非 `MAINTENANCE`；当前 server 路径和保存未决请求的 `backend` 同库恢复路径不依赖上述名字。迁移收据和历史业务事件的 synthetic fixtures 继续验证当前 PostgreSQL 与采集器兼容性。

## 旧查询入口的 PostgreSQL 兼容升级

这 7 个入口的旧 CloudBase 查询实现已归档到上述固定 Git 提交和私有恢复包。保留函数名是为了服务真实旧调用者；新实现只读取当前 PostgreSQL，不恢复旧库读写实现。

`getAddressList` 已于 `2026-09-30T21:56:01Z` 完成独立生产升级和实际代码读回，固定转发公开 `/api/v1/locations`。四种原地址类型的真实 SCF 调用通过，返回原 `success/id/addressList` 合同；包只有 3 个公开文件，无 SDK、密钥或 CloudBase 查询，超时为 15 秒，不安装依赖。它不是业务故障时的旧库 fallback。

其余 6 个入口已于 `2026-09-30T22:50:15Z` 完成逐个生产部署和实际代码读回：`getUserInfo`、`getUserInfoByOpenids`、`getHomeTripList`、`getMyTripHistory`、`getTripList`、`getTripDetail`。配套业务镜像 `52f4405` 已先行部署；随后开发者工具真实 `wx.cloud.callFunction` 验证全部通过。它们由 `services/backend/scripts/sync-cloud-queries.mjs` 从 `compat/query-bridge.js` 和可信 `backend/context.js` 生成；`--check` 验证副本，不手改生成文件。每个部署包仅含 5 个公开文件及一个独立的 `query-bridge.secret`。这个叶密钥只能签名该函数对应的只读 action，不能登录、修改业务或调用其他 action；私钥只在受保护的部署目录中注入，不能提交、上传到小程序或放入普通批量部署配置。

部署顺序是先验证新业务服务的有限只读桥，再逐函数核对环境、代码摘要及现有配置，单独部署并读回。旧请求仅在可信微信上下文中关联现有账号，沿用当前资料、成员和文件权限；超出完整响应上限或无法安全投影时明确要求新版客户端，不回读冻结 CloudBase 或返回伪造空列表。六个实际包共 36 个文件均与封存包一致，全部 Active、15 秒、不安装依赖，其余配置、版本、绑定和定时器未变。这些函数保留实际旧消费者的名字，正常 5.1.0 server 路径不依赖它们；不能因新客户端不引用而直接删除。

`getPublicStats` 继续保留：它只以固定 `publicStats` action 转发到 `statistics`，最终读取同一 PostgreSQL，并保留真实包装器契约测试。它不属于本次归档的旧库查询实现，也不加入正常全量部署清单。

## TEMPORARY FALLBACK — 同一 PostgreSQL 的兼容路径

`backend` 的登录和有限兼容桥、`statistics` 的公开统计与账号桥继续服务已发布客户端，不能因删除旧 writer 而一并移除。`marketApi` 正常入口只加载 PostgreSQL 只读兼容 `publicRelay.js`；未被入口加载的旧 CloudBase 写入、公开查询、社区及网站管理模块和旧配置副本已从本地树移除，可从上述固定 Git 提交和私有恢复包核对。此前模块清理没有改动网站、管理站；当前服务器上的市场、社区、管理 API 及旧公开 HTTP 协议的同 PG relay 继续保留。7 个查询函数现也读取同一 PostgreSQL，但均通过独立受控部署处理，不属于正常批量部署白名单。

`cleanupMarketImagesDaily`、`placeBusinessFiveMinutes`、`publicStatsHourly` 已停用，正常部署配置中不再声明这些触发器。删除前实际 SCF 触发器和 HTTP 绑定均为空；`syncPublicStatsReplica` 此前仍有小时调用，外部调用来源尚未识别，本次不声称已关闭该来源。原始导出、恢复包与逐项删除收据保留，完成的临时工作记录已移除，最终状态见[切库记录](../docs/backend-cutover-2026-09-30.md)。

PostgreSQL 接受第一笔业务写入后，不能回退到 CloudBase 写入、恢复旧写权限或重新启用上述函数。修复及 fallback 必须连接同一个 PostgreSQL 主库，避免产生两份业务数据。

六个查询适配器已消费新增只读合同，缺少这些 action 的旧业务镜像不能直接回退使用。修复镜像必须保留查询合同并连接同一 PostgreSQL；现存旧镜像和归档仅用于取证、比较，不是恢复旧库写入的指令。
