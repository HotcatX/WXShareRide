# 小程序前端云调用模型：静态审计

审计日期：2026-09-22。范围：当前工作区的首页、拼车列表与详情、个人中心、历史行程、市场列表与详情，以及共享缓存/生命周期工具。只读代码；未访问云数据库、运行模拟器或获取真实调用量。下列数字是指定条件下代码会发起的请求数，不是线上实测、计费账单或SDK内部重试次数。工作区可能同时有其他开发，行号对应本次读到的版本。

## 1. 先区分三种成本

- **F：云函数请求**，例如 `wx.cloud.callFunction(getTripList)`。一个请求可能包含多个后端数据库读写，不能将F直接当数据库操作数。
- **D：客户端直连数据库请求**，例如 `Notifications.count()`、`userInfo.get()`。它们不会出现在只统计 `callFunction` 的报表里。
- **S：云存储接口请求**，例如 `getTempFileURL`；图片真正下载的流量另外统计。

当前常用浏览路径不是定时轮询：在审计的 `app.js/pages/utils/custom-tab-bar` 范围未发现 `setInterval`；主要由 `onLoad/onShow`、用户刷新/翻页/筛选以及业务动作触发。首页与个人中心的300ms定时器是一次性合并刷新，公告计时器仅关闭过期弹层，不周期性请求云端。`onShow` 是返回前台/重新显示页面时触发，不能按“停留每30秒一次”估算。

证据：[首页调度](/Users/cat/Documents/Github/wx/pages/home/home.js:389)、[个人中心调度](/Users/cat/Documents/Github/wx/pages/profile/profile.js:111)、[空的自定义tab组件](/Users/cat/Documents/Github/wx/custom-tab-bar/index.js:1)。

## 2. 常用路径的条件式调用量

以下默认：有效ID、普通小程序上下文、没有同时切号/变更筛选/业务写操作、网络完成一次请求；额外推荐码调用在下一节单列。范围为一轮逻辑触发，不含用户继续反复操作。缓存命中、游客、无业务数据、离开过快会减少调用。

| 路径 | 云函数F | 直连DB/存储 | 解释 |
|---|---:|---|---|
| 已登录、服务区内、首页完整冷启动；所有相关缓存未命中 | **5–6** | D=1 | 城市配置1、社群配置1、公共统计1、我的行程1、个人状态同步1；同步确实改变记录再读我的行程1。`onLoad/onShow`刷新计时器合并，不应机械乘二。 |
| 首页冷启动，但保留24h公共统计、10min状态同步时间 | **3–6** | D=1 | 城市配置/社群配置的内存缓存因真正进程冷启动消失；公共统计和状态同步可被持久缓存省掉。前提是页面停留到300ms刷新发生。 |
| 游客、服务区内、首页冷启动且公共缓存皆空 | **3** | D=0 | 城市配置、社群配置、公共统计；不读个人行程与未读。 |
| 同一首页30秒内返回，身份/变更版本不变，统计缓存有效 | **0** | D=0 | 我的行程、未读、社群有新鲜度/在途合并；非定时轮询。 |
| 首页超过30秒返回、个人状态10min内仍有效 | **2–3** | D=1 | 社群配置1、我的行程1；公共统计到期再加1。状态同步也到期时再加1，状态改变再加1，即该条件放宽后 **2–5**。 |
| 已登录首页主动下拉刷新 | **4–5** | D=1 | 强刷社群、统计、我的行程、状态；状态改变后再读一次行程。城市配置不因该下拉自动重读。 |
| 拼车列表首次打开，列表缓存未命中 | **1–4** | D=0或2 | `getTripList(type=all)`1；城市配置0/1；有候选且状态同步10min到期时同步0/1，改变后列表重读0/1。地点配置缺失时Departure和Arrival各1次D。 |
| 拼车列表同身份/日期范围/变更版本30秒内返回 | **0** | 通常D=0 | 返回复用内存/持久短缓存；不是每次返回都会同步状态。若此时日历仍打开，日历缓存缺失另加0/1 F。 |
| 拼车列表30秒后返回 | **1** | D=0 | 重读当前初始日期段；`onShow`不直接再次调用状态同步。日历仍打开另算0/1。 |
| 拼车列表确实加载下一日期段 | **1/段** | D=0 | 一次请求同时取两类行程，默认后续段为2天；有在途合并、无更多数据/无有效手势为0。 |
| 只改出发地/目的地、路线类型、展开满员 | **0** | D=0 | 本地筛选/分组；改变日期范围则另触发0/1列表请求。在途请求键改变可有旧请求已发出且结果被弃用。 |
| 打开或切换日历月份 | **0–1** | D=0 | `getTripList(action=calendar)`；按请求键共享5min缓存和在途请求，非每天一次。 |
| 打开公共拼车详情，有效未过期路线 | **基础1** | 有openid时D=1 | 缓存仅先显示，仍后台强制刷新详情。司机资料缺失且本人有权查看，另加0–2 F（旧缓存与新响应各可触发一次资料补读）；正常完整响应通常无需补读。 |
| 公共拼车详情30秒内返回 | **基础0** | 有openid时仍D=1 | 详情节流；`loadUserSpots()`每次onShow直读本人常用上下车点，未共享缓存。超过30秒基础F变1；资料补读按上行条件。 |
| 公共求车详情首次打开／超过30秒返回 | **基础1** | 本页该路径无D | 与拼车公共详情一样，缓存命中仍刷新；正常30秒内返回基础0。 |
| 个人中心首次进入／超过30秒返回，已登录 | **1** | D=1 | `getUserInfo`及Notifications.count；同页30秒内返回0F/0D。跨首页与个人中心的未读请求目前不共享在途/新鲜度。 |
| 历史行程首次进入，普通生命周期 | **2** | D=0 | onLoad与onShow均直接调用`getMyTripHistory`，没有合并；之后每次onShow再1。这里只数历史列表，不含自动进入评分详情后的额外请求。 |
| 市场首次进入，默认时间排序，无旧商品列表缓存 | **1–5** | S依图片/头像缺失而定 | 商品首屏1，地区配置0/1、广告0/1、已登录本人资料0/1、最多8件首屏的卖家资料0/1批。默认不启用距离排序。 |
| 市场首次进入，恢复了旧商品列表缓存 | **基础1–4 + B** | S还可能处理旧缓存全部图片 | `B`为卖家补读批数，取决于缓存列表和新列表中不同卖家的缺失情况；每批最多20人、重叠在途去重。旧缓存可能含已翻页积累的许多商品，因此不能硬写“最多5次”。 |
| 市场普通返回，同查询/身份/变更版本30秒内 | **0** | 通常0 | 若距离排序启用且资料缓存失效，可能额外本人资料0/1；若位置结果改变排序则再拉列表，不能套用这一完全不变条件。 |
| 市场普通返回超过30秒，默认排序 | **1 + B** | 新图片/头像S另算 | 刷新首屏1，卖家资料缺失才加B；不会每次onShow都重读广告和地区树。距离排序还可能加本人资料1。 |
| 市场“查看更多”一次 | **0–1 + B** | S按新增图片/头像 | 本地够展示时0；接近本地末尾且云端有更多时1次，云页20条、在途有防重。 |
| 市场下拉刷新 | **2 + B** | S另算 | 列表1+广告1；卖家资料补读B。 |
| 市场商品详情首次进入 | **1–2** | 卖家头像S可能0/1 | `marketApi(detail,trackView:true)`1，即便有详情缓存；卖家资料新鲜则0、否则批查1；管理员代发资料可直接使用。普通返回只有本地商品变更标记改变才重读。 |

这里“基础F”指详情正文请求；登录恢复加入、主动下单/退出/屏蔽、评分、缺失身份补登录、失败后的用户重试需要独立计入，不能偷塞进普通浏览上界。个人参与详情还有角色差异：司机Carpool页详情0/1，乘客资料另加`ceil(成员账号数/20)`；Carpool乘客页详情0/1、司机补资料0/1；Request乘客页除详情0/1外，缺身份会login1、缺司机资料0/1、有其他乘客资料0/1。Request创建者/接单司机页首次强制读详情1，再按各角色缺资料情况补读。它们并未统一成一个“详情总是一次”的模型。

## 3. 全局推荐码请求是额外层

[app.js:105](/Users/cat/Documents/Github/wx/app.js:105)与[app.js:115](/Users/cat/Documents/Github/wx/app.js:115)分别处理appLaunch/appShow；[页面包装器:65](/Users/cat/Documents/Github/wx/app.js:65)在正常pageLoad再调用捕获。每次捕获非本人ref会调用一次`referralApi(trackVisit)`，见[referral.js:57](/Users/cat/Documents/Github/wx/utils/referral.js:57)。所以一个携带同一ref的普通冷启动可能发**3次trackVisit**，这三次并未在客户端合并；并不代表3名独立访客。

`getMyReferralCode`已有本地值则0，否则登录用户并发合并后1；`bindReferral`没有待绑定/未登录则0，存在待绑定时并发合并后1，见[referral.js:80](/Users/cat/Documents/Github/wx/utils/referral.js:80)。普通无ref且推荐码已缓存的启动附加0；带ref且需要取码/绑定的冷启动附加通常3–5。精确次数依生命周期、入口query、是否自己的ref和已有状态，不能据此推线上占比。即便后端去重，已经发出的函数调用仍存在。

## 4. 已有优化与仍可能放大的位置

### 已经做得较好的部分

- 首页与个人中心分别将相同资源、身份和本地修改版本下的请求合并，成功读后30秒内复用；首页/个人中心onLoad、onShow的300ms调度会互相替换。[首页资源合并:48](/Users/cat/Documents/Github/wx/pages/home/home.js:48)、[个人中心:10](/Users/cat/Documents/Github/wx/pages/profile/profile.js:10)。
- 首页公共统计单独持久24h，个人状态同步单独持久10min；减少与个人写操作无关的统计重读。[统计:764](/Users/cat/Documents/Github/wx/pages/home/home.js:764)、[状态:901](/Users/cat/Documents/Github/wx/pages/home/home.js:901)。
- 拼车列表同时读取Carpool与Request，日期分页及相同请求合并已存在；普通地点筛选不会发云请求。[列表:847](/Users/cat/Documents/Github/wx/pages/home/carpoolList/carpoolList.js:847)、[日期分页:1057](/Users/cat/Documents/Github/wx/pages/home/carpoolList/carpoolList.js:1057)、[筛选:1401](/Users/cat/Documents/Github/wx/pages/home/carpoolList/carpoolList.js:1401)。
- 日历5min共享缓存；公共配置按集合30min内存缓存；地点配置5min共享内存及在途合并。[日历:125](/Users/cat/Documents/Github/wx/utils/rideCalendarPicker.js:125)、[配置:34](/Users/cat/Documents/Github/wx/utils/cloudConfig.js:34)、[地点:29](/Users/cat/Documents/Github/wx/utils/rideAddressConfig.js:29)。
- 市场首次bootstrap有门闩，首屏同key在途合并，即使force也共享同一在途请求；普通返回冷却30秒。卖家按20人批查、同一卖家跨请求共享在途，新鲜期10min。[bootstrap:706](/Users/cat/Documents/Github/wx/pages/market/market.js:706)、[首屏请求:1998](/Users/cat/Documents/Github/wx/pages/market/market.js:1998)、[卖家共享:193](/Users/cat/Documents/Github/wx/utils/marketSellerProfileCache.js:193)。
- `prefetchTripDetails`虽有实现，本次全局搜索仅见定义和导出，没有页面调用证据；不能把“最多预取8条”计入当前每次列表请求。

### 优先值得做的5项

1. **先去掉确定的重复：历史页双加载与推荐访问重复。** 历史页加入同身份/变更版本的共享promise、一次onLoad/onShow协调；研究回访不能继续在这两个钩子各发请求。推荐码按启动会话/入口ref聚合访问，保留需要的入口来源，避免同次启动计3次网络事件。[历史页:17](/Users/cat/Documents/Github/wx/pages/profile/tripHistory/tripHistory.js:17)、[历史请求:106](/Users/cat/Documents/Github/wx/pages/profile/tripHistory/tripHistory.js:106)、[推荐码:57](/Users/cat/Documents/Github/wx/utils/referral.js:57)。这项收益最容易用调用计数验证。
2. **共享用户资料和未读状态缓存。** 当前首页与个人中心各有30秒缓存，却不共享Notifications在途/TTL；市场有独立getUserInfo缓存，公共拼车详情每次onShow仍直读userInfo。建立按身份+资料修订版本的只读资源层；必要时上下车点推迟到用户展开预约控件，已有资料先用。主动写入后明确失效，不能让权限/封禁依赖旧缓存。证据：[首页未读:973](/Users/cat/Documents/Github/wx/pages/home/home.js:973)、[个人未读:306](/Users/cat/Documents/Github/wx/pages/profile/profile.js:306)、[详情点位:122](/Users/cat/Documents/Github/wx/pages/home/tripDetail/tripDetail.js:122)、[市场本人资料:1899](/Users/cat/Documents/Github/wx/pages/market/market.js:1899)。
3. **区分“普通详情后台重验”和“写操作后的强制重读”。** 两个公共详情的缓存命中路径仍调用`fetchTripDetail(...force:true)`，共享工具force分支又刻意绕开在途合并，保证加入/退出后不会接到旧响应。不能简单删force；应以身份+行程+本地修改代数为键，普通同代重验共享请求，修改后开新代强读，同时合并缺资料补读。详情的可用状态、参与关系、联系方式仍须及时核验，不能为了省调用让失效行程继续可加入。[公共详情:572](/Users/cat/Documents/Github/wx/pages/home/tripDetail/tripDetail.js:572)、[求车详情:435](/Users/cat/Documents/Github/wx/pages/home/requestDetail/requestDetail.js:435)、[force语义:110](/Users/cat/Documents/Github/wx/utils/tripDetailCache.js:110)。
4. **市场旧缓存仅补当前可见资料/图片，并把缓存目标说清。** 市场5min“新缓存”目前主要秒开，bootstrap仍force读首屏，实际普通返回阈值是30秒。恢复旧缓存时会对全部历史累积行调用卖家补全与图片URL解析，而首屏实际仅8条；可延迟非可见卖家/图片到即将展示时。保留按人/文件去重，不要对每张卡独立调用。换筛选/位置的请求用最终稳定查询键，避免中间态请求。证据：[bootstrap:1105](/Users/cat/Documents/Github/wx/pages/market/market.js:1105)、[恢复缓存:2383](/Users/cat/Documents/Github/wx/pages/market/market.js:2383)、[卖家补全:1593](/Users/cat/Documents/Github/wx/pages/market/market.js:1593)、[图片URL:2314](/Users/cat/Documents/Github/wx/pages/market/market.js:2314)。
5. **把“读取后同步状态再重读”的成本单独量化，再决定合并。** 首页可能经历getHomeTripList→syncMyTripStatus→getHomeTripList；列表可能getTripList→syncTripStatus→getTripList。它们已有10分钟限制，不能假设每访问三连调；两者覆盖范围也不同，不能无条件互相替代。可让同步返回最小变更/新版本供页面修补，或让读取返回时间派生状态并把必要持久化交给服务端任务；必须验证现有历史迁移、统计、权限与余位逻辑，不能只在前端隐藏第二次读。证据：[首页:799](/Users/cat/Documents/Github/wx/pages/home/home.js:799)、[首页重读:914](/Users/cat/Documents/Github/wx/pages/home/home.js:914)、[列表同步:675](/Users/cat/Documents/Github/wx/pages/home/carpoolList/carpoolList.js:675)。

## 5. 对独立研究采集服务的约束

独立采集服务不应把“每个既有云调用结束”转换成“再调一次采集函数”。客户端渲染/曝光/点击事件写入共享小队列，在前台批量发送并按eventId重试；首页仅按账号前台会话和有效缓存查一次待回访，不能首页、个人中心、历史页各自轮询。零结果、搜索条件和可见候选需要业务语义事件，不能从函数调用次数直接推断。

后端成功发布/加入/退出等核心事实应由业务事务内写最小事件或outbox；它们不依赖客户端额外上传成功日志。调查答案与显式意向走独立提交API得到确认，不能仅依赖可丢失的曝光队列。独立服务应有自己的失败/限流/熔断边界，使研究行为采集故障不阻断找车；对于必须原子记录的业务事实，要按预先定义的可靠性和紧急降级政策执行并标记覆盖中断。

前端请求测量首版建议仅记录聚合：`functionName/action/page/trigger/cacheOutcome/requestStarted/requestCompleted/duration/responseBytesBucket/coalescedCount/servedFromCacheCount`。不收请求body、联系方式、openid或完整错误正文。区分F/D/S，区分app生命周期、页面生命周期、用户动作、自动重验；相同业务动作与网络重试使用不同层级ID。仪表本身批量上传或先本地输出，不能每个调用再单发测量请求。

用真实会话替换以下符号，再评估云调用增长：

```text
既有函数调用 = 首页首次/有效返回次数×条件均值
             + 拼车有效日期页次数
             + 公共详情网络重验次数
             + 个人资料刷新次数
             + 市场列表页与资料补读批数
             + 用户业务写操作、推荐码、其他功能请求

新增研究调用 = 实际发送的客户端事件批数
             + 待回访查询/邀请领取次数
             + 答案、意向及参与状态提交次数
             + 服务端outbox投递或处理调用（若采用）
```

批量能减少调用次数，不自动减少数据库写入次数。必须用运行期聚合验证平均与P95会话调用数、缓存命中率、重复率、失败率、D读写、S流量及后端每请求数据库操作；本静态审计不能给出可信的月费、日活或“节省百分之多少”。
