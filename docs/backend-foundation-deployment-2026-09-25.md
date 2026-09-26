# 后端内部部署记录

2026-09-26 已将内部实例更新至提交 `a933fca`，保留各阶段恢复记录。**尚未把正式业务写入转移到 PostgreSQL；目标小程序版本 5.1.0 未上传、未送审。**

## 已部署内容

| 组件 | 部署结果 | 正式流量 |
| --- | --- | --- |
| 新业务服务 | `linkx-backend:20260926-market-core`，`/opt/linkx-backend` | 仅宿主机 `127.0.0.1:3101`；没有 Caddy 公网路由 |
| 新业务数据库 | PostgreSQL 16，001 至 018 schema 已应用 | 全部业务表为空；没有导入真实用户、管理员或行程 |
| 采集服务 | `linkx-analytics-collector:20260925-normal-names` | 保留原 Compose project、数据库、JWT、密钥、socket、数据目录 |
| CloudBase `statistics` | 依次增量上传 `compat.js`、`bridge.js` | 相同协议常量，无业务语义变更；读回 Active、15 秒 |
| CloudBase `syncMyTripStatus` | 增量上传并发修复后的 `index.js` | 事务内重读当前用户，仅迁移本轮成功且仍存在的行程；读回 Active、15 秒 |
| 小程序客户端 | 正常命名、fallback 隔离、删除不可达代码 | 仅本地修改和模拟器检查，未上传新版本 |

PostgreSQL 采用固定镜像摘要
`sha256:efedf3595f1d6f415c08568ba171029bf54052e754cc9f030e3f2412b21f3d67`。
数据库不发布宿主机端口；应用使用独立非超级用户。凭据仅保存在服务器
`/etc/linkx-backend`，不进入仓库、导出报告或小程序包。

本次业务源码归档 SHA-256：`0bb9893e14967c061826e785ab968fc22b31a2a7d236d14a9392bc4614c48278`。
业务镜像 ID：`sha256:bf5fd962df6f6ebfbe296a0a96c0aec8357d4e9c8751d9ae70b94e710332e859`。

第一阶段源码归档 SHA-256：

- 新业务服务：`a03d1c1814a1d011fa94f181387b6e06f13a8f9e269b51747925b15742941db1`。
- 采集服务：`b150245aa537da0ae86dccf6d11c956ab9ee886b6fafaeca3081b5a54e8d64e4`。

## 本次内部升级验证

- 提交 a933fca 的后端 431 项测试通过，真实 PostgreSQL、0 跳过；TypeScript 和差异检查通过。前一内部版本 bca907b 的376项通过仅是历史证据。
- 服务器已依次应用003–018，并逐表确认全部业务表为空；新业务健康与行程列表返回200，私有接口401、空白名单管理员入口403、未知管理员路径404且private,no-store。市场HTTP尚未接线返回404。缺微信AppSecret时登录503符合当前内部配置。
- 后端、PostgreSQL和现有采集服务均healthy；公网采集health200，新业务路由404，未改变现有公网路由和客户端写库。
- 升级前PostgreSQL自定义格式备份已真实恢复到独立临时数据库，核验原2项schema和0条用户/行程后删除该临时库。首次恢复因容器内备份文件归属不可读失败；修正仅该文件owner后恢复成功。
- 未部署市场云函数本地修复、未提交小程序审核、未执行生产导入或切主。
- 本地18版隔离库完成兼容演练：8核心集合首导后，再插入1管理员、25商品、130文件、72引用；25原到期时间和原管理员摘要均逐项回读相等，商品JSON不存在第二份图片字段。广告/社区只做纯转换核验，尚未接中央导入；不能把该演练称作整库正式迁移。隔离库已清理。

## 第一阶段历史验证

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

本次内部业务升级备份：

- 当前升级前数据库：`/var/backups/linkx-backend/before-a933fca.dump`，SHA-256 `9a7329001c265fdaf9758ff4f1f65781b9f6dd4f86b762fc2f8e6d4f9752099f`。
- 当前升级前源码：`/var/backups/linkx-deployments/backend-before-a933fca.tar.gz`；上一镜像 `linkx-backend:20260926-admin-files` 和源码目录 `/opt/linkx-backend-before-a933fca` 保留。
- 数据库：`/var/backups/linkx-backend/before-bca907b.dump`，SHA-256 `dcbb1243c5babc5032fbc134d48b2f4b8d07f962a4d54bfc93f294dd0d85257b`。
- 源码：`/var/backups/linkx-deployments/backend-before-bca907b.tar.gz`，SHA-256 `959b985a93b4d0990d2bf9078b6db211e5a40845790c13922845cc5d881f3ef9`。
- 原镜像 `linkx-backend:20260925-foundation` 和原源码目录 `/opt/linkx-backend-before-bca907b` 保留；该目录不承担当前服务路径。
- 已应用SQL不能修改；后续结构变更须新增迁移。此次只有内部服务容器被替换，采集容器和原有数据未重建。

采集升级前备份：

- SQLite：`/var/backups/linkx-collector/collector-2026-09-26T02-05-35.885Z.sqlite`。
- 原源码：`/var/backups/linkx-deployments/collector-before-normal-names-20260925.tar.gz`。
- 前一个镜像：`linkx-research-collector:20260925-d835491-placesv2`。

本次未改变采集 schema；代码恢复应复用当前数据库，不能直接把旧数据库快照覆盖回去而丢失新增事件。备份用于灾难恢复与核验。

下一阶段仍须完成完整旧数据映射、差异对账、业务功能覆盖、微信独立登录凭据、恢复演练及压力验证。当前完整导出审计已有阻断项，未执行导入或切主。旧版直接数据库写入和旧客户端兼容必须一起处理。

`utils/compat/cloudReads.js` 是当前明确隔离的只读 fallback，带统一删除标记。其他历史 JWT/存储协议兼容属于存量迁移边界，不能仅因发版成功便删除。所有业务写入始终只允许一个权威库。
