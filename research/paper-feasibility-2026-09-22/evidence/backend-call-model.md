# 当前后端调用模型：本地代码审计

审计日期：2026-09-22。范围为当前 `/Users/cat/Documents/Github/wx` 的第一方云函数、触发器配置和调用入口，以及相邻 `wx.web` 的公开网站网关代码；未调用云函数、查询云数据库、读取云监控、部署或修改产品代码。历史部署说明仅作为线索，不视为今天线上状态证明。

**用户截图中“本日”显示的约47,700次尚未被归因，也不是已证实的完整日用量或稳定日均。** 本报告说明哪些路径可能放大请求与数据库工作量，不声称其中任何一项已经造成该数量，也不把“调用”直接解释为云函数执行次数。套餐指标和SDK操作的计量关系须与当前官方口径、控制台指标名称及实际计费明细对齐。

协调代理另行只读看到控制台为个人版、显示20万调用/3GB/15万CU，资源周期为2026-09-23 00:00至10-22 23:59；9月22日明细暂无数据，界面提示只能选周期内日期，因此本轮没有取得可归因的历史7日分项。本报告没有据空明细推断零消耗。协调代理核验的[CloudBase文档型数据库FAQ](https://docs.cloudbase.net/database/faq)说明计量涉及调用与存储，进一步说明不能仅统计云函数入口次数替代套餐用量。

## 1. 先把三种数量分开

- `F`：实际云函数执行次数。客户端 `wx.cloud.callFunction`、HTTP网关进入函数、定时触发均是不同来源；客户端失败重试是否已执行也需监控核验。
- `Q/W/S`：函数内部数据库读取/写入与存储SDK操作数量。本报告中的数量指**代码显式执行的SDK方法调用**，不等同计费读写单位；一次批量查询可以返回多条文档，事务SDK内部还有提交/重试。
- `E`：研究事件行数。30条事件合成一个请求可以减少请求数量；如果服务端仍逐条写文档，不会自动把数据库写入变成一次。

不能把 `F + Q + W + S` 不加区分直接相加成“套餐调用次数”。也不能因为没有新增函数调用，就说事务内新增研究写入没有成本。

扫描本地20个云函数入口及31个第一方JS文件，未发现服务端 `callFunction(...)` 嵌套调用。当前主要放大路径是**一次外部函数执行中的数据库扇出、分页、条件补读和事务重试**，以及前端重复发起同一功能请求。`cloud.getTempFileURL/deleteFile` 是存储SDK操作，不是嵌套云函数。

## 2. 主要路径和可复核模型

以下均假设请求成功、无SDK内部重试；用户缺失或权限拒绝可能提前返回。`ceil0(n/k)`表示空集合为0，否则向上取整；`B`为列表双向拉黑查询数：未认证0，有身份至少1，有相关其他成员时通常2。

| 入口 | 外部函数执行 | 函数内部工作量与放大点 | 代码证据 |
| --- | --- | --- | --- |
| `login` | 1 | 查询本人资料1次；新用户写1次，已有完整资料通常无写。前端成功后仍单独调用`getUserInfo`做资料完成判断；虽然login已经返回`profileCompleted`，当前没有复用。可合并返回所需有限字段/权威完成状态，不靠客户端猜测 | [login:23](/Users/cat/Documents/Github/wx/cloudfunctions/login/index.js:23)、[login:78](/Users/cat/Documents/Github/wx/cloudfunctions/login/index.js:78)、[login页面:77](/Users/cat/Documents/Github/wx/pages/other/login/login.js:77)、[资料判断:38](/Users/cat/Documents/Github/wx/pages/other/login/login.js:38) |
| `getUserInfo` / `getPublicStats` | 各1 | 各1次数据库读取。首页PublicStats已有24小时本地缓存，不是每次回前台都读取 | [getUserInfo:9](/Users/cat/Documents/Github/wx/cloudfunctions/getUserInfo/index.js:9)、[getPublicStats:26](/Users/cat/Documents/Github/wx/cloudfunctions/getPublicStats/index.js:26)、[home缓存:3](/Users/cat/Documents/Github/wx/pages/home/home.js:3) |
| `getHomeTripList` | 1 | 1次userInfo查询，再按集合各合并ID、每50个查询。`Q=1+ceil0(C/50)+ceil0(R/50)`，C、R为各自集合候选ID并集。乘客旧引用不含类型，同一ID会进入两边查询 | [readUser:119](/Users/cat/Documents/Github/wx/cloudfunctions/getHomeTripList/index.js:119)、[fetchMap:90](/Users/cat/Documents/Github/wx/cloudfunctions/getHomeTripList/index.js:90)、[集合并集:160](/Users/cat/Documents/Github/wx/cloudfunctions/getHomeTripList/index.js:160) |
| `syncMyTripStatus` | 1；客户端成功结果按账号节流10分钟 | 基础读取与getHomeTripList近似；对到期路线更新状态/公共计次/个人计次，必要时更新userInfo历史索引。已经settled的路线仍有单文档复查；未settled且有k名有效参与者，个人计次一次尝试约`2+2k`次显式读取、至多`1+k`次写入，另有状态/公共计次操作。参与者变化或事务冲突最多3次外层尝试 | [基础读取:351](/Users/cat/Documents/Github/wx/cloudfunctions/syncMyTripStatus/index.js:351)、[到期处理:409](/Users/cat/Documents/Github/wx/cloudfunctions/syncMyTripStatus/index.js:409)、[计次:146](/Users/cat/Documents/Github/wx/cloudfunctions/syncMyTripStatus/rideCompletion.js:146)、[10分钟节流:901](/Users/cat/Documents/Github/wx/pages/home/home.js:901) |
| 首页同步后再次读路线 | 额外0或1 | 首页先读列表，随后后台sync；如果状态/历史变化又调用getHomeTripList，重读本人索引和路线。变化为0不会重读，不可算成每次固定三请求 | [home:810](/Users/cat/Documents/Github/wx/pages/home/home.js:810)、[changed后重读:918](/Users/cat/Documents/Github/wx/pages/home/home.js:918) |
| `getMyTripHistory` | 每次调用1；冷进入有两处无去重入口 | 后端1次userInfo查询；司机创建D、司机加入J、乘客创建K、乘客历史P分别批查，`Q=1+ceil0(D/100)+ceil0(J/100)+ceil0(K/100)+2×ceil0(P/100)`。角色之间有重叠还会重复读取；无历史分页。页面onLoad和onShow都直接调用，`loadHistoryTrips`无在途合并/TTL，是确定存在的重复入口 | [页面onLoad:17](/Users/cat/Documents/Github/wx/pages/profile/tripHistory/tripHistory.js:17)、[onShow:30](/Users/cat/Documents/Github/wx/pages/profile/tripHistory/tripHistory.js:30)、[无去重请求:106](/Users/cat/Documents/Github/wx/pages/profile/tripHistory/tripHistory.js:106)、[后端5组回填:76](/Users/cat/Documents/Github/wx/cloudfunctions/getMyTripHistory/index.js:76) |
| `getTripList`日期页，type=all | 每次日期页1 | 两类各按100条循环读至不满100，再各1次探测下一日期，最后做拉黑查询。若该范围两类记录数均<100，通常`Q=4+B`，有身份且有其他成员通常6次SDK读取。一般式为`Σ_t(floor(N_t/100)+1)+T+B`，T是集合数；整百记录会多一次空页确认 | [日期循环:420](/Users/cat/Documents/Github/wx/cloudfunctions/getTripList/index.js:420)、[下一日期探测:467](/Users/cat/Documents/Github/wx/cloudfunctions/getTripList/index.js:467)、[两类与拉黑:587](/Users/cat/Documents/Github/wx/cloudfunctions/getTripList/index.js:587) |
| `getTripList`旧快速列表 | 1 | 默认每类1条查询；快速查询报错，或调用者关闭fastOnly且快速结果不足时，每类再发6条兼容查询。双类最差路径可达14条列表查询再加B。应记录fallback实际发生率，不能假定线上都命中此路径 | [快速与fallback:364](/Users/cat/Documents/Github/wx/cloudfunctions/getTripList/index.js:364) |
| `getTripList`calendar / places | 各1 | calendar内部读完相关月份；places内部读完当前城市所有有效日期供给，而不是只拿列表当页。均用100条循环，无下一日期探测，再拉黑过滤。返回数据虽小，内部读取可多。客户端月历已有5分钟共享缓存，不能宣称每次点日期都全量重查 | [calendar:483](/Users/cat/Documents/Github/wx/cloudfunctions/getTripList/index.js:483)、[places:539](/Users/cat/Documents/Github/wx/cloudfunctions/getTripList/index.js:539)、[既有缓存说明:40](/Users/cat/Documents/Github/wx/docs/call-volume-optimization-2026-09-11.md:40) |
| `getTripDetail` | 1 | 先正文1次；非成员每20名成员2次拉黑存在性查询；认证者再读本人评分记录1次，司机资料通常1次，Request有权限者额外分批读乘客资料。当前已是批量拉黑检查，不能再按旧“每成员两读”估算 | [拉黑批量:263](/Users/cat/Documents/Github/wx/cloudfunctions/getTripDetail/index.js:263)、[主入口扇出:319](/Users/cat/Documents/Github/wx/cloudfunctions/getTripDetail/index.js:319) |
| `marketApi`普通列表/距离排序 | 1 | 普通列表1次查询，无count；未要求fastList时另解析图片临时链接。距离排序每一页重新扫描最多DISTANCE_SORT_SCAN_LIMIT条并本地排序，按批次查询，须按启用占比衡量 | [普通分页:1234](/Users/cat/Documents/Github/wx/cloudfunctions/marketApi/index.js:1234)、[距离扫描:1256](/Users/cat/Documents/Github/wx/cloudfunctions/marketApi/index.js:1256)、[图片链接:772](/Users/cat/Documents/Github/wx/cloudfunctions/marketApi/index.js:772) |
| `marketApi`详情trackView | 1 | 正文读取1次；若要求trackView，再读该用户/商品/日计数，未达日限则写计数文档并更新商品总数（额外1读2写），还可能有冷实例建集合检查及图片临时链接。达到限额仍会先查询日计数。它不是每条研究曝光的完整日志 | [view:1330](/Users/cat/Documents/Github/wx/cloudfunctions/marketApi/index.js:1330)、[detail:1388](/Users/cat/Documents/Github/wx/cloudfunctions/marketApi/index.js:1388) |

这里`N_t`指服务器该条件实际扫描返回记录数，而不是最终客户端可见卡片数。列表在读取后做拉黑或地点匹配，最后只显示10张不意味着只读10条。

## 3. referral：可明确核验的重复与读写

[app.js:105](/Users/cat/Documents/Github/wx/app.js:105)和[app.js:115](/Users/cat/Documents/Github/wx/app.js:115)分别在appLaunch、appShow调用`captureReferral`。有ref参数时，[utils/referral.js:75](/Users/cat/Documents/Github/wx/utils/referral.js:75)每次调用trackVisit，未对同一次入站建立稳定ID。冷启动两个生命周期拿到同一ref的情况下可以产生两次函数调用；具体占比未知，不能假定所有启动都有ref。

正常有效推荐访问的trackVisit：推荐码映射和推荐人资料约2次读，写visit1次，再读stats1次/写stats1次，即通常3读2写；fallback会增加查询/映射写。visitId带`Date.now()+Math.random()`，请求重试或生命周期重复不会由服务端幂等合并。[referralApi:106](/Users/cat/Documents/Github/wx/cloudfunctions/referralApi/index.js:106)、[trackVisit:166](/Users/cat/Documents/Github/wx/cloudfunctions/referralApi/index.js:166)。

`getMyReferralCode`正常已有code时仍查询userInfo并`set`映射（1读1写）；客户端已有code会命中本地缓存，不必每次调用。`getStats`还额外读stats和最近20条绑定。`bindReferral`有已有绑定短路；首次成功包含查推荐人、查绑定、写绑定、查/更改被推荐人、读/写统计。客户端有在途合并，成功会清掉pending。[ensure:64](/Users/cat/Documents/Github/wx/cloudfunctions/referralApi/index.js:64)、[bind:193](/Users/cat/Documents/Github/wx/cloudfunctions/referralApi/index.js:193)、[stats:246](/Users/cat/Documents/Github/wx/cloudfunctions/referralApi/index.js:246)、[前端缓存:80](/Users/cat/Documents/Github/wx/utils/referral.js:80)。

## 4. 定时、全扫描、网站和健康检查

本地可见唯一timer是[cleanupMarketImages/config.json:3](/Users/cat/Documents/Github/wx/cloudfunctions/cleanupMarketImages/config.json:3)，与[cloudbaserc.json:83](/Users/cat/Documents/Github/wx/cloudbaserc.json:83)相同：`0 0 4 * * * *`，每天一次（具体执行时区由云端配置决定，本次不猜）。正常配置仅约1次函数执行/天，不能凭这个timer解释47,700次函数执行；内部会每100条扫描商品与MarketFiles，默认各最多5000条（最多各50个SDK分页读取），再分批删存储文件、逐记录标记cleaned，默认最多200条。实际扫描/删除数未知。[cleanup:114](/Users/cat/Documents/Github/wx/cloudfunctions/cleanupMarketImages/index.js:114)、[上限与入口:303](/Users/cat/Documents/Github/wx/cloudfunctions/cleanupMarketImages/index.js:303)。

`syncTripStatus`没有本地timer；只有显式`fullScan=true`才全扫描，普通没有ID也不扫描。全扫描每100条读所有记录，再逐条同步及复查个人计次，即一次函数可能做大量DB工作。其入口没有基于调用者的维护权限校验；是否实际被调用、调用者及配置未知。将来应将维护权限、批次和进度游标作为独立工作核实，不为降低成本移除必要计次。[fullScan:356](/Users/cat/Documents/Github/wx/cloudfunctions/syncTripStatus/index.js:356)、[入口:378](/Users/cat/Documents/Github/wx/cloudfunctions/syncTripStatus/index.js:378)。

公开英文网站确实可能增加CloudBase执行，但已有缓存：相邻[public-worker/index.mjs:71](/Users/cat/Documents/Github/wx.web/public-worker/index.mjs:71)列表TTL120秒、详情60秒；[198行](/Users/cat/Documents/Github/wx.web/public-worker/index.mjs:198)先读缓存，同实例相同在途请求合并，未命中才[214行](/Users/cat/Documents/Github/wx.web/public-worker/index.mjs:214)访问CloudBase `marketApi`。静态文件读取不走这个后端接口。配置有每IP与源站限流，但不能把每个节点/实例的限流配置当成全站严格每日账单上限。未缓存的公开列表每集合最多扫描150条、至多2次读取；不同offset页仍重新扫描再切片；图片另做临时URL解析。[publicPreview:328](/Users/cat/Documents/Github/wx/cloudfunctions/marketApi/publicPreview.js:328)、[切片:401](/Users/cat/Documents/Github/wx/cloudfunctions/marketApi/publicPreview.js:401)。

网站后台是不同HTTP分支，实际POST动作会进入CloudBase；Bearer验证通常先读session和account两次，再执行动作。[webAdminSecurity:41](/Users/cat/Documents/Github/wx/cloudfunctions/marketApi/webAdminSecurity.js:41)。浏览器跨域OPTIONS进入该handler时会提前204，不读数据库；是否网关截获或执行函数须用监控区分，不能把每次POST机械乘2。[webAdmin:56](/Users/cat/Documents/Github/wx/cloudfunctions/marketApi/webAdmin.js:56)。

在本项目云函数、相邻公开网站/后台源代码与可见Worker配置中，未发现持续heartbeat、health轮询或scheduled Worker回调；超时用的setTimeout是中止请求，不是周期轮询。**未检查云端配置和外部监控服务，不能据此排除云外健康检查、旧客户端、旧部署或其他调用者。** 历史2026-09-08审计的“其余无触发器”不能替代今日线上核验。

## 5. 五个优先优化点

1. **先修已确定的重复入口，收益最好解释。** 历史页onLoad/onShow用同一在途请求与按账号/变更版本的成功缓存；后端把五组历史回填先合并为两类集合并集，再引入有明确完整性语义的历史分页。referral用一次入站visitId贯穿launch/show，服务端去重后再增计数；不要把真实不同回访强行合并。login复用已经返回的权威资料完成状态，必要时随同返回后续页面需要的有限资料，避免刚登录立即再查一遍。
2. **合并首页读取与必要同步，保持已有缓存。** 设计一个认证首页响应：共享一次userInfo定位与路线批读，到期且未处理才做同步，直接返回同步后的本人列表/最早下次变化时间。普通返回仍用已有30秒缓存，sync保留已有10分钟节流/必要业务失效机制；取消“有变化后再完整重读一次”的可避免往返。不要让合并函数每次请求强制进行所有计次事务；错误修复可重试性与权限仍须保留。
3. **削减getTripList内部放大，而非只看返回包小。** 核验复合索引和旧fallback的真实触发率；优先保证新日期查询正常。calendar/places依据供给版本复用结果或按需维护候选聚合，避免每个用户重扫全月/全部未来日期；个性化拉黑过滤不能被公共缓存抹掉，跨用户缓存也不能泄露受限供给。缓存命中率、读取页数、fallback次数应先有分动作聚合证据。
4. **将网站与二手观测分开归因，缓存可公共化部分。** 统计marketApi按来源与action区分publicWeb/admin/mini-program；公开网站继续边缘缓存与同请求合并，热点源站可返回按供给版本的公共DTO，避免每offset重扫。同商品重复浏览先采用已有业务语义下的短期去重；若把view遥测转独立服务，应明确原实时公开viewCount的更新策略，不能悄悄改变产品计数。
5. **独立采集服务先接新增研究遥测，不迁走预约事务。** 新浏览/选择集批次直传独立HTTPS接收器；login或既有认证请求顺带短期签名研究token，接收器本地验签，不每批回CloudBase。核心业务事件留同事务outbox，按批导出，而不是每事件跨云调用。开始时按2–4小时或更慢的研究导出时效预算选择频率：每小时24次/日、每6小时4次/日只是算术示例，实际需求/分页需测。它会增加少量CloudBase写入和导出扫描，不能承诺把当前47,700次消除。

## 6. 验证改进需要的最小证据

先获取同一完整日期、同一时区的聚合统计：函数名、HTTP/SDK/timer来源、action、调用数、失败/重试、耗时、日期页数、读取/写入SDK计数及公开网关缓存命中。区分线上正式用户、开发者工具、人工核验脚本与导出任务；不要输出用户openid或查询正文。优先利用现有云监控/日志，避免为了量调用而每次另调用“计数函数”。若必须加测量，只在原执行内累加，按抽样/批次汇总，并标明覆盖版本与样本比例。

函数执行模型可写为 `F_day = F_mini_program + F_web_origin_miss + F_admin + F_timer + F_manual_and_legacy + F_retries`。内部DB/存储SDK操作用 `Σ(action请求数 × 该动作实测平均操作数)`另算。先与控制台指标逐项对齐，再按实测占比排列优化；代码确定的重复入口可以先修，但不得用静态模型伪造精确节省百分比。
