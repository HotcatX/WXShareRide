# 后端内部部署记录

2026-09-26 已将内部实例更新至提交 `4ddd545`，保留各阶段恢复记录。**尚未把正式业务写入转移到 PostgreSQL；目标小程序版本 5.1.0 未上传、未送审。**

## 已部署内容

| 组件 | 部署结果 | 正式流量 |
| --- | --- | --- |
| 新业务服务 | `linkx-backend:20260926-events`，`/opt/linkx-backend` | 仅宿主机 `127.0.0.1:3101`；没有 Caddy 公网路由 |
| 新业务数据库 | PostgreSQL 16，001 至 024 schema 已应用 | 33 个业务表均为空；没有导入真实用户、管理员或行程 |
| 采集服务 | `linkx-analytics-collector:20260925-normal-names` | 保留原 Compose project、数据库、JWT、密钥、socket、数据目录 |
| CloudBase `statistics` | 依次增量上传 `compat.js`、`bridge.js` | 相同协议常量，无业务语义变更；读回 Active、15 秒 |
| CloudBase `syncMyTripStatus` | 增量上传并发修复后的 `index.js` | 事务内重读当前用户，仅迁移本轮成功且仍存在的行程；读回 Active、15 秒 |
| 小程序客户端 | 正常命名、fallback 隔离、删除不可达代码 | 仅本地修改和模拟器检查，未上传新版本 |

PostgreSQL 采用固定镜像摘要
`sha256:efedf3595f1d6f415c08568ba171029bf54052e754cc9f030e3f2412b21f3d67`。
数据库不发布宿主机端口；应用使用独立非超级用户。凭据仅保存在服务器
`/etc/linkx-backend`，不进入仓库、导出报告或小程序包。

本次业务源码归档 SHA-256：`80d29c3f6bd9c88706126bfe192d75edb9003ee36d887c646d5a42addb60c2bc`。
业务镜像 ID：`sha256:1a2980ff1ee5f88d856a25b37f1685d8d6fe85c087788f26f3b88bd82ab9a8b1`。

第一阶段源码归档 SHA-256：

- 新业务服务：`a03d1c1814a1d011fa94f181387b6e06f13a8f9e269b51747925b15742941db1`。
- 采集服务：`b150245aa537da0ae86dccf6d11c956ab9ee886b6fafaeca3081b5a54e8d64e4`。

## 本次内部升级验证

- 提交4ddd545增加事务内冻结的行程前后快照、可靠投递模块和可停止的后台任务循环。完整后端601项测试通过，真实PostgreSQL、0跳过，TypeScript和差异检查通过；独立代理完成交叉审计。
- 隔离的真实PostgreSQL到现有SQLite接收器验证发布、加入、退出、再次加入、取消，以及接收端提交后丢失ACK再重投；五条事实保持相同字节且只计一次，取消后的参与者正确标为inactive。另覆盖历史身份/版本延续、纽约日期、部分ACK、连接中断、并发互斥和冻结记录不可改写。
- 024已应用；新镜像内空队列投递、零到期行程关闭与COS配置核验通过。内部health/rides/ads/community均200。投递与关闭模块仍未接入main，没有自动调度或新生产事件发送。
- 升级前备份真实恢复到独立临时数据库，核对23项schema及用户/行程/文件0行后删除临时库。当前新库仍33张业务表、0条业务记录。

### 图片与广告内部版本的证据

- 提交4e77948增加图片可信上传、按业务授权的短期读取链接，以及广告读取/点击接口；后端577项测试全部通过，真实PostgreSQL、0跳过，TypeScript和差异检查通过。
- 023已应用；逐表确认33业务表为空。内部health/ads/community正常；无会话上传401、未知图片404。公网health200、ads业务入口404。原采集、数据库和Caddy没有重建。
- 升级前dump真实恢复至独立临时数据库，核对22项schema、用户/商品0行后删除验证库；没有覆盖运行数据库。
- Linux部署镜像中，sharp 0.35.4 两张1200万像素合成PNG并发完整解码成功，进程峰值RSS147MiB；应用容器内存上限改为384MiB。这是解码专项验证，不是全业务峰值容量结论。
- 图片存储后续已完成真实验证，见下节；微信AppSecret仍未配置。未切换小程序或公开新业务端口。
- 服务器持久化图片配置目录为root:1000、0750，Compose只读挂载。更新后的Compose已重建内部backend并读回healthy，原采集/数据库/Caddy不变。

### 图片存储配置与真实验证（2026-09-26）

- 已创建仅编程访问的专用子账号，并读回确认只关联图片最小权限策略：读取现有小程序图片、读取桶版本状态、仅向新图片目录上传。不授予对象删除、权限修改或其他云资源权限。
- 密钥只保存在服务器的受限凭据文件中，应用以只读文件加载；本机临时下载副本已删除。没有使用登录控制台的全权限账号密钥。
- 使用94字节合成PNG在真实私有COS桶验证：上传与回读内容一致、重复写同路径不会覆盖、普通与旧cloud命名空间签名读取成功、专用账号删除请求被403拒绝。
- 随后通过原云开发管理工具精确删除该测试对象，并从运行中的新后端读回确认为不存在；本机和服务器临时测试脚本均已删除，没有创建业务数据库记录。
- 新后端、原采集服务和数据库均healthy；公网采集health为200，新业务ads入口仍为404。本验证覆盖存储适配器，不代表小程序全链路或业务迁移已经完成。

### 上一内部版本的证据

- 提交7b62c7e的后端540项测试通过，真实PostgreSQL、0跳过；TypeScript和差异检查通过。新增管理员发布/编辑/批次/模板、社区读写、显式浏览计数及旧发布回执迁移；原494项证据属于前一内部版本。
- 服务器已应用021–022，并逐表确认33个业务表为空；健康、市场列表、社区读取返回200，未授权管理端403，未登录浏览写入401。微信AppSecret仍未配置。
- 后端、PostgreSQL和现有采集服务均healthy；公网采集health200，新业务community路由404，未改变现有公网路由和客户端写库。
- 本轮升级前数据库备份真实恢复到独立临时数据库，读回20项schema及用户/商品0行后删除临时库；不是将备份覆盖运行库。
- 未部署市场云函数本地修复、未提交小程序审核、未执行生产业务导入或切主。
- 本地22版隔离库对25个已支持集合执行中央原子导入及同源重放：1163用户、3921行程、1管理员、31管理审计、25商品、134文件、87引用、486浏览桶、1广告、128点击、1社区当前配置和6修订；本轮新增1旧管理批次、1旧创建回执，以及显式确认空的管理模板。原文件和补导清单SHA逐项核验，旧批次和行摘要逐项回读相等且明确legacy-web-v1，公共社区读取不暴露locator。该范围仍不包括全部业务域，原导出非原子，不是生产切主依据。隔离库已清理。

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

- 数据库：`/var/backups/linkx-backend/before-4ddd545.dump`，SHA-256 `bc583e8669179f16a60560051027adf71eecb242af35add2a2399da3d8830f01`。
- 源码：`/var/backups/linkx-deployments/backend-before-4ddd545.tar.gz`，SHA-256 `1210e38aff14dde2938c4e0d6936dc25bd82d551b2a562f4ca119681bd3b73a0`；上一镜像 `linkx-backend:20260926-files-ads` 和目录 `/opt/linkx-backend-before-4ddd545` 保留。服务器图片凭据目录独立于源码恢复目录，恢复源码时仍需保留其挂载。

图片与广告版本升级前备份：

- 数据库：`/var/backups/linkx-backend/before-4e77948.dump`，SHA-256 `79f979694c20e4718995edfcad20770948000e8b43b41bf5fbdef4d72943cd05`。
- 源码：`/var/backups/linkx-deployments/backend-before-4e77948.tar.gz`，SHA-256 `441fa2c46e48d2a5492b3c49200d8d7d375bfc9cc8f09760ca65a926c7ef5c52`；上一镜像 `linkx-backend:20260926-admin-content` 和目录 `/opt/linkx-backend-before-4e77948` 保留。

上一阶段恢复点：

- 当前升级前数据库：`/var/backups/linkx-backend/before-7b62c7e.dump`，SHA-256 `771ec747850a5d4293a2874a6c77d21ef2008e2c2025e6243e68651ab8a87bcd`。
- 当前升级前源码：`/var/backups/linkx-deployments/backend-before-7b62c7e.tar.gz`，SHA-256 `1a9e9015a098981c0010cf561c42ade2fd5f3a8c40a42e30b44774834bcd8aa0`；上一镜像 `linkx-backend:20260926-catalog` 和源码目录 `/opt/linkx-backend-before-7b62c7e` 保留。

前期恢复点：

- 前一阶段数据库：`/var/backups/linkx-backend/before-517aaf6.dump`，SHA-256 `113d0ae077ef17910c55820c150d60c7d4cc7fba76785f5a4ec5b4f0ee0fd059`。
- 前一阶段源码：`/var/backups/linkx-deployments/backend-before-517aaf6.tar.gz`；上一镜像 `linkx-backend:20260926-market-core` 和源码目录 `/opt/linkx-backend-before-517aaf6` 保留。
- 前一阶段数据库：`/var/backups/linkx-backend/before-a933fca.dump`，SHA-256 `9a7329001c265fdaf9758ff4f1f65781b9f6dd4f86b762fc2f8e6d4f9752099f`。
- 前一阶段源码：`/var/backups/linkx-deployments/backend-before-a933fca.tar.gz`；镜像 `linkx-backend:20260926-admin-files` 和源码目录 `/opt/linkx-backend-before-a933fca` 保留。
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
