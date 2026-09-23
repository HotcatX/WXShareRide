# LinkX 独立研究采集服务部署记录

> 历史初始部署记录：以下“关闭采集、客户端未接入”等状态、限额及待办仅描述首次部署阶段，已由后续实现替代，不作为当前运行配置。当前 `.3` 扩展采集、部署与体验版上传验收见[扩展采集实现记录](expanded-collection-2026-09-23.md)；中间 `.2` 阶段见[历史行为观测与统计迁移记录](research-rollout-2026-09-23.md)。

日期：2026-09-23。工作目录 `/Users/cat/Documents/Github/wx`。用户已购买腾讯云海外服务器并授权配置；以下记录区分实际完成与待启用项目，不代表已开始收集真实用户数据。

## 已核对的基础设施

- 服务器：`43.153.4.125`，腾讯云硅谷二区 `lhins-l6lb98k1`，登录用户 `ubuntu`，2 核、约 2GB 内存、40GB 系统盘、2GB swap；控制台套餐为 512GB/月流量、20Mbps 峰值带宽。
- 已更新至 Ubuntu 24.04.5 LTS、内核 `6.8.0-139-generic`、Docker 29.8.1、Compose 5.5.1；系统更新后的两次重启验证通过，自动安全更新服务保持运行。
- 已启用主机 UFW，默认拒绝入站，允许 TCP 22/80/443。腾讯云防火墙原有 22/80/ICMP，新增并在控制台确认 TCP 443；没有放行数据库或管理端口。
- 接收器端口明确发布为 `127.0.0.1:3000`，Caddy 对公网提供 80/443；不能依赖 UFW 自动拦截 Docker 发布的端口。管理 API 仅使用受权限和独立密钥保护的 UNIX socket。
- 系统时区统一为 UTC，NTP 同步正常；研究时间按协议保存时间戳，纽约服务日期另行处理。
- 代码 `/opt/linkx-collector`，数据 `/var/lib/linkx-collector`，本机备份 `/var/backups/linkx-collector`，服务端配置 `/etc/linkx-collector`。密钥只在服务器生成和保存，不进入仓库、小程序包或本文。
- 已在 DNSPod 免费版添加 `collect` A 记录到 `43.153.4.125`，TTL 600；本机及服务器 DNS 查询均确认生效。没有修改根域名、其他子域名或 AAAA。
- `https://collect.linkx.ink/healthz` 已通过公网证书校验返回 HTTP 200。Let's Encrypt 证书签发者 YE2，当前有效期至 2026-12-22 03:29:55 UTC；Caddy 已配置自动续期，证书 `/data` 与配置 `/config` 使用独立持久卷。没有购买 SSL 证书。
- 域名注册与实名已完成，本轮未提交 ICP 备案。用户随后自行在微信后台添加 `https://collect.linkx.ink` 并回复“ok了”；这是用户报告的后台保存成功，尚未通过微信真机请求独立验证，也不能据此推定 ICP 备案已完成。

## 当前阶段

服务器和采集基础模块已部署，**真实研究采集仍关闭**。这不是小程序已开始自动采集的交付声明。

接收器 `REAL_COLLECTION_ENABLED=false`，只接受经本机管理通道创建的合成参与者；未知身份和真实参与者默认拒绝。客户端 `config/research.js` 保持 `enabled=false`、`endpoint=''`，未挂入 app.js、页面或登录流程，未上传小程序版本。密码未写入仓库或配置，应用签名密钥和管理密钥均在服务器单独生成。

当前能力：严格事件白名单、签名短期令牌、授权版本校验、50 条/64KiB 批次、原字节重试、批次及跨批事件去重、撤回后的接收阻断。SQLite WAL + FULL 提交后才确认 ACK；真实业务成功与实际同行事实不从客户端点击推断。

## 已完成验收

| 项目 | 结果 |
| --- | --- |
| 客户端测试 | 20/20 通过，包括缓存容量、令牌不落盘、切号撤回、原文重试与 8 类事件合同交叉验证 |
| 服务端测试 | 在目标服务器构建的最终镜像内 12/12 通过，包括磁盘满无成功 ACK、并发撤回、真实 SIGKILL 后 WAL 恢复、备份隔离恢复 |
| 实际 SDK 联调 | 30 条合成事件入队时 0 网络请求；第一次提交故意丢 ACK，SDK 重建后原字节重试获重复 ACK，队列清空；撤回后旧令牌 403 |
| 公网 HTTPS 合成测试 | 健康、签名上传、重试、冲突、撤回及旧令牌拒收全部通过；合成参与者已撤回，未使用真实数据 |
| 公网入口 | HTTP 308 跳转 HTTPS；HTTPS 健康 200；无令牌批次 401；公网管理路径 404 |
| 在线备份 | 每日 UTC 03:30 加最多 15 分钟随机延迟；手动执行成功，SQLite integrity_check 通过 |
| 恢复演练 | 从实际本机备份创建新的候选库；完整性正常且恢复门禁 closed、可分析事件为 0，没有覆盖运行库 |
| 开机自启 | 最终整机重启后 collector 健康、Caddy HTTPS 200、备份 timer 正常，手动备份再次通过 |

初次接收器空闲内存约 19MiB；最后重启、测试和备份后的 Docker stats 为接收器约 75MiB、Caddy 约 51MiB（包含容器记账内存，非生产承载能力保证），对应上限分别为 512MiB 和 128MiB。数据库页容量初始上限 1GiB，低磁盘空间时拒绝写入而不伪造成功。未来真实规模需要依据活跃用户、事件量和峰值实测调整。

本地队列最多 500 条/256KiB/7 天，每个应用前台会话最多一次上传，两次至少相隔 5 分钟。SDK 不逐事件调用 CloudBase，也不自动刷新令牌；之后身份桥需尽量随已有登录响应提供令牌。关闭小程序后不能保证后台按时上传或准点删除，需由后续前台机会处理。

## 运维入口与备份边界

主机安装 `ops/` 内的 systemd units：`linkx-collector.service`、`linkx-collector-https.service`、`linkx-collector-backup.service/.timer`。服务端设置在 `/etc/linkx-collector/compose.env`；修改后需要重新创建相关容器才能生效。

登录服务器后可执行以下命令；它们只输出聚合状态，不输出密钥：

```sh
cd /opt/linkx-collector
sudo docker compose --env-file /etc/linkx-collector/compose.env --profile https ps
sudo docker compose --env-file /etc/linkx-collector/compose.env exec -T collector node scripts/admin.mjs status
sudo systemctl start linkx-collector-backup.service
sudo journalctl -u linkx-collector-backup.service -n 10 --no-pager
sudo systemctl list-timers linkx-collector-backup.timer
```

本机备份目录为 `/var/backups/linkx-collector`，不是异机容灾。当前不自动删除旧备份：关闭采集开关不代表历史备份没有真实数据。正式开启前须定好 COS 归档、容量与保留策略、撤回记录重放，并验证整机丢失后的恢复。恢复工具只生成默认隔离的新候选；完整性检查成功不能替代撤回状态对账。

## 正式接入仍需完成

1. 用户已报告 request 合法域名保存成功。本机 `project.private.config.json` 已将 `setting.urlCheck` 改为 true（覆盖共享配置中的 false）；需要刷新开发者工具域名配置、关闭手机调试豁免后做微信真机测试，并核实 ICP 状态。电脑 HTTPS 检查不能代替微信正式运行环境验收。
2. 建立可信 CloudBase 登录、研究参与状态、短期令牌与撤回桥接；不能把 UNIX 管理 API 或管理密钥公开给小程序。
3. 完成参与用途说明、选择与撤回界面；接入页面事件。当前已有 SDK，但页面还没有调用它。
4. 实现业务事务 outbox 与行程结束后的简短回访；区分“是、否、未回答”，保留修改和双方冲突的语义。不得从点击或历史状态补造履约标签。
5. 配置私有 COS 异机备份、真实数据保留/清理和恢复前撤回对账，最后逐步启用真实采集。

后续实施代理应先读 `docs/ride-research-data-contract.md`、`services/research-collector/README.md` 和 `utils/researchClient.md`，以当前已部署合同为准。不要复用登录密码作应用密钥，不输出签名令牌，不删除云端历史数据。

## 最终运行状态

2026-09-23 04:31 UTC，最终整机重启后：Docker、collector、HTTPS 和备份 timer 均为 active，collector 健康检查通过，公网 HTTPS 再次返回 HTTP/2 200。磁盘约使用 8.3GB，剩余约 30GB。本机备份合计约 280KiB。

SQLite 3.53.4，完整性检查 `ok`；仅有 3 个已撤回的合成参与者，在线载荷 0、可分析事件 0，真实采集开关 false。密钥目录 0700，密钥与数据库文件 0600。系统无待重启更新。

现有 CloudBase 业务和云端历史数据保持原状；本轮服务器准备不会自动减少原有业务调用次数。
