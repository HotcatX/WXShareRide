# 云函数部署边界

正常部署仅允许根 `cloudbaserc.json` 中的 `backend` 和 `statistics`，两者使用 `server` authority。部署前核对 AppID、环境、源码及配置；不能从整个 `cloudfunctions` 目录批量部署。

## 当前身份与查询兼容

`backend` 保留可信微信登录、authority 和有限的未决请求恢复；`statistics` 保留统计与采集账号桥。业务操作始终连接同一个 PostgreSQL 主库，失败不能回写 CloudBase。

另保留 7 个独立部署的旧查询适配器和 `getPublicStats`，均不加入正常全量部署清单：

- `getAddressList` 固定读取 `/api/v1/locations`，保留原地址列表响应。包无 SDK、密钥或 CloudBase 查询，超时 15 秒，不安装依赖。
- `getUserInfo`、`getUserInfoByOpenids`、`getHomeTripList`、`getMyTripHistory`、`getTripList`、`getTripDetail` 只读取 PostgreSQL；由 `services/backend/scripts/sync-cloud-queries.mjs` 生成，用 `--check` 核对副本，不手改生成文件。
- 六个私有查询包每个仅含 5 个公开文件及独立 `query-bridge.secret`。叶密钥仅可签名该函数的只读 action，不能登录或修改业务；私钥仅注入受保护部署目录，不进入 Git、小程序或普通批量部署配置。
- `getPublicStats` 仅以固定 `publicStats` action 转发 `statistics`，最终读取同一 PostgreSQL。

查询升级先部署并验证服务端只读合同，再逐函数核对目标、源码摘要和现有配置，部署后读回。可信微信上下文和当前账号、成员、文件权限均须保留；无法安全返回完整响应时明确报错，不能回读旧库或伪造空列表。已消费新查询合同的函数不能回退到缺少这些 action 的旧镜像。

## 已退役入口

十二个旧维护拒写函数已于 `2026-09-30T23:37:33Z` 完成生产删除验收：`createTrip`、`joinTrip`、`tripManage`、`login`、`updateUser`、`clearUserNotifications`、`rideDemand`、`referralApi`、`syncTripStatus`、`syncMyTripStatus`、`cleanupMarketImages`、`syncPublicStatsReplica`。旧 writer、旧版本、`cleanupMarketImagesDaily`、`placeBusinessFiveMinutes`、`publicStatsHourly` 等旧定时器不得重新部署。旧统计的外部小时调用来源尚未识别，不声称已关闭该来源。

旧网页版的 `marketApi`、`webHouseShare` 及其两个 HTTP 绑定已于 `2026-10-01` 实际删除并读回核验；29 个旧网站静态文件也已删除，8 个平台认证/管理文件保留。其余 10 个小程序云入口的 ID、运行时和修改时间与删除前逐项一致。网站管理、社区和市场直接调用服务器正常 API。小程序中的 `market.call({name:'marketApi'})` 是本地视图适配分支，实际发出服务器 HTTP 请求，不是同名云函数调用。

旧 HTTP 兼容路由 `/api/v1/compat/public-web`、`/api/v1/compat/house-share` 及其专用配置已移除；正常 `/api/v1/previews/rides`、市场、社区和管理接口保留。微信身份桥、原未决请求恢复、独立查询适配器和文件 ACL 不属于旧网页清理范围。

历史实现可从 [a82f73b 的 cloudfunctions](https://github.com/HotcatX/WXShareRide/tree/a82f73b/cloudfunctions) 和私有归档核对；迁移事实见[切库记录](../docs/backend-cutover-2026-09-30.md)。原始数据、收据及恢复包保留用于对账，不是恢复 CloudBase 写权限的指令。
