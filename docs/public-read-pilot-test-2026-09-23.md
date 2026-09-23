# 首页公开统计迁移试验记录（历史）

> 本文记录首次人工快照与 iPhone 验证，不能作为当前部署说明。独立测试工程、原始测试目录和旧 `/trial` 接口已清理。当前迁移配置见 [public-stats-migration-2026-09-23.md](./public-stats-migration-2026-09-23.md)。

2026-09-23 UTC。结论：独立服务器部署、公开数据一致性及微信开发者工具直连已验证；连续十次直接读取均未调用 CloudBase，并发五次读取合并为一次 HTTP。服务故障后自动回退一次 CloudBase、恢复后重新直连以及关闭试点恢复原路径均已实测通过。iPhone 真机验收也已完成（微信调试关闭，当前 Wi-Fi 网络）。尚未切换任何线上流量。

## 范围与实现

选择 `getPublicStats` 的三个公开字段作为首个只读试点：`_id`、`servedTrips`、`coverageText`。源云函数只读 `PublicStats/home`。没有执行预约、座位、支付、用户资料或行程状态写入，没有部署云函数，也没有上传/发布小程序。

新路径为 `https://collect.linkx.ink/trial/v1/public-stats`。Lighthouse 的独立 Node 容器只读人工快照，不持有 CloudBase 凭据，不自动访问数据库。主小程序本地代码仅在 `envVersion=develop` 且 `linkxPublicStatsTrialV1 === true` 时尝试新服务；正式版、体验版和未知版本继续走原接口。试点超时 2.5 秒后最多回退一次，并发请求合并；试点及其回退不读写原首页的 24 小时缓存。

实际运行使用独立工程 `services/public-read-pilot-miniapp/`，同 AppID，但不加载原应用启动或首页逻辑。它只初始化云环境并运行手动只读测试，域名校验保持开启。生产 helper 通过同步脚本逐字节复制到测试工程；它没有加载研究采集 SDK。不要将这个测试工程上传至小程序后台。

## 已取得的证据

| 检查 | 实际结果 |
| --- | --- |
| CloudBase 公开基线 | 2026-09-23 05:24:22.430 UTC 取得：8,451，NY / NJ；耗时 3,037ms |
| 电脑 HTTPS 连续读取 | 10/10 返回 200，三字段均与基线一致；0 次 CloudBase 回源 |
| HTTPS 耗时 | 74–542ms，中位数 76ms；只是本机小样本，不是压力测试或微信真机性能 |
| 查询字符串及 POST | 公网入口均返回 404 |
| 快照临时移出 | 新接口返回 503 + no-store；原采集健康接口仍返回 200 |
| 快照恢复 | 新接口重新返回 200，与原值一致 |
| 微信 HTTPS 健康检查 | 用户完成后台验证后刷新域名清单；urlCheck=true，200，290ms，清理开关成功 |
| 域名生效前的微信回退 | 1 次 HTTP 尝试、1 次 getPublicStats 回退、无重复重试；成功且数据与基线相同，耗时 2,992ms |
| 微信直连连续读取 | 10/10 来自 Lighthouse，HTTP=10、CloudBase=0、回退=0；均与基线相同，81–557ms，中位数84ms |
| 微信并发读取 | 5/5 成功，合并为1次HTTP，CloudBase=0、回退=0；测试后开关已删除 |
| 微信服务故障回退 | 将试点快照临时移出，新接口503；1次HTTP后仅1次CloudBase回退，reason=http_error，数据一致，3,400ms |
| 微信故障恢复 | 快照已恢复；1次HTTP、0次CloudBase，source=lighthouse，684ms，数据一致 |
| 关闭试点对照 | 0次HTTP、1次CloudBase，reason=pilot_disabled，1,319ms，数据一致 |
| 最终清理与原服务 | 所有测试返回cleanup.ok=true、removed=true、flagDisabled=true；没有遗留故障文件，原采集健康接口200，三个服务active |
| 开发者工具项目配置 | 对应“极链行服务”，AppID `wx8a8a389199aa2a0e`；用户完成验证后刷新，request 清单现包含 `https://collect.linkx.ink` |
| 自动化验证 | 服务端 9/9；前端及首页缓存 27/27；相关社区首页、时区、行程生命周期回归 46/46 |
| 线上环境门禁额外检查 | release/trial/未知环境 12 组首页缓存与并发矩阵通过，均 0 次新 HTTP |

历史原始记录已按用户要求于本轮清理；此文仅保留验证摘要。微信直连使用真实 wx.request 和生产同一份适配器，保持域名校验开启，未 mock 网络。随后已通过 iPhone 镜像操作真实 iPhone 完成单网络验收，见下节。Android、蜂窝网络、跨网络测试和生产节省调用量尚未验证。

## iPhone 真机验收（05:58 UTC）

用户明确授权启用 iPhone 镜像并代操作测试。测试工程通过 previewer 的 `auto_preview` 推送开发预览，最后一版包大小 64,702 字节；没有执行 upload、上传体验版或发布。通过 CUA 读取 iPhone 镜像的真实手机界面并点击“真机一键自检”，不是从模拟器采集结果，也没有 mock 设备平台或网络。

手机画面实际显示：

```text
PASS 真机自检通过｜ios｜调试关闭
基线：通过｜HTTPS：通过
连续 10 次：通过，HTTP 10 / 云 0
并发 5 次：通过，HTTP 1 / 云 0
关闭对照：通过，HTTP 0 / 云 1
本地开关：已关闭
```

一键流程先读取当前 CloudBase 公开基线，比较连续/并发结果的数据和真实来源，再关闭试点读取原接口；整轮正常路径有 12 次 HTTPS（含1次健康检查）和2次只读 CloudBase（基线与关闭对照）。测试程序仅在 `platform=ios/android`、`enableDebug=false`、`envVersion=develop`、阶段计数与数据均符合预期、最终开关关闭时报告通过。界面截图保留在本对话的 CUA 工具输出；当时人工转录的结构化证据明确标记为观察记录，后按用户要求与临时测试文件一起清理。

本轮使用一台 iPhone，手机状态栏显示 Wi-Fi。未切换网络、未测试 Android；此前503故障注入及自动回退是在开发者工具完成，不把它改写为真机故障注入。此结果证明当前只读快照链路能在该 iPhone 使用，不能据此声称整个后端或正式用户流量已迁移。

## 服务器状态

新增 `linkx-public-read-pilot.service`；源代码 `/opt/public-read-pilot`，镜像 `linkx-public-read-pilot:20260923`，快照 `/var/lib/linkx-public-read-pilot/snapshot.json`。容器不映射宿主端口，仅由现有 Caddy 精确 GET 路由访问；非 root、只读根目录、128MiB 内存上限，空闲内存观测约 17.2MiB。原 collector 和 Caddy 容器没有被重建，Caddy 配置通过校验后平滑重载。

本次快照保留实际基线取得时间，有效至 **2026-09-23 11:24:22.430 UTC**。到期后服务应返回 503，由开发试点回退 CloudBase。没有定时刷新；不得延长旧数据时间戳冒充最新数据。继续测试时应重新只读取得一次公开基线并生成新快照。

真实研究采集仍关闭：小程序 `config/research.js` 的 enabled=false，服务器 REAL_COLLECTION_ENABLED=false。没有转移真实用户研究数据。
