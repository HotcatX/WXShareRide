# 行程、接送说明与周模板契约审计

状态：**核心stops、周模板、成员接送说明、私有投影及我的行程已在新后端实现并本地验证；尚未切生产。** 当前字段和接口以 `services/backend/SCHEMA.md` 为准，本文保留旧消费者证据和设计缘由。 本文核对当前前端、旧 CloudBase 写入/读取函数、新后端，以及 2026-09-25 美东时间完成的私有数据提取。原始提取不是原子快照；下面只报告结构和计数，不包含用户原文、身份、地址或收款信息。

建议用唯一 `stops` 数组替换尚未正式接入的 `origin/destination`，保留每个站点。车辆仍以个人资料为唯一可编辑来源；周模板只保留真正用于重复发布的字段。接送说明保存在乘客关系内，不增加分段容量、行程车辆副本、模板车辆副本或第二套收款账号。

## 1. 当前产品实际含义

| 领域 | 当前真实行为 | 证据 |
| --- | --- | --- |
| 发布路线 | 当前司机/求车页面各产生一个 `departures` 项和一个 `destinations` 项。出发项有地址、本地日期、时间；到达项只有地址。旧云函数允许两个数组各有多个项。 | [newTrip](../pages/home/newTrip/newTrip.js#L837)、[createTrip](../cloudfunctions/createTrip/index.js#L96) |
| 出发时间 | 旧函数对所有出发站计算最早和最晚时间，但不重排原数组。旧过期/列表逻辑参考最晚出发；当前新后端按最早出发关闭报名。 | [createTrip 时间元数据](../cloudfunctions/createTrip/index.js#L68)、[routeExpiry](../utils/routeExpiry.js)、[新 rides](../services/backend/src/rides/service.ts) |
| 路线展示 | 当前详情和“我的行程”的主标题主要展示第一个出发和到达点，不能因此在存储/API 中丢掉其余点。 | [tripDetail](../pages/home/tripDetail/tripDetail.js#L496)、[myTripDetailDriver](../pages/profile/myTripDetailDriver/myTripDetailDriver.js#L143) |
| 供车容量 | 创建者提供总客座数；加入一个乘客账号减少一个座位。多站没有任何分段库存或中途释放座位规则。 | [createTrip](../cloudfunctions/createTrip/index.js#L229)、[joinTrip](../cloudfunctions/joinTrip/index.js#L196) |
| 求车人数 | 创建者可代表 1–4 人；另一个账号加入增加一人；司机接单不占乘客席。 | [createTrip](../cloudfunctions/createTrip/index.js#L269)、[joinTrip](../cloudfunctions/joinTrip/index.js#L250)、[acceptRequest](../cloudfunctions/tripManage/index.js#L511) |
| 供车上下车点 | 页面要求乘客填写两个非空文本，最长 60 字符，并提供“私议”等自由值；云函数写入乘客对象。它们不是选择路线 stop 的 ID，也没有时间或空间验证。旧服务本身未强制非空。 | [tripDetail 输入](../pages/home/tripDetail/tripDetail.wxml#L152)、[加入校验](../pages/home/tripDetail/tripDetail.js#L658)、[joinTrip](../cloudfunctions/joinTrip/index.js#L196) |
| 求车上下车点 | 当前加入求车不收集个人接送说明；没有证据可以用用户住址或路线端点补造。 | [joinRequest](../cloudfunctions/joinTrip/index.js#L250)、[requestDetail](../pages/home/requestDetail/requestDetail.js#L490) |
| 车辆 | 当前发车页面先校验个人资料中的车牌/品牌/型号；实际行程文档不保存车辆。成员看到的是司机当前个人资料，不是发布时车辆快照。 | [newTrip 资料](../pages/home/newTrip/newTrip.js#L257)、[发布参数](../pages/home/newTrip/newTrip.js#L837)、[getDriverData](../cloudfunctions/getTripDetail/index.js#L178) |
| 行李 | `largeLuggageCount` 属于求车，不是车辆行李容量，也不是每个后加入成员的行李数。当前求车页面固定提交 0；历史仍有正数，并在司机接单后的页面展示。 | [passenger_submitRequest](../pages/home/newTrip/newTrip.js#L953)、[createRequest](../cloudfunctions/createTrip/index.js#L269)、[司机求车详情](../pages/profile/myRequestDetailDriver/myRequestDetailDriver.js#L210) |
| 供车 Zelle | 个人资料的 `defaultShowZelle` 是将来发布的默认选择；发车把当次选择保存为行程 `zelle=yes/no`。资料修改不改变既有行程的展示选择；实际姓名/账号仍实时来自个人资料。仅向行程参与者展示。 | [newTrip](../pages/home/newTrip/newTrip.js#L271)、[getDriverData](../cloudfunctions/getTripDetail/index.js#L189)、[tripDetail WXML](../pages/home/tripDetail/tripDetail.wxml#L103) |
| 求车 Zelle | 旧实现向已加入的求车参与者显示接单司机 Zelle，没有供车式的每行程开关。不能假称两类旧流程已经使用相同开关。 | [getDriverData](../cloudfunctions/getTripDetail/index.js#L189)、[求车乘客页面](../pages/profile/myTripRequestPassenger/myTripRequestPassenger.wxml#L105) |
| Zelle 的业务性质 | 页面展示/复制姓名和账号，没有付款、扣款、支付成功或成交确认协议。 | [copyZelle](../pages/home/tripDetail/tripDetail.js#L830) |

“最后一站还没出发，所以可以在任意站加入”“上下车说明对应某一站”“下车后释放席位”都没有源代码依据。本轮不引入这些规则。

## 2. 数据结构证据

| 提取分组 | 结果 |
| --- | --- |
| 3,733 条供车 | 全部只有一个出发站；3,732 条只有一个到达站，1 条有两个到达站 |
| 188 条求车 | 全部一个出发站、一个到达站 |
| 到达时间 | 7,843 个出发/到达点中，到达项均没有 date/time |
| 行程车辆 | 3,921 条行程都没有 carNumber/carBrand/carModel 字段 |
| 供车成员 | 4,973 个成员条目；4,081 个同时有非空 pickupAddress/dropoffAddress；892 个未填写 |
| 求车行李 | 166 条为 0，10 条为 1，10 条为 2，2 条为 4；均为整数 |
| 供车 Zelle 标记 | yes 1,675 条，no 2,044 条，缺失 14 条 |
| 137 条模板 | 均为单一出发/到达地址和周几、时刻；均保存车辆和 Zelle 副本；没有 departures/destinations 数组 |

这支持“不能裁掉额外到达点”的要求，但并未提供现有多出发站运营经验。892 个缺少接送说明的历史成员应保留缺失状态，不能用个人住址、行程首站或“私议”自动补齐。

## 3. 单一 canonical 写入 DTO（建议）

正式接入前一次性替换尚未发布的 `origin/destination` 输入，不在同一 API 同时接受这些字段和 `stops`。旧 CloudBase `departures/destinations` 仅出现在迁移器和集中隔离的临时适配器里。

```ts
type RideStop =
  | { kind: 'departure'; address: string; placeId?: string; departureAt: string }
  | { kind: 'destination'; address: string; placeId?: string };

type CreateRide = {
  kind: 'offer' | 'request';
  cityKey: 'ny_nj';
  timeZone: 'America/New_York';
  stops: RideStop[];
  listedPriceCents: number | null;
  note: string;
} & (
  | { kind: 'offer'; seatCapacity: number }
  | { kind: 'request'; partySize: number; largeLuggageCount: number }
);
```

具体约束：

1. 数组次序就是 `ride_stops.position`，调用方不再同时提供 position。至少一个出发和到达点；兼容旧表达能力时先保留“所有出发项在前、所有到达项在后”，不新增交错停靠/分段搭乘语义。
2. 出发项给明确 UTC 时间；到达项禁止混入 departureAt/arrivalAt，当前没有到达时间事实。出发时间按输入次序不递减，首项为最早出发；相同出发时刻允许存在，不按地址去重。
3. **Create 不再接收顶层 departureAt。** `rides.departure_at` 和响应顶层 `departureAt` 从出发站的最早时间派生，用于索引/列表；不能由客户端再次独立赋值。数据库派生值与站点在同一事务写入并验证一致。
4. 数量/长度需要资源上限。建议新写 2–20 站、每类最多 10 站、地址 1–300 字符、placeId 1–100 字符，沿用现有字符串长度预算。这是待确认的新输入预算，**不是声称旧系统已有这些限制**，也不是裁剪历史数据的理由。
5. `seatCapacity`、`partySize` 延续当前定义；容量仍是整条行程的一个值，成员 seatCount 仍是整条行程占用。没有 `fromStop/toStop`、按段剩余座位或推导的上下车序号。
6. 价格名称继续使用中央 `listedPriceCents/listedPriceLabel`。上述 Create 保持现有新建金额输入；历史 label 来自独立迁移规则，不通过另添 price/displayPrice 等字段解决。确认的旧金额也不自动等于每人或实际成交金额。
7. 多出发站新建规则与报名截止需 root 一并确认：建议新 API 在首站出发前完成报名/退出/接单，防止全程占座模型被误用为中途上车模型。旧代码有最晚出发截止；本批所有行程都只有一个出发站，所以本批数据没有两者差异，但不能将该差异隐去。

### 加入 DTO

继续使用已有 `role` 与 `seatCount`，只增加唯一名称的个人接送说明，不接受 passengerInfo、OpenID、昵称或整个用户对象：

```ts
type JoinRide =
  | { role: 'passenger'; seatCount: number; pickupAddress?: string; dropoffAddress?: string }
  | { role: 'driver' };
```

- 服务端读取并锁定行程后按 kind 校验：加入 offer 必须两个非空接送说明（当前 UI 最长 60）；加入 request 没有这两项输入，不从 profile 补造。严格拒绝不适用的字段，不能默默丢掉。
- 当前 UI 的新增加入账号发 seatCount=1；原求车创建者的多人席位仍来自 partySize。本切片不新增多人加入 UI。
- 成员身份来自会话。姓名/头像若需历史展示快照，由服务端读取并构造，不信任客户端 passengerInfo。
- 同幂等 key、不同接送说明必须冲突；已 active 成员用新 key 重发也不能静默修改接送说明，必须内容相同返回未变化，或受控 409。暂不新增“修改接送说明”接口。
- 退出再加入时覆盖当前关系的接送说明，不能复用上次的数据；历史变化由已存在的业务事件留下必要事实。不要把电话、Zelle 或整个 profile 放进事件/通知正文。

## 4. 车辆、行李、Zelle 与最小存储

优先复用既有表和受控 JSON，而不是增加新表或重复事实。

| 数据 | 唯一可编辑/持久位置 | 返回/使用规则 |
| --- | --- | --- |
| 行程站点 | `ride_stops` | 保存每一项；公开路线投影白名单返回 |
| 路线备注 | `rides.details.note` | 迁移旧 comment；主 API 不再接收 comment 别名 |
| 求车行李 | `rides.details.largeLuggageCount` | 非负整数；当前 UI 仍提交 0，历史正数保留；不要解释成车辆容量或后加入成员合计 |
| 车辆 | `users.profile.vehicle = {plate,brand,model}` | 只在有关系权限的司机资料投影中读取；不增加 ride.vehicle/template.vehicle |
| Zelle 姓名/账号与默认偏好 | `users.profile.zelle = {name,account,public}` | account/name 仅私密投影；public 表示供车今后发布的默认开关，不是互联网公开授权 |
| 供车当次披露选择 | `rides.details.zelleDisplay: boolean` | 发布时服务端从当前 profile 默认值记录一次；既有行程不随默认值变动。迁移 yes/no 只在边界转布尔；缺失按不展示处理并在源归档保留“原来缺失”的证据 |
| 本次成员接送说明 | `ride_members.details.pickupAddress/dropoffAddress` | 只供本人和同一行程司机查看；不是 route stop 或住址 |

`zelleDisplay` 与个人资料 `zelle.public` 不是两个同步开关：前者是已发生的该次发布选择，后者是未来默认值；服务端只在创建时读取一次。当前 newTrip 也没有独立当次 Zelle 编辑控件，所以新 Create 无需增加一个用户可编辑的 Zelle 字段。临时旧客户端适配要保留其已提交的当次 yes/no 语义，不能让旧客户端写入时被悄悄替换；主 API 不再接收 yes/no 字符串。

求车 Zelle 建议在私密投影里明确保留旧规则：只有已接单司机和已确认求车成员之间可查看；不人为增加一个并不存在的旧每行程开关。若 root 决定统一改为 profile 偏好控制，那是行为变更，应单独确认并测试，不能冒充字段重命名。两条规则集中在一个授权投影函数，不能分散于页面判断。

以上字段都能用现有 001 的 ride_stops/details 承载；不需要为它们重写已应用 SQL。若增加 CHECK 或索引，新增独立 migration。已由 root 增加的价格 label 迁移不在本设计切片内。

## 5. 私密投影边界

现有新后端公开 `GET /rides` 和 `GET /rides/:id` 维持白名单；**不要为了详情展示而直接追加 users/profile/members 的完整 JSON**。建议另设鉴权 `GET /api/v1/rides/:rideId/participants`，服务端查询本人真实关系，再返回限定字段。这个接口不是新增 UI。

| 请求者 | 可读内容 |
| --- | --- |
| 游客、登录但未加入者 | 公开路线、出发时间、牌面价/原标签、剩余席位、是否有司机、备注；司机统计只取已定义聚合。没有车牌、联系号、收款账号、个人接送说明、完整用户/成员对象 |
| offer 司机/创建者 | 本人资料；当前乘客的 id/name/avatarUrl、必要联系方式、seatCount、上下车说明 |
| offer 乘客 | 自己的成员信息和接送说明；当前司机必要联系方式与 vehicle；Zelle 受当次 zelleDisplay 控制。不给其他供车乘客的接送说明/联系方式 |
| request 司机 | 创建者及当前乘客的必要联系方式；求车行李；不把用户个人住址当作本次上车点 |
| request 创建者/乘客 | 已接单司机联系方式/vehicle；同组成员的名字、头像和联系方式，保留当前“其他乘客”页面已有的组内沟通能力；Zelle 按上一节受控旧规则 |
| 已退出/被移除成员 | 不能仅因数据库保留历史 membership 就继续拿到当前联系方式/接送说明 |
| 已结束但关系未退出 | 可按经过验证的历史参与关系读本人行程及必要组内信息；不能把所有历史成员都视为仍 active。取消导致 state=left 时按退出规则处理 |

投影沿用唯一名称：用户 `id/name/avatarUrl`，`phone/phoneRegion/wechatId`，司机 `vehicle` 与符合条件的 `zelle:{name,account}`，成员 `role/seatCount/pickupAddress/dropoffAddress`。不返回 OpenID 作为认证凭据；后端仍保留可信 OpenID 关联排障/事件。不要向客户端透出 zelle.public、任意 profile.location、资料修改时间或源文档全部字段。

存在两个实际旧暴露面，不能复制为新 API 的兼容承诺：

1. [getUserInfoByOpenids](../cloudfunctions/getUserInfoByOpenids/index.js) 接受任意 OpenID 列表，没有 actor/行程关系校验，返回电话、住所相关字段和 Zelle。旧页面有关系判断也不能代替服务端授权。新 participants 失败时不能自动回退这个通用查人接口来绕过授权。
2. [getTripDetail.sanitizeTripDoc](../cloudfunctions/getTripDetail/index.js#L135) 主要删除旧别名，仍返回整个行程文档；offer.passengers 中的个人接送说明不因此变成可公开数据。

当前求车同组页面还展示 `p.address`，来自个人资料，不是本次提交的 pickupAddress。新 canonical profile 已把 location 私有化；建议此旧字段不进入 participants，不能改名为 pickupAddress 掩盖来源。这是需随下一客户端适配处理的明确差异，不在本次文档中改线上 UI。

私密响应应 `Cache-Control: private, no-store`，客户端缓存必须按登录账号和行程隔离；退出登录、退出/被移除和取消后清掉旧私密缓存。公共与私密响应分接口，避免公共缓存混入参与者信息。权限查询与所读成员集须使用一致事务快照/等效锁策略，不能先在旧快照授权再读新敏感信息。

## 6. 周模板只保留真实使用字段

审计所有当前可达 CarpoolTemplate 消费者后：

- [newTrip.applyDriverShortcut](../pages/home/newTrip/newTrip.js#L660) 只应用路线、人数、价格、备注、下一周日期/时间，**不应用模板车辆或模板 Zelle**。
- 模板车辆输入从当前个人资料加载，[loadUserInfo](../pages/home/driverCarpoolTemplate/driverCarpoolTemplate.js#L183) 没有读取 tpl.carNumber 等快照。保存模板后 [afterCreateTemplate](../pages/home/driverCarpoolTemplate/driverCarpoolTemplate.js#L417) 又单独更新个人资料；这是 profile 写入的消费者，不证明车辆快照用于发布。
- 旧模板 Zelle **仍有可达消费者**：[loadTemplateDetail](../pages/home/driverCarpoolTemplate/driverCarpoolTemplate.js#L95) 用 tpl.zelle 恢复编辑页复选框，编辑确认和保存又回写模板。它只在模板编辑中往返，当前发布不读。不能说这个字段完全无人读取并立刻删线上列。
- 模板列表展示路线、星期/时间、人数、参考价等，不把车辆快照作为发布来源。

因此新模板不增加 `definition.vehicle` 或 `definition.zelleDisplay`。旧车辆/Zelle 副本只放一次性迁移来源归档，保留可追溯证据，不进入第二份可编辑业务状态。迁移不能以旧模板副本覆盖较新的个人资料，也不能把旧模板 Zelle 值自动写入 profile.zelle.public。

模板编辑器随后接入新后端时，车辆仍如现有行为更新唯一 `/me` profile；冗余的模板专属 Zelle 控件/写入应在客户端正式发布时一起清理。不要悄悄将该旧控件重新解释成个人全局偏好，也不要在旧客户端仍直写 CloudBase 时删除旧列。这里不新增任何按钮、弹窗或新 UI。

### 模板时刻 DTO

模板仍是 offer，每周星期与本地首站时刻只存一次：

```ts
type TemplateStop =
  | { kind: 'departure'; address: string; placeId?: string; offsetMinutes: number }
  | { kind: 'destination'; address: string; placeId?: string };

type WeeklyTemplate = {
  name: string;
  weekday: number;                 // 0 周日 … 6 周六
  localTime: string;               // 首站纽约 HH:mm
  timeZone: 'America/New_York';
  definition: {
    kind: 'offer'; cityKey: 'ny_nj'; stops: TemplateStop[];
    seatCapacity: number; listedPriceCents: number | null; note: string;
  };
};
```

这是模板时刻表示，不是 Create 同时接受绝对时间和偏移两套输入。Create 只接受 RideStop，template 只接受 TemplateStop；地点/顺序/业务字段验证复用同一底层 schema。首个出发站 `offsetMinutes=0`，其余出发站为非负整数且不递减；建议先限制同一日/跨午夜 24 小时内的偏移，作为新输入预算，不能用于裁剪历史。到达站仍没有时间。

**offsetMinutes 是相对首站的纽约日历墙上分钟，不是保证路上经过了多少分钟。** 实例化过程先选首站周次，再用“当地年月日+首站 HH:mm+offsetMinutes”得到每站的当地日期/钟点，最后逐站解析 IANA 时区为 UTC。不能用首站 UTC 加分钟来替代跨 DST 的周模板时间含义，更不能每周加固定 604,800 秒。

保持现有周模板策略：

1. 用纽约日历求下一个所选星期，保留 localTime；当天还满足至少 15 分钟提前量时可用，否则顺延一周。模板卡片点击时重新算，不能使用页面打开时已经过期的预览。
2. 保留当前 30 个实际日长上限。多站实例化还必须校验全部出发时间有效、顺序和整体界限，不能只检验首站。
3. 春季跳时：任一出发站落入不存在的当地钟点，整份模板跳过该周，不能偷偷挪一个站的时刻。秋季重复钟点：新模板实例采用已有产品明确的较早一次；若不满足提前量则顺延，不改用较晚一次。
4. 旧模板 weekdayIndex=0周一，通过 `(oldIndex+1)%7` 一次性转换。137 个现有模板各只有一个出发站，直接映射 offsetMinutes=0；不得把过去某条具体行程的 UTC 时刻存回模板。
5. 模板 CRUD 不自动发布；使用模板时按当前 profile 获取车辆与将来的 Zelle 默认值，按当前时间生成 canonical RideStop 后进入普通创建流程。多站预览使用同一实例化函数，不能在列表、点击、发布三处各写一套时间算法。

现有 [rideTime](../utils/rideTime.js#L73) 和 [nextWeeklyOccurrence](../services/backend/src/templates/time.ts) 已实现单首站的纽约周次、15 分钟、30 日和 DST 策略；扩展应复用它们的已验证政策。当前“最近发布再用一次”入口已删除；不要为本切片重新引入历史快捷入口或按钮。

## 7. 实现顺序与验收门槛

1. root 确认 stops 输入、报名截止、私密投影和模板旧冗余字段归档决策后，统一更新中央 SCHEMA.md；此文不构成已上线 schema。
2. 修改未正式接入的 rides/template schema、服务及合成测试，一次性替换 origin/destination；不增加别名兼容。保留已应用 SQL 的校验和。
3. 创建事务同时写全部站点及派生最早出发时间。join 事务在现有锁/幂等/拉黑顺序内保存接送说明，事件/通知只带必要事实。
4. 新增私密 participants 白名单并做跨账号、未加入、退出/剔除、取消、求车司机更替、供车 Zelle 关闭、profile 默认值改变的授权回归。不能只测试 WXML 是否隐藏。
5. 用合成多站验证数量上限、两个到达站不丢失、相同时刻、午夜、DST 缺口/重复、周次滚动和模板点击后过期。真实提取只做脱敏 dry-run，不改生产。
6. 接入现有页面，保留单出发/单到达 UI，不新增控制。旧字段的真正删除在对应新正式版验证后执行；尚未适配的线上旧调用仍按集中 TEMPORARY FALLBACK 边界工作。

当前实现没有改变：线上 CloudBase 仍是权威业务库；本文件仅新增设计审计，不代表多站、私密详情或模板迁移已完成。
