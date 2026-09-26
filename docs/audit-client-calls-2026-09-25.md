# 小程序客户端调用与迁移审计（2026-09-25）

审计基线为提交 `88a9221`；2026-09-25 重构后，死代码已删除，当前调用文件名已同步更新。历史风险证据的行号指向该基线，不代表问题尚未修复。
## 结论

目前已经替换原 CloudBase 读取的有两类：**首页公开统计**、**自动地点推荐**。新增研究行为、曝光、点击、诊断和是／否回访通过 HTTPS 批量传到服务器；这批事件原来没有等量的云函数调用，不能按事件条数计算节省。

拼车的列表、详情、发布、加入、退出、状态更新、个人资料，以及市场、通知、模板，仍主要使用 CloudBase。当前是业务系统加独立采集服务，并没有把整个小程序后端迁走。

客户端依赖可以收口为少量业务模块，不需要把现有所有变量和兼容分支逐个搬到服务器。优先统一 API 边界和响应结构，然后逐个迁移业务域；不建议一次重写后整体切换。

本报告是静态代码审计，不修改源码、云资源或生产数据。服务器实时计数由主审计报告另列。

## 范围与计数口径

从 `app.json` 的 26 个注册页面、`app.js`、自定义 tabBar 和组件入口，递归跟踪本地字面量 `require`。扫描得到 70 个可达 JavaScript 文件。这里的“可达”表示进入构建和依赖图，不代表该文件每个函数都会被执行。

| 项目 | 静态数量 | 含义 |
| --- | ---: | --- |
| 可达文件中的云函数调用表达式 | 61 | 含 1 个没有调用者的遗留方法 |
| 排除该遗留方法后调用位置 | 60 | 不是每日请求次数；包含异常恢复、兜底和用户操作分支 |
| 明确使用的云函数名称 | 18 | `cloudConfig` 的常量别名归并到 `marketApi` |
| 直接数据库集合操作位置 | 25 | 7 个集合；16 处读取／计数，9 处写入／删除 |
| 云存储上传位置 | 3 | 市场图片、资料补全头像、资料编辑头像 |
| 临时文件 URL 获取位置 | 2 | 市场图片、卖家头像；每处可按批次多次请求 |
| 自有 HTTPS 业务路径 | 3 | `/v1/public-stats`、`/v1/batches`、`/v1/place-suggestions` |

18 个函数：`login`、`getUserInfo`、`getUserInfoByOpenids`、`updateUser`、`getHomeTripList`、`getTripList`、`getTripDetail`、`getMyTripHistory`、`createTrip`、`joinTrip`、`tripManage`、`syncTripStatus`、`syncMyTripStatus`、`rideDemand`、`marketApi`、`referralApi`、`clearUserNotifications`、`statistics`。

排除的旧代码：

- `pages/profile/tripActionReason/tripActionReason.js`、`pages/other/feedback/feedback.js` 未在 `app.json` 注册，也不在依赖图，不纳入当前线上调用位置。
- `utils/driverRecentRoutes.js` 已无可达引用，不把其 `Carpool` 查询算作现行请求。
- `pages/home/carpoolList/carpoolList.js:1145` 的 `fetchListFast` / `fetchListFromCloud` 只有互相引用，没有实际调用者，也没有 WXML 事件绑定。其 `meta.name` 调用位置从有效静态口径中剔除。
- `cloudfunctions/getAddressList` 的存在不表示当前客户端调用它；地址配置现在直接读集合。

可复核命令：先读 `app.json`，再对入口依赖闭包搜索 `cloud.callFunction`、`.collection(`、`cloud.uploadFile`、`cloud.getTempFileURL` 和 `wx.request`。不要用整个仓库搜索结果直接计数，测试、服务端和废弃页面会造成明显高估。

## 当前调用分布

| 功能 | 当前路径 | 迁移情况与证据 |
| --- | --- | --- |
| 首页累计服务次数等公开统计 | HTTPS GET `/v1/public-stats`，失败回 `statistics(action: publicStats)` | 已替换；`utils/publicStatsClient.js:124`、`:147`。`config/publicStats.js` 各环境 100%。首页仍保留原有 24 小时缓存，`pages/home/home.js:3`、`:764`，因此不能按每次打开首页计节省 |
| 自动地点推荐 | HTTPS `/v1/place-suggestions`，本地固定地点和个人最近地点兜底 | 已替换旧 `getTripList(action: places)`；历史 `fd21ce5^:utils/ridePlaceOptions.js` 可验证旧调用。现在 `utils/ridePlaceOptions.js:56`、`utils/placeRecommendations.js:78`、`utils/analyticsClient.js:393`；5 分钟按用户、字段、模式、另一端地点和版本缓存，语义已扩展，不能机械视为一条新 HTTP 等于一条旧云调用 |
| 固定出发／到达地点配置 | 直接查询 `Departure`、`Arrival` | **仍 CloudBase**。`utils/rideAddressConfig.js:28`，一次缓存未命中发两个数据库读取，5 分钟内合并／复用 |
| 研究行为与是／否回访 | 本地持久队列 → HTTPS `/v1/batches` | 新增能力，不是原调用节省。`utils/analyticsClient.js:23`、`:333`，`utils/tripFollowup.js:138`；最多 50 事件／64 KiB 一批，`config/analytics.js:11` |
| 采集授权和 OpenID 关联 | `statistics` 的 `status` / `activate` 等 | **仍 CloudBase**。`utils/analyticsSession.js:127`；每次进入前台重新 status，首次另 activate；会话过期可再次刷新。OpenID 不是认证凭据，迁往自建服务仍要服务端可信登录换取会话 |
| 首页我的行程 | `getHomeTripList` + 按需 `syncMyTripStatus` | **仍 CloudBase**，`pages/home/home.js:830`、`:921`。状态刷新一般间隔 10 分钟，有变化再读取行程 |
| 拼车列表、日历、详情、历史 | `getTripList`、`getTripDetail`、`getMyTripHistory` | **仍 CloudBase**，列表 `pages/home/carpoolList/carpoolList.js:965`，日历 `utils/rideCalendarPicker.js:137`，详情 `utils/tripDetailCache.js:129`，历史 `pages/profile/tripHistory/tripHistory.js:170` |
| 发布、加入、退出、删除、评价、黑名单 | `createTrip`、`joinTrip`、`tripManage` | **仍 CloudBase**，`pages/home/newTrip/newTrip.js:873`、`:970`，`pages/home/tripDetail/tripDetail.js:747`，`utils/tripManage.js:53` |
| 路线状态更新 | `syncTripStatus` / `syncMyTripStatus` | **仍 CloudBase**；列表客户端主动触发 `pages/home/carpoolList/carpoolList.js:736`，并非完全由服务器时钟驱动 |
| 登录和资料 | `login`、`getUserInfo`、`getUserInfoByOpenids`、`updateUser`，少量直接写 `userInfo` | **仍 CloudBase**；登录 `pages/other/login/login.js:85`，资料更新 `utils/userProfileUpdate.js:11`；模板页还绕过云函数写资料 |
| 周模板和常用上下车点 | 直接读写 `CarpoolTemplate`、`userInfo` | **仍 CloudBase**，`pages/home/driverCarpoolTemplate/driverCarpoolTemplate.js:65`、`:399`、`:405`，`pages/home/CarpoolTemplateList/CarpoolTemplateList.js:352` |
| 通知 | 直接查／改 `Notifications` + `clearUserNotifications` | **仍 CloudBase**，`pages/profile/notification/notification.js:60`、`:137`、`:167`、`:203`、`:255` |
| 市场闲置／转租／交易记录／广告 | `marketApi`，卖家资料函数、图片云存储 | **仍 CloudBase**；列表、详情、发布、修改、删除、卖家页、我的列表、广告点击都有调用，不能只迁移拼车就认为全后端完成 |
| 公共配置／城市树／价格表 | `marketApi(publicConfig/communityConfig)`，直接 `CITY_TREE` / `Request_Price` | **仍 CloudBase**，`utils/cloudConfig.js:44`，`utils/Region.js:402`，`pages/home/newTrip/newTrip.js:518` |
| 邀请链路 | `referralApi` | **仍 CloudBase**，`utils/referral.js:51`；获取邀请码、绑定、记录访问。App 和页面生命周期均会捕获 referral |

## 能否直接算出“节省多少调用”

**目前不能从采集数据库的事件总数精确计算。** 也不能仅靠等几天弥补缺失的计数器。

现有诊断有以下边界：

1. `utils/rideDiagnostics.js:5` 只记录 9 个允许名称，其中 `getPublicStats` 已不是当前公开统计兜底函数名；不覆盖 `statistics`、`syncTripStatus`、登录资料、市场、邀请、直接数据库和云存储。
2. `utils/rideDiagnostics.js:87` 每个前台会话最多 100 条成功、20 条去重后的失败，而且必须先取得采集授权。首次授权前的请求和后台返回的请求可能不被记录。
3. `utils/publicStatsClient.js:24` 的 HTTP／CloudBase／fallback 计数只在客户端内存，首页 `_publicStatsReadDiagnostic` 也只是页面属性，未作为批量事件上传。
4. 当前公开读取服务没有可用于逐请求统计的 GET 访问计数。因此不能仅从已存服务端快照反推出有多少客户端读取成功。
5. 云端定时同步是额外成本：每 5 分钟 `statistics` 约 288 次执行／日；原小时触发器 `syncPublicStatsReplica` 还调用一次 `statistics`，24 个小时触发对应约 48 次函数执行／日。名义固定总量约 336 次／日，未含重试、授权桥和数据库操作。**函数执行数不等于套餐“调用次数”计费单位。**
6. 业务事实 `TripActions` 仍先写 CloudBase，再同步到服务器。复制一条业务记录并不代表原始业务调用已经省掉。

建议在下一次小版本中补一个统一传输层，按小时、版本、功能及 transport 汇总计数，复用已有批量上传，不为每次请求另发统计请求。最少区分：

- `cloud_function`：函数名、动作、尝试数、成功数、失败数、延时区间；避免把 function→function 中继误算为客户端请求。
- `cloud_database`：集合和读／计数／写操作次数；不采查询条件、返回正文。
- `cloud_storage`：上传、临时 URL 获取、下载和字节数。
- `server_http`：API 操作、成功／失败、fallback；特别单独计公开统计和地点推荐。
- 本地 `cache_hit`、请求合并、重试次数；从成功用户请求到传输尝试要能对应。

服务器再记录按路由聚合的请求计数、状态、延时，不保存正文和鉴权头。账单仍以 CloudBase 控制台用量明细为准，并将发布前后的活跃用户、前台会话、列表读取、发布／加入次数作为归一化分母。

补齐计数后，24 小时可以看趋势；覆盖工作日及周末的 7 天能做第一版估算；考虑哥大学生按星期出行，14 天比较同星期、相同时段更合理。这是观测建议，不是保证达到某个统计置信度。每段同时报告请求量和活跃人数，低流量不能只报百分比。

## 可先简化的具体问题

### 1. 同一个资料对象有两套访问入口

`getUserInfo` / `updateUser` 与直接 `db.collection('userInfo')` 同时存在。模板常用地点甚至在找不到文档时自行 `.add()`，见 `pages/home/CarpoolTemplateList/CarpoolTemplateList.js:352`—`:371`。后端迁移时若只替换云函数，这些路径仍会读写旧库，导致账户有两份状态。

建议所有账号资料、常用地点、周模板走明确 API。客户端只提交需要修改的字段；由服务器处理当前账号、校验和唯一记录。保留前端显示缓存，但不再让页面知道数据库集合名。

### 2. “恢复加入”连续读两次个人资料

`pages/home/tripDetail/tripDetail.js:259` 的 `resumeJoinAfterLogin()` 读 `getUserInfo` 后调用 `joinCarpool()`，后者在 `:702` 再次读取同一资料，最后才在 `:747` 加入。可传入已经验证的短期结果，或者让加入 API 直接校验服务端资料并返回统一 `PROFILE_REQUIRED` 错误。

这不是建议删除加入交易的服务器校验。应删除客户端重复网络往返，同时保留服务端权威验证。加入成功后必须获取新座位／成员状态，不能把这类刷新当作无用请求删除。

### 3. 首页和“我的”各自统计未读数

`pages/home/home.js:981` 与 `pages/profile/profile.js:307` 对同一个用户做相同 count。两页各有 30 秒资源缓存，但缓存状态不共享。可以做统一通知资源缓存，或随 `/me/bootstrap` 返回未读数；读通知后统一失效。

### 4. 地区树缓存只在失败时使用

`utils/Region.js:417` 即使有有效缓存，仍立即分页读 `CITY_TREE`；缓存仅在 catch 返回。编辑页还主动指定 `{ useCache: false }`，见 `pages/profile/editInfo/editInfo.js:393`。适合改为版本化配置，一份响应覆盖城市树、固定地点和参考价；缓存有效期内不查询，后台按版本更新。

### 5. 登录返回结构和业务错误缺少统一规范

`pages/other/login/login.js:44` 同时兼容 `data[]`、`data{}`、`userInfo`、`user` 和两种 profileCompleted 名称。`getTripList` 等使用 success，另一些使用 ok，失败在 errorMsg、msg 等字段间分散。这些适配分支是变量越来越多的重要来源。

自建 API 应固定 `{ ok, data, error: { code, message }, requestId }`，固定用户、行程、参与记录 DTO；过渡期在一个兼容适配器里转换旧 CloudBase 结果，不在每页增加分支。

### 6. 客户端承担了业务过期推进

列表 `syncTripStatus` 和首页 `syncMyTripStatus` 会引发查询、更新及再次读列表。自建后端可集中处理定时推进和读时派生状态，但必须先明确 expired / closed / cancelled / completed 的差别；出发时间过去不等于真实成交或实际成行。

### 7. 不要把已经存在的有效缓存删掉

公开统计 24 小时缓存、地点 5 分钟缓存、日历共享请求、详情按身份分区缓存、列表失效标记、请求合并等已在解决实际成本／一致性问题。精简应收口到统一资源层，保留必要能力；“变量少”不等于去掉身份隔离、幂等、版本校验和并发保护。

## 对全迁移的客户端约束

建议客户端只依赖 `api.auth`、`api.users`、`api.rides`、`api.templates`、`api.notifications`、`api.market`、`api.config`、`api.analytics`，HTTP / CloudBase 选择只在这层出现。

按配置、公开读取、账号登录、行程读取、行程事务写入、模板与通知、市场及文件、采集授权桥分阶段迁移。需要特别处理：

- `OpenID` 用作数据库关联键，但客户端自报 OpenID 不能作为权限依据。新登录需微信可信交换后签发自有会话；服务端从会话取当前用户。
- 读请求可以明确使用 CloudBase fallback；**写请求不能在超时后盲目再写旧库**。必须使用同一个幂等键、查询提交结果，并保持一个写入主库。
- 旧正式版仍可能继续运行，其直接数据库写入尚未消失。切换写主库前要兼容旧客户端的边界或控制支持版本，不能只靠新版本已发布。
- 市场图片／头像现在是 CloudBase fileID。迁移业务 API 不会自动迁移文件；需保留旧文件解析，或建立到腾讯云 COS 的映射及旧 URL 兼容层。
- 自建后端如果仍逐次调用 CloudBase SDK 读写旧库，可能只省掉部分函数入口开销，不能称为摆脱 CloudBase 调用成本。
- 统计采集必须保留 real / synthetic 隔离、已有事件 ID 和幂等语义；这些是数据可信度和排错所必需，不应随着重写直接删除。
