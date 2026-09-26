# 后端重构第一阶段部署记录

当地日期 2026-09-25，服务器部署 UTC 2026-09-26。此阶段完成独立后端的内部实例与正常命名整理，**尚未把正式行程写入转移到 PostgreSQL**。

## 已部署内容

| 组件 | 部署结果 | 正式流量 |
| --- | --- | --- |
| 新业务服务 | `linkx-backend:20260925-foundation`，`/opt/linkx-backend` | 仅宿主机 `127.0.0.1:3101`；没有 Caddy 公网路由 |
| 新业务数据库 | PostgreSQL 16，001 与 002 schema 已应用 | 空业务库；没有导入真实用户或行程 |
| 采集服务 | `linkx-analytics-collector:20260925-normal-names` | 保留原 Compose project、数据库、JWT、密钥、socket、数据目录 |
| CloudBase `statistics` | 依次增量上传 `compat.js`、`bridge.js` | 相同协议常量，无业务语义变更；读回 Active、15 秒 |
| CloudBase `syncMyTripStatus` | 增量上传并发修复后的 `index.js` | 事务内重读当前用户，仅迁移本轮成功且仍存在的行程；读回 Active、15 秒 |
| 小程序客户端 | 正常命名、fallback 隔离、删除不可达代码 | 仅本地修改和模拟器检查，未上传新版本 |

PostgreSQL 采用固定镜像摘要
`sha256:efedf3595f1d6f415c08568ba171029bf54052e754cc9f030e3f2412b21f3d67`。
数据库不发布宿主机端口；应用使用独立非超级用户。凭据仅保存在服务器
`/etc/linkx-backend`，不进入仓库、导出报告或小程序包。

源码归档 SHA-256：

- 新业务服务：`a03d1c1814a1d011fa94f181387b6e06f13a8f9e269b51747925b15742941db1`。
- 采集服务：`b150245aa537da0ae86dccf6d11c956ab9ee886b6fafaeca3081b5a54e8d64e4`。

## 验证

- 新后端 54 项通过，含真实 PostgreSQL 的身份唯一、账号隔离、幂等重试、座位竞争、司机竞争、事件失败原子回滚、周模板与纽约 DST；0 跳过。
- 根目录 764 项通过。删除了只覆盖已下线“最近发布”能力的 15 项旧测试，因此不能把测试总数下降理解为未运行。
- 采集服务与运维工具本地 54 项通过；新 Linux 镜像隔离测试 43 项通过。
- TypeScript 和 `git diff --check` 通过；26 注册页、72 可达 JS 无缺失依赖。
- 模拟器实际渲染首页、正常导航行程列表并完成加载，未发现模块缺失或运行时错误。工具直接编译列表曾发生上下文未就绪，正常导航复核通过；未上传小程序、未执行发布/加入/回访答案。
- 新内部服务 health/rides 返回 200，未登录 me/templates 返回 401；公网 `/api/v1/rides` 返回 404，确认没有开放新业务入口。
- 采集 HTTPS 健康检查返回 200；collector、backend、PostgreSQL 均 healthy，重启次数 0、无 OOM。采集容器替换后首次探测遇启动阶段连接重置，后续读回才作为成功验证。
- 升级后原采集库可读：12 个真实激活账号、232 个有效事件、30 批；这些是当时的累计数，不表示迁移后新增量。事务业务事实 153 条与 1,054 条 legacy snapshot 分开保留。

空载观察 backend 约 45 MiB、PostgreSQL 约 35 MiB；这不是峰值容量测试或生产承载承诺。

## 恢复位置与边界

采集升级前备份：

- SQLite：`/var/backups/linkx-collector/collector-2026-09-26T02-05-35.885Z.sqlite`。
- 原源码：`/var/backups/linkx-deployments/collector-before-normal-names-20260925.tar.gz`。
- 前一个镜像：`linkx-research-collector:20260925-d835491-placesv2`。

本次未改变采集 schema；代码恢复应复用当前数据库，不能直接把旧数据库快照覆盖回去而丢失新增事件。备份用于灾难恢复与核验。

下一阶段仍须完成完整旧数据映射、差异对账、业务功能覆盖、微信独立登录凭据、恢复演练及压力验证。当前完整导出审计已有阻断项，未执行导入或切主。旧版直接数据库写入和旧客户端兼容必须一起处理。

`utils/compat/cloudReads.js` 是当前明确隔离的只读 fallback，带统一删除标记。其他历史 JWT/存储协议兼容属于存量迁移边界，不能仅因发版成功便删除。所有业务写入始终只允许一个权威库。
