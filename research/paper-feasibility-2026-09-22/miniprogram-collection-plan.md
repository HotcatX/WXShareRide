# 微信小程序可实施的数据补采方案

核查日期：2026-09-22。范围：当前本地产品代码及微信官方开发文档；未查询云库，未读取已清理的历史备份，未改业务代码、部署或写数据库。文中“已有”指本地代码可证实的机制，不能代替线上部署版本和数据覆盖审计。“建议”均为待实施设计。

## 结论：先形成可信的出行意向和结果，再研究时间弹性的匹配价值

当前产品足以低成本补采一组适合独立研究的数据：用户明确确认的一次找车意向、愿意接受的出发时间范围、当时可选择的路线及余位、加入/接单/退出/取消的状态变化，以及事后简短自报结果。默认方案不需要 GPS、微信支付、后台持续采样或读取微信聊天。

最贴近当前产品的优化问题是：**在已有固定线路和司机公布时刻下，利用乘客自报时间弹性，能增加多少被用户接受的选择；哪些需求仍被接送区域、余位和时段错配限制？** 不预设当前市场供给稀疏，也不预设必须移动司机发车时刻。先研究现有路线的容量匹配/时刻兼容性，避免没有行驶轨迹和真实绕行偏好却声称解决动态道路车辆路径问题。仿真可报告“条件下的匹配上界/相对基线”，实际成行改善必须有前瞻性结果测量或实验支持。

当前代码不能直接给出完整需求分母或真实完成率。几个必须保持的区别：

- 筛选/搜索是浏览行为；用户明确确认的出行意向才进入需求样本。
- 云函数返回路线是候选数据；客户端真正渲染且进入可视区域才是几何曝光，仍不代表注意到或认真阅读。
- 加入路线/司机接单是平台内承诺；复制微信号是联系入口操作；都不是实际成交、付款或成行。
- 到了发车时间而标为 `past` 是时间状态；未答事后问题是未知，不是出行失败。
- 同一账户的重复刷新/点击/退出后重加不自动成为新出行；同行人数不等于账户数。

## 1. 当前代码证明了什么

| 功能 | 已有行为与证据 | 对研究的影响 |
|---|---|---|
| 司机发布、乘客求车 | [newTrip.js:630](/Users/cat/Documents/Github/wx/pages/home/newTrip/newTrip.js:630) 分流；司机提交在711行，求车提交在849行；[newTrip.wxml:219](/Users/cat/Documents/Github/wx/pages/home/newTrip/newTrip.wxml:219) 为乘客单点出发时间；[createTrip/index.js:205](/Users/cat/Documents/Github/wx/cloudfunctions/createTrip/index.js:205) 和240行事务写入正文、用户引用、服务端 `createdAt` | 可新增明确意向与时间窗；目前表单是单点时刻，不能从它推断容忍区间。司机参考价可输入、乘客价自动计算，不能把两类价当同一种自由报价 |
| 现有 `rideDemand` | [rideDemand/index.js:77](/Users/cat/Documents/Github/wx/cloudfunctions/rideDemand/index.js:77) 对已服务 NY/NJ 跳过；其余城市增加请求计数并尝试写事件；入口 [home.js:676](/Users/cat/Documents/Github/wx/pages/home/home.js:676) | 这是“希望开通城市”的表态，没有出行日期/OD/人数；不能充当未满足找车需求。同一用户重复请求会增加计数，不能当独立需求数 |
| 列表筛选 | [carpoolList.js:1223](/Users/cat/Documents/Github/wx/pages/home/carpoolList/carpoolList.js:1223) 在客户端按OD、日期、类型过滤；[carpoolList.js:1401](/Users/cat/Documents/Github/wx/pages/home/carpoolList/carpoolList.js:1401) 只有日期范围变化才必然重查 | 服务端调用日志不含全部真实筛选过程；在前端最终筛选状态采集，不能仅在 `getTripList` 中补日志 |
| 日期分页 | [carpoolList.js:201](/Users/cat/Documents/Github/wx/pages/home/carpoolList/carpoolList.js:201) 首次通常加载两天，明确日期时一天；928行调用云函数；1057行继续加载；[getTripList/index.js:436](/Users/cat/Documents/Github/wx/cloudfunctions/getTripList/index.js:436) 一个日期作为逻辑页 | 首屏空列表可能只是已加载日期内为空；需记录已覆盖区间、后续页、加载失败，不能称整个市场无车 |
| 列表缓存与刷新 | [carpoolList.js:29](/Users/cat/Documents/Github/wx/pages/home/carpoolList/carpoolList.js:29) 30秒缓存；401行恢复缓存，847行复用内存/请求；1385行持久保存“隐藏满员”偏好 | 新旧缓存、用户身份、筛选偏好、状态刷新都会影响候选集。记录来源和版本，不能为了埋点取消现有缓存或每次读取都增加一次搜索 |
| 卡片/详情 | [carpoolList.wxml:47](/Users/cat/Documents/Github/wx/pages/home/carpoolList/carpoolList.wxml:47) 为内部 `scroll-view`；98行是路线卡片；[carpoolList.js:1606](/Users/cat/Documents/Github/wx/pages/home/carpoolList/carpoolList.js:1606) 带预览进入详情；[tripDetailCache.js:1](/Users/cat/Documents/Github/wx/utils/tripDetailCache.js:1) 详情缓存5分钟、可允许30分钟旧缓存、最多80条及预取 | 详情API调用可能只是预取；点击、详情展示、网络取数分别记录。卡片曝光应相对滚动容器检测，不能只读API日志 |
| 加入与接单 | [joinTrip/index.js:167](/Users/cat/Documents/Github/wx/cloudfunctions/joinTrip/index.js:167) Carpool 事务入团并记录 `joinedAt`；249行处理求车加入；[tripManage/index.js:554](/Users/cat/Documents/Github/wx/cloudfunctions/tripManage/index.js:554) 接单；重复加入/接单已有分支 | 有业务成功事实，尚缺统一、完整、可去重的研究事件。Carpool新加入减1座；求车发布可含1–4人而只有1个创建者账户，必须另存 `party_size/seat_units` |
| 退出/取消 | [tripManage/index.js:337](/Users/cat/Documents/Github/wx/cloudfunctions/tripManage/index.js:337) 删除Carpool正文；371行退出时删成员；460行求车删除正文；124行日志失败只打印错误 | 当前存活正文存在幸存者偏差，退出者的 `joinedAt` 等可能丢失。研究需要在成功变更时保留脱敏前后状态，而不是日后恢复不存在的正文 |
| 旧原因页面 | [tripActionReason.js:204](/Users/cat/Documents/Github/wx/pages/profile/tripActionReason/tripActionReason.js:204) 先客户端写 `TripActions`，235行才调用云函数，云函数又可能写日志 | 某些事件可能表示尝试而非成功，存在重复且时间字段有 `createTime/createdAt` 差异；旧日志不能不加清洗直接算取消率 |
| 历史记录 | [tripHistory.js:30](/Users/cat/Documents/Github/wx/pages/profile/tripHistory/tripHistory.js:30) 展示时取历史；[getMyTripHistory/index.js:56](/Users/cat/Documents/Github/wx/cloudfunctions/getMyTripHistory/index.js:56) 用用户历史ID回填现存正文；97行缺失正文返回占位 | 适合增加事后卡片，但不能只依赖现存历史正文去找取消/退出后的待确认意向 |
| 自动结束 | [syncTripStatus/index.js:288](/Users/cat/Documents/Github/wx/cloudfunctions/syncTripStatus/index.js:288) 发车时刻一过即可改为 `past` | 不知道是否真的上车、到达或付款。真实结果必须独立字段，禁止沿用 `past` 作为真值 |
| 通知与评分 | [notification.js:43](/Users/cat/Documents/Github/wx/pages/profile/notification/notification.js:43) 读取站内 `Notifications`；[tripManage/index.js:839](/Users/cat/Documents/Github/wx/cloudfunctions/tripManage/index.js:839) 只准过去行程司机乘客互评；本次在业务JS中未检出 `requestSubscribeMessage/subscribeMessage.send` | 当前站内通知不是微信服务通知。评分来自选择性回应和存活成员，不能自动代表全体体验、取消者或真实完成 |
| 时间与前台生命周期 | [rideTime.js:1](/Users/cat/Documents/Github/wx/utils/rideTime.js:1) 服务区固定 `America/New_York`，含DST；[app.js:112](/Users/cat/Documents/Github/wx/app.js:112) 已有App `onShow`；[home.js:389](/Users/cat/Documents/Github/wx/pages/home/home.js:389) 已有页面显示/隐藏处理 | 应延续服务区时区，不跟随手机时区。可以前台恢复上传、展示到期结果卡片；不要依赖后台定时执行 |

## 2. 微信能力：可以做、有条件、不能可靠观察

以下官方原文在2026-09-22直接HTTPS读取核实。通用web抓取器未能打开部分微信页面，不代表官方页面不存在。

| 能力 | 判断 | 可实施做法及边界 |
|---|---|---|
| 前台/后台切换 | 可做 | `App.onShow/onHide`、页面 `onShow/onHide/onUnload` 可作为前台会话边界。普通小程序后台约5秒后JS挂起，长时间或内存压力可销毁；退出钩子不是可靠上传承诺。[App](https://developers.weixin.qq.com/miniprogram/dev/reference/api/App.html)、[运行机制](https://developers.weixin.qq.com/miniprogram/dev/framework/runtime/operating-mechanism.html) |
| 卡片几何曝光 | 可做但只是代理测量 | `IntersectionObserver` 返回相交比例；在 `setData` 完成后观测卡片，相对 `.list-scroll` 并考虑视口，前台且主要弹层关闭时，达到预先约定阈值如面积50%、连续1秒，记录一次。阈值是研究定义，并非微信保证。它不证明视线、注意力或完全无遮挡；同时观测过多节点会影响性能。[创建观察器](https://developers.weixin.qq.com/miniprogram/dev/api/wxml/wx.createIntersectionObserver.html)、[observe](https://developers.weixin.qq.com/miniprogram/dev/api/wxml/IntersectionObserver.observe.html)、[参照节点](https://developers.weixin.qq.com/miniprogram/dev/api/wxml/IntersectionObserver.relativeTo.html) |
| 批量云端上报 | 可做 | `wx.cloud.callFunction({name,data})` 可携带事件数组，由后端校验并返回事件或整批确认。本方案更新为每批≤50条、序列化≤64KiB的自定预算，优先随已有认证请求附带传输。[Cloud.callFunction](https://developers.weixin.qq.com/miniprogram/dev/wxcloud/reference-sdk-api/functions/Cloud.callFunction.html) |
| 断网重试 | 有条件 | 前台监听网络恢复，恢复后有限重试；真实完成依赖服务端确认。网络显示已连接不等于请求成功。[网络变化](https://developers.weixin.qq.com/miniprogram/dev/api/device/network/wx.onNetworkStatusChange.html) |
| 本地待发队列 | 有条件 | storage同一微信用户/小程序上限10MB、用户间隔离，并随代码包清理；换设备/清缓存/存储失败均可能丢队列。适合有限缓冲，不是研究事实库。[数据缓存](https://developers.weixin.qq.com/miniprogram/dev/framework/ability/storage.html) |
| 离开后提醒 | 有条件，最小方案不依赖 | 常规 `requestSubscribeMessage` 必须在用户点击等允许场景触发、得到模板接受结果后按对应资格发送；传统一次性授权对应一条服务消息，长期订阅取决于类目/模板资格。当前API文档是一次最多5模板，但本方案只申请一个相关提醒。拒绝不影响找车服务，发送成功也不代表读过。[接口](https://developers.weixin.qq.com/miniprogram/dev/api/open-api/subscribe-message/wx.requestSubscribeMessage.html)、[总览](https://developers.weixin.qq.com/miniprogram/dev/framework/open-ability/subscribe-message-overview.html) |
| 新版订阅Beta | 待资格核实 | 官方总览已有支付/`liveActivity`按钮服务触发取得code的新版一次性订阅Beta，不应概括所有消息都必须传统弹窗。尚未核查该应用准入、模板和基础库，不能作为论文采集前提。[总览](https://developers.weixin.qq.com/miniprogram/dev/framework/open-ability/subscribe-message-overview.html) |
| GPS与后台轨迹 | 技术上有条件，默认不采 | 专门后台位置接口要求适用类目、开通权限、用途配置及用户授权；普通后台计时不等于后台定位能力。本题通过预设地点和事后确认即可，不新增位置权限。[后台定位](https://developers.weixin.qq.com/miniprogram/dev/api/location/wx.startLocationUpdateBackground.html) |
| 微信聊天/线下议价 | 不能可靠观察 | 当前小程序不能从“复制微信”得知加好友、谈妥、拒绝、乘车或线下支付。官方群入口接口提供启动/群标识；选择会话文件需用户选文件，都不构成任意聊天历史读取能力。研究只用自报结果，不采聊天内容。[群入口](https://developers.weixin.qq.com/miniprogram/dev/api/open-api/group/wx.getGroupEnterInfo.html)、[选择会话文件](https://developers.weixin.qq.com/miniprogram/dev/api/media/image/wx.chooseMessageFile.html) |
| 自报时间弹性/成行 | 可做，质量有条件 | 标准控件和云函数即可；愿意填写者有选择偏差，答案可能修改或不一致。保留回应来源、版本、未回答状态，不能称客观轨迹核验 |
| 没回小程序者的结果 | 不能自动知道 | 既没有主动回来也没有有效获准提醒回应时，结果一直是未知。到期、沉默、关闭页面、删除本地缓存都不证明失败 |

隐私范围应写入清晰的数据用途说明，并按研究需要取得相应同意；如未来新增定位/手机号等微信隐私接口，须遵守平台声明和授权流程。默认不新增这些接口，也不把平台隐私授权当作研究参与同意。[微信隐私协议开发指南](https://developers.weixin.qq.com/miniprogram/dev/framework/user-privacy/PrivacyAuthorize.html)

## 3. 最小方案：一项后台基础、两处轻量输入

### P0：可信业务事件与一次意向的身份

新增研究专用 `RideResearchEvents`（只追加），以及可重建的 `RideIntents`/`OutcomeFollowups` 投影；名称为建议，不是已存在集合。核心发布、加入、接单、退出、踢出、取消事件由服务端在业务事务中与状态变化同提交。若业务写入路径不能立刻全部事务化，用**同业务事务的outbox记录**，之后投递；仅“业务成功后另调用采集云函数”不能解决丢事件。

客户端事件和服务端已提交事件分别标记 `source=client/server`，不让客户端声称成功改变业务状态。现有已提交业务失败回滚时不得留下“成功”事件；重复 `request_id` 返回先前结果。创建行程本身也要加幂等键，避免网络超时后用户重试产生重复正文。

`intent_id` 表示某账户明确确认的某一次出行需求，`search_id` 是一次浏览查询，`trip_id` 是平台路线，`membership_id` 是一次参与段，`operation_id` 是一次操作，彼此不可混用。同一意向可查看多个方案、退团后重加并保留原 `intent_id`。可展示“继续之前这次找车/另一次出行”，不能仅因同OD同日期就强制合并（同日可能往返或多次出行）。未明确建立意向的普通浏览保留 `intent_id=null`。

### P1：在找车或求车入口轻量确认时间弹性

1. 提供两实验组一致的“先表达这次意向、再显示本次建议”轻量入口，入口可放在列表筛选区下方，并在空列表旁提供同一入口。用户主动进入后先完成或跳过意向表达，再生成本次建议；不强制阻断正常列表浏览，不要求用户必须填问卷才能找车。不要只收空结果用户，否则无法估计全部明确需求的匹配比例。
2. 复用用户已选的标准出发地/目的地/日期。若筛选为“不限”或没有时刻，让用户补齐后明确确认，不能把默认今天或所有日期自动当出行计划。要求选择意向时刻、人数；已有求车表单则直接复用。
3. 可选项用“只接受这个时间 / 可前后15分钟 / 可前后30分钟 / 自定义最早、最晚 / 暂不确定”。没有回答保存 `flexibility_status=unknown`，不要默认成0或±30。预设对称窗口必须经过用户选中；不对称偏好用最早/最晚，存原始选择与解析后UTC范围。
4. 普通找车意向可设为仅本人可见。是否“公开求车”单独明确，不能把研究登记自动发成公开路线或承诺帮用户找到车。
5. 司机最小方案仍按已公布发车时刻固定；增强阶段可问“可提前/推迟多少”，须明确不会未经确认改动已公布行程。真实可调整范围与离线仿真的假设窗口分别存储。

入口顺序只保证表达发生在**本次新增建议**显示之前，不证明用户未见供给。当前列表会自动加载，用户还可能从分享详情进入；分别记录 `prior_exposure`（本次已看列表/详情、没有已记录展示、未知）与 `prefill_source`（用户主动筛选、分享参数、已浏览路线、手动输入等）。预填字段经用户明确确认后才进入意向，不能将某条已看路线的时刻冒充用户独立表达的期望。即使本次先输入，旧用户也可能知道常见班次或受以前浏览锚定；研究表述只能称“建议前自报偏好”，不能称完全不受供给影响的潜在偏好。初次访问/已有浏览/回访用户的分层应预先定义，不将未记录曝光当成未曝光证据。

**接送区域与硬到达要求要另外处理。** 用户先表达意向，再展示邻近时刻的现有车辆，让其明确接受某个方案；这样可观察从声明弹性到实际选择的转变，但选择/加入仍不等于实际同行。收集可接受的具体上车/下车区域或预设站点ID及地点配置版本；“Fort Lee”“哥大”等粗区域只能用于聚合，不能当作区域内任意点可互换。已有用户自定义的精确地址不直接导入研究数据；必要时在产品端保留、研究端只保留经确认的站点/区域键和兼容性标记。

可选问“最晚几点必须到达？”并允许“不确定/没有硬期限”。然而当前没有可靠的路线时长或到达承诺，单独取得 `latest_arrival` 不能证明某车能按时到达。**首轮试点仅按用户明确可接受的接送区域和出发窗口推荐现有车辆**，到达约束的满足情况记 `unknown`。有硬到达需求而时长未知的用户，可以继续浏览并自行确认，但算法不能贴“保证可行”标签；只有未来取得可信时长上界/保守缓冲及用户认可的假设，才能按 `departure + duration_bound + buffer <= latest_arrival` 判断，且记录估计来源、版本和不确定性。初期也不按仅有直线距离估算可行。

插入点：列表 [carpoolList.wxml:29](/Users/cat/Documents/Github/wx/pages/home/carpoolList/carpoolList.wxml:29)、空结果79行；发布表单司机时间68行、乘客时间219行；提交参数 [newTrip.js:739](/Users/cat/Documents/Github/wx/pages/home/newTrip/newTrip.js:739) 和865行；后端 [createTrip/index.js:205](/Users/cat/Documents/Github/wx/cloudfunctions/createTrip/index.js:205)、240行。

### P0：事后一个问题，保留未知与外部结果

按后续用户偏好，第一版采用“这次预约，您实际坐上这趟车了吗？”的**是／否双按钮，另有独立关闭入口**；绑定明确的预约对象，不从最后浏览路线自动关联。关闭、未回复和延期保留未知，点击“否”后可选填其他出行方式/原因，不强制追问。司机端按具体预约乘客询问，不将整趟车出发推断为所有人都同行。当前页面接入、次日低频回访策略、参与去重、多人语义和验收以[实施代理提示词](agent-implementation-prompt.md)第二节为准。

更丰富的结果分类可在后续的可选追问或明确意向结束卡片中使用，例如“平台其他路线/微信等其他渠道/公共交通或其他方式/没有出行/不说明”。不要在首个弹窗同时要求回答所有分类，默认不问聊天对象、实际地址或支付账户。

- 触发时间以用户明确需求窗口之后加缓冲为准，例如最晚出发后2小时或次日；这是提示策略，不是自动判定结束。跨日长途需另设规则，勿发车一分钟后就强问完成。
- 同一账户一天最多展示一张、允许稍后、不阻碍发车/找车；记录 `eligible/offered/visible/responded/dismissed`，分别统计获得回答的分母。最小方案只在回访时提示，明确其回访选择偏差。
- 对已入团者，可在司机与乘客端独立确认，按参与关系计算 `both_confirmed / one_side_reported / conflicting / unknown`。回答互相矛盾保留原回答，不强行覆写为完成或失败。
- “没有出行”的追问原因可选：计划变了/未找到合适时间/无空座/对方取消/价格或地点不合适/其他/不说明；它不等于平台导致失败。
- 取消、退出或正文删除后仍从服务端保留的脱敏意向及历史参与段找待确认项。主动撤回研究参与按既定删除/去标识规则处理，不能以append-only为由永久保留。

插入点：[home.js:389](/Users/cat/Documents/Github/wx/pages/home/home.js:389) 合并到已有刷新请求或低频单次拉取；[tripHistory.js:106](/Users/cat/Documents/Github/wx/pages/profile/tripHistory/tripHistory.js:106) 展示独立待确认项；[notification.js:43](/Users/cat/Documents/Github/wx/pages/profile/notification/notification.js:43) 可放站内提醒。P0不依赖微信订阅消息，也不依赖用户打分。

## 4. 增强方案：可解释的选择集和小规模干预

### P1：候选、渲染、曝光、点击四层区分

服务器返回 `result_set_id`、供给快照时间及路线版本；列表合并分页/缓存后产生 `render_set_id`。前端最终筛选结果记录标准OD键、日期区间、类型、隐藏满员偏好、已加载日期范围、候选数、实际展示数、是否还有下一页、加载错误、缓存来源和年龄。不要记录用户输入的自由文本搜索字串。

模型中的 `F_i` 应称**有状态版本的条件相容集合**：只收录在所记录时刻、覆盖范围、权限和已知接送/时间/席位条件下相容的候选，并保留未知项。它不是保证可售或保证准点的集合；缓存中的余位可能已经变化，司机自报也可能过时，加入前仍须服务端重新校验。缺少可信时长时不能把到达期限视为已满足，普通显示余位也不能自动升级为真实可售余位。

`applyAllFiltersAndGroup` 的 `setData` 回调后绑定观察器；以 `.list-trip-card` 为目标、`.list-scroll` 和有效视口为参照。阈值0.5、前台连续1秒是可预注册的起点；在页面隐藏/卸载、筛选变化、弹层出现时停止计时与观察。重渲染不能重复算同一次曝光；同一 `page_view_id + render_set_id + trip_id` 达阈值一次，返回页可记新访问但仍属于同一意向。记录实际位置/排序区段，区分available/full，不能用云端返回顺序代替屏幕位置。

滑动太快、设备限制、丢事件时记为“曝光未被观测”，不要推断用户没看见。曝光阈值可以做0.5秒/1秒/2秒敏感性分析；不采触屏轨迹、眼动、全量滚动像素。初期只对当前已渲染批次观测，避免成百上千节点长期驻留。

点击插入 [carpoolList.js:1642](/Users/cat/Documents/Github/wx/pages/home/carpoolList/carpoolList.js:1642)；详情渲染应在实际展示成功后记录，而不是 [tripDetailCache.js:129](/Users/cat/Documents/Github/wx/utils/tripDetailCache.js:129) 网络回调。复制联系方式只记 `contact_copy_succeeded` 与渠道枚举，不记录复制内容。[tripDetail.js:765](/Users/cat/Documents/Github/wx/pages/home/tripDetail/tripDetail.js:765)

### P1：状态快照只取足以复现当时约束的字段

每个业务事件保留 `trip_version_before/after`、标准OD、公布出发时间、原容量/剩余座位、涉及参与段、`intent_id`、可用状态、已知价格的数值及币种（若参与价格研究）、生效时间。用户姓名、原始openid、电话、微信号、车牌、支付账号、精确接送点、备注自由文本都不进入研究导出。

**容量不能从现存平台成员数倒推。** 分开保存司机声明总容量、平台有效预约的 `seat_units`、司机自愿报告的线下占座（可未知）、该时点明确确认的可售余位及 `confirmed_at`。司机在自己的行程详情可用一个可选控件确认“目前还能接几位”，并可选“已有其他渠道乘客/容量调整/其他”；这是一项自报状态而非GPS事实。所有纠正追加事件，不能回写历史成原本就如此。确认余位之后的新平台加入应按同一版本继续扣减，避免将自报剩余再减一次已计入的成员；并发变化须重新校验。没有近期司机确认时只能称“平台显示余位”，优化结果要对余位不确定性做保守情景分析，不能以 `passengerCount-availSeatNum` 代替真实乘客数或平台成交数。

插入点：[myTripDetailDriver.js:277](/Users/cat/Documents/Github/wx/pages/profile/myTripDetailDriver/myTripDetailDriver.js:277) 所在司机行程管理页附近新增余位确认控件；实现需在服务端版本事务内处理，不能客户端直接覆盖 `availSeatNum`。同行多人应绑定一段预约的席位数，研究汇总同时报告账户数和座位单位数。

保留不可逆“已发生”记录和未来事件重建基线：研究启动时的脱敏供给基线标注 `observation_started_at`；它不是从历史创建以来的完整日志。后续修改/删除/退出用追加事件更新投影。业务上删除正文仍允许，但需在删除事务内先保留最少研究字段，且实现已告知的数据保留/撤回政策。历史取消原因只保留预定义编码，不默认复制自由文本。

### P2：可落地实验，但先明确要证明什么

**测量试验**：为了减少负担，可对符合条件的账户随机分配“简洁确认入口”与“同入口加时间弹性选项”，估计意向提交、窗口回答率与放弃率。此试验测的是采集方式对响应的影响，不能直接证明匹配算法改善了出行。基础曝光和关键业务事件应各组同样记录。

**推荐试验**：在用户已明确意向与时间窗之后，对窗口内合法路线比较“当前时间排序”和“更合适的时间/余位推荐”；不得自动改承诺时刻或自动加入。分组由服务端建立稳定 `assignment_id`，登录后跨设备一致，存 `experiment_id/version/eligible_at/assigned_at/arm/assignment_probability/stratum`；客户端只使用下发组别。记录被分配和真实看到推荐，主要分析用意向治疗效应，不能只挑“看过且点过”的人。

同一市场的用户共享座位，简单按用户随机可能产生组间干扰。要主张市场总体优化，优先考虑按有足够样本的走廊×**出发服务区块**做预先随机switchback。路线可能提前数日发布，分组应在该服务区块开始接受发布/预订前建立，并贯穿发布、浏览、加入、退出、临近出发、结果确认的生命周期；不能到了自然日才随机、按每次刷新随机或在旧预约上切换政策。按服务区块保留同一assignment，记录 `service_block_id/booking_policy_version`。跨窗口、改期、跨区块存量订单的归属与缓冲须预注册；如果时段间干扰无法隔离，就不能声称该区块设计消除了干扰。不能为了多“样本”把每次点击当独立实验单元；样本量/区块数不足则只做试点和区间估计，不包装成确定因果结论。

两臂使用同一事后问题、展示位置、触发时机、频率与结果口径，在随机化前定义主指标（如“明确意向中经确认的目标服务达成”、等待至平台承诺时间）及缺失结果上下界；分别报告回答率、外部出行率、取消率、未知率、供给方负担。若算法只优化“平台入团”，题目就只声称承诺匹配改善。未回答的成行结果做上下界/敏感性分析，完整案例分析只能作为受限附表。使用微信入口或做提醒实验本身不是研究创新，贡献须落在新的问题、识别或算法与证据上。

相同问法和相同响应率都不能消除选择偏差：处理可能改变谁愿意回答、谁再次打开小程序，以及回应者中成功/失败者的构成。因此始终按预先设定的缺失界限和敏感性方案报告，而不是仅在两组响应率显著不同时才分析缺失。可以比较处理前特征与回应模式，但不能据此证明未回应者随机缺失；增加样本量也不能自动解决这一偏差。

增强提醒只在用户主动选择“出行后提醒我”且获得合适模板资格/授权后发一次；不依赖全天候后台，不反复索取订阅，不把拒绝者剔出主分析。

## 5. 事件字段与可靠性规范

建议字段分三层，允许按事件类型最小化，而不是每行复制大对象。

| 层 | 字段 | 规则 |
|---|---|---|
| 通用信封 | `event_id, event_name, schema_version, source, occurred_at_client_ms, received_at_server, app_version, instrumentation_version` | 客户端稳定生成事件ID并在重试时复用；服务端写接受时间；核心事件另有服务端发生/提交时间 |
| 关联 | `actor_key, actor_key_version, actor_role_in_event, session_id, page_view_id, intent_id, trip_key, membership_id, operation_id, search_id` | 服务端用认证上下文做研究用HMAC伪名，不接收客户端自报actor_key；密钥和映射不进入小程序/研究导出。伪名不是完全匿名，仍限制关联与保留 |
| 时间/意向 | `service_timezone, desired_local_date, preferred_local_time, earliest_departure_at_ms, latest_departure_at_ms, flexibility_status, flexibility_source, party_size, acceptable_pickup_keys, acceptable_dropoff_keys, place_config_version, prior_exposure, prefill_source` | 源答案、缺失、版本都保留；时间窗及接送区域依据用户明确回答；人数与账户身份分开；记录既往已知展示与预填来源，未记录不等于未曝光 |
| 可选到达/容量 | `latest_arrival_at_ms, arrival_feasibility, duration_bound_source, total_capacity, platform_reserved_seat_units, offline_reserved_seats, sellable_seats, capacity_confirmed_at` | 缺少可信时长时到达可行性为unknown；线下占座未知不填0；显示余位、自报可售余位与现存账户数不同 |
| 选择集 | `result_set_id, render_set_id, query_state, coverage, result_count, displayed_count, cache_source, cache_age_ms, state_revision, ranking_version` | `coverage`含已加载日期、has_more、加载是否完整；空结果必须排除网络失败/未加载 |
| 行为 | `trip_version_seen, position, section, visibility_ratio_threshold, visible_duration_ms, click_target` | 点击不等于曝光成功，曝光不等于注意；金额等仅按研究必要加入 |
| 业务变化 | `trip_version_before, trip_version_after, state_before, state_after, seat_units, reason_code, committed_at_server` | 在事务中保存，限制可写事件名；失败尝试另用attempt/rejected事件 |
| 结果 | `question_version, reporter_role, outcome, outcome_route, response_status, replaces_event_id, invitation_id` | 结果订正追加新事件，不覆盖旧答案；无回应为unknown；双边冲突独立标签 |
| 实验 | `experiment_id, experiment_version, assignment_id, arm, probability, assignment_unit, policy_version` | 服务端分组后固定；旧版本与未分组分别标注；客户端不生成随机arm |

完整的全合成示例见 [synthetic-collection-events.json](/Users/cat/Documents/Github/wx/research/paper-feasibility-2026-09-22/synthetic-collection-events.json)。示例中的ID、地点、路线、时间和人数均人工构造，与真实用户无关。它用于表达语义，不是生产API合同。

### 幂等、顺序和跨退出保留

- `event_id`用于传输去重；`operation_id`用于业务重试去重；`intent_id`用于出行语义关联，三者不能相互替代。服务端以确定性文档ID/唯一约束去重，ack重复ID也算已接收。
- 每次客户端入队即保留同一事件ID，ack后才出队；一批部分成功只移除已ack事件。队列序号辅助同一次设备会话排序，不能当多设备全局顺序。
- 服务端事务为每条路线递增版本；同一意向修改用预期版本或明确冲突策略。多端并发修改时间窗不应静默最后写覆盖而无记录。
- 接受一个加入操作后保留参与段；退出将该段关闭，重加产生新参与段但可关联同一意向；取消不抹除先前展示/加入的事实。保留的都是最小脱敏状态，并按期限清理，不保留完整联系资料副本。
- 现有旧日志要标 `legacy_unverified`，源头、字段定义和重复规则单列；不把补写日期当真实事件发生日期，不把未观察到的旧加入/退出补造成真实事件。

### 上传、失败、成本

用户补充调用次数不足后，采用[低调用方案](low-call-collection-plan.md)：行为先存本地，优先随下一次已有认证请求附带一批；最多50条且≤64KiB，以大小先到为准。取消每20–30秒固定上传。无附带机会时才有界独立补传，默认每前台会话最多1次、两次独立请求至少间隔5分钟；这些是待试点参数，不是微信限制。每次仅一个在途批次，固定ID与内容重试。页面隐藏时先持久化并尽力发送，前台恢复后继续；不承诺后台上传或最后一次退出时一定成功。

本地队列建议限制在256KiB或500条、最多保留7天；达到上限优先保留意向确认/结果回答等不可重建项，低优先级重复曝光可丢弃并累计 `telemetry_loss_count`。这些客户端重要事件仍可能随缓存清理丢失，真正改变业务或保存答案必须用正常服务端提交+确认，不应只躺在埋点队列。切换账户后不得把旧账户队列作为新账户上传；按账号分区处理，退出登录不能串号。非登录浏览只能作为独立匿名会话，不能无依据跨设备拼接。

不每次滚动、输入字符或缓存命中就调用云函数。若逐批独立上传，简单调用模型为Σ每会话 `ceil(E/B)` 加上尾批/重试，另受字节上限影响；实际采用附带请求时，独立请求还会减少。若服务器逐事件写入，写操作仍约D×E；低优先级客户端行为也可每批一文档保存，再离线展开，这样应用层写入操作减少，但幂等/权限读取与套餐计量仍另计。原始体积约D×E×S，另有索引/副本；不在未核实套餐前承诺金额。核心业务、参与段和答案继续可查询地保存，只建必要索引；低价值曝光超预算可明确采样，保留概率和丢失口径。

上线前监测：同一操作重复成功事件数、业务成功与事务事件差值、上传失败与队列丢失、事件时延、未知版本、孤立关联、分组比例异常，以及是否影响找车/发布的延迟和错误率。采集故障应有开关；业务成功事件若需保证完整，使用事务outbox并可重放，不应吞掉错误后宣称完整。

### 时间、版本、缓存和实验污染

- 服务区时间用 `America/New_York`，UTC毫秒用于排序；保留用户输入的本地日期/时刻以及解析规则版本。客户端跨中国/美国时区操作不得改变出行日期。[rideTime.js:57](/Users/cat/Documents/Github/wx/utils/rideTime.js:57) 已对春季跳过时刻校验，秋季重复小时取较早一次；新增窗口应同后端一致，并记录有歧义时的选择，不能让不同端各自用 `new Date(localString)`。
- 客户端发生时间可偏差，离线上报的 `received_at_server`也不是发生时间。研究用事务时间确定业务顺序，客户端时间只用于其能力范围内的浏览时序，保留两种时钟及明显偏差标记。可用一次往返估算偏差并记录不确定度，不静默改写源时间。
- App与页面生命周期各自有scope；恢复前台不自动新建出行意向，冷启动也不一定新需求。给前台访问 `page_view_id`，不要把 `onLoad+onShow` 双触发算两个独立需求。
- 缓存来源分 `network/memory/storage/list_preview/prefetch`。记录所见状态版本与年龄，忽略已被当前请求版本判废的旧网络结果；不把它们算展示。列表满员过滤/好友屏蔽/日期分页属于选择集限制，不应让离线算法“推荐”用户当时无权看到或已过期的路线。
- 分组或排名版本加入相关缓存key/响应元数据；政策切换时清晰失效或保留带旧版本的展示记录。一次内容渲染和一次后台状态同步分别计数；预取到详情从不自动产生detail-view。

## 6. 优先顺序、验收和研究可用性

| 顺序 | 最小交付 | 通过后能回答 | 不能据此声称 |
|---|---|---|---|
| P0a | 核心业务事件、基线供给、事务/幂等、取消退出前脱敏状态 | 平台承诺、流失、取消与供给状态的前瞻性重建 | 历史所有行为已恢复；实际成行已核验 |
| P0b | 相同口径的事后确认、邀请/回应/缺失记录 | 已有预约的自报同行与未知；P1后扩展至登记需求中的外部替代 | 未答即失败；`past`即完成 |
| P1a | 明确意向、显式时间窗与人数，缺失单列 | 登记需求内的时段错配、弹性分布、固定线路匹配潜力 | 所有居民/所有访问者真实需求；未回应者弹性为0 |
| P1b | 候选覆盖、真实几何曝光、点击、缓存版本 | 当时可选择集与用户选择关系，推荐偏差诊断 | 阅读、信任、线下谈判或因果偏好 |
| P2 | 分组、政策版本、统一结果测量、样本量设计 | 适用设计范围内的提醒/推荐效果 | 小样本点击差异就是市场效率提升 |

在主协议建议的2–4周诊断先导中，先安排1–2周工程核对，确认字段、时钟、队列、双端身份和用户负担，并跟进已纳入行程的完整生命周期；这些是规划窗口，不是满足统计功效的期限。正式样本规模应从当期真实活跃量、意向提交率、窗口回答率、结果回应率、可随机区块数和预期效应估算，再决定采多久。若关键字段太稀疏，应缩小问题到描述性市场错配/鲁棒性和部分识别，不靠增加重复曝光行数“凑样本”。

必须通过的针对性验证：同一操作超时重试不重复扣座/创建；业务失败不留成功事件；取消后仍能在授权保留范围内关联最小历史事实；断网/关闭再打开能补发且不重复；账号切换不串事件；筛选缓存/分页/弹层下不虚报曝光；不同手机时区和DST边界同一时刻一致；从未回应者仍是unknown；实验assignment及缓存版本一致。正式采集前冻结事件定义与主要指标，记录每次变更的生效时间。

这个方案最有价值的不是增加大量浏览行，而是补足三个此前很难证明的量：**一次明确需求的分母、用户真正接受的时间范围、带缺失标记的实际结果**。它们足以把“平台里有很多行程”推进到可检验的匹配优化问题。
