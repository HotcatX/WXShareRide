# 旧云函数清理审计（2026-09-08）

审计仓库提交：`9c14ab8`。环境：`cloud1-7gmtcu4s3aebce27`，上海区域。北京时间审计已到 2026-09-09，以下调用日期统一采用北京时间。

## 结论与执行状态

**已按用户明确确认，从云端删除全部 25 个已迁移旧函数。当前云端恰好保留 20 个当前函数，均为 Active。** 用户确认新版小程序在 9 月上线，并明确选择“删除全部25个已迁移旧函数，接受旧客户端回流风险”。

云端删除完成时间：2026-09-08T23:57:24.108Z（UTC）。操作记录位于 [2026-09-08-deletion.json](/Users/cat/Documents/CloudFunctionBackups/WXCarGoods/2026-09-08-deletion.json)。随后按用户追加要求，删除本地对应的 25 个旧函数目录，防止整目录重新上传时重建旧函数。本地与云端均保留相同的 20 个当前函数，业务数据库和权限未修改。旧源码可从 Git 历史恢复；恢复云端时应使用实际部署包与配置备份。

删除后检查通过：

- 25 个旧名字全部消失，剩余名单与预定的 20 个保留函数完全一致。
- 20 个保留函数均为 Active。
- cleanupMarketImagesDaily 定时触发器仍启用，cron 未变。
- 通过远程调试执行 4 个只读实际请求：marketApi/publicConfig、getTripList、getHomeTripList、getPublicStats，全部成功。
- 未通过发布、加入、取消或图片清理等写操作测试，以免改动业务数据。

审计依据为当前源码、云端实际部署代码、SCF 配置、完整历史调用指标及用户确认的上线时间。9 月 1–8 日 25 个旧入口均为零；今天部分监控缺失且日志服务不可用，这一限制已在删除前告知用户并获得明确接受。

## 9 月上线后的重新核验

用户确认“9 月上线新版”，未提供具体日。9 月 1–8 日整个区间均为零，因此这一区间内的任意实际上线日之后，已完成自然日的旧函数调用也是零。今天的数据缺口单独保留，不混入完整日统计。

- 25 个旧入口：每个均有 8 个完整日指标点，全部 0 次。
- 20 个当前函数：同期合计 96791 次；例如 createTrip 271 次、joinTrip 153 次、tripManage 175 次、marketApi 10,245 次。
- rideDemand 同期也是 0 次，但当前客户端明确调用它，因此本次保留；这也是不能仅按零调用删除的例子。
- 证据文件：`post-september-release-summary.json`。

## 已删除：4 个市场旧入口

| 函数 | 历史最后非零调用日 | 近 30 个完整日调用次数 | 当前替代入口 |
|---|---|---:|---|
| `createMarketItem` | 2026-06-26 | 0 | `marketApi` create |
| `updateMarketItem` | 2026-06-20 | 0 | `marketApi` update |
| `deleteMarketItem` | 2026-06-20 | 0 | `marketApi` delete |
| `trackMarketFiles` | 2026-06-20 | 0 | `marketApi` 内部文件关联/删除处理 |

历史窗口为 2026-06-01 至 2026-09-08；近 30 个完整日为 2026-08-10 至 2026-09-08。并非只搜索仓库判断：上述旧函数有可查询到的历史正调用，之后归零；同期 `marketApi` 近 30 日累计 15169 次。`cleanupMarketImages` 该窗口每天一次、共 30 次，证明早段监控并非统一截断后补零。

当前客户端在 `pages/market/marketPost/marketPost.js` 使用 `marketApi create/update`，删除入口也改为 `marketApi delete`。云端 `marketApi/index.js` 与本地标准化换行后完全一致，含 create/update/delete 路由及文件关联/删除标记；20 个当前函数的云端业务代码均不引用 25 个候选。

`trackMarketFiles` 的旧“上传但未发布登记”能力没有被单独的新版 action 等价复刻；新版当前流程改为成功发布/更新时登记 attached，删除时登记 deleted。不能为旧客户端仅改函数名直接转发。`cleanupMarketImages` 继续独立运行，不能一并删。

## 已删除：21 个出行旧入口（9 月全部为零）

| 函数 | 调用次数 | 最后非零调用日 |
|---|---:|---|
| `addCarpoolDetail` | 5 | 2026-08-26 |
| `addCarpoolList` | 8 | 2026-08-26 |
| `addCarpoolRequest` | 1 | 2026-08-25 |
| `editMyRequestDetailCreate` | 1 | 2026-08-26 |
| `editMyTripDetailDriver` | 6 | 2026-08-26 |
| `editMyTripDetailPassenger` | 2 | 2026-08-27 |
| `getCarpoolDetail` | 218 | 2026-08-27 |
| `getCarpoolList` | 371 | 2026-08-27 |
| `getCarpoolRequestDetail` | 27 | 2026-08-26 |
| `getCarpoolRequestList` | 371 | 2026-08-27 |
| `getDriverHomeTripList` | 609 | 2026-08-28 |
| `getPassengerHomeTripList` | 608 | 2026-08-27 |
| `updateCarpoolRequestStatus` | 375 | 2026-08-27 |
| `updateCarpoolStatus` | 386 | 2026-08-27 |
| `updateMyTripStatusDriver` | 614 | 2026-08-28 |
| `updateMyTripStatusPassenger` | 614 | 2026-08-27 |
| `updateUserCreateTrip` | 8 | 2026-08-26 |
| `updateUserJoinTrip` | 5 | 2026-08-26 |

这些是调用次数指标，不能单凭指标确定来自正式版、体验版、开发工具还是其他 SDK 调用。最晚调用在 2026-08-28，早于用户确认的 9 月新版上线月份。9 月 1–8 日上述函数全部为零，说明目前观察到的调用已切换到新入口；21 个出行旧入口的完整零调用观察期仍短于市场旧入口，删除后回流的旧客户端可能失败。

另有 3 个出行旧入口整个近 30 日都为零：`acceptCarpoolRequest`、`editMyRequestDetailDriver`、`joinCarpoolRequest`。它们同属旧出行业务；9 月所有相关旧入口均为零。低频操作本身零调用仍不能单独证明所有旧使用方已退出。

四个旧状态函数存在真实调用链：`updateMyTripStatusDriver`、`updateMyTripStatusPassenger` 都会调用 `updateCarpoolStatus` 和 `updateCarpoolRequestStatus`，不能只删被依赖的两个函数。

## 必须保留：20 个当前函数

- `cleanupMarketImages`
- `clearUserNotifications`
- `createTrip`
- `getAddressList`
- `getHomeTripList`
- `getMyTripHistory`
- `getPublicStats`
- `getTripDetail`
- `getTripList`
- `getUserInfo`
- `getUserInfoByOpenids`
- `joinTrip`
- `login`
- `marketApi`
- `referralApi`
- `rideDemand`
- `syncMyTripStatus`
- `syncTripStatus`
- `tripManage`
- `updateUser`

`cleanupMarketImages` 云端有启用的 `cleanupMarketImagesDaily` 定时触发器，cron 为 `0 0 4 * * * *`。其余 44 个函数的 SCF 配置没有触发器。`cloudbaserc.json` 只列 14 个函数；其中缺少但仍在用的 `login`、`getUserInfo`、`updateUser`、`getAddressList`、`getPublicStats`、`clearUserNotifications` 不能因此删除。

## 验证边界

- 当前源码和 45 个云端实际部署包均已检查；动态函数名、封装调用、后端调用都纳入检查。20 个保留函数对 25 个旧候选没有依赖。
- SCF 函数配置已逐个读取并备份。旧 HTTP 网关返回 EnableService=false、Total=0；新版 HTTP 路由接口未由当前 DevTools 桥接独立核验，因此不声称排除了所有潜在外部调用方。
- 今日（北京时间 9 月 9 日）旧候选未出现正调用点，但尾段缺少数据点。按小时补查旧市场函数也得到空点数组；缺失数据点不按零处理。
- 旧 GetFunctionLogs 对活跃的 `marketApi` 也返回空列表，不可作为无调用证据。新版 SearchClsLog 对在用函数和 4 候选查询均返回 `ResourceNotFound.TopicNotExist`。这里主要依据真实历史调用指标，而非空日志。
- 通过远程调试执行了一次只读 `marketApi publicConfig`，成功返回 cityTree、regionTree。未为验证创建、修改或删除业务数据，未调用清理函数。
- 模拟器普通用户的 MarketFiles 查询被数据库规则拒绝；未修改权限。没有把这次拒绝当作整个管理账户没有数据库权限。

## 备份和恢复材料

完整备份目录：[2026-09-08](/Users/cat/Documents/CloudFunctionBackups/WXCarGoods/2026-09-08)，已放在小程序项目之外，避免被项目打包上传。另有 [删除前完整归档](/Users/cat/Documents/CloudFunctionBackups/WXCarGoods/2026-09-08.tar.gz)（192,716,885 字节），已验证可读取，SHA-256 记录在同名 .sha256 文件。归档包含删除前状态；本报告和独立 deletion/postcheck 文件记录最终状态。

- `cloud-code/<函数名>/`：45 个实际部署包（含依赖），共 96553 个文件，逐文件 SHA-256 见 `cloud-code-backup-manifest.json`。
- `cloud-config/<函数名>.json`：原始云端运行时配置，包括内存、超时、角色、网络及触发器等。
- `cloud-code-comparison.json`：云端与仓库的逐函数对比；26 个 index.js 字节相同、marketApi 仅换行不同、18 个有文本差异。
- `monitor-invocations.json`、`monitor-market-history.json` 及 current-day 文件：可复核的调用指标和缺点说明。
- `reports/`：独立静态调用图、出行/市场迁移、云端依赖、运行时及 HTTP 网关审计。

完整部署包已在搬迁后逐文件重新计算 SHA-256，校验结果见 `backup-verification.json`。

4 个市场候选的原配置一致：Nodejs16.13、index.main、256 MB、3 秒、TCB_QcsRole；无环境变量、无层、无 VPC 绑定、无触发器。恢复时以对应原始云端包和配置为准，不能用仓库文件代替。删除后重建函数不能恢复原调用历史或所有平台身份，因此备份不等于平台一键撤销。

## 官方接口参考

调用监控含义见 [CloudBase 云函数监控](https://docs.cloudbase.net/cloud-function/debugging/monitor)；[GetFunctionLogs](https://cloud.tencent.com/document/api/583/18583) 的查询时间跨度受限；本次新版日志接口依据 [SearchClsLog](https://cloud.tencent.com/document/api/876/128127)。具体账户结果以本地保存的审计证据为准。
