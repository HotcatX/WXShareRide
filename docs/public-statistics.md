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
