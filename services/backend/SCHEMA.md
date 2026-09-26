# 业务数据库与迁移边界

本文件描述 `migrations/001` 至 `006` 的字段契约。它是维护文档；本轮阶段、权限与发布决策仍以根目录临时 `BACKEND_MIGRATION_WORK.md` 为准。已有账号、核心行程、模板、拉黑与通知；这不代表评分、市场及旧数据已经全部迁出，也不代表所有本地迁移文件已部署。

## 唯一模型

数据库使用 snake_case；TypeScript/API 使用 camelCase。同一概念仅保留一个事实字段；旧别名只在一次性迁移器和临时兼容适配器出现。

| 表 | 主键和核心字段 | 规则 |
| --- | --- | --- |
| `users` | UUID `id`，`app_id`，`openid`，`name`，`avatar_url`，`profile`，创建/更新时间 | `(app_id,openid)` 唯一。OpenID 只由可信微信登录/服务端迁移确定；不能作为客户端认证凭据。 |
| `sessions` | `token_hash`，`user_id`，`expires_at`，`last_seen_at` | 只持久化 token 的 SHA-256，不保存原 token。过期由认证层校验；用户删除级联删除会话。 |
| `rides` | 旧行程原 ID `id`，`kind`，`creator_id`，`city_key`，`status`，`seat_capacity`，`departure_at`，`time_zone`，`listed_price_cents`，`details`，`version`，创建/更新时间 | `kind=offer/request`；`status=open/cancelled/closed`。数据库保留旧 ID，跨旧集合 ID 冲突须先解决。 |
| `ride_members` | `(ride_id,user_id)`，`role`，`seat_count`，`state`，`joined_at`，`left_at`，`details` | 每行程最多一位 active driver。司机占客座数 0，乘客 1–8；同账号同行人数用 seat_count 表示。 |
| `ride_stops` | `(ride_id,position)`，`kind`，`address`，`place_id`，`departure_at` | position 为整个行程内从 0 起的唯一顺序。出发站有时间；到达站当前可无时间。保留每一个出发和到达站，不裁成首尾。 |
| `idempotency_requests` | `(user_id,operation,request_key)`，`payload_hash`，`response_status`，`response_body`，`created_at` | 同请求编号不同内容必须冲突。业务结果与幂等结果在同一事务提交；写超时不能改写独立旧库。 |
| `business_events` | `id`，`ride_id`，`ride_version`，`action`，`actor_id`，`payload`，`created_at` | `(ride_id,ride_version)` 唯一。每次已提交业务变化记录一个事实事件，同事务写入。不是点击/曝光明细。 |
| `ride_templates`（002） | UUID `id`，`user_id`，`name`，`weekday`，`local_time`，`time_zone`，`definition`，创建/更新时间 | 本人私有的每周司机模板，weekday=0周日…6周六，HH:mm，纽约时区。绝对时间不存于模板。 |
| `user_blocks`（003） | `(blocker_id,target_id)`，`active`，`reason`，`blocked_at`，`updated_at` | 每方向一个事实；重新启用复用原行。双向任意有效记录阻止新加入，不移除已有参与关系。 |
| `migration_batches` / `migration_sources`（006） | 批次UUID/AppID/来源hash；每批次 `(collection,source_id)` 和完整序列化JSON/hash | 私有迁移证据，不提供客户端API，不参与业务权限判断。 |
| `notifications`（004） | 旧ID兼容 `id`，`user_id`，`event_id`，`ride_id`，`type`，`title`，`content`，`read`，`created_at` | 仅收件人可读/改/删；`event_id,user_id` 唯一。旧通知无事件ID可为null；read保留布尔，不伪造旧阅读时刻。 |

006 允许旧资料的 updated_at 和成员 joined_at 为 null，表示未知；仅 closed 行程可缺城市或可信容量。新建/加入仍由服务端写真实时间，open/cancelled 必须有城市和容量。来源归档保留全量原字段，单条 SHA-256 由数据库与所存 JSON 文本核对；hash 对应序列化后的 JSON，不冒充原导出文件字节hash。

005 为 rides 增加唯一 `listed_price_label`（API `listedPriceLabel`）原始报价文本。它与金额的职责不同，不建立 `referencePrice/displayPrice/price` 等兼容别名。通知 ride_id 是可失效导航目标而非外键，因为旧版取消会物理删除行程；这不能成为复活被删除行程的依据。

`schema_migrations(version,checksum,applied_at)` 仅用于管理 SQL 版本，不是业务表。没有创建占位业务模块、重复用户当前/历史行程数组或单独的“满员”状态字段。

## 容量、时间和成行

- `offer` 容量来自司机提供的客座数，当前范围 1–8；`request` 当前业务上限为 4。求车发起人的同行人数保存在其 passenger 成员的 `seat_count`，不能当容量。
- 剩余座位等于容量减 active passenger 的 seat_count 总和；历史容量未知时返回null，不补0、不推算新容量。关系跨行求和不能由单行 CHECK 保证，业务写必须锁定行程行并在事务内校验。
- `open` 仍需结合出发时间、座位和司机接单状态判断可操作性。旧 `full` 归入 open，是否满员从成员计算；旧 `past` 归入 closed。closed 只表示业务生命周期已关闭，**不表示用户确认实际成行**。
- `departure_at` 是最早出发站的绝对 UTC 时刻，`time_zone` 当前固定 `America/New_York`；其他出发时间保留在 stops。周模板不在此表，把下周同一星期/本地钟点实例化后才生成 UTC。
- `listed_price_cents` 是可确认的牌面 USD 金额，空值代表未明确数值。新建API采用现有每人报价约定；历史原文没有标明单位时不能自动当人均价。`listed_price_label` 原样保留原报价文字及条件，复杂/多金额文案保留文本和null金额，不抽取首数字。它们不是已支付或实际成交金额。
- 回访“是/否/未答”、评分是独立事实，不将这些事实塞进 `closed` 状态或任意 JSON。通知、拉黑已使用各自关系表。

## JSON 的受控用途

所有 JSONB 列数据库 CHECK 要求 object。具体字段和类型在服务边界验证，未知字段不能无声加入。

`users.profile` 的 canonical 键与 `src/users/routes.ts` 一致：

- `phone`、`phoneRegion`、`wechatId`、`bio`；
- `vehicle: {plate,brand,model}`；`zelle: {name,account,public}`；
- `region: {state,county,area,key,label}`；`location: {label,address,latitude,longitude}`；
- `preferences: {pickupAddresses,dropoffAddresses,comments}`；`profileCompleted`。

这些字段都可缺省。电话、微信联系号、住址、车辆和收款资料不能随着 users 行直接公开。用户是司机还是乘客来自每条 ride_members，不由用户资料里的全局 role 判断。

`rides.details` 只收 `note`、供车boolean `zelleDisplay`、求车integer `largeLuggageCount`。旧 comment 转唯一 note；旧 yes/no 转boolean，其他值拒绝。新供车从本人profile.zelle.public记录本次显示选择；求车保留旧的已加入成员可看司机收款资料规则。车辆和收款账号始终读司机当前profile，不在行程和模板重复保存。

`ride_members.details` 只收供车乘客本次 `pickupAddress` / `dropoffAddress`，加入时要求两项非空、各最多60字符；求车拒绝这两项。姓名、头像、联系方式不由客户端注入成员记录，旧副本仅在来源归档保留。相同角色/席位/接送说明重复加入是no-op；已有关系变更返回409，退出再加入会替换旧说明。接送说明不进入公共投影或事件/通知。

`business_events.payload` 是带版本业务事件的必要快照，由服务端构造；`idempotency_requests.response_body` 是已完成操作的响应。它们都不是第二个可编辑业务主库。

## Schema 应用

`src/migration/apply.ts` 导出：

```ts
await runMigrations(pool, migrationsDirectory?); // 返回本次实际应用的文件名
```

runner 使用单个连接、数据库 advisory lock、每文件事务。每个已应用文件记录 SHA-256；缺失或变更已应用 SQL 时拒绝继续。新增变更应新增 SQL 文件。文件失败会回滚该文件 DDL；不会自动执行破坏性 down migration。

## 完整 CloudBase 导出审计

`src/migration/normalize.ts` 是纯函数，不连接 CloudBase/PostgreSQL，不写文件、不导入线上。输入格式：

```json
{
  "kind": "cloudbase-full-export",
  "appId": "已确认的小程序 AppID",
  "collections": {
    "userInfo": [],
    "Carpool": [],
    "CarpoolRequest": []
  }
}
```

必须使用完整、未裁剪业务文档。该 kind 是调用方明确的来源声明，**不是导出完整性证明**：生产迁移前仍须按云端集合数量、分页、最终增量和附件另行对账。现有 analytics/地点同步快照缺少资料、成员、模板等事实，不能改个 kind 冒充完整导出。额外非空集合在当前切片中报告 UNMAPPED_COLLECTION，不会被丢弃后宣称全部迁移成功。

```ts
const { plan, report } = normalizeCloudBaseExport(source, {
  timeZone: 'America/New_York'
});
```

- `report` 只有受控集合分类、问题码、已知字段名、计数；不含 ID、OpenID、地址、联系方式、原始值，未知字段/集合名称也不会直接输出。
- `plan` 包含账号、完整受控行程资料、sourceSha256和所有原文sources，仅供可信进程内部使用。来源须有非重复_id、无损JSON；原文归档不意味着未知业务字段已完成映射。任何 error 都使 `plan=null`；不能拿部分有效候选做生产导入。`candidateCounts` 仅表示审计过程中识别到的数量。
- 账号使用 `(appId,openid)` 确定性 UUID，保持重跑一致；这只是迁移 ID 映射，不提供登录能力。
- 同 OpenID 多资料、旧别名冲突、未知用户/字段/集合、账号异常状态、open行程未知城市或座位对不上、缺失必需地址/时间、ID 冲突、测试数据混入都会阻断。
- 用户的 8 组旧行程数组只做关系对账；它们不再导入第二套索引。孤立或角色不符引用先报告问题，不能直接删除。
- 时间只接受明确 UTC/offset、毫秒和 CloudBase `$date`。纽约春季缺失小时及秋季重复小时需要明确解决；不会选择一个看似合理的时刻。缓存 UTC 与本地时间冲突也会阻断。
- 价格统一由 `legacy-price.ts` 按完整字符串识别已核验USD格式，使用整数分转换；明确免费才为0。无报价和复杂文案都保留原始label、金额为null。复杂文本在报告中记 `PRICE_TEXT_PRESERVED` 提示而不阻断保真导入；不可保真的非标量/无效数字仍阻断。金额单位未被原文确认时，不能仅凭解析成功用于人均价分析。
- 旧求车成员列表及接单司机没有独立加入时间，保留joinedAt=null并记提示；显式无效时间仍阻断。独立旧资料写路径的更新时间取有效记录中最大值，仅指最后已记录写入，不用于决定哪个资料字段正确；全部缺失保留null。
- 仅已closed历史行程可将缺失城市、冲突容量置null；原C/A/N完整留来源，不删成员、不声称实际超卖或成行。非空未知城市、open行程冲突、用户/关系未映射仍阻断。

命令行只输出 report；成功退出码 0，有待处理问题 1，读文件/JSON 错误 2：

```sh
node src/migration/analyze.ts /absolute/path/full-export.json
```

当前没有生产数据写入/切主命令。`report.ready=true` 仅表示本切片结构审计通过，不表示整个产品迁移、权限投影、旧客户端兼容、备份恢复或最终增量验证已完成。

## 已验证

`test/migration-normalize.test.ts` 覆盖身份冲突、资料映射、PII 不泄漏、源类型、时间/DST、报价、成员/容量、索引对账和只读 CLI。`test/migration-schema.test.ts` 使用真实临时 PostgreSQL schema，覆盖重复/并发应用、文件校验、DDL 失败回滚、唯一约束、JSON CHECK、司机/座位/状态约束及外键。

```sh
BACKEND_TEST_DATABASE_URL=postgresql://... node --test test/migration*.test.ts
```

测试只使用隔离 schema 和合成记录；测试结束销毁自己的 schema，不读取或清理生产数据。

## 每周出行模板（002）

`src/templates/routes.ts` 导出 `registerTemplateRoutes(app,{pool,requireUser})`；root 负责接入应用。所有接口都要求有效登录，会话账号就是 owner，不接受 body/query 传入 OpenID 或 userId：

| 接口 | 行为 |
| --- | --- |
| `GET /api/v1/templates?page=1&limit=100` | 只列本人，按周一到周日、当地时间、ID 稳定排序。返回 items/page/limit/hasMore；每条有 nextOccurrence。 |
| `POST /api/v1/templates` | 创建本人模板，要求 idempotency-key。 |
| `PATCH /api/v1/templates/:id` | 本人局部修改顶层字段；definition 如提供则整体替换并完整验证，不能局部混合旧结构。事务锁定后重读，避免并发改名称和时间互相覆盖。 |
| `DELETE /api/v1/templates/:id` | 只删除本人模板，要求 idempotency-key；相同 key 重试仍返回原成功结果。 |

没有归属权限的 ID 和不存在的 ID 都返回 404。创建/更新响应不包含动态预览，因此幂等重放结果固定。列表在每次读取时计算最新下次出发时间，模板 CRUD 不自动发布行程。

请求示例：

```json
{
  "name": "周二去学校",
  "weekday": 2,
  "localTime": "15:00",
  "timeZone": "America/New_York",
  "definition": {
    "kind": "offer",
    "cityKey": "ny_nj",
    "stops": [
      {"kind": "departure", "address": "Fort Lee", "placeId": "fort_lee", "offsetMinutes": 0},
      {"kind": "destination", "address": "Columbia", "placeId": "columbia"}
    ],
    "seatCapacity": 3,
    "listedPriceCents": 1500,
    "note": ""
  }
}
```

definition 复用offerFieldsSchema和共同站点验证；只替换出发时间表示。departure站点用纽约墙上时间offsetMinutes（0..1440），首站0，非递减；destination无时间。2–20站、两类各1–10、所有出发在到达之前。当前产品只有司机周模板。

`nextWeeklyOccurrence(schedule,stops,now)` 用 IANA 纽约时区和 UTC 日历运算，不使用机器本地时区。规则与现有小程序一致：

- 下一个该星期/本地钟点；当天仍有至少 15 分钟则可以用，否则整周递进。
- 最远 30 个实际经过的日长；不会把旧出发日期直接用于发布。
- 对每个站点按本地钟点解析；任何一站落入春季不存在的钟点就整周跳过。不是把分钟偏移直接加到首站UTC。
- 秋季重复钟点显式选较早一次。若较早一次已过提前量，不临时改用较晚一次，而顺延整周。这是已有产品规则，与历史数据导入“不能猜歧义时间”不同。
- canonical weekday=0周日。旧模板 weekdayIndex=0周一只能在迁移边界用 `(oldIndex+1)%7` 转换；主 API 不接受旧别名。

nextOccurrence仅返回可直接用于发布的绝对时间stops，移除模板offset，不重复存departureAt/localDate。模板车辆/Zelle副本不是旧发布路径的资料来源，因此不进入新definition；历史原文留来源归档。旧CarpoolTemplate仍未导入，新接口尚未接替线上直写CloudBase。

新增测试 `templates-time.test.ts` 与 `templates.integration.test.ts` 覆盖 UTC/上海/洛杉矶/檀香山/纽约机器时区、DST 两类边界、15 分钟门槛、年末和闰日、owner 隔离、并发幂等、并发修改、删除重试、分页、严格字段拒绝和真实 PostgreSQL CHECK。

## 拉黑与通知（003–004）

拉黑API只接收同AppID的内部用户ID，身份仍由会话确定。每次加入先锁行程，再按确定顺序取得加入者与现有参与者的无向用户对锁；拉黑/解除只取用户对锁，不反向锁行程。先完成的事务确定结果：拉黑先提交则加入失败，加入先提交则关系保留。无关用户对可并行，错误不暴露由谁拉黑或私人理由。重复加入先按已有成员事实返回，不被之后的拉黑变成失败。

通知在同一次行程事务内生成；写通知失败会回滚成员、版本、事件及幂等回执。供车乘客变动通知创建者；求车乘客变动通知创建者和接单司机；司机变动通知乘客；取消通知当时仍参与的其他成员。创建、无变化重放不重复发通知。当前只接入 joined/left/cancelled；评分邀请、移除成员等须随对应业务补齐，不能声称全部旧通知已迁入。

列表按 created_at/id 倒序游标分页，保留数据库微秒精度，默认50最多100条，独立返回真实未读总数。单条已读、全部已读和清空均要求幂等键及收件人条件。重放清空/全部已读的旧请求不会作用于之后新增通知。没有公开发送通知接口，也不接受客户端指定收件人。

## 行程输入与私有参与资料

新建只接受stops，不再接受未发布的origin/destination/顶层departureAt别名。出发时间为UTC且顺序不递减，首站派生索引和整车加入截止；容量不分站。请求默认行李0、0..20。全部站点、成员、事件和幂等回执一次事务保存。

`GET /api/v1/rides/:rideId/participants` 用单条SQL同时核对active关系并投影，防止授权后成员变更导致越权。无权限/退出/取消/不存在统一404。供车司机看active乘客，供车乘客只看自己与司机；求车成员保留同组联系能力。只返回白名单联系字段和允许的当前车辆/收款资料，不返回OpenID、整份profile、住址或任意JSON。

`GET /api/v1/me/rides?scope=current|history&role=driver|passenger&page=1&limit=20` 只看本人未退出、未取消关系，复用公共行程投影并加本人role/seatCount。current为open且未出发，history为closed或已出发，不能解释为实际成行。两接口成功与错误都设private,no-store。
