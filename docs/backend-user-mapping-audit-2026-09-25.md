# 用户身份、资料与时间字段迁移审计

本次只读分析 `data/backend-migration-20260925` 中的完整业务文档、当前写入口及可查 Git 历史。只新增本文，没有修改 normalizer、schema、业务代码或生产数据。以下都是聚合计数，不包含 OpenID、文档 ID、地址、联系方式或用户原文。

提取是 2026-09-26 02:08:46 UTC（纽约 2026-09-25 22:08:46）完成的在线扫描，不是原子快照。范围和分页完整性见 [原始数据审计](backend-data-audit-2026-09-25.md)；当前唯一新字段契约见 [SCHEMA](../services/backend/SCHEMA.md)。本文提出映射决策，不另造一套 profile 字段。

## 核心结论

1. **没有发现 `_openid` 主字段自身重复。** 1,163 条有主身份的资料，其 `_openid` 全部唯一。首版 normalizer 的两次 duplicate 来自两份只有 `openid` 的稀疏旧文档，恰与另外两份完整 `_openid` 资料交叉相同。不能将其描述成两份可信主资料互相冲突。
2. 全部 1,166 条用户文档都有且只有一个可解析创建时间；不存在本批用户创建时间缺失。80 条没有可解析更新时间，不能以导入时间或创建时间伪装真实修改时间。
3. `max(updatedAt,updateTime)` 可以归并这两个已记录时间，**不能证明最后一次资料修改时间**，更不能用它决定哪个电话、地址或昵称较新。部分写入只改 `bigregionUpdatedAt`，另有写入完全不更新时间。
4. 两组交叉身份文档没有相互冲突的资料值，但不能无条件合并其行程索引并恢复权限。稀疏文档各自指向一个已不存在的求车，导出的行为日志和通知都没有旁证。
5. 求车额外乘客 65 个关系、司机 64 个关系缺少加入时间，合计 129 个。当前导出没有可给这些关系恢复精确加入时间的事务事件。后置日志与通知只能保留为佐证。

## 身份与重复文档

| 项目 | 数量 |
| --- | ---: |
| 原始 userInfo 文档 | 1,166 |
| 有非空 `_openid` 且主字段唯一 | 1,163 |
| 只有 `openid`，值与已存在 `_openid` 相同 | 2 |
| 两种身份字段都缺失 | 1 |
| 同文档两个身份字段值冲突 | 0 |
| 嵌套 `userInfo` 对象 | 284 |

284 个嵌套对象都只有 `appId/openId`，其 appId 全等于本次目标小程序、openId 全等于外层 `_openid`。它们是重复身份上下文，**不是昵称/头像资料**；可以核对后不放进 canonical profile，原文保留在来源证据中。不能拿客户端以后传入的同名对象做认证。

对两组交叉重复逐字段比较，排除身份、源文档 ID、时间和旧反向索引后，资料值冲突数均为 0。一组两文档分别有 9/46 个字段，另一组为 35/10 个字段；稀疏文档比完整资料更早创建，不能因此把稀疏文档当作“最新/最权威用户”。

| 聚合分组（不是用户标识） | 旧索引条目 | 在现存行程中找到且角色相符 | 行程已不存在 |
| --- | ---: | ---: | ---: |
| 交叉重复组 A | 18 | 15 | 3 |
| 交叉重复组 B | 4 | 3 | 1 |

其中两份稀疏文档各一个 `tripDriverJoin` 指向不存在的求车；相关 TripActions/Notifications 均为 0。两份文档创建时间都早于可查最早相关代码版本 2026-06-20。当前及 `44cbc3e` 的 `tripManage.acceptRequest` 新建资料会同时写 `_openid/openid`，所以只能说这些稀疏文档形状接近旧接单索引，**不能证明其确切生产者或删失过程**。

建议的无损处置：

- 按 `(appId,_openid)` 建立 1,163 个 canonical 账号，资料以对应完整主身份文档为来源。两个 `openid`-only 文档不再创建第二个账号，不覆盖完整资料。
- 原始两文档、哈希、源文档定位及交叉身份候选关系保存在统一私有迁移证据层；这是来源关联，不授予登录能力或成员权限。没有冲突的身份归并不等于所有索引都可信。
- `ride_members` 只从现存行程或已验证业务事实构造，旧数组用来对账。4 个失效引用原样保留证据，不制造占位行程、不重新授予司机/乘客关系，也不删除 CloudBase 源记录。
- 不能继续使用“遍历中遇到第一条就保留”的 canonical 选择方式：本批一组的稀疏文档在完整资料之前，首版候选会先选中稀疏文档。当前 `plan:null` 已阻止实际导入；下一版必须先分组再明确选择主身份资料。
- 缺身份的 1 条文档只有旧角色、时间及一个已不存在的乘客行程引用，未含嵌套身份。保持未归属来源记录，不根据旧文档 ID、角色、相似时间或姓名猜用户。它不能产生可登录账号。

全批 8 组旧索引共有 8,828 个条目，其中 6 个指向不存在行程，包含缺身份文档的 1 个引用；已找到行程的司机/乘客角色粗核没有不符。首版更严格的“供车/求车、创建者”等规则仍须保留，本文这个粗核不覆盖它们。也不能将不同检查的问题次数相加称为失效账号数。

## 创建与更新时间：字段的生产者决定语义

| 创建字段 | 有效文档数 | 说明 |
| --- | ---: | --- |
| `createdTime` | 725 | 当前登录、资料更新、发布、加入及归因补建用户主要使用 |
| `createTime` | 438 | 旧格式；当前 marketApi 补建区域资料仍会使用，但不能把全部 438 条归因于当前实现 |
| `createdAt` | 3 | 两份 openid-only 稀疏文档和一份缺身份文档 |

每条文档恰有一个有效创建字段，无同文档创建别名冲突。主身份资料的创建来源是 725+438 条。另有 3 个主身份用户，其现存行程创建早于现存用户资料的创建时间，说明 `users.created_at` 最多表示这份资料记录的已知创建时间，不能称首次注册或首次用车时间。

| 更新时间情况（全 1,166 条） | 数量 |
| --- | ---: |
| 仅 `updateTime` | 619 |
| 仅 `updatedAt` | 3 |
| 两者相同 | 75 |
| `updatedAt` 较新 | 47 |
| `updateTime` 较新 | 342 |
| 两者都没有 | 80 |

389 条双时间不等，不是 389 次资料冲突。初版报告 388 是身份筛选/跳过重复后的分母；本文直接扫描全部原始文档。可用更新时间最大值早于本条创建时间的记录为 0。80 条缺更新时间都只有旧 `createTime`，也没有 `bigregionUpdatedAt` 可以补充。

已核验生产者：

| 写入口 | 更新时间行为 | 推论 |
| --- | --- | --- |
| [login](../cloudfunctions/login/index.js) | 新资料 createdTime/updateTime；已有资料仅在补 status/referralCode 时实际提交 updateTime | 不是每次登录都会刷新，更不是 lastLogin |
| [updateUser](../cloudfunctions/updateUser/index.js) | 资料、常用备注写 updateTime | updateTime 可以表示资料修改，但不是专用资料版本号 |
| [createTrip](../cloudfunctions/createTrip/index.js)、[joinTrip](../cloudfunctions/joinTrip/index.js)、[syncMyTripStatus](../cloudfunctions/syncMyTripStatus/index.js) | 角色/行程索引也写 updateTime | 较新的 updateTime 可能只是行程关系变化 |
| [tripManage](../cloudfunctions/tripManage/index.js) 接单 | 写 updatedAt；新建时 createdAt/updatedAt | updatedAt 与 updateTime 都可能是真实较新的行级写时间 |
| tripManage 退出/剔除、评分汇总 | 部分路径同时写两者 | 两个字段不同不能简单认定有一个错误 |
| [referralApi](../cloudfunctions/referralApi/index.js) | 补邀请码或绑定资料写 updateTime | 非资料编辑也会刷新 |
| [marketApi.upsertUserRegion](../cloudfunctions/marketApi/index.js) | 写 bigregionUpdatedAt，未同步更新前两者 | 29 条有该时间，其中 7 条晚于前两者最大值 |
| [常用地点页](../pages/home/CarpoolTemplateList/CarpoolTemplateList.js) | addToSet/pull 写 pickupSpot/dropoffSpot，不更新时间 | 即使取三个字段的最大值也不能保证捕获全部最后写入 |
| [rideCompletion](../cloudfunctions/syncMyTripStatus/rideCompletion.js) | 写完成事实键与计数，不更新用户两个时间 | 不能拿用户行更新时间给每个字段排序 |

建议采用一个清晰口径：有明确记录时，canonical `updated_at` 取已验证的行级写时间 `max(updatedAt,updateTime,bigregionUpdatedAt)`，含义是**最后已记录修改时间**；保留原始值及所用规则的来源证据，不新增 profile 内的时间别名。嵌套 location 的地理来源时间不自动加入此最大值，它可能表示采集时间而非用户行修改时间。

无任何记录的 80 条应保持未知。建议统一历史保存方案允许旧数据的 canonical `updated_at` 为 NULL，新业务写始终写实际服务端时间；不能用创建时间、导出时间或 now 冒充它。现有 001 为 NOT NULL，实际实现需要新增迁移及读取排序处理，**不能编辑已部署 001，也不能现在绕过门槛导入**。如果 root 采用另一种统一历史证据方案，应在 SCHEMA 一次性决定；本审计不额外设 legacyUpdatedAt 等第二套业务变量。

即便最大值可计算，也不能用整条记录的最大时间挑选“最新联系方式”或覆盖空值：资料接口允许用户显式清空，行程同步也会更新时间。字段冲突必须按对应生产者和已确认产品语义处理。

## 缺失加入时间的证据边界

全部 3,733 条供车、188 条求车都有有效创建时间；供车只有 1 条缺更新时间。供车 4,973 个乘客对象全部有有效 joinedAt，来自 [joinTrip 的乘客对象写入](../cloudfunctions/joinTrip/index.js)。创建者/供车司机的初始成员关系可按创建动作的时间建立，不能套用到后来加入者。

| 当前缺加入时间的求车关系 | 额外乘客 | 接单司机 |
| --- | ---: | ---: |
| 关系数 | 65 | 64 |
| 匹配同当前成员的事务事件 | 0 | 0 |
| 匹配后置旧 accept/join 操作日志 | 0 | 23 |
| 匹配后置通知 | 57 | 53 |
| 至少一种后置佐证 | 57 | 56 |
| 没有上述佐证 | 8 | 8 |

乘客的 57 个通知匹配中，有 16 个关系对应多个不同通知时间；司机 53 个中有 9 个。不能简单取最早或最近通知当加入时刻：多个接收方各写通知、退出后重入、异步延迟都可能造成差异。现有代码先提交业务事务，再分别写通知；旧 `acceptRequest` 的 logAction 也在业务提交之后。日志时间最多证明“这个动作在该记录之前已经发生”，不等同事务内 joinedAt。

因此，这 129 个关系先保留已有成员身份/角色事实及 NULL 加入时间，后置日志、通知保留在唯一来源证据层，不伪造精确时间。需要与历史容量等问题一起决定可空历史成员 schema；新加入仍必须写真实服务端时间。当前 001 的 joined_at NOT NULL 在该策略实施之前仍是阻断，不应把行程 updatedAt 代入。

## 未映射资料：沿用唯一 canonical profile

初版 userInfo 顶层 UNMAPPED_FIELD 共 4,330 次，具体如下。计数表示字段出现次数，不表示用户数或坏数据数：

| 原字段 | 出现数 | 映射/保留策略 |
| --- | ---: | --- |
| region | 1,015 | 非空 423 条均为 US/CN，是电话国家，不是居住区域。映射到既有 profile.phoneRegion；有 regionPhone 时按当前页面优先用 regionPhone。 |
| address / Apartment / buildingName | 960 / 134 / 3 | 非空 187 / 75 / 3；它们可能是楼名/房间或地址。两位用户有非空值差异，不能全当同义字段或凭行级更新时间选取。明确无冲突才归入既有 location；冲突原样保留证据待处理。 |
| bigregion / bigregionUpdatedAt | 128 / 29 | 区域展示及区域更新时间；已有 region 结构能映射的部分映射，展示层级差异不要当文本冲突强行覆盖。时间按上文口径。 |
| cityKey / cityLabel | 3 / 3 | 用户区域上下文，先与 region/location 已有字段核对；不自动复制成行程 cityKey。无法表达的部分保留来源证据，待区域领域映射明确。 |
| pickupSpot / dropoffSpot | 4 / 5 | 共 8/9 个条目，都是字符串、无重复、各数组不超过 20；可直接映射到既有 preferences.pickupAddresses/dropoffAddresses，保留顺序。 |
| customPrice | 158 | 31 个账号至少一个非空默认价；fortLeeCore 非空 27、fortLeeNonCore 非空 12，重叠不能相加。仍被发车/模板默认价格读取，不能删作废字段或伪装成交价。当前 canonical profile 未包含其语义，保留来源并作为功能覆盖阻断。 |
| referralCode | 478 | 全部唯一且符合现有基于 OpenID 的确定性算法；保留外部邀请码字节，移交归因领域，不塞进 profile 或重新生成随机码。 |
| rideStats / _rideCompletionV1 | 562 / 562 | 完成计数/评分投影与已计数键。可重算的评分须用完整评分事实对账，旧完成基线不能在历史记录已删除时无损重算；保存 checkpoint 证据，不把计数相加归并。 |
| blockedUsers | 2 | 本批两个数组均空；可核对独立 UserBlocks 后不进入运行态 profile，原始记录仍归档。非空时不能沿用本条结论。 |
| userInfo | 284 | 已核对的重复 appId/openId 身份上下文；无需新 profile.userInfo。 |

补充冲突和细节：

- `regionPhone` 286 条全是 US/CN；旧 region 与其同时非空 33 条，25 相同、8 不同。当前 addInfo 使用 `regionPhone || region`、editInfo 使用 regionPhone，故采用显式 regionPhone 优先是现有字段语义，不是时间猜测；另外 390 条仅有旧代码可回填同一个 phoneRegion 字段。8 个旧值仍保存在证据层。
- `name/nickName` 没有双非空冲突；8 个 nickName 字段本批都为空。不要为迁移再创造 nickname/displayName 多份真相。
- location 共 43 个对象，其中 40 非空；这 40 个 displayName/name 均相同，lat/lng 成对。完整原始文档有 4 个 location 带额外元数据，共 47 个字段出现次；首版在身份筛选后报告 40，分母不同。provider、coordinateAccuracy、来源时间等是证据，不能当新的用户编辑属性；regionKey/city/zip 等地理含义未覆盖前不可静默抹掉。
- `regionDisplay/bigregion` 双非空 3 条全部不同，但 marketApi 一个保留完整显示，一个只拼州/区域；这是层级差异，不应自动当错值。`Apartment` 与 address/buildingName 的差异涉及 2 个不同账号，当前资料页与展示辅助函数的优先级也不同，应保留完整来源，等待统一 location 映射。
- 当前状态字段 984 条 normal、182 条缺失，未发现其他状态；这不代表可以删除未来账号限制语义。全局 role 159 driver/446 passenger/561 缺失，来自最近操作模式，不能作为所有行程权限。

## 可自动处理与保留未知的清单

在统一来源证据保存、回归样例及下一版 normalizer 实施后，可以自动处理：主身份唯一账号映射；无冲突 canonical 资料；明确创建时间别名；已记录更新时间最大值；电话国家字段的生产者优先级；常用地址数组；重复嵌套身份核验。两份 openid-only 文档只作来源关联，不创建第二账号、不恢复无证据权限。

必须保留未知或继续阻断：缺身份文档；80 个未知用户修改时间；129 个未知求车加入时间；不存在行程的旧索引；2 个地址差异账号；当前 canonical 未覆盖的有效默认报价和部分地理信息；完成计数基线及归因功能的完整迁移。无损意味着**原始内容和判断依据仍可追溯**，不是所有历史字段都必须继续成为可写 profile 属性。

执行前验收至少包括：1,163 主账号唯一、两份交叉来源可追溯、无身份记录不获得账号；逐用户 canonical profile 与原来源按显式规则对账；NULL 时间不会被排序/展示误当现在；成员权限只来自已核实事实；原始证据与业务主表职责分开；依旧存在任何未决实际功能时不切主业务。

## 复核与证据

本次仅在本地内存读取 JSON 并输出固定字段名、计数、类型和相等性结果；没有另存原始资料。源文件保持私有目录原状。用于复核的 SHA-256：

| 文件 | SHA-256 |
| --- | --- |
| userInfo.json | 0d82bf60de0729acb0c9279a2056f744804dadee5109edb67fbf778608ee86e5 |
| Carpool.json | 021fdb0d70c794e176706917e2ec8f34e41513b1778d21cbd26ce45133adca33 |
| CarpoolRequest.json | f19d8b591ace5804df3e5558ffa8a76fda206861f6d43ad8d18561af2cbde356 |
| TripActions.json | bda9ec4e4bd5f34446a6e978a5a8cd505ca610feacda09181193a1ef8e1d18f7 |
| Notifications.json | 5eefc47e6a1d50c43d8ec047f6fc3dc1063ba727223293c104e54e1a74e78294 |

本批生产者解释以当前源码和 Git `44cbc3e` 为证据，不把仓库最早可查代码当作更早年代的部署证明。提取以来线上仍在变化，实际迁移必须重新对账，不能把本文的静态数量当作切主时刻的验收数量。
