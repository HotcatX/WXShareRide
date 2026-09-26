# 给实施代理的提示词：拼车研究数据基础与轻量结果回访

编写日期：2026-09-22。已按当前本地代码复核。以下正文可直接交给负责开发的代理；本轮只编写方案，没有实现或部署功能。

---

你接手 `/Users/cat/Documents/Github/wx` 微信小程序。请实现一个可审查、可测试、可逐步启用的研究数据采集版本，为后续预约拼车、候选推荐、取消与重复合作研究建立数据基础。不要只提交计划。先核对当前代码，再完成本地实现、针对性测试、数据字典、部署步骤与验收证据。

本任务的主要产品决策是：**保留两个回答按钮“是／否”，提供独立的关闭入口；用低频前台回访收集具体预约的实际同行自报，并补齐意向、候选与业务生命周期。** 优先保留完整的高价值事件与结构化选择集；最新截图显示套餐容量额度3GB、调用额度20万次，不能按容量无限设计。研究质量取决于含义、关联和完整性，不能用高频重复记录代替有效样本。

新增约束：用户当前调用次数不足，必须遵循[低调用采集方案](low-call-collection-plan.md)。默认本地队列＋随已有认证请求附带批次；不要按每次行为调用或每20–30秒固定上报。业务成功事实在原业务事务内记录，不额外转调采集函数。明确报告节省的是客户端请求、函数执行还是数据库写入，不把它们混为一个数字。

长期架构备选见低调用方案的“独立研究采集服务”：保留CloudBase业务，客户端行为可批量直传独立HTTPS接收器，核心事实通过事务outbox成批导出。本次只要求采集协议和传输实现可替换；用户尚未决定迁移，不擅自新增生产服务器、购买资源或切换目的端，也不同时启用两套上传。截图单日调用不能当稳定月均，当前调用量尚不包含本方案未实现的研究采集。

后续已补[独立采集服务与调用模型](independent-collector-and-call-model.md)，含控制台只读证据、前后端调用审计、身份与撤回、归档和费用模型。**最新用户约束：采集基础设施全部部署腾讯云；托管选型以[腾讯云低成本采集方案](tencent-only-collection-plan.md)为准，旧Workers/D1/R2方案不再是实施默认。** 完整研究采集首选Lighthouse＋同机SQLite事务数据库＋COS备份；独立SCF函数URL＋COS仅是低执行费比较项，缺少可靠状态层时不作为完整方案。COS不能等价替代SQL事务，先冻结状态合同、做并发故障测试，再启用采集。每访问1–3批只是情景预算；独立接收器可配置前台积压60秒刷新，不适用于CloudBase通道。先修历史页/推荐访问重复并保留业务事务，独立服务不会自动减少当前业务调用。域名、地域、证书、计费告警及上线步骤须写入可审查部署清单，不凭本提示词购买或部署。

本次开发交付本地可审查版本。不得擅自部署、上线研究采集或用户实验、删除云端记录、修改已有公开计次含义。已有研究工作在 `research/paper-feasibility-2026-09-22/`；先阅读 `decision-and-protocol.md`、`data-audit.md`、`miniprogram-collection-plan.md`。本提示词细化了第一版“是／否”回访，替代旧方案在首屏同时展示多个结果选项的交互；不改变未知结果、参与身份和证据分级的要求。

新增接入前提：先阅读[微信网络要求核验](evidence/weixin-network-requirements.md)。独立HTTPS直传须核验当前小程序主体、接口域名ICP备案及服务器域名配置；境外服务器不自动豁免微信域名规则。现有CloudBase运行成功或开发者工具关闭域名校验，均不证明独立域名在正式环境可用。账号资格未验证时可以继续本地开发和合成测试，但不得声称海外直连已可上线；不要为规避域名校验实施临时备案、虚假备案或开发调试豁免。

账号实查补充：阅读[腾讯云账号与报价核验](evidence/tencent-account-feasibility.md)。个人版可用作备案资源，但当前期限不足、云托管固定IP未开；不得擅自同意云托管条款、启用、续费或变更计费。用户选的288元/年硅谷2核2GB活动机明确不支持调整配置，扩容按新机迁移设计。独立研究采集只隔离新增研究请求，不能把现有业务调用自动减少计入收益。

## 一、必须先掌握的真实代码结构

下表行号用于定位，以实际函数为准；禁止直接假定线上部署与本地相同。

| 位置 | 当前机制 | 实施要求 |
| --- | --- | --- |
| [app.js:88](/Users/cat/Documents/Github/wx/app.js:88)、[app.js:112](/Users/cat/Documents/Github/wx/app.js:112) | 云初始化、前台生命周期、朋友圈预览与推荐码 | 复用全局生命周期；不在全局无条件弹窗，不影响分享预览 |
| [home.js:389](/Users/cat/Documents/Github/wx/pages/home/home.js:389) | 首页刷新、自动社区公告、城市选择等 | 增加低频回访协调，与既有弹层互斥；隐藏、切号和旧请求返回时不弹 |
| [tripHistory.js:17](/Users/cat/Documents/Github/wx/pages/profile/tripHistory/tripHistory.js:17)、[getMyTripHistory/index.js:56](/Users/cat/Documents/Github/wx/cloudfunctions/getMyTripHistory/index.js:56) | onLoad/onShow双入口；历史ID回填存活正文，缺失项被过滤 | 去重请求；独立“待确认/已回答”入口，不能仅从存活历史卡片生成回访 |
| [createTrip/index.js:205](/Users/cat/Documents/Github/wx/cloudfunctions/createTrip/index.js:205) | Carpool/CarpoolRequest发布已有事务 | 事务内记录发布事件、版本、必要基线；补稳定操作幂等键 |
| [joinTrip/index.js:167](/Users/cat/Documents/Github/wx/cloudfunctions/joinTrip/index.js:167)、[joinTrip/index.js:249](/Users/cat/Documents/Github/wx/cloudfunctions/joinTrip/index.js:249) | 两类加入已有事务；重复加入有分支 | 成功业务、参与段、事件同事务；重复加入不新建参与段 |
| [tripManage/index.js:289](/Users/cat/Documents/Github/wx/cloudfunctions/tripManage/index.js:289) | Carpool踢人、删除、退出仍有非事务读改写 | 必须将相关状态与事件原子化，覆盖并发；不能仅加一个事后日志调用 |
| [tripManage/index.js:260](/Users/cat/Documents/Github/wx/cloudfunctions/tripManage/index.js:260)、[tripManage/index.js:466](/Users/cat/Documents/Github/wx/cloudfunctions/tripManage/index.js:466)、[tripManage/index.js:561](/Users/cat/Documents/Github/wx/cloudfunctions/tripManage/index.js:561) | Request退出、删除和接单已有事务 | 在原事务内增加最小记录，保留既有业务权限和人数语义 |
| [tripManage/index.js:124](/Users/cat/Documents/Github/wx/cloudfunctions/tripManage/index.js:124)、[tripActionReason.js:204](https://github.com/HotcatX/WXShareRide/blob/88a9221/pages/profile/tripActionReason/tripActionReason.js#L204) | 日志可能吞错误；旧页面先写尝试再做业务 | 旧TripActions标明来源/局限，不能当新系统成功事实或取消率真值 |
| [syncTripStatus/index.js:288](/Users/cat/Documents/Github/wx/cloudfunctions/syncTripStatus/index.js:288)、[syncMyTripStatus/index.js:215](/Users/cat/Documents/Github/wx/cloudfunctions/syncMyTripStatus/index.js:215) | 过计划出发时刻即可past；另有个人计次台账 | 只记录时间状态变更；实际同行自报另存，不能覆盖rideStats和结算凭证 |
| [carpoolList.js:401](/Users/cat/Documents/Github/wx/pages/home/carpoolList/carpoolList.js:401)、[carpoolList.js:928](/Users/cat/Documents/Github/wx/pages/home/carpoolList/carpoolList.js:928)、[carpoolList.js:1223](/Users/cat/Documents/Github/wx/pages/home/carpoolList/carpoolList.js:1223) | 缓存、日期分页、客户端筛选和隐藏满员 | 区分服务端返回、实际渲染、几何曝光；保留缓存和覆盖范围 |
| [newTrip.js:739](/Users/cat/Documents/Github/wx/pages/home/newTrip/newTrip.js:739)、[tripDetail.js:746](/Users/cat/Documents/Github/wx/pages/home/tripDetail/tripDetail.js:746) | 单点出发时刻与加入操作 | 意向和时间弹性须明确输入；成功以服务端为准 |
| [rideTime.js:1](/Users/cat/Documents/Github/wx/utils/rideTime.js:1)、[tripDetailCache.js:1](/Users/cat/Documents/Github/wx/utils/tripDetailCache.js:1) | 纽约时区/DST、详情预取与缓存 | 统一时间解析；预取不算详情阅读 |
| [privacy.wxml:1](/Users/cat/Documents/Github/wx/pages/other/privacy/privacy.wxml:1)、[profile.js:111](/Users/cat/Documents/Github/wx/pages/profile/profile.js:111) | 已有用途说明及个人中心 | 在现有入口增加清楚的研究用途与参与管理，不混同微信接口隐私授权 |

额外核查全部写入Carpool/CarpoolRequest的路径和所有参与角色：司机发车、求车创建者、求车额外乘客、接单司机、退出/剔除/删除。不要只覆盖最常见页面。当前未发现研究采集SDK或微信订阅消息发送实现；首版不以订阅消息为依赖。

## 二、“是／否”回访的确定交互

### 乘客第一版

使用可关闭的自定义轻弹层，复用现有视觉样式，不增加UI库。内容示例（日期与路线来自本人有权查看的预约）：

> 确认一下这次拼车
>
> 9月21日 18:30 · Fort Lee → 哥大
>
> 这次预约，您实际坐上这趟车了吗？
>
> **否　　是**

右上角提供“×”，语义为暂不回答。回答可以在历史入口更正。不要问含糊的“行程是否完成”“是否满意”，不要把成行和评价混成同一个问题。

- 只有点击“是”或“否”并收到服务端确认，才产生有效答案；接口失败保留待提交状态，不能假装保存成功。
- 关闭、切后台、页面卸载、弹层未出现、接口失败、无回访，均不产生“否”。`answer`允许空值，`responseStatus`独立保存。
- “是”仅表示自报乘上该预约车辆，不能推断到达、准点、付款、整团人数或减排。
- “否”仅表示该次预约没有实际搭乘，不等于完全没出行或平台造成失败。
- “否”提交后可在**同一轻卡片**提供可跳过的后续选项：“后来用了其他平台行程／其他渠道拼车／公共交通或其他方式／没有出行／不说明”；可选原因枚举独立于实际出行方式。禁止自动连弹多层、强制原因或默认自由文本。
- 如用户表示改期/尚未结束，经鉴权的答案接口记录 `followup_deferred` 和可选自报新时间，`answer`仍为空；若刚刚误答，先作有版本的撤销/修订，不能用客户端埋点清空已确认答案，也不能把延期永久归为失败。回访延期不自动修改原业务发车安排。

### 司机回答与双边验证

司机问题必须对应**具体预约关系**：“这次预约，您实际接送了这位预约乘客吗？”授权的业务UI可展示已有昵称等帮助辨认；研究事件不复制姓名或联系方式。司机端第一版优先在历史详情显示待确认列表，最多每天主动邀请一项，不连弹整车乘客。

司机只回答“这趟车出发了”不能确认所有乘客。字段分开定义：`reporterRole`是乘客或司机，`subjectScope=bookingAccountPerson`指双方正在确认的同一位预约账号本人；司机是观察报告者，不把司机本人作为问题对象。只有双方针对同一乘客、车辆/司机及服务时次的答案才允许合并：`bothYes / bothNo / oneSideYes / oneSideNo / conflicting / unknown`；保留回答来源和修订历史，不向对方展示答案，不关联评分奖励或处罚。

团体预约中一个账号可能代表多人。乘客首问只确认预约账号本人，司机对应地确认是否接送这位本人，不把“是”乘以预约人数。代订或司机不能辨认本人时允许关闭/跳过并可选标记 `proxyBooking/subjectUncertain`，不把“接到了某位同行人”转换为账号本人yes。若以后需要全组实际人数，使用独立可选人数问题和 `subjectScope=party`，不能改变旧问题含义，也不能与个人答案直接做一致性合并。

### 资格、时间与不打扰规则

1. 用独立 `eligibleAt`，不监听past即弹。首版自动回访采用纽约服务日期次日09:00之后的首次合适前台访问；这是保守回访策略，不是到达判定。夜间、长途、已知延期采用更晚的配置或仅手动入口；无法判断是否属于例外时走手动入口，不能一刀切推定结束。
2. 仅限本人授权参与的数据、已建立可信参与关系且尚未完成该项回答的任务。退出/取消的预约也需要结果观测，按原计划窗口之后回访；不因正文删除或成员退出自动排除。
3. 默认每前台访问最多一次、每账号每服务日最多一次；每个问题对象最多两次自动邀请，两次至少间隔24小时。7天后停止自动邀请，历史页仍可补答并记录回忆时滞。`autoInviteExpiresAt`与回答资格/保留期限分开：自动邀请过期不禁止仍有授权的手动补答和更正。这些是可配置产品默认值，不是统计充分条件。
4. 与社区公告、登录/隐私说明、城市选择及当前提交流程互斥；用户正在填写发布表单不弹。首页不合适就延后，不要强求每次访问展示。
5. `claimPrompt`在同一事务锁定**账号×纽约日期的自动邀请额度**和具体任务，防止多端分别领取不同任务同时弹窗；短租约只允许当时有效的领取者展示。领取不等于展示，分开记录eligible、claimed、shown、dismissed、answered、autoInviteExpired；shown按invitationId幂等回报。明确未展示的取消可释放；但无shown回包可能是已经显示而网络丢失，不能自动认定未展示并再次发放。租约到期而状态不明时采用保守的当日不再自动邀请，保留 `displayUncertain`，不计为已观测展示。历史手动补答不占自动额度。
6. `onLoad/onShow`及多页面复用同一请求/会话协调器。账号切换、隐藏、过期响应、游客和朋友圈预览均须阻止错误弹出。
7. 一次重试、一段退出后重加，不自动导致同一事实被问两次。建议回访目标按“本人×行程×对方×明确服务时次”去重，关联一个或多个参与段；改期、换司机和多段加入需要显式归属。不能仅按 `questionVersion` 变化给旧用户重新弹问。

普通 `wx.showModal` 的确定/取消分支不适合直接承载“答案与暂不答”三种语义。使用自定义组件区分按钮和关闭；参考[微信官方showModal文档](https://developers.weixin.qq.com/miniprogram/dev/api/ui/interaction/wx.showModal.html)，不要把 `cancel` 或 `fail` 自动转换成负面结果。

## 三、除弹窗之外，必须准备的数据

按以下顺序实现，不启动推荐实验、不改现有排序。

| 优先级 | 数据与粒度 | 采集位置/方式 | 未来能回答什么 |
| --- | --- | --- | --- |
| P0 | 每次成功发布、加入/接单、退出、剔除、取消、关键改期/容量变更的前后版本 | 服务端业务事务；覆盖所有入口 | 预约提前量、席位占用、晚释放、重新匹配；不再只看到幸存行程 |
| P0 | 每段参与和每个结果问题的资格、邀请、回答与修订 | 独立参与台账和回访服务 | 预约与自报同行的差距，失访和双边冲突 |
| P1 | 每个明确出行意向及修改版本 | 找车页自愿“记下这次找车”入口；求车表单复用 | 真正需求分母、没预约的需求；搜索不自动算意向 |
| P1 | 可接受时间窗、人数、接送区域 | 可跳过的小控件，默认未知；记录此前曝光和预填来源 | 时间错配与替代候选潜力，不虚构±30分钟弹性 |
| P1 | 选择集、当时显示余位和版本、已加载日期范围 | 网络返回/缓存恢复与客户端最终筛选分别记录 | 用户当时有哪些可见机会，推荐与重复配对的竞争解释 |
| P1 | 最终渲染、几何可见、点击、详情实际打开、联系入口操作 | 轻量前端事件，批量上传 | 选择漏斗；预取不是阅读，复制联系不是成交 |
| P1 | 零结果及“没有合适车辆” | 分开保存浏览零结果与用户主动确认的失败意向/原因 | 缺供给、时间/地点不合与加载故障的区别 |
| 后续可选 | 司机确认可售余位、线下占座、自报实际人数 | 司机管理页可选控件，版本化保存 | 座位不确定性；不能从成员账号数直接得出载客率 |

一次意向可关联多次搜索和预约，刷新不新建需求；同账号同日多次出行不能强并。普通浏览保持 `intentId=null`。隐私找车登记与公开求车必须分别选择，不能自动公开。

时间与地点的“不填写”都是未知，不是零弹性、无限弹性或区域内任意点可接受。有硬到达期限而没有可靠行程时长时，保存条件未知；首版不承诺准点。支持现有固定点/区域键，研究导出不复制具体住宅地址。

### 长期价格研究的低负担预留

根据后续讨论，把**被动价格快照**纳入P1；不实现动态定价、不改变现有报价规则、不扩大第一版是/否弹窗。具体依据见[动态定价研究补充](pricing-research-note.md)。

- 发布时区分 `priceKind=driverReference|configuredRequestReference|unknown`，记录 `priceSource=manual|personalDefault|platformDefault|template|requestConfig|unknown`、预填/最终金额、来源版本及是否手改。可验证的服务端配置来源与客户端编辑自报分开，不把Request固定参考价当乘客支付意愿。
- 在选择集保存实际显示价格、单位、价格表示类型及格式化版本；加入/接单事务保存提交时参考价与版本，关联用户所见价格、参与段和席位单位。名称用 `referencePriceAtCommit`，不能写成 `paidPrice/agreedPrice`。
- 金额用整数分，币种与单位明确；区间保存上下界，议价/未知保持类型，不照搬只取首个数字的展示函数。币种由什么规则确定要有记录，无法核验则unknown；不将自由文本原样导入研究数据。
- 当前没有正式行程改价/拼车付款事实：模板或个人默认价修改不是已发布行程改价，复制Zelle也不是支付。只为未来priceChange事件预留合同，不制造旧历史；真实约定/支付金额若要自报，另设未来可选研究模块。

## 四、统一数据与接口合同

先输出并冻结 `docs/ride-research-data-contract.md`，再让多个代理并行。命名可遵循仓库习惯，但必须统一类型、缺失语义、时间单位、版本及事件枚举。下列为建议结构，按实际需要保持简单。

- `RideResearchEvents`：追加事件；业务成功事件只由服务端生成。至少含 `eventId/eventName/schemaVersion/source/actorKey/role/occurredAt/receivedAt/operationId/tripType/tripKey/tripVersionBefore/tripVersionAfter/membershipId/intentId/seatUnits/reasonCode/instrumentationVersion`，按类型选择字段，不复制整份业务正文。
- `RideMemberships`：一次加入到退出的参与段、双方研究标识、席位单位、服务时次及开始/结束事件。退出关闭，重加建新段；保留必要的删除前事实。Request创建者、额外乘客和接单司机按真实语义关联。
- `RideOutcomeFollowups`：问题目标、本人授权关系、`eligibleAt/autoInviteExpiresAt/questionVersion/reporterRole/subjectScope/promptPolicyVersion/claimLease/shownCount/status/answerVersion`；答案与修订用追加事件留存，投影可更新。账号日额度单独按确定性键维护，不能只锁同一followup。
- `RideIntents`：明确意向的最新状态，变更另留事件；期望时刻、显式时间窗、人数、可接受地点键、`priorExposure/prefillSource`和每项缺失状态。
- `RideChoiceSets`：只保存结构化选择集合及必要版本。服务器返回集合和客户端合并过滤后的渲染集合分开；`resultSetId/renderSetId/coverage/cacheSource/cacheAge/rankingVersion/filterState`关联到每项 `tripKey/versionSeen/position/status/displayedSeatCount`。相同内容可存一次并引用，不能将server集合自动当render集合。
- 研究参与状态与身份映射单独受限保存；研究身份由服务端随机映射或HMAC生成，不能用客户端可伪造身份、公开openid或不加密钥的散列。它是可关联假名，不是完全匿名。

一个 `rideResearch` 云函数可承载 `getPendingFollowups/claimPrompt/recordPromptEvent/submitOutcome/reviseOutcome/upsertIntent/ingestClientEvents/updateResearchPreference` 等动作，避免无必要地新增许多云函数。业务成功事件仍在原业务函数事务内写，不通过事后跨函数调用伪装原子性。

上述动作是逻辑能力，不要求每项都独立往返调用。自动回访将查询下一项与领取合并为 `getAndClaimNext`，认证首页/历史请求顺带返回下次到期提示；回答请求可同时携带shown和行为批次。业务结果与telemetryAck分别返回，低优先级批次失败不影响主要业务；共享采集助手本地执行，禁止为每个附带批次再转调另一云函数。受限客户端批次可采用 `RideTelemetryBatches` 单账号不可变批文档，不能把核心业务台账也变成无法可靠查询的数组。

核心接口示意：

```text
submitOutcome({followupId, answer: 'yes'|'no', operationId, expectedVersion})
  -> {ok, answerVersion, savedAt, duplicate}
reviseOutcome({followupId, action: 'setAnswer'|'withdrawAnswer'|'defer', answer?,
               newPlannedTime?, operationId, expectedVersion})
  -> {ok, answerVersion, savedAt, duplicate}
recordPromptEvent({followupId, invitationId, event: 'shown'|'dismissed', eventId})
ingestClientEvents({schemaVersion, events: [...]})
  -> {ackedEventIds, rejected: [{eventId, code}], retryableEventIds}
```

`submitOutcome/reviseOutcome`从 `getWXContext().OPENID`校验本人、对应参与关系、问题范围、回答资格和版本；自动邀请过期与回答授权过期不能混用。撤回参与后拒绝新研究回答；不能凭客户端传actorKey授权。更正、撤销和延期均须事务检查版本、保留被替代答案，不静默最后写覆盖；延期后的当前答案为空，新时间只影响回访计划。重复operationId且payload相同返回原结果，payload不同应拒绝。`shown/dismissed`只是客户端报告，身份可信不等于实际注意力已证明。

客户端研究事件不允许使用发布成功/加入成功等服务端专用事件名，不允许伪造他人actor、arm、真实履约状态。事件时间保留客户端发生和服务端接收；业务顺序以事务提交版本为准，不将断网后的接收时间冒充发生时间。

## 五、可靠性、成本和数据边界

1. **事务与幂等。** 状态、参与段、研究事件同事务；需要异步处理时，在原业务事务写outbox，再幂等投递。不能先改业务后try/catch写事件并称完整。业务成功后才通知，事务重试内不发外部消息。事件ID、业务操作ID、出行意向ID各司其职。
2. **现有业务兼容。** 扣座、成员、用户索引和研究记录须覆盖并发。保留既有调用参数的兼容行为，记录旧客户端覆盖限制；不让旧版用户被迫提供研究字段才能找车。开启可靠采集后失败应正确回滚；紧急停采开关允许降级，但必须记录覆盖中断，不能宣称该时段完整。
3. **删除与观察起点。** 业务正文仍可按原规则删除，事务内保留已告知用途下最小结构化事实。新数据从启用时开始；若需现有行程基线，标明 `observationStartedAt/source=baseline`，不伪造旧发布/取消事件、不从past补造yes。第一批自动回访优先纳入启用后建立的参与记录，旧记录的回顾性问卷另标层级。
4. **客户端队列。** 优先本地持久队列＋已有认证请求附带上传；最多50条且≤64KiB一批，本地最多500条/256KiB/7天。默认每前台会话最多1次独立补传、两次独立请求至少间隔5分钟，取消固定短周期上报；参数均是可调产品预算，不是微信硬上限。保持一个在途批次，固定batchId/payloadHash及事件ID重试，按账号隔离，确认后才出队。逐事件接收可部分ack；整批不可变保存时整批验证并确认，拒绝项不可通过改写同batchId内容来“修复”。结果和意向由正常提交API确认，离线待同步不能显示已保存。详见低调用方案中的失访、丢失和频控取舍。
5. **曝光控制。** 以实际scroll-view为参照；例如50%卡片连续前台可见1秒，记录阈值版本。页面隐藏、弹层遮挡、筛选版本变化就停止计时；上报一次不代表用户认真看过。不要记录每个滚动像素或键盘输入。
6. **云空间使用。** 在获授权的研究范围内，核心业务/意向/答案不采样，尽量完整保存结构化选择集及修订；相同快照去重。低价值曝光超预算才采样，记录概率与丢失计数。批量调用减少请求数，不自动减少文档写入量。新增按事件、行程版本、意向、用户待确认状态的必要索引，避免首页扫描全表。
7. **成本可解释。** 写明每日会话数×每会话事件数×平均字节量、快照项目数和索引等估算参数；用实际试点测量替换假设，不因空间大就承诺写入/查询免费。提供调用量、延迟、重试、重复、丢失、孤立事件及缺失结果的汇总脚本，不展示个人明细。
8. **用途与保留。** 前台清楚说明用于服务改进及研究、可跳过、不影响评分和服务；研究参与与偏好追踪有可撤回管理入口，不能默认沿用微信接口授权。区分全局功能开关、账号参与状态和接受的用途版本：只有 `globalEnabled && participant.status === active && purposeVersionAccepted` 才采集该用户研究行为、创建研究任务；全局开关初始关闭，上线开启不自动代表所有用户加入。撤回在服务端立即生效，取消邀请并拒绝后续队列，新设备同步后清理旧队列；正常业务必要审计与研究集合用途分开。未参与的另一方不默认获得可关联研究身份，双边研究记录仅在资格具备时建立，否则标明不可关联/观测范围不足，不能阻止正常拼车。保留期限配置化，交付明确的待上线确认配置项和清理/去关联实现，不默认永久保留个人关联。
9. **最小字段。** 不向研究集合复制微信号、电话、车牌、聊天、支付账号、原始openid、精确住址或自由文本备注。UI使用既有授权业务资料帮助本人辨认与研究导出是两回事；导出采用白名单。新集合禁止客户端直接读别人记录或写核心事实。
10. **部署包。** 云函数独立打包；共享研究助手须在构建时纳入各包并校验一致性，不能运行时require兄弟目录。不要顺带升级全仓依赖或改无关业务。新增字段逐步兼容，不以重建生产集合实现迁移。

## 六、建议的代理分工与依赖

由总协调代理先冻结接口/事件合同和文件归属。合同完成后可并行A、B、C，D做独立验收；先用合成数据，不互相等待云端部署。

- **代理A，后端事实与权限。** 负责createTrip/joinTrip/tripManage及必要sync入口、研究云函数、参与段/事件/结果幂等、受限权限与数据索引。负责后端对应测试。需要事务化Carpool相关分支，修复与本次采集完整性直接相关的并发风险。
- **代理B，结果回访体验。** 负责新回访组件、协调器、home/tripHistory/profile必要接入和用途/参与管理UI；保留双按钮+独立关闭，处理公告冲突、请求合并、切号和更正。不得自行改后台合同、评分和计次。
- **代理C，意向与候选观测。** 负责carpoolList、新意向小控件、newTrip必要关联、详情实际查看/联系入口事件及轻量队列；保持排序/缓存/分页业务行为。通用传输器若与B共用，先明确单一维护者，其他人只调用合同。
- **代理D，研究质量与验收。** 独立核对事件数据能否重建生命周期、缺失和分母，核查测试证据、导出白名单、成本与覆盖报告；不直接修改A/B/C共同文件，先给具体问题，由负责人修正。

尚无服务端合同时B/C可用明确标注的mock接口做组件与事件测试，不能把mock保存成功当真实成功。P0可靠事件+回访完成后再合入P1意向/候选，推荐策略与A/B实验属于后续任务。

## 七、完成标准与必须验证的场景

请补有实际区分能力的测试，复用当前Node测试设施，而非只断言代码字符串。相关已有测试包括 `tests/request-lifecycle.test.cjs`、`tests/ride-completion.test.cjs`、`tests/ride-sync-integration.test.cjs`、`tests/home-profile-read-cache.test.cjs`、列表/缓存/时区与朋友圈预览测试。

- 两人并发抢末座；加入/退出/删除同时发生；重复发布/加入请求；事务失败或提交结果不明；必须不重复扣座、不丢参与人、不留虚假的成功事件。
- 删除/退出后仍可按授权最小事实回访；退出后重加能重建多段参与，实际结果不重复计人次；Request的多席/多角色正确。
- 点击是、点击否、关闭、切后台、网络失败、成功回包丢失、多端领取不同任务、租约过期和迟到shown、答案更正/撤销/延期、陌生人提交、伪造actor分别验证；未知不能变成否，冲突不能被覆盖；过自动邀请期限仍可按授权历史补答。
- 首页公告/登录/城市弹层和回访互斥；冷启动onLoad+onShow不双弹；账号切换/游客/朋友圈预览/旧异步响应不错误展示。
- 决策时缓存/分页/本地过滤正确；空列表区分加载失败和真实零结果；详情预取不产生查看，几何曝光去重且可停止。
- 服务区纽约午夜、DST跳时/重复小时、手机中国时区、改期/夜间行程的eligibleAt一致且不提前。
- 研究全局开关关闭保持现有业务；全局开启但个人未参与/用途版本未接受时不采集；撤回后服务端拒绝新研究写入，清理/去关联和多端队列处理可验证；不默认给未参与对方建研究身份；已有公开rideStats与评分逻辑不因答案改变。
- 部分批次ack与队列上限、跨账号、重复事件不同payload、未知schema版本、事件白名单与大小限制均有明确处理。
- 低调用验收：30次浏览不产生30次独立请求；正常业务携带批次失败不影响业务成功；缓存不因埋点而强制刷新；原业务函数不再额外转调采集函数；单批保存不无条件逐事件拆写；分别列出前端请求/函数执行/数据库读写的新增预算。
- 两个最小可重放合成场景：正常加入→实际同行→双方确认；加入→退出/删除→其他方式出行。另覆盖未知和双方冲突，演示分母及事件重建结果。

交付：代码与有意义的测试结果；`docs/ride-research-data-contract.md`；实施说明/功能开关/索引与权限配置；合成fixture；只输出聚合的质量核验与导出工具；部署顺序和回滚方案。提供模拟器验证证据（可用时），清楚列出未执行的线上验证，不能用本地mock声称生产已运行。

只有上述内容成为可审查结果后，才报告实施完成。报告要区分“本地实现完成、已测、待部署、待启用采集”。

---

## 使用说明

本文件不等于论文实验协议，也不授权直接启动推荐实验。第一版的主要收益是：保留失败/退出路径，获得可区分未知的同行自报，建立完整研究分母和当时选择集。自报与曝光仍有误差；后续分析须报告回应选择偏差，不能把大量事件行当作大量独立参与者。
