# 公开统计运行说明

首页公开统计优先读取 `https://collect.linkx.ink/v1/public-stats`，CloudBase `PublicStats/home` 仍是权威来源。客户端 `config/publicStats.js` 的 develop/trial/release 均为100%；新源码随小程序发版生效。服务当前部署记录统一见[后端部署记录](backend-foundation-deployment-2026-09-25.md)，不再维护多份试验期间的镜像、测试计数和“待发布”状态。

客户端由 `utils/publicStatsClient.js` 负责请求合并、2.5秒超时、最多一次 CloudBase 回退和连续两次失败后的五分钟熔断；回退实现集中在 `utils/compat/cloudReads.js`。旧客户端的 `getPublicStats` 仍须保留。24小时应用缓存优先于网络，服务端副本有效期为两小时，因此展示的数据年龄可能接近26小时。

统一云函数 `statistics` 负责公开统计读取和同步。`syncPublicStatsReplica` 保留原小时第25分钟定时器，经验证触发来源后签名委托 `statistics`。旧兼容入口转发仍产生云函数调用；不能由静态调用点数量推算实际节省量。

接收服务只持有三个公开统计字段，没有 CloudBase 数据库凭据。同步使用独立 HMAC 密钥、时差和摘要校验、单进程原子替换，拒绝过期或倒退版本。接口和恢复步骤以[服务 README](../services/public-read-pilot/README.md)为唯一契约；历史试验工程与一次性结果已移除，版本历史保留原验收记录。

## 运维与回退

当前宿主服务 `linkx-public-read-pilot.service`、容器 `linkx-collector-public-read-pilot-1`，源码 `/opt/public-read-pilot`，副本 `/var/lib/linkx-public-read-pilot/snapshot.json`，密钥 `/etc/linkx-public-stats/sync.key`。这些运行名称仍被 Compose/systemd 使用，不能只因含 pilot 就删除。

需停止服务器公开读取时，在 `/etc/linkx-collector/compose.env` 设置 `PUBLIC_STATS_READ_ENABLED=false`，在 `/opt/linkx-collector` 执行：

```sh
sudo docker compose --env-file /etc/linkx-collector/compose.env --profile pilot up -d --no-deps public-read-pilot
```

该操作只关闭公开读取，同步继续。客户端缓存未命中时回云；恢复为 true 后执行同一命令。不得删除 CloudBase 数据、兼容函数或替换正在写入的副本文件。

检查 GET 是否200、`snapshotAt` 是否随小时同步推进、有效期是否两小时；过期/停用应返回503，由客户端回退。旧 `/trial/v1/public-stats` 应返回404。现有回归位于 `tests/public-stats-*.test.cjs` 和 `services/public-read-pilot/test/`，保留故障和兼容路径覆盖。

## PostgreSQL 切换准备（尚未启用）

新后端用同一个 `public_statistics` 查询提供标准 `/api/v1/statistics/public` 和旧协议 `/api/v1/statistics/legacy`。后者保留旧客户端校验所需的 `source: cloudbase-snapshot` 字符串；该值只是旧协议标记，切换后内容来自 PostgreSQL。每次从库取数后生成一分钟有效的响应，不另建统计缓存或同步任务。业务处于 staged 或未导入统计基线时均返回503。

`config/backend.js` 是客户端和过渡云函数的唯一权威模式源。运行 `node services/backend/scripts/sync-cloud-authority.mjs` 生成 `backend`、`statistics` 两个独立部署包的 `authority.js`；使用 `--check` 校验，不能单独手改生成文件。当前值仍是 `cloudbase`，增加这些代码不会自动切库。

最终交接应按以下顺序操作：

1. 停止旧业务写入入口，包括 `syncTripStatus`、`syncMyTripStatus` 及旧管理端；排空 `TripActions` 的待投递事件。仅停止统计同步函数并不能停止旧库写入。
2. 完成一致快照、导入和对账后，停用旧地点及公共统计定时器。`statistics` 在 server 模式仍校验定时器或 relay 身份，但返回明确退役结果且不读旧库、不发送快照；旧小时包装器识别这个结果，不伪造同步时间。
3. 同步启用新业务，部署同一模式的兼容函数，并将 Caddy 的旧 `GET /v1/public-stats` 精确映射到 `/api/v1/statistics/legacy`。封闭旧 `/internal/v1/public-stats/sync` 入口，避免迟到任务刷新旧副本；保留采集授权及业务事件接口。
4. 旧客户端 HTTP 失败时仍可调用 `statistics.publicStats`，但该函数在 server 模式也只读取新库。连接失败不会退回旧统计。确认旧入口和新入口结果一致，再退役旧副本服务。

当前 CloudBase 权威阶段可按上节恢复公开读取。首次 PostgreSQL 业务写入以后，只能回退到仍使用同一 PostgreSQL 的服务版本或传输入口；不能把模式改回 CloudBase 作为自动故障恢复。回旧库需要停写、逆向迁移和重新对账。
