# 公开统计运行说明

从 5.1.3 起，首页固定显示“累计成功出行 · 10K+ 人次”，不再请求历史累计人数，也不依赖本地统计缓存。新安装、清除缓存、下拉刷新和账号切换均不会请求此项统计。后台与旧版客户端仍可通过 `GET https://collect.linkx.ink/api/v1/statistics/public` 读取 PostgreSQL `public_statistics` 的精确累计值。2026-09-30 切库后，不再维护 CloudBase 快照、小时同步任务或独立统计服务。生产切换与客户端发布证据见[切库记录](backend-cutover-2026-09-30.md)。

累计基线由迁移显式导入，不能用现存路线重新计算全部历史总量。关闭新行程时，有司机则同事务增加 `min(5, 1 + 有效乘客座位数合计)`，无司机求车增加 0；司机独行可增加 1。此口径与[个人完成次数](ride-completion-stats.md)不同，也不是回访确认的实际成行人数。实现见[内部关闭任务](../services/backend/src/rides/completion.ts)。

## 客户端展示与兼容

5.1.3 已删除首页统计请求、格式化和 `homePublicStatsCacheV1` 缓存逻辑。旧版在首次读取达到 10,000 后复用里程碑缓存，但新安装、清除缓存或未取得里程碑结果的设备仍可能发起请求。

公开接口、兼容接口和 PostgreSQL 继续保留并返回精确累计值，后台仍可查询；仅首页展示与刷新行为变化。业务关闭任务仍正常累计，不因首页停止读取而停止计数。

当前源码已删除统计专用灰度配置、熔断、诊断计数和新发起的云函数回退调用。这是随下一次小程序构建生效的客户端精简，不代表已发布 5.1.0 会自动改变调用方式。

已发布 5.1.0 仍使用 `https://collect.linkx.ink/v1/public-stats`，Caddy 将它转发到 `/api/v1/statistics/legacy`；其失败回退调用 `statistics.publicStats`。这两个旧协议以及更早的 `getPublicStats` 包装函数继续读取同一 PostgreSQL，失败不会改读旧 CloudBase 数据，不能因当前首页不再请求而立即移除。兼容云调用仍产生 CloudBase 调用次数。

旧响应的 `source: cloudbase-snapshot` 是 5.1.0 校验所需的协议字段，不代表实际数据源。后端在查询后生成一分钟有效且带数据哈希的旧格式响应；未完成导入或业务模式非 active 时返回 503。

`config/backend.js` 是部署 authority 的单一来源。通过 `node services/backend/scripts/sync-cloud-authority.mjs` 生成两个云包配置，使用 `--check` 核验；不要单改生成文件，也不要把模式改回 CloudBase 作为故障恢复。

## 运维

- 旧 `POST /internal/v1/public-stats/sync` 已封闭并返回 410，旧统计和地点同步定时器已停用。
- `public-read-pilot` 不再属于运行服务或 Compose 配置；历史源码留在 Git，旧快照和密钥仅保留为私有恢复资料。
- 核验标准接口和旧协议地址时，对照标准 `servedCount` 与旧字段 `servedTrips`。故障先检查业务服务及 PostgreSQL，不恢复旧快照写者。
- 已有新业务写入后，恢复旧数据库会丢失或分叉这些写入；兼容传输仍须使用同一 PostgreSQL。

`tests/public-stats-client.test.cjs` 覆盖首页首次进入、清除缓存、刷新、返回和账号切换均不请求统计；`tests/home-profile-read-cache.test.cjs` 保留个人行程、未读数与社区缓存验证。`services/backend/test/statistics.integration.test.ts` 与 `services/backend/test/legacy-public-statistics.integration.test.ts` 覆盖 PostgreSQL 查询、保留的公开接口和 5.1.0 旧格式；云统计专项另覆盖原生入口和身份桥。
