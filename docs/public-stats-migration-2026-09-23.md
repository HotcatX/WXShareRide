# 首页公开统计迁移与全量配置验收

公开统计读取优先交给Lighthouse，CloudBase `PublicStats/home` 仍为权威来源，读取失败保留CloudBase回退。当前 `statistics` 及两个旧兼容入口已部署，实际超时均为15秒；小程序版本 `2026.09.23.2` 上传成功，研究与公开统计develop/trial/release均配置100%，**尚未正式发布，待用户在微信平台完成**。本轮按用户要求以开发者工具编译及实际运行验收，`urlCheck=true`，不声称手机验证。登录、预约、座位、行程状态、支付及个人资料业务保持原路径；行为采集状态见[首期记录](research-rollout-2026-09-23.md)。没有新增产品按钮、弹窗或导航入口。

## 路径与数据

- `GET https://collect.linkx.ink/v1/public-stats`：公开统计副本，返回 `_id`、`servedTrips`、`coverageText`，无用户标识。
- 新客户端公共统计回云统一调用 `statistics({action:'publicStats'})`；统一函数也包含小时同步及行为采集的技术授权动作。
- 现有 `syncPublicStatsReplica` 保留每小时第25分钟的旧触发器。兼容实现先验证本次直接 `wx_trigger` 来源及指定触发器，再用域隔离HMAC委托 `statistics`；旧 `getPublicStats` 兼容实现也转发至 `statistics`。两个兼容包已部署成功，getPublicStats真实调用及07:25 UTC自然定时转发均已通过；新函数不另建第二个定时器。
- 同步实现只读 `PublicStats/home` 两个汇总字段，向 `/internal/v1/public-stats/sync` 发一个 HMAC 签名 POST。签名专用密钥没有 CloudBase 数据库权限、不在小程序包或 Git 中。伪造客户端event不能获得同步权限。
- 接收端验证签名、五分钟时差、严格白名单、摘要与取得时间，拒绝回滚；文件 mode 0600 原子替换。副本寿命两小时，过期或停用返回 503。

## 小程序启用范围

`config/publicStats.js` 当前配置develop/trial/release均100%，全量时不依赖本地匿名安装桶。该配置随新代码包到达用户后生效，不是远程开关，也不代表已完成微信正式发布。研究数据在develop/trial使用独立test命名空间，不能与公开统计的全量读取混为真实研究样本。

原有24小时缓存继续优先使用，缓存未命中时请求服务器；2.5秒超时、HTTP错误或无效快照最多触发一次 `statistics({action:'publicStats'})` 回退，不重试HTTP。两次连续失败后，本次运行五分钟内直接回云。未知环境、关闭/无效配置也走云；100%时不因随机桶存储不可用而退出直连路径。已分发的旧包仍可调用 `getPublicStats` 兼容入口。研究批次失败则留本地队列退避重试，**没有逐条回云函数写入的降级路径**。

两小时是副本可被新 HTTP 请求接受的期限，不代表首页两小时刷新。保留原 24 小时缓存时，显示数据年龄理论上可接近 26 小时。这个接口迁移适合验证流程，不是主要节省调用量的来源。

## 调用成本

每小时同步对应每日24次显式数据库读取、24次同步POST。最初直接定时函数是每日24次函数执行；启用旧timer→statistics兼容转发后，计划约48次函数执行/日（30天约1,440次），平台重试另计。旧包经getPublicStats兼容转发也会多一层函数执行；新包直接调用statistics。是否净节省取决于实际缓存未命中、失败回退和版本覆盖，不能用小程序全部调用量推算。Lighthouse不按CloudBase交互数收费，但仍使用服务器带宽等资源。

## 运维与回退

服务 `linkx-public-read-pilot.service`、容器 `linkx-collector-public-read-pilot-1`，代码 `/opt/public-read-pilot`，副本 `/var/lib/linkx-public-read-pilot/snapshot.json`，签名密钥 `/etc/linkx-public-stats/sync.key`。容器没有宿主端口，Caddy 只代理精确路径；仅快照目录可写，密钥挂载只读，128 MiB 内存上限。部署保持单个进程写快照。

立即停止新 HTTP 读取：在 `/etc/linkx-collector/compose.env` 设置 `PUBLIC_STATS_READ_ENABLED=false`，在 `/opt/linkx-collector` 执行：

```sh
sudo docker compose --env-file /etc/linkx-collector/compose.env --profile pilot up -d --no-deps public-read-pilot
```

同步仍继续，客户端缓存未命中时自动回云。恢复为 `true` 后重复此命令。客户端配置 `enabled:false` 则在下次发包后完全停止新请求。不要删除 CloudBase 数据或原 `getPublicStats` 函数。

检查副本：请求 GET，核对 `snapshotAt` 随定时器推进且 `expiresAt-snapshotAt=7200000`；检查容器 `public-stats-sync` 状态日志。旧 `/trial/v1/public-stats` 已移除。尚未配置长期外部告警，不把本次成功等同于持续可靠性。

回滚配置备份为 `/opt/linkx-collector/Caddyfile.before-public-stats-rollout`、`compose.before-public-stats-rollout.yaml`；仅在核对无后续修改后恢复。

## 清理与验收

早期独立测试小程序、开发者工具中的对应项目记录、当时原始测试JSON与临时部署文件已删除；保留必要服务实现、回归测试和这份运维说明。项目打包排除 `services/data/docs/tests/research`，云函数由独立云函数目录管理。

本轮实际运行环境为微信开发者工具develop，合法域名校验开启。公开统计真实HTTPS成功、24小时缓存命中、并发合并均通过；2.5秒超时、503、坏快照回退CloudBase及连续两次失败后的熔断也通过。当前配置双路三个环境均100%已从运行时读回；不把模拟故障说成生产故障，不把本轮开发者工具验收说成手机验证。

历史自动测试记录：早期服务端17项、客户端23项、首页与个人页缓存16项、定时函数与上下文11项通过；统一入口当时相关29项测试通过。平台附加userInfo/tcbContext只剥离、不作为鉴权依据，临时字段诊断已移除。历史数量不是本轮完整测试总数。

早期部署读回：服务器正式接口返回200，旧 `/trial` 路径404，无签名同步POST为401；三项systemd服务active，采集 `/healthz` 为200，公开统计容器只读根目录、没有宿主端口，当时内存约16.7MiB / 128MiB。当前collector镜像为 `linkx-research-collector:20260923-full`，healthy。

初始阶段，`syncPublicStatsReplica` 部署至 `cloud1-7gmtcu4s3aebce27`，超时读回为15秒，`publicStatsHourly` 计划为 `0 25 * * * * *`。首次真实自动触发在 **2026-09-23 06:25:01.403 UTC** 取得源数据，服务器在 **06:25:01.902 UTC** 记录同步HTTP 200；随后GET返回同一取得时间、到期时间 **08:25:01.403 UTC**，数据为8,451 / NY / NJ。这是旧直接定时路径的历史验收，不冒充后来统一入口的转发验收。

最终兼容部署后的 **2026-09-23 07:25 UTC** 自然触发已完成旧定时wrapper→statistics→服务器的真实路径：GET读回 `snapshotAt=1790148303678`（07:25:03.678 UTC），`expiresAt=1790155503678`（09:25:03.678 UTC）；sidecar日志为 `event=public-stats-sync`、`status=200`、`at=1790148304176`（07:25:04.176 UTC）。取得时间已推进，副本有效期准确为两小时。

本轮最新部署事实：

| 项目 | 状态 |
| --- | --- |
| 统一statistics云函数 | 当前支持test/real隔离的实现部署完成，实际超时15秒；公开统计真实HTTPS与CloudBase回退均通过 |
| 旧getPublicStats / syncPublicStatsReplica兼容替换 | 最终兼容包均部署成功，实际超时均15秒；部署后真实调用getPublicStats正常返回8451；07:25 UTC自然定时经旧wrapper→statistics同步成功，服务器返回200且副本时间推进 |
| collector行为接收服务 | `linkx-research-collector:20260923-full` 已部署且healthy，真实开关开启；当前真实分析视图0条，与公开统计副本分开计数 |
| 研究HTTPS与页面链路 | 开发者工具urlCheck=true；离线3条保留、丢ACK后原body重放duplicate=true、队列0；实际筛选的search/result数量53、2与页面匹配，测试数据不进入real视图 |
| 小程序新包 | `2026.09.23.2` 上传成功；待用户在微信平台完成审核、发布，尚无正式发布记录 |
| 运行配置 | 公开统计和研究develop/trial/release均100%；研究develop/trial为test命名空间，release为真实命名空间 |
| 测试清理 | 只删除synthetic=1、purpose=ride-research-v1、截至1790190142676的11批/28事件载荷；测试和真实eligible事件均0，保留最小收据和1个active测试授权。开发者队列0，临时smoke存储不存在 |

最终读回：full镜像healthy，清理后载荷batches=0、syntheticEligibleEvents=0、realEligibleEvents=0。公开统计HTTPS仍返回200，`snapshotAt=1790187903416`、`expiresAt=1790195103416`处于有效期，小时同步持续推进。含私钥的临时部署stage及服务器临时构建目录/压缩包已删除；必要服务密钥与控制元数据未删除。

历史版本 `2026.09.23.1` 上传包为1,423,933 bytes，当时采用公开统计release5%、研究release5%/develop/trial0和collector `20260923-notice`，statistics包13.3KB；这些是已被本轮全量配置替代的阶段记录。

当前原首页已接入并上传体验版，100%配置须随正式新包到达用户后生效，不能称已正式全量发布。产品云调用目标统一为statistics，没有新增researchParticipation产品入口；云端旧researchParticipation函数返回ResourceNotFound，同名utils模块只是内部代码。本轮按开发者工具验收结束，没有手机验证，正式用户流量与节省量尚未观测。

官方定时器说明：https://docs.cloudbase.net/cloud-function/timer-trigger 。微信定时器来源说明：https://developers.weixin.qq.com/miniprogram/dev/wxcloud/guide/functions/triggers.html 。
