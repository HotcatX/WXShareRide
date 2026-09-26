# CloudBase 数据迁移只读审计（2026-09-25，美东时间）

本次完成 48 个实际集合的首尾清单核验，以及其中 **32 个业务/配置集合的完整 keyset 扫描**，得到 **16,841 条文档**。32 个单集合 JSON 合计 **10,212,062 bytes（约 9.74 MiB）**，共 91 页（包括每个集合末尾的空页）。每集合 `_id` 唯一、升序游标遍历到空页、文件 SHA-256 已复核。

**这是在线数据库的只读审计提取，不是原子快照，也不是全 48 集合的完整备份。当前 normalizer 的 `ready=false`，禁止据此直接切换主库。** 线上业务继续使用 CloudBase；本次没有导入、回写、修改、新建集合或部署云函数。

## 范围、时间与计数漂移

环境：`cloud1-7gmtcu4s3aebce27`，AppID：`wx8a8a389199aa2a0e`。已按 `cloudbase-operator` 工作流先读结构，再读文档。CLI 没有提供直接导出入口，本次使用 `cloud_db_read_doc`，按 `_id` 升序、每页 500 条、下一页 `_id > lastId`，不用易受插入/删除影响的 offset 分页。

时间如下（UTC；美东为前一日 22 点）：

| 观测 | UTC 时间 |
| --- | --- |
| 初始 48 集合结构响应落盘 | 2026-09-26 02:02:48.267 |
| 首批 userInfo 500 条响应落盘 | 2026-09-26 02:05:13.070 |
| 批量遍历开始 | 2026-09-26 02:06:58.847 |
| 32 集合遍历结束 | 2026-09-26 02:08:46.622 |
| 最终结构核验完成 | 2026-09-26 02:11:18.733 |

首次 userInfo 页在分页脚本启动前已成功读取并复用，manifest 已单独记录这一点；响应落盘时间不是请求开始时间。初始全清单 16,910 条，结束全清单 16,912 条。

| 集合 | 开始清单 | 实际导出 | 结束清单 | 结论 |
| --- | ---: | ---: | ---: | --- |
| TripActions | 1,549 | 1,549 | 1,551 | 导出后仍有新增活动，提取不含结束时的全部事件 |
| market_view_events | 485 | 486 | 485 | 扫描结果与首尾清单计数不同；可能存在期间变更或清单计数时延，不能认定为同一时点快照 |
| 其余 30 个已扫描集合 | 相等 | 相等 | 相等 | 数量相等不证明内容期间未更新 |

keyset 扫描避免普通 offset 位移，但新增文档的 `_id` 若小于已读游标仍可能漏入本次提取；删除、更新也可能使跨页结果属于不同时刻。未来切主前仍需冻结写入或经验证的增量追平及业务级核对。

## 已扫描的 32 个集合

表中 bytes 是 compact 单集合 JSON 的实际字节数，不是腾讯云存储计费容量；页数包含末尾空页。

| 集合 | 初始清单数 | 导出条数 | 页数 | JSON bytes |
| --- | ---: | ---: | ---: | ---: |
| userInfo | 1166 | 1166 | 4 | 1,449,554 |
| Carpool | 3733 | 3733 | 9 | 3,816,138 |
| CarpoolRequest | 188 | 188 | 2 | 133,222 |
| CarpoolTemplate | 137 | 137 | 2 | 66,241 |
| Notifications | 8268 | 8268 | 18 | 3,405,519 |
| TripActions | 1549 | 1549 | 5 | 616,560 |
| UserBlocks | 62 | 62 | 2 | 17,126 |
| TripRatings | 40 | 40 | 2 | 16,022 |
| MyTrips | 443 | 443 | 2 | 95,043 |
| MyTripHistory | 443 | 443 | 2 | 272,206 |
| market_goods | 25 | 25 | 2 | 47,431 |
| houseShare | 1 | 1 | 2 | 1,631 |
| MarketFiles | 130 | 130 | 2 | 66,070 |
| MarketAdFiles | 0 | 0 | 1 | 2 |
| market_ads | 1 | 1 | 2 | 783 |
| market_ad_events | 128 | 128 | 2 | 31,629 |
| market_view_events | 485 | 486 | 2 | 153,600 |
| MarketImportBatches | 1 | 1 | 2 | 518 |
| community_config | 1 | 1 | 2 | 605 |
| CommunityConfigHistory | 6 | 6 | 2 | 5,838 |
| CITY_TREE | 3 | 3 | 2 | 450 |
| cityTree | 1 | 1 | 2 | 2,978 |
| regionTree | 1 | 1 | 2 | 8,238 |
| Departure | 1 | 1 | 2 | 198 |
| Arrival | 1 | 1 | 2 | 198 |
| Departure_Request | 1 | 1 | 2 | 202 |
| Arrival_Request | 1 | 1 | 2 | 196 |
| Request_Price | 16 | 16 | 2 | 1,815 |
| PublicStats | 1 | 1 | 2 | 306 |
| feedback | 3 | 3 | 2 | 702 |
| ride_city_demand | 2 | 2 | 2 | 568 |
| ride_city_demand_events | 2 | 2 | 2 | 473 |

## 仅盘点、未读取文档的 16 个集合

这 16 个集合初始合计 70 条，涉及后台账号、凭证/会话、管理配置/审计及空集合。未把它们伪装成空数组并交给迁移器。它们不阻止完成本次业务数据审计，但仍是完整恢复与后台服务迁移的范围缺口。

| 集合 | 初始清单数 |
| --- | ---: |
| MarketAdminSessions | 7 |
| MarketAdminSettings | 1 |
| MarketAdminTemplates | 0 |
| WebAdminAccounts | 1 |
| WebAdminAuditLogs | 31 |
| WebAdminLoginAttempts | 2 |
| WebAdminSessions | 15 |
| WebAdminSettings | 1 |
| WebAdminUploads | 10 |
| market_admins | 1 |
| relation_data_depart | 0 |
| relation_data_depart-preview | 0 |
| sys_department | 0 |
| sys_department-preview | 0 |
| sys_user | 1 |
| sys_user-preview | 0 |

后续应先查明后台账号及会话的真实使用方、有效期和哈希/密钥依赖，再决定凭证是否迁移或重建；业务管理配置、上传元数据及审计日志需建立独立映射。空集合应先核对当前代码依赖，再决定是否不建。任何有意不迁移的集合都需进入明确清单，不能静默跳过。

## 首版 normalizer 的结果及解释

使用 `services/backend/src/migration/analyze.ts` 对 core 四集合及全部 32 选定集合分别运行，均只打印聚合 report，均返回 `ready=false`。输入 JSON 的 `kind: cloudbase-full-export` 是现有解析器要求的格式标签，**不代表本提取已经满足全库或原子快照条件**。

| 类型 | 输入条数 | 首版候选数 |
| --- | ---: | ---: |
| userInfo | 1,166 | 1,163 users |
| Carpool + CarpoolRequest | 3,733 + 188 | 3,921 rides |
| 从行程派生的参与关系 | — | 9,022 members |
| 从行程派生的站点 | — | 7,843 stops |
| 其余 29 个选定集合 | 11,754 | 尚无业务迁移映射 |

**候选数不是可导入数。** 当前 normalizer 即使发现错误仍构造候选对象，候选中存在首版默认值；不得绕开 `ready` 使用 plan 导入。模板 137 条、通知 8,268 条、事件 1,549 条等均仍需专门模型。

以下是当前规则产生的 issue 次数；同一文档可能命中多项，未映射字段是字段出现次数，不能相加称为“坏记录数”。

| issue | userInfo | Carpool | CarpoolRequest | 判断 |
| --- | ---: | ---: | ---: | --- |
| UNMAPPED_FIELD | 4,330 + location 子项 40 | 16,489 | 585 | 首版字段白名单未覆盖历史格式，需逐字段对齐 |
| UNMAPPED_CITY | — | 2,683 | 119 | 均为缺失 cityKey；不是识别出异常城市 |
| UNRESOLVED_PRICE | — | 1,137 | 170 | 首版价格格式过窄或旧价格语义尚未定义，详见下表 |
| CONFLICTING_ALIASES(updatedAt) | 388 | — | — | 两个可解析更新时间不同，需要旧写入逻辑确定含义 |
| MISSING_OR_INVALID_TIMESTAMP(updatedAt) | 80 | 1 | — | 尚无可用时间，不能伪造业务时间 |
| DUPLICATE_OPENID | 2 | — | — | 同一身份的后续重复文档；需比对和合并策略，不能任意删除 |
| MISSING_OR_INVALID_IDENTITY | 1 | — | — | 需查明是否旧导入/异常文档，不能凭空分配身份 |
| SEAT_BALANCE_MISMATCH | — | 596 | — | 候选模型下座位与参与人数不一致，须核对旧版人数语义及历史状态 |
| SEAT_CAPACITY_EXCEEDED | — | 227 | — | 同上，尚不能直接认定旧业务数据错误 |
| INVALID_SEAT_COUNT | — | 57 | — | 需核对旧字段类型和零/缺省含义 |
| MISSING_MEMBERSHIP_TIMESTAMP | — | — | passengerID 65 / driverOpenid 64 | 老记录缺少参与时间，需明确可接受历史标记 |
| CREATOR_MISSING_FROM_MEMBERS | — | — | 1 | 核对创建者/参与者规则 |
| DUPLICATE_MEMBER | — | — | 1 | 核对旧索引是否可重复，避免迁移重复关系 |
| UNRESOLVED_LEGACY_MEMBERSHIP | 7 | — | — | 用户历史索引与行程成员关系待核对 |

此外，首版为 3,681 条 Carpool、186 条 Request 候选设置初始版本（notice），将 602 条用户旧 role 作为旧角色信息而非直接成员关系（notice）。32 集合分析中有 28 个非空额外集合触发 `UNMAPPED_COLLECTION`；另一个额外集合为空。完整 issue 汇总在私有 report 中。

## 价格、城市和时间字段的脱敏分类

分类脚本只输出固定格式类别或代码中已有的公开城市名，不输出未识别价格文本、地址、姓名或身份。

| referencePrice 类别 | Carpool | CarpoolRequest |
| --- | ---: | ---: |
| 当前解析器接受的纯数字字符串 | 1,536 | 16 |
| 当前解析器接受的数字 + $/人 | 1,046 | 2 |
| 字段缺失（当前可解析为 null） | 14 | 0 |
| 币种后缀 | 251 | 1 |
| 币种前缀 | 41 | 0 |
| 其他单位后缀 | 9 | 0 |
| 数字区间 | 1 | 2 |
| 其他字符串（不披露原值） | 835 | 167 |

当前规则仅接受纯数字/数字字符串和特定 `$/人` 后缀。前后缀、区间及其他字符串必须依据旧 UI、云函数及价格选择配置解释，不能用“提取第一个数字”代替。牌面价是发布时的价格信息，也不能凭它推断实际线下成交。

- Carpool：1,050 条具有公开 `ny_nj` / `纽约/新泽西`；2,683 条两个字段均缺失。
- CarpoolRequest：69 条具有相同公开城市标记；119 条两个字段均缺失。
- 不存在本次白名单统计中另一个未知城市值；但缺失城市仍需从发布规则/版本证明来源，不能只按现有用户群猜填。
- 全部 1,166 条用户：`updatedAt` 有效 Date wrapper 467 条、缺失 699；`updateTime` 有效 Date wrapper 1,083 条、缺失 83。
- 两个字段均有效时：相同 75 条，`updatedAt` 较新 47 条，`updateTime` 较新 342 条。另有仅 `updateTime` 可用 619 条、仅 `updatedAt` 可用 3 条、都不可用 80 条。全用户两个日期不同共 389 条；normalizer 在身份筛选后报告 388 次，分母不同。

以上证据说明相当一部分阻塞来自**首版 schema/解析规则未覆盖旧格式**。重复身份、缺失身份及候选座位矛盾需要另行调查，但本审计不擅自修正线上数据。

## 私有产物、复现入口及保护

原始数据目录（仅本机，gitignored，目录 0700、文件 0600）：

`/Users/cat/Documents/Github/wx/data/backend-migration-20260925/`

精确 manifest 路径：

`/Users/cat/Documents/Github/wx/data/backend-migration-20260925/export-manifest.json`

目录内容：

- `collections-start-response.json` / `collections-end-response.json`：48 集合首尾清单。
- `<Collection>.json`：32 份完整 keyset 扫描结果；`<Collection>-page-NNN-response.json`：原始分页响应，仅私有落盘。
- `selected-collections-export.json`：全部 32 个选定集合的 normalizer 输入。
- `core-collections-export.json`：userInfo / Carpool / CarpoolRequest / CarpoolTemplate 输入。
- `core-normalization-report.json` / `selected-normalization-report.json`：仅聚合问题和候选计数。
- `format-patterns-report.json`：价格格式、公开城市类别、日期表示分类。
- `export_readonly.py`：本次只读分页脚本；为保护本批数据，已有完整输出时再次运行会拒绝覆盖。新批次须用新的私有目录并先重新读取结构；不要将旧响应复用到新的时间窗口。
- `audit-patterns.mjs`：重跑上述脱敏格式分类；不请求云端、不写生产。

只读解析入口（在仓库根运行，stdout 仅聚合报告；非零退出表示未满足迁移门槛）：

```sh
node services/backend/src/migration/analyze.ts data/backend-migration-20260925/selected-collections-export.json
node data/backend-migration-20260925/audit-patterns.mjs
```

本次 CLI 若用 PIPE 捕获大响应会在 65,536 bytes 截断；实际导出改用受保护的普通文件作为 stdout，逐页 JSON 解析成功后才纳入结果。没有把命令的原始响应、临时 URL 或个人资料打印到终端。`data/` 已被 Git 和小程序打包忽略。

## 迁移前尚需完成

1. 按旧代码逐字段确定用户、行程、成员、价格、城市、时间及模板语义，更新 normalizer；每个被舍弃字段都要有明确理由。
2. 对重复身份、成员关系、座位及历史状态逐类核对，保留原始依据；不能将候选默认值当成已验证数据。
3. 为通知/行为/模板/集市/配置及仅盘点集合明确迁移、归档或重建策略，再定义真正的完整迁移范围。
4. 在独立数据库 dry-run 导入并验证数量、关系及 API 行为；原始库保持只读。导入前必须让适用集合的审计门槛通过。
5. 正式切换前生成新的完整导出并追平持续写入，验证幂等与回滚；本批数据只作格式审计及迁移开发依据。
