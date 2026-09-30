# 公开统计运行说明

首页公开统计优先读取 `https://collect.linkx.ink/v1/public-stats`。2026-09-30 切库后，Caddy 将该地址转发到业务后端的 `/api/v1/statistics/legacy`，数据来自 PostgreSQL 的同一个 `public_statistics` 查询。标准接口为 `/api/v1/statistics/public`；不再维护 CloudBase 快照、小时同步任务或独立统计服务。

旧协议中的 `source: cloudbase-snapshot` 只为兼容已发布客户端保留，不代表实际数据源。后端在查询后生成一分钟有效的旧格式响应；未完成导入或业务模式非 active 时返回 503。生产切换与验收见[切库记录](backend-cutover-2026-09-30.md)。

## 客户端缓存与兼容

`utils/publicStatsClient.js` 负责请求合并、2.5 秒超时、最多一次云函数回退和连续两次失败后的五分钟熔断。24 小时应用缓存仍优先于网络，主动刷新可绕过缓存，因此不能把展示统计当作实时值。`config/publicStats.js` 的 develop/trial/release 均为 100%；该配置随客户端构建发布。

已发布 5.1.0 的回退实现位于 `utils/compat/cloudReads.js`，调用 `statistics.publicStats`。该函数已使用 `server` authority，读取同一个 PostgreSQL 业务接口；失败不会改读旧 CloudBase 数据。它仍属于正式客户端协议，不能随旧快照服务一起删除。兼容云调用仍产生 CloudBase 调用次数。

`config/backend.js` 是部署 authority 的单一来源。通过 `node services/backend/scripts/sync-cloud-authority.mjs` 生成两个云包配置，使用 `--check` 核验；不要单改生成文件，也不要把模式改回 CloudBase 作为故障恢复。

## 运维

- 旧 `POST /internal/v1/public-stats/sync` 已封闭并返回 410，旧统计和地点同步定时器已停用。
- `public-read-pilot` 不再属于运行服务或 Compose 配置；历史源码留在 Git，旧快照和密钥仅保留为私有恢复资料。
- 日常核验标准接口和旧协议地址均返回 200，并核对标准 `servedCount` 与旧字段 `servedTrips`。先检查业务服务及 PostgreSQL；不恢复旧快照写者。
- 修复或传输 fallback 必须继续使用同一 PostgreSQL。当前业务出现新写后，恢复旧数据库会丢失或分叉这些写入。

接口与回退回归保留在 `tests/public-stats-*.test.cjs`、`services/backend/test/statistics.integration.test.ts`、`services/backend/test/legacy-public-statistics.integration.test.ts` 及云统计相关测试中。删除的快照服务自测随实现一并退役，不替代现行接口验证。
