# 业务数据库与迁移边界

本文件描述 `migrations/001` 至 `020` 的字段契约。它是维护文档；工作阶段、权限与发布决策见根目录临时 `BACKEND_MIGRATION_WORK.md`。已有账号、核心行程、模板、通知、统计、管理员认证、文件事务、商品接口及广告/社区存储模型；这不代表整个产品已迁出，也不代表本地模块已部署或客户端已接入。

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
| `migration_batches` / `migration_sources`（006、011、013） | 批次UUID/AppID/来源hash、`plan_sha256`、`imported_counts`、可空 `observed_before`；每批次 `(collection,source_id)` 和完整序列化JSON/hash | 私有迁移证据；转换指纹和数量回执成对保存。重复导入不覆盖运行态；不提供客户端API或授予业务权限。 |
| `notifications`（004） | 旧ID兼容 `id`，`user_id`，`event_id`，`ride_id`，`type`，`title`，`content`，`read`，`created_at` | 仅收件人可读/改/删；`event_id,user_id` 唯一。旧通知无事件ID可为null；read保留布尔，不伪造旧阅读时刻。 |
| `ride_ratings`（008） | 原文本ID、`ride_id`、`rater_id`、`target_id`、双方角色、1–5整数 `score`、`created_at`、可空 `event_id` | `(ride_id,rater_id,target_id)` 唯一，不自评，双方角色相反；旧记录保留时间和分数，不复制汇总到profile。 |
| `ride_completions`（009） | `(ride_id,user_id)`、首次 `role`、可空 `counted_at/event_id` | 旧收据的时间/事件未知则同时为空；不依赖当前成员关系，不授予成员权限。 |
| `public_statistics`（009–010） | `app_id`、`served_count`、可空 `coverage_text`、`updated_at` | 显式导入旧累计值和覆盖文案；缺失文案为未知，不猜默认地区。关闭事件同事务增加人次，不从现存行程重算旧总数。 |
| `referral_codes`（012） | `user_id` 主键、全局唯一 `code` | 每账号一个 `ref_` 加12位小写十六进制码，保留已发布旧码。 |
| `referral_bindings`（012） | `referred_user_id` 主键、`referrer_user_id`、`bound_at` | 首次有效绑定不可更换，不可自邀；人数由事实关系查询，不另建计数表。 |
| `admin_accounts`（014） | `(app_id,id)`、`owner_key`、`enabled`、`credential_version`、可空 `password_salt/password_hash`、创建/更新时间 | id 为原规范化账号名，不复制 username；owner_key 可由多个管理账号共享。缺凭据不能登录，旧未知更新时间允许null，不伪造用户/OpenID。 |
| `admin_sessions`（014） | `token_hash`、`app_id/account_id`、`credential_version`、`expires_at/created_at` | token只存hash，有效期8小时；停用、改凭据或归属变化永久删除旧会话。 |
| `admin_login_attempts` / `admin_origins`（014） | `(app_id,scope)` 和窗口/次数；`(app_id,origin)` | 原子15分钟窗口，每账号10次、每应用120次；scope为账号hash或global。来源必须精确HTTPS匹配，默认无授权来源。 |
| `admin_audit` / `admin_requests`（014） | 审计UUID、app/account/action/details/time；幂等主键 `(app_id,owner_key,operation,request_key)` | 管理写入、审计和永久回执同事务；旧审计actor不强制有账号，不由日志创造权限。 |
| `files`（015–016、018） | UUID、app/provider/locator、user或admin owner、可空 `uploaded_by_admin_id`、`legacy_readonly`、status、可空内容元数据及时间 | `(provider,locator)` 全局唯一且不可修改；上传者不同于共享归属。旧只读文件未知时间可null，新文件时间和管理员上传者不可缺失。 |
| `file_references`（015） | `(app_id,resource_kind,resource_id,slot)`、`file_id` | 资源类型listing/ad/community；有序slot如image.0、thumbnail.0。引用事实是唯一依据，不另存refCount或attached状态。 |
| `market_listings`（017） | `(app_id,id)`、两类owner恰一、`shared_admin_management`、`status`、`expires_at`、`version`、`content`、创建/更新时间 | content无images，图片只存引用。status允许online/offline/sold/deleted；删除留墓碑和永久幂等结果。version为0至JS安全整数上限。 |
| `ads` / `ad_clicks`（019） | 广告 `(app_id,id)`、展示内容、contact目标、窗口及权重；点击 `(app_id,id)`、ad_id、位置、商品类型、可空actor/time | 点击不等于曝光或成功联系。ad_id无外键，保留已删除广告的历史。 |
| `community_configs` / `community_revisions`（019） | 每app一份当前配置；修订 `(app_id,id)`、唯一version、previous_version、before/after、可空actor/time | 图片只存file_references。连续历史和内容一致由转换器校验，运行更新须锁当前配置并同事务写修订与引用；历史不自动发布。 |
| `market_views`（020） | `(app_id,id)`、listing_id、可空actor_user_id、纽约day、count、可空创建/更新时间 | 每日累计桶，不是一条一次浏览；已删除商品保留原标识，未知用户不造账号。已知用户同商品同日唯一，页面浏览总数由sum(count)派生。 |

009 允许仅 `closed` 系统事件的 actor_id 为null；其他业务动作仍必须有真实用户操作者。

007 允许旧模板updated_at=null；列表不把未知时间改成现在。

006 允许旧资料的 updated_at 和成员 joined_at 为 null，表示未知；仅 closed 行程可缺城市或可信容量。新建/加入仍由服务端写真实时间，open/cancelled 必须有城市和容量。来源归档保留全量原字段，单条 SHA-256 由数据库与所存 JSON 文本核对；hash 对应序列化后的 JSON，不冒充原导出文件字节hash。

005 为 rides 增加唯一 `listed_price_label`（API `listedPriceLabel`）原始报价文本。它与金额的职责不同，不建立 `referencePrice/displayPrice/price` 等兼容别名。通知 ride_id 是可失效导航目标而非外键，因为旧版取消会物理删除行程；这不能成为复活被删除行程的依据。

`schema_migrations(version,checksum,applied_at)` 仅用于管理 SQL 版本，不是业务表。没有创建占位业务模块、重复用户当前/历史行程数组或单独的“满员”状态字段。

## 容量、时间和成行

- `offer` 容量来自司机提供的客座数，当前范围 1–8；`request` 当前业务上限为 4。求车发起人的同行人数保存在其 passenger 成员的 `seat_count`，不能当容量。
- 剩余座位等于容量减 active passenger 的 seat_count 总和；历史容量未知时返回null，不补0、不推算新容量。关系跨行求和不能由单行 CHECK 保证，业务写必须锁定行程行并在事务内校验。
- `open` 仍需结合出发时间、座位和司机接单状态判断可操作性。旧 `full` 归入 open，是否满员从成员计算；旧 `past` 归入 closed。closed 只表示业务生命周期已关闭，**不表示用户确认实际成行**。
- `departure_at` 是最早出发站的绝对 UTC 时刻，`time_zone` 当前固定 `America/New_York`；其他出发时间保留在 stops。周模板不在此表，把下周同一星期/本地钟点实例化后才生成 UTC。
- `listed_price_cents` 是可确认的牌面 USD 金额，空值代表未明确数值。新建API采用现有每人报价约定；历史原文没有标明单位时不能自动当人均价。`listed_price_label` 原样保留原报价文字及条件，复杂/多金额文案保留文本和null金额，不抽取首数字。它们不是已支付或实际成交金额。新建/模板可带listedPriceLabel原文；提供文本时其解析金额必须与listedPriceCents一致，复杂文字须金额null，避免显示与数值矛盾。
- 回访“是/否/未答”、评分是独立事实，不将这些事实塞进 `closed` 状态或任意 JSON。通知、拉黑已使用各自关系表。

## JSON 的受控用途

所有 JSONB 列数据库 CHECK 要求 object。具体字段和类型在服务边界验证，未知字段不能无声加入。

`users.profile` 的 canonical 键与 `src/users/routes.ts` 一致：

- `phone`、`phoneRegion`、`wechatId`、`bio`；
- `vehicle: {plate,brand,model}`；`zelle: {name,account,public}`；
- `region: {state,county,area,key,label}`；`location: {label,address,residence,latitude,longitude}`；
- `preferences: {pickupAddresses,dropoffAddresses,comments,routePrices:{fortLeeNonCore}}`；`profileCompleted`。

`location.residence` 保留手填处所，与地图提供的 `location.address` 分开；`fortLeeNonCore` 保留默认报价原文，不另存可能矛盾的金额副本。迁移联系电话区号优先 regionPhone 后 region，处所优先 Apartment、address、buildingName；地区使用当前编辑器消费的顶层字段及嵌套 location 补缺，差异留下受控提示和完整来源。地图 provider/精度等元数据只归档。常用接送点以当前 pickupSpot/dropoffSpot 为准，旧别名仅补缺，不能合并后复活已删除选项。

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

必须使用完整、未裁剪业务文档。该 kind 是调用方明确的来源声明，**不是导出完整性证明**：生产迁移前仍须按云端集合数量、分页、最终增量和附件另行对账。现有 analytics/地点同步快照缺少资料、成员、模板等事实，不能改个 kind 冒充完整导出。核心集合和下述市场/内容集合已支持；其他额外非空集合报告UNMAPPED_COLLECTION，不会被丢弃后宣称全部迁移成功。用户非零评分汇总与实际明细必须对账，缺少TripRatings不能假装完整。

```ts
const { plan, report } = normalizeCloudBaseExport(source, {
  timeZone: 'America/New_York'
});
```

- `report` 只有受控集合分类、问题码、已知字段名、计数；不含 ID、OpenID、地址、联系方式、原始值，未知字段/集合名称也不会直接输出。
- `plan` 包含账号、完整受控行程资料、sourceSha256和所有原文sources，仅供可信进程内部使用。来源须有非重复_id、无损JSON；原文归档不意味着未知业务字段已完成映射。任何 error 都使 `plan=null`；不能拿部分有效候选做生产导入。`candidateCounts` 仅表示审计过程中识别到的数量。
- 账号使用 `(appId,openid)` 确定性UUID。先按身份分组，唯一_openid主资料为canonical来源；仅有openid且只含旧索引/时间/role的重复稀疏文档只归档，不覆盖资料或较早创建时间。无主资料的openid-only身份仍阻断；无身份且仅含已识别旧索引元数据的文档归档而不创建账号。嵌套userInfo仅在appId/openId一致且没有额外字段时视为重复上下文。此映射不提供登录能力。
- 同 OpenID 多主身份资料、旧别名冲突、未知用户/字段/集合、账号异常状态、open行程未知城市或座位对不上、缺失必需地址/时间、ID 冲突、测试数据混入都会阻断。
- 用户的8组旧行程数组只做关系对账；已不存在行程的悬空引用归档+notice，不建幽灵行程或成员。求车创建者按旧详情、权限和完成统计的实际语义固有地是乘客，不依赖其是否遗漏在 passengerID 中。仅已关闭求车中，非创建者的接单司机若也残留在乘客数组，按旧角色判断保留司机角色，原座位分配不转给创建者，冲突容量置未知；对应旧乘客历史索引只归档。其他已存在行程的成员/角色矛盾仍阻断；索引格式错误也阻断。
- 时间只接受明确 UTC/offset、毫秒和 CloudBase `$date`。纽约春季缺失小时及秋季重复小时需要明确解决；不会选择一个看似合理的时刻。缓存 UTC 与本地时间冲突也会阻断。
- 价格统一由 `src/prices.ts` 按完整字符串识别已核验USD格式，使用整数分转换；明确免费才为0。无报价和复杂文案都保留原始label、金额为null。复杂文本在报告中记 `PRICE_TEXT_PRESERVED` 提示而不阻断保真导入；不可保真的非标量/无效数字仍阻断。金额单位未被原文确认时，不能仅凭解析成功用于人均价分析。
- 旧求车成员列表及接单司机没有独立加入时间，保留joinedAt=null并记提示；显式无效时间仍阻断。独立旧资料写路径的更新时间取有效记录中最大值，仅指最后已记录写入，不用于决定哪个资料字段正确；全部缺失保留null。
- 仅已closed历史行程可将缺失城市、冲突容量置null；原C/A/N完整留来源，不删成员、不声称实际超卖或成行。非空未知城市、open行程冲突、用户/关系未映射仍阻断。
- 已审计旧计数标记、完成checkpoint、driverID、城市别名和手动完成信息由 `ride-metadata.ts` 验证后仅归档。checkpoint与原个人收据核对，不用当前成员重写历史。已关闭但无checkpoint的行程不补算。旧driver文档悬空只作提示，不能变成身份来源。
- 唯一过期缺城市的旧open类别可提供 `observation:{sourceSha256,at}`：调用方须核验导出清单和文件hash，at为相关集合开始读取前已成立的时刻，绑定同一原始来源hash。所有出发站严格早于at、无公开计数/个人完成标记和实际收据，才可归closed；不补城市、不计数、不生成事件，原status完整归档。有效城市的open行程仍留给正常关闭任务处理；非空未知城市不会修正。默认不推断，不用当前时间或分页结束时间冒充观测证据。`observed_before`不表示原子快照。
- `PublicStats/home` 必须是唯一有效基线，累计数为非负安全整数，原覆盖文案和更新时间保真；最后一次增量元数据只校验归档，不重新执行。原邀请码只保留经过可信账号核对的唯一旧码，不在转换时给缺码用户补码。旧 `blockedUsers` 只有空数组可归档，非空关系必须显式对账。

命令行只输出 report；成功退出码 0，有待处理问题 1，读文件/JSON 错误 2：

```sh
node src/migration/analyze.ts /absolute/path/full-export.json
```

当前没有生产数据写入/切主命令。`report.ready=true` 仅表示本切片结构审计通过，不表示整个产品迁移、旧客户端兼容、备份恢复或最终增量验证已完成。

内部 `importSnapshot(pool,source,expectedAppId,observation?)` 仅用于空目标首次导入：必须显式提供上述8个已支持集合，重新审计原始source，不能提交调用方自制plan。全局事务锁和表写锁包住空库检查、全部模型、来源归档、读回数量和回执；中途失败全部回滚。事务内以数据库时钟拒绝未来观测时间。目标任何业务/会话/事件/回执数据非空就拒绝，不支持合并、清空或增量覆盖。同app/source只在转换指纹一致时重放原回执，成功后的业务变化不被重试覆盖；转换结果变更需显式迁移。原始输入在首个await前深拷贝，防止校验后被调用方修改。

该内部函数保留核心数据隔离演练能力：整个市场集合组都未提供时仍可导入核心数据。因此 `report.ready`、导入成功或空数组不能作为全量切主门槛。最终生产入口还须独立核验完整清单、必需域、源集合数量/哈希、增量和附件；当前没有完成或开放这一切主入口。

市场组一旦提供任一相关集合，必须同时显式提供 `market_goods/MarketFiles/market_view_events/WebAdminAccounts`。`houseShare` 若提供，须与同ID商品除浏览字段外完全一致，才仅归档。广告/社区/网站上传组一旦提供，必须同时具备该市场组及 `WebAdminUploads/market_ads/market_ad_events/community_config/CommunityConfigHistory`。`WebAdminSettings` 仅转换精确HTTPS管理来源；旧HTTP规则不会默默丢弃或自动扩大授权。未迁旧登录会话。

空目标保护与SQL runner共用schema advisory lock，在锁内从PG目录发现并锁定当前schema全部数据表（仅排除schema_migrations）。不维护会随新增功能遗漏的表名清单；目录标识符由PG quote_ident引用。目标须是专用应用schema，新增的管理员/文件表或其他非空表同样阻止首导。这不代表新表已经支持业务导入。

## 管理员与文件基础（014–016、018）

管理员账号不伪造OpenID，也不进入users。登录使用现有账户算法的异步scrypt（N=16384、r=8、p=1、32字节salt、64字节hash）；事务外计算后再次锁账号核对凭据。业务事务按账号→会话顺序锁定，并在等待后读取数据库clock_timestamp核验过期。凭据、归属或停用操作永久撤销原会话，重新启用不恢复旧token。无公开开户/重设密码/临时口令API；旧sessions不导入。

`normalizeAdminAccounts` 验证完整WebAdminAccounts、原规范化账号名/role/版本/所有权和摘要算法。只含元数据的投影会因缺密码摘要阻断；合法原salt/hash在私有JSON候选保留准确小写hex，中央导入写bytea时解码，不重哈希、不打印真实凭据到报告或测试夹具。

`normalizeAdminAudit`按旧writeAudit动作验证固定字段，原32位或request_编号按app/source ID稳定映射UUIDv8，全部原ID留来源归档；上传审计同样保留。旧账号不要求当前仍存在，历史日志不能创建身份。已无运行消费者的market_admins、MarketAdminSettings仅验证后归档，旧code/role不进入新认证体系。旧批次和永久发布回执仍待迁移，不能仅归档后宣称管理端已迁完。

管理接口仅接受admin_origins中的完整HTTPS来源，parser/鉴权错误也带private,no-store。Origin白名单不是身份认证，仍必须带管理员token。永久幂等作用域为app+owner+operation+key，读取回执前仍重新鉴权；原微信用户幂等锁键不变，不混用两类身份。

文件状态只有pending/ready/deleting/deleted。预约和确认是可信存储适配器调用的内部函数；客户端报一个locator或内容hash不能证明上传归属。新文件ready须有存储读取验证过的size/media/hash/verifiedAt；旧文件允许元数据未知且legacy_readonly。物理对象键provider+locator全局唯一且永久保留，不重新使用已删除对象键。

业务调用方须在同事务先授权并锁定资源，再修改file_references。核心按资源advisory锁和有序文件行锁替换引用；原资源可以保留/重排已有历史图片，新资源不能拿旧引用获得归属授权。附加只允许ready，新附加必须与可信owner匹配。文件事务显式要求READ COMMITTED，避免等待文件锁后仍读到遗漏新引用的旧事务快照。

管理员上传归属为ownerKey，上传者是另外的不可变事实uploaded_by_admin_id；可信输入必须同时带adminAccountId/ownerKey。预约要求该账号启用且归属一致，确认仅限原上传者。同归属其他管理员只有在文件当前仍被同归属或显式共享管理的非deleted商品引用时才能复用；广告、社区或历史引用不能授权。末条商品引用删除后失去共享资格，无需“曾经附着”布尔值。以上检查在同一文件锁内，避免释放引用与新增共享竞争。历史未知上传者不能被猜成当前管理员。

删除先锁文件、检查零引用、提交deleting，再调用存储；失败保留deleting可重试，NotFound视作成功。数据库提交回执丢失后再次读取deleted即可返回，不重复删除。legacy_readonly文件尚未全量引用核对，不进入删除；pending文件须先有真实上传截止/关闭协议，当前不自动清理。没有refCount、平行outbox、实际存储删除适配器或定时器。

`normalizeMarketFiles`将旧MarketFiles与已转换listing图片生成文件/引用候选，已接主导入器。goodsId只代表最后附加索引，不能覆盖商品有序images或证明唯一引用；旧deleted/removed/cleanup是删除意图，不等于存储成功。所有候选legacy_readonly，未验证的内容元数据保持null，按原createdAtMs/updatedAtMs保存台账时钟；独立服务端时间完整归档。遇到错误不返回部分可导入结果。广告/社区引用由normalizeContentFiles归并，实际对象存在性仍需另外核对。

## 市场模型、事务与旧数据转换（017）

`src/market/schemas.ts` 统一商品与转租的内容字段，`src/migration/market.ts`
私有转换候选已接中央首次导入；市场 SQL、用户事务核心及 HTTP 路由已实现，客户端及最终切主仍未完成。
主审计仍拒绝未支持的非空市场集合，不能把这部分转换通过当成整库迁移通过。

- 内容只保留 `listingType`、`title`、`description`、整数 `priceCents`、`category`、
  `condition`、`region:{state,county,area}`、`buildingName`、可空 `location`、
  `startDate/endDate`、可空 `sellerContact` 和 `sublet`。
  创建/修改输入另接收有序 `images:[{fileId:UUID,thumbFileId?:UUID}]`，最多6张且保持配对。
  保存content前剥离images，只写file_references；不复制首图、hasImage或展示URL。
  仅私有迁移边界 `market-images.ts` 保留旧cloud标识校验，转换成UUID引用后不写入商品JSON。
  联系人头像仍是原头像资料，可为HTTPS或cloud地址，不误当市场附件。
- 转租房型沿用唯一 `category`，租期沿用唯一日期窗口。`sublet` 只收房屋类型、
  可空押金分值、家具/费用布尔值、室友偏好及可空人数；普通商品必须为 null。
  旧 false 保留原义，不额外推断房屋事实。金额不四舍五入，不解析任意字符串；
  最大 10,000,000,000 分，未来 SQL 必须使用能容纳该范围的类型。
- 来源映射另加原 `id`、`appId`、`ownerUserId` 或 `adminOwnerKey`（二者恰一）、
  `sharedAdminManagement`、`status`、绝对 `expiresAt`、`version`、`createdAt/updatedAt`。
  这些字段不能混入客户端内容输入。旧未知更新时间为 null，缺失版本初始为 0 并记录提示。
- 网页归属须由已核验的管理员账号到 ownerKey 映射确认；多个账号可以共享管理范围，
  不因当前只有一个账号就假定 ownerKey 为账号唯一键。旧 OpenID 代发记录仍归真实用户，
  用显式 `sharedAdminManagement` 保留有效网页管理员的既有共享管理权限。
  不把它们改写成网页账号所有，也不伪造 OpenID。
- 管理员登录账号和会话独立于微信 users。账号非秘密字段投影仅能证明归属；不能用于
  恢复密码认证，更不能冒充完整源备份。未映射操作者、账户冲突或未知字段会阻断候选。
- `normalizeMarketListings(documents,{appId,users,adminOwners},issue)` 不写库或改源。
  调用方必须保留完整来源，并在任意 error 时拒绝整个计划，不能导入部分成功的行。
  别名须先一致核验；原创建请求、批次摘要、更新摘要和统计字段暂时校验归档。
  切换前仍须完成永久创建去重、批次结果、浏览事实、文件归属和附件内容的迁移。

`src/market/time.ts` 显式接收服务器时间，按纽约日期限制商品两个月、转租十八个月，
月份末尾截到实际末日。新建或明确修改日期才计算纽约结束日最后一毫秒（支持夏令时）；
不因编辑其他内容延长有效期。历史导入始终保留原 `expireTime` 的绝对时刻，
不把旧 UTC 日末悄悄重算成纽约日末。开始日期不作为额外可见性门槛。

文件生命周期的迁移边界：一张文件可以被多条商品引用，关联关系保存顺序及缩略图配对，
不复制 refCount。`pending/ready/deleting/deleted` 与引用分开；旧 `deleted` 只是删除意图，
不等于对象已经消失。附加引用和清理锁定同一文件，检查无引用后置 deleting，
再执行外部存储删除；deleting 对象禁止新增引用。现 CloudBase 游标扫描不是事务快照，
不能作为新后端的文件锁替代。广告与社区配置、历史回滚图片也须独立保留引用。

`src/market/service.ts` 当前只实现微信用户自己的创建、内容修改、状态修改和删除。
所有写入带永久幂等键，修改另带expectedVersion，锁商品后校验归属/版本；正文、文件引用和回执同事务。
删除写deleted墓碑并释放引用，不立即删除对象。重试原创建键返回原结果，不复活墓碑；同键不同内容409。
无变化的状态操作不加版本；正文、图片和状态修改保留原expiresAt，真实日期/类型变化才重新校验日期窗。
网站管理员批量发布、部分失败重试、批次与单行两层去重、管理模板和编辑权限仍需接入；不可据此增加管理员删商品权限。

`normalizeAds` 和 `normalizeCommunity` 已接中央原子导入：保留contact广告、点击事实、社区当前配置及连续修订；未匹配历史操作者保持null并保留原始来源，不生成账号或被删广告。点击不是曝光或成功联系。社区当前/历史文件槽统一属于community/main，历史修订不能自动发布为当前内容；群入口可用性和自动公告启用分别保留。其他广告目标类型明确阻断。两域尚无运行HTTP或管理写入服务。

`normalizeContentFiles` 验证网站上传的request/file两份完整回执、原hash键、账户归属、路径、用途、MIME、尺寸和时钟，再与市场文件及内容引用按精确locator归并。旧文件保持legacyReadonly；上传元数据留原始来源，不冒充重新核验过的二进制。未知owner/time保持null，旧市场台账时钟不被独立上传时钟覆盖。共享管理的用户所有商品可保留可信管理员图片；不转移商品或文件所有权。

`normalizeMarketViews` 保留每日累计桶和原ID，逐商品对账viewCount；缺失商品和未知用户仍保留历史计数。服务器时间、函数毫秒时间、商品lastViewAt是不同写入事实，不强行校成相同。视图聚合不复制进商品content。

## 市场读取与用户写入

`GET /api/v1/market/listings`、`GET /api/v1/market/listings/:id` 和 `GET /api/v1/market/sellers/:sellerId/listings`：游客只得原预览范围的脱敏文案、粗地区、报价和图片UUID；有效会话可读已发布商品及实际UI使用的有限卖家资料。无效Bearer返回401，不能用查询参数伪造身份。公开仅online且未过期，本人详情和 `GET /api/v1/me/market/listings` 可看自己的offline/sold/过期记录，deleted不可见。

分类、地区、关键词、商品类型、时间/距离排序及offset分页均服务端处理；精确地区/关键词/距离筛选要求登录。图片仅返回有序fileId/thumbFileId，不公开存储locator；UUID至可用URL及旧客户端格式适配仍待接入。浏览数从market_views求和，GET不会增加计数；浏览写入尚待接入。卖家资料随item返回，空卖家列表不提供独立资料查询。

`POST /api/v1/market/listings`、`PATCH /api/v1/market/listings/:id`、`POST /api/v1/market/listings/:id/status`、`DELETE /api/v1/market/listings/:id` 复用已实现的用户事务服务；要求可信会话、幂等键，修改带expectedVersion。路由已接应用，尚未成为生产主写入口或适配管理端。

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

nextOccurrence仅返回可直接用于发布的绝对时间stops，移除模板offset，不重复存departureAt/localDate。模板车辆/Zelle副本不是旧发布路径的资料来源，因此不进入新definition；历史原文留来源归档。旧CarpoolTemplate已有纯转换（尚未写入服务器）：weekdayIndex周一0转一次、保留sourceId、非UUID确定性转换。仅空座位字符串按旧模板编辑/应用的明确默认设1并记notice，发布前仍可编辑并确认；其他无效人数阻断。旧更新时间缺失为null，原priceLabel保真。新接口尚未接替线上直写CloudBase。

新增测试 `templates-time.test.ts` 与 `templates.integration.test.ts` 覆盖 UTC/上海/洛杉矶/檀香山/纽约机器时区、DST 两类边界、15 分钟门槛、年末和闰日、owner 隔离、并发幂等、并发修改、删除重试、分页、严格字段拒绝和真实 PostgreSQL CHECK。

## 拉黑与通知（003–004）

拉黑API只接收同AppID的内部用户ID，身份仍由会话确定。每次加入先锁行程，再按确定顺序取得加入者与现有参与者的无向用户对锁；拉黑/解除只取用户对锁，不反向锁行程。先完成的事务确定结果：拉黑先提交则加入失败，加入先提交则关系保留。无关用户对可并行，错误不暴露由谁拉黑或私人理由。重复加入先按已有成员事实返回，不被之后的拉黑变成失败。

通知在同一次行程事务内生成；写通知失败会回滚成员、版本、事件及幂等回执。供车乘客变动通知创建者；求车乘客变动通知创建者和接单司机；司机变动通知乘客；取消通知当时仍参与的其他成员。移除仅通知被移除者，包含必要理由；评分仅通知被评价者；关闭只为有司机和乘客的组发送评价邀请。创建、无变化重放不重复发通知。旧通知仅完成转换，尚未实际导入。

列表按 created_at/id 倒序游标分页，保留数据库微秒精度，默认50最多100条，独立返回真实未读总数。单条已读、全部已读和清空均要求幂等键及收件人条件。重放清空/全部已读的旧请求不会作用于之后新增通知。没有公开发送通知接口，也不接受客户端指定收件人。

## 行程输入与私有参与资料

新建只接受stops，不再接受未发布的origin/destination/顶层departureAt别名。出发时间为UTC且顺序不递减，首站派生索引和整车加入截止；容量不分站。请求默认行李0、0..20。全部站点、成员、事件和幂等回执一次事务保存。

`GET /api/v1/rides/:rideId/participants` 用单条SQL同时核对active关系并投影，防止授权后成员变更导致越权。无权限/退出/取消/不存在统一404。供车司机看active乘客，供车乘客只看自己与司机；求车成员保留同组联系能力。只返回白名单联系字段和允许的当前车辆/收款资料，不返回OpenID、整份profile、住址或任意JSON。

`GET /api/v1/me/rides?scope=current|history&role=driver|passenger&page=1&limit=20` 只看本人未退出、未取消关系，复用公共行程投影并加本人role/seatCount。current为open且未出发，history为closed或已出发，不能解释为实际成行。两接口成功与错误都设private,no-store。

`POST /api/v1/rides/:rideId/members/:memberId/remove` 要求本人会话、幂等键和非空 reason；memberId 是内部用户 UUID。仅行程创建者可以移除其他成员，求车接单司机没有此权限，不能移除创建者。仅首站未出发的 open 行程可修改；保留原成员行和历史，仅更新 state/left_at。事件、通知和回执同时提交；同一键重放不会移除后来重新加入的关系，成员仍可用新键再次加入。

## 迁移模块

`normalize.ts` 统一来源归档和全有或全无的plan；`types.ts` 是迁移行类型，`values.ts` 统一时间/字段/用户索引校验，`users.ts`负责身份选择、profile.ts负责资料转换，templates/notifications/blocks各处理自己的旧文档。共用报价解析在业务层prices.ts，避免新业务依赖旧导入器。

旧通知保留原ID/read/title/content/type/createdAt，eventId=null，多个导航别名必须一致；已物理删除的ride仍可保留导航目标，不从文字重建业务事件或成员权限。旧extra逐字段验证后仅在来源归档保留。

旧拉黑按blocker→target归并：最多一个active；存在active时，它的创建必须不早于旧inactive的解除时间。全部inactive取最新有据更新时间，若同刻内容冲突则阻断。dedupedAt只作维护来源，不能覆盖实际状态。源62条即使运行态归并为52对，原文仍逐条归档，不删除源库。

## 评分与完成计数（008–009）

`POST /api/v1/rides/:rideId/ratings` 接收 `{targetId,score}`，targetId是内部用户UUID；会话确定评价者。锁行程后以数据库当前时间核对closed且最后出发站严格已过，双方须仍是active成员且司机/乘客角色相反。禁止自评、改分；同幂等键重放原成功，不同键重复评价返回409 ALREADY_RATED。评分、版本事件、目标通知、回执同时提交。没有回访、双方先互评或拉黑前置条件。

`GET /api/v1/rides/:rideId/ratings` 仅向有效成员返回其本人已评价的targetId/score，不提供他人的逐条评分。鉴权与投影使用同一SQL快照；成功、失败均private,no-store。

`closeDueRides(pool,appId,batchSize)` 是内部有界任务函数，不提供客户端触发接口；当前尚未安装生产调度。以最后出发站严格过期为条件，按行程锁并发SKIP LOCKED，仅open→closed一次。个人完成收据、公开增量、系统事件、评价邀请同事务提交。旧closed行程不会重算；旧收据冲突保留首次角色和未知时间。个人次数按每个匹配账户一次，至少一司机、一真实乘客；不按同行座位数。公开人次保留旧口径：有司机时 `min(5,1+active乘客seat_count之和)`，无司机求车0，供车司机独行1。两项均不表示用户回访已确认实际成行。public_statistics缺少该AppID基线时整个关闭批次回滚，不偷偷从0开始。

迁移rating保留原ID/分数/时间，核对身份、行程类型、双方角色和唯一关系。已发生的历史提前评分保留并记LEGACY_EARLY_RATING_PRESERVED提示，不改时间，也不放宽新写入权限。所有旧用户role/all评分sum/count/avg/weightedAvg与明细对账后仅归档；加权均分继续使用prior 4.7、weight 3、一位小数。_rideCompletionV1去重收据与三项completed计数必须一致；已退出或当前未匹配者的旧收据仍保留，但不恢复成员。缺失/矛盾/未知业务字段阻断整个导入计划。

## 统计显示与邀请关系（010–012）

`GET /api/v1/me/statistics` 返回本人all/driver/passenger的 `completedTrips/ratingCount/averageRating/weightedRating`。从评分和完成收据直接查询，不维护另一份个人汇总。未评分的均分为null；沿用JavaScript一位小数toFixed及4.7×3先验，不用SQL不同的舍入规则。退出当前行程不扣除历史完成次数。

公开行程投影含当前司机的 `driverStatistics`，无司机为null；私有participants投影只在原有授权SQL快照内附加成员当前角色的 `statistics`。内部ratingSum转换后移除，不新增任意用户ID查询接口。`GET /api/v1/statistics/public` 只读配置AppID的 `servedCount/coverageText`，缺失基线503，不伪造0。统计接口均no-store，拒绝额外查询字段。

登录事务和 `GET /api/v1/referrals/me` 保留或签发本人邀请码；接口只返回码和推荐人数。新码优先沿用原OpenID派生格式，唯一冲突时生成随机码，不覆盖归属。`POST /api/v1/referrals/bind {code}` 要求会话与幂等键，同账号锁串行首次绑定；同码重复为no-op，其他码409，自邀/跨应用/不存在拒绝。已有用户也可首次绑定，不额外推断新客、奖励或首次访问归因。访问明细留给既有分析采集，不再建平行日志表。

公共基线和原邀请码已接首次导入，显示接口已接应用；客户端消费者、生产调度和最终单写切换仍需完成。当前没有将本地模块切换为生产权威写库。
