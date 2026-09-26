# 后端模型与重写审计（2026-09-25）

本报告仅审计仓库源码，没有修改业务代码、调用线上写接口或查询云端私有数据。风险项说明代码允许出现的情况，不表示已证实线上发生。账单、正式流量和云端唯一索引需要另行核实。

结论：可以重写为一个模块化 Node.js 后端和一个 PostgreSQL 业务库。现有复杂度主要来自两套行程结构、用户反向数组、历史字段兼容、独立云函数之间复制代码，以及 CloudBase 与采集服务器的跨系统同步。业务本身不需要微服务、消息队列集群或通用工作流引擎。现有独立采集服务应先保持运行，业务迁移稳定后再决定是否合并。

## 实际范围和规模

- 22 个云函数入口；排除依赖目录后共 55 个 JS 文件、9,702 行。
- 采集服务 `src` 下 13 个 JS/MJS/CJS 文件、1,395 行，现有 SQLite 初始化包含 19 张表。
- 公共统计只读服务 4 个源文件、261 行。
- `marketApi/index.js` 1,610 行，`tripManage/index.js` 905 行，`getTripList/index.js` 611 行。
- 仅完全相同的文件副本就有 778 行额外重复：5 份 `businessLedger.js`、5 份 `placeCatalog.js`、2 份 `rideCompletion.js`、2 份 `requestState.js` 等。复制是独立云函数部署的技术适配，未必是作者无意义加功能，但会增加每次修复的部署面。

产品范围除了拼车，还有求车、二手、转租、图片生命周期、站内通知、评分、拉黑、邀请归因、广告、网页管理后台及公开网页预览。重写不能只实现“发布/加入/退出”就替换整个后端。教培业务不在本仓库的已核验领域范围内，应独立确定需求，不能把用户身份和权限自动合并。

## 优先级发现

### P1：个人行程同步可能覆盖并发加入/发布结果

证据：`cloudfunctions/syncMyTripStatus/index.js:314` 读取用户的 8 个数组，`:343` 起在内存分类，`:377` 最后整组覆盖 `tripDriver`、`tripDriverJoin`、`tripPassenger`、`tripPassengerCreate` 及 4 个 History 数组。最终更新没有事务重读或乐观版本条件。与此同时，`cloudfunctions/joinTrip/index.js:135` 和 `cloudfunctions/createTrip/index.js:171` 使用 `addToSet` 写入当前行程。

一个可发生的顺序是：同步读到旧数组 → 新加入事务提交 → 同步写回旧数组。行程的乘客关系仍存在，但“我的行程”的反向索引会丢失新项。这是反向关系存储带来的具体一致性风险。

建议：近期修复为事务重读并仅移动确定过期的 ID，避免覆盖新关系。重写直接查询 `ride_members` 和 `rides`；当前/历史只是带时间和状态条件的查询，不再搬动 8 组数组。

### P1：发布缺少请求幂等键，不能把写请求超时直接 fallback 到旧后端

证据：`cloudfunctions/createTrip/index.js:257`、`:297` 都以 `add` 产生新 ID，入口 `:308` 没有处理 `clientRequestId`。业务日志的幂等键使用新行程 ID 和版本生成（`cloudfunctions/createTrip/businessLedger.js:63`），只能去重同一个已创建行程的日志，不能去重两次发布。

若服务器已完成写入但响应丢失，客户端重试或切回 CloudBase 会产生第二条行程。迁移若让新旧两套数据库都接受同一行程的加入，还可能分别扣同一个座位。

建议：所有写操作都带稳定 `requestId`，后端以“用户 + 操作 + requestId”唯一约束存储请求哈希和结果；超时后查询同一请求结果或重试同一入口。每个业务领域同一时刻只能有一个写入主库。读请求可以降级，写请求不能按网络失败在两个独立主库之间切换。

### P1：评分写入和累计值不是同一事务，并发可重复或丢失增量

证据：`cloudfunctions/tripManage/index.js:826` 先查询是否评过，`:836` 再随机 ID 新增评分，`:852` 单独更新累计。`updateRatingSummary` 在 `:755` 读取旧汇总后，于 `:767` 写绝对值。

同一评分并发请求可能同时通过“未评过”判断（实际是否被云端唯一索引阻止需要核验）；不同乘客同时给同一司机评分，即使评分唯一约束存在，累计值仍可能覆盖。评分插入成功、汇总更新失败还会造成部分成功，重试却返回已评分。

建议：评分表唯一键 `(ride_id, rater_id, target_id)`，校验参与关系、写评分、更新汇总同一事务；现阶段数据量可直接从评分表汇总，不必持久化所有 avg/weightedAvg 派生字段。

### P2：同一个概念被多种结构表示，兼容分支已进入每条主路径

证据：

- `Carpool._openid` 表示司机，而 `CarpoolRequest._openid` 表示发起乘客，司机改放 `driverOpenid`（`cloudfunctions/joinTrip/index.js:95`）。
- 乘客有对象数组 `passengers`、字符串数组 `passengerID`，旧数据还要兼容字符串形式的 `passengers`（`cloudfunctions/tripManage/index.js:79`）。
- `passengerCount` 在 Carpool 表示总可用座位，在 CarpoolRequest 表示求车人数；`availSeatNum` 又保存可推导的剩余量（`cloudfunctions/createTrip/index.js:230`、`:268`）。
- 用户 `role` 在发布司机行程时写为 driver（`createTrip/index.js:172`），加入时写为 passenger（`joinTrip/index.js:137`）。它只能表达最近操作模式，无法表达一个人同时是若干行程的司机和其他行程的乘客。
- `getMyTripHistory/index.js:63` 使用 4 组历史索引，乘客 ID 还要分别查询 Carpool 与 CarpoolRequest（`:87`）。
- 资料兼容 `name/nickName/nickname`、`wechatID/wechatId/wechat`、`carNumber/carPlate/plateNumber`（`getTripDetail/index.js:19`）。时间同时使用 `createdTime/createTime/createdAt` 和 Date/ms/text。

建议：统一内部模型和命名，旧字段只放在一次性迁移器和旧 API 响应适配器中；不要让新的领域代码继续接受所有别名。用户保留可选“默认操作模式”，每次行程的角色只存在成员关系上。

### P2：用户资料创建入口分散，身份唯一性不能只靠 query limit(1)

证据：`login/index.js:23` 查询后新增随机 ID；`updateUser/index.js:97`、`referralApi/index.js:68`、`createTrip/index.js:137`、`joinTrip/index.js:107`、`tripManage/index.js:143` 都有另一个创建或补齐入口。`rideCompletion.js:156` 甚至需要专门识别同一 OpenID 找到多个用户资料的情况。

这是代码层面的竞争窗口，是否已有线上重复要查询才能确定。建议一个身份服务承担 get-or-create；库层唯一约束保证身份唯一。当前单个小程序仍以经服务器验证的 OpenID 关联所有数据；若将来两个不同 AppID 的服务共库，唯一键应包含 AppID，不能假定不同小程序 OpenID 可以直接互认。

### P2：完成统计包含较多为反向数组和旧数据补偿的状态

证据：`syncTripStatus/index.js:218` 以出发时间经过判定 `past`，并维护 `servedStatsCounted/Delta/Source/CountedAt`；`rideCompletion.js:106` 维护用户私有 `_rideCompletionV1.driverKeys/passengerKeys`，与总计数互相校验，列表最多 10,000 项。两个同步函数各复制 229 行完成计数逻辑。

建议：“计划已过期”与“用户确认成行”明确分开，不能把 `past` 自动当作真实完成。未来库内采用唯一完成事实 `(ride_id,user_id)` 或成员终态配合查询汇总；前台人次计数作为可重算的投影。“是/否”回访保留回答来源、事件时间和未回答状态，牌面价保留为 `listed_price`，不能命名为实际成交价。

### P2：通知在业务事务外直接写入，失败后无法可靠补发

证据：`joinTrip/index.js:220` 业务事务完成，`:232` 再写通知；`tripManage/index.js:103` 写通知失败只记录日志并返回 false。当前实现能保持业务成功，但通知失败没有持久化重试任务。

建议：在业务事务里同时写 notification/outbox，由同一应用的后台任务送达。现有站内通知不必引入 Kafka 或外部消息队列；一张带重试时间和唯一键的任务表足够。不要因想减少变量而删除事务、幂等和失败重试。

### P2：市场接口把多种真实职责放在一个文件，迁移时要分模块而非删掉功能

证据：`marketApi/index.js:9` 含商品、图片、广告、浏览统计等集合；`:973` 发布、`:1043` 编辑、`:1140` 删除、`:1564` 又路由小程序、公开网页和网页管理端。二手和转租共享核心字段，但 `:918` 起存在转租专属属性。`imageFileID/imageFileIDs/thumbFileID/thumbFileIDs/hasImage` 同时保存，`pickupStartDate/availableStartDate` 等混合可展示字段与事实字段（`:944`）。

建议：模块拆为 listings、media、admin/content，统一 listing 核心和独立 sublet 详情；图片是有顺序的附件记录，首图由顺序推导；显示文本由 API 格式化，业务库只存一个真实时间。保留管理员代发、批量导入、图片归属和审核日志，不能与普通用户权限混在一起。

### P2：采集链路可靠性设计必要，但“桥接”复杂度可以在统一后端后减少

证据：`statistics/handler.js:16` 统一了采集授权、公共统计、timer/relay 多个职责；`businessOutbox.js:2` 每次最多 10 条，`placesSync.js:45` 每个 5 分钟 tick 只处理一批，理想排空上限是 120 条/小时、2,880 条/天，实际还受大小、失败、延迟影响。无效首条会抛错阻断后续批次。当前没有证据说明流量已经达到这个限制。

采集库用 participant/grant/operation/batch/event receipts 保证身份可信、撤销有效、批次和事件去重，place history 和 rank snapshot 保证研究可复现（`store.mjs:43`、`places.mjs:67`）。这些不是都可以删除的“杂变量”。但业务统一到新后端后，可复用登录会话与用户外键，不再每次经 CloudBase 授权桥，也不再跨云搬运每条业务事件。分析派生表可随时重算，主事实和去重键需保留。

建议近期给 outbox 增加积压量/最老待同步时间监控、有限排空循环和失败记录隔离方案；本次审计不改线上策略。迁移后继续保留事件版本、请求 ID、真实/测试隔离、服务端 OpenID 关联、保留期、备份与恢复校验。旧 grant/receipt 数据不要直接删除。

## 推荐的最小业务模型

采用一个 Node.js 应用，按模块组织。PostgreSQL 适合这次重写的关系和事务需求，不代表现有 SQLite 采集库当前不够用；2GB 机器上同时运行旧服务与新库需要先测内存、连接数与峰值延迟，不能仅凭规格承诺承载量。先单实例应用和数据库、限制连接池，不先加 Redis。

| 模块 | 最小事实表 | 核心规则 |
| --- | --- | --- |
| 身份/资料 | users、sessions | OpenID 服务器验证；库层唯一；公共资料/私人联系方式使用不同响应投影；司机资料可先作为明确字段，没必要通用 EAV |
| 拼车/求车 | rides、ride_stops、ride_members | ride.kind=offer/request；creator 和 driver 含义明确；seat_capacity 与 member.seat_count 分开；成员唯一且座位扣减同事务；当前/历史用查询 |
| 反馈/社交 | ride_feedback、ratings、user_blocks | 是/否/未答各有含义；评分和拉黑关系唯一；角色来自 ride_members |
| 地点 | places、place_aliases | 固定地点与用户候选地点共用一个 ID 体系；展示标签可变，统计 ID 稳定 |
| 二手/转租 | listings、sublet_details、media_assets、listing_media | 状态显式；金额整数 cents；附图按位置排序；文件删除异步重试 |
| 通知/内容 | notifications、content_config | 收件人索引；用户只读改自己的通知；广告/社区配置保持小型明确 schema |
| 归因 | referral_codes、referral_bindings | 若现有功能继续使用则保留；访问事件可走统一采集，统计从事实汇总 |
| 可靠性 | idempotency_requests、outbox_jobs | 统一幂等入口；写成功和 outbox 原子提交；可靠重试 |
| 管理 | admin_accounts、admin_sessions、audit_events | 与普通用户权限隔离；先保留现有可用管理端行为 |
| 行为采集 | events、event_batches（初期继续现有采集库） | 事件 ID 唯一；带 actor、ride、页面、构建版本、时间；明细与可重算聚合分开 |

这不是要求第一版创建所有表，而是把真实职责列清楚。可以合并低频配置表，也可以将稀疏非查询属性放入有固定 schema 的 JSONB；不要为了“只有几张表”把全部业务放入无约束 JSON。

行程基本状态可用 `open/cancelled/expired`，是否满员由容量与有效成员计算；`confirmed_outcome` 单独来自回访。司机是否已接求车单由有效 driver 成员/driver_id 表达。是否允许 `closed`、管理员关闭和人为完成等更多状态，应以当前产品规则决定，不能随重写自行改变。

统一字段规则：`id`、`user_id`、`created_at/updated_at`、UTC 时间戳和明确业务时区、金额整数 cents。用于展示的 `firstDepartureDate/Time`、`pickupRangeText`、各种 avg、`hasImage` 不作为多份独立真相保存。每周模板保留 weekday + local_time + timezone，实例化后才生成绝对出发时间，保证纽约夏令时与下周同一上课时间语义。

## CloudBase 迁出的依赖和顺序

1. **先建立 API 边界**：前端所有业务访问经一个 SDK/适配层；当前除了云函数，还有直接数据库读写。地址 `utils/rideAddressConfig.js:27`、区域 `utils/Region.js:396`、通知 `pages/profile/notification/notification.js:57` 都要迁移。未注册旧页面的直接调用须先核实是否仍被正式包引用，不能只搜索字符串就认定有真实流量。
2. **先搬读请求**：列表、详情、地址、公共配置、个人资料读取等。复制数据并做返回值与权限投影对比。读副本允许短时滞后时才能 fallback，加入按钮最终必须由写主重新确认容量。
3. **建立独立登录**：现有登录使用 `cloud.getWXContext().OPENID`（`login/index.js:15`）。独立服务必须实现微信登录凭据兑换和自己的会话，不能接受客户端声称的 OpenID。AppSecret 留服务器；保留旧版身份桥作为迁移期适配。
4. **迁移整个拼车写域**：发布、加入、退出、踢人、取消、状态处理、评分和相应个人关系一起迁移；不要按单个用户随机分到两个写主。验证历史数据、唯一键、座位数、成员关系，短暂锁写完成最终增量，再切主。旧云函数改为带可信身份转发到新服务，使尚未升级的旧客户端仍落到同一主库。
5. **迁移市场/文件**：业务写迁移与拼车分开排期；先保留 cloud:// 文件兼容，后续把图片迁到腾讯云 COS 或等效对象存储。`marketPost.js:233` 的上传、`marketApi/index.js:790` 的临时 URL、`cleanupMarketImages` 的清理都要覆盖。迁移文件应先复制、校验、切 URL，再清理旧副本。
6. **迁移派生统计、归因和管理端**：业务已同库后可移除部分跨系统复制；所有消费者确认后再停旧 timer/桥接/函数。外部微信平台登录请求仍存在，“去 CloudBase 调用”不等于“没有任何微信接口”。

在完成旧客户端适配或确认其退出前，保留少量云函数转发会继续产生 CloudBase 调用。这是兼容成本，应统计真实版本占比再决定退役时间，而非迁库当天直接删除。

当前仓库未搜到 `requestPayment/cloudPay/unifiedOrder` 等支付执行接口；已实现的是 Zelle 账号展示/复制（如 `pages/profile/myTripDetailPassenger/myTripDetailPassenger.js:417`），不能把它当作已验证线上支付/成交系统。通知目前是 Notifications 站内表，没有发现可等同于已实现微信订阅消息发送的调用。后续若加支付或订阅通知，要作为新功能另行设计，不能假定迁出时自动获得。

## 重写验收门槛

- 同一请求重复提交、响应丢失重试不会重复创建；并发抢最后一座只能一个成功。
- 发布/加入与“我的行程”查询一致，不再依赖客户端/定时器搬数组修补。
- 求车多人数、司机接单、司机退出、取消、评分、拉黑完整保留；旧 API 请求经过适配仍满足同一规则。
- 纽约夏令时、每周模板、历史过期和真实成行分别验证。
- 业务成功必有对应版本事件；研究事件、曝光/点击、回访仍可通过 OpenID 关联，牌面价不冒充实际交易额。
- 管理端、游客公开预览、登录用户私人资料三套投影权限相互独立。
- 新旧数量与关键事实对账，备份恢复演练通过；切回只能基于同一个权威写入状态，不能回滚到有时间差的旧主库继续写。

本报告是重写前的范围、模型和风险审计，未批准或执行生产数据库迁移，也未停用任何线上服务。
