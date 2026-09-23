# 动态定价：长期备选与现在应保留的证据

日期：2026-09-22。性质：补充文献扫描及本地价格流程审查；没有调整报价、部署功能或启动价格实验。

## 判断

动态定价值得预留数据接口，但现阶段不替代首篇主线。一般性的“根据供需、时间和余位调价，再用优化/强化学习提升收益”已有大量近邻；甚至“非强制价格建议如何改变司机行为”也已有直接对应的BlaBlaCar工作。换一个小程序和数据集不足以确认创新。

长期收集不等于必须等一年才开始判断。现在应把价格的含义和决策时快照保存正确，在诊断先导中检查实际价格变异、价格不合的自报比例、司机可调价意愿和真实结果覆盖。若同类场景价格几乎固定、失败主要由地点或时刻造成，继续累积相同数据不会自动识别价格弹性。

## 直接相关的一手来源

本表为追加扫描，不把工作论文网页或会议摘要计入此前14篇全文阅读。

| 研究 | 本次证据层级 | 对选题的约束 |
| --- | --- | --- |
| Farajallah、Hammond、Pénard，2019，[What drives pricing behavior in Peer-to-Peer markets?](https://www.sciencedirect.com/science/article/pii/S0167624517302135) | 出版方摘要与引言；此前B4 | BlaBlaCar司机经验、报价与售座已有实证研究；经验、信誉与价格不能混为同一机制。 |
| Yan等，2021，[Matching and pricing in ride-sharing: Optimality, stability, and financial sustainability](https://doi.org/10.1016/j.omega.2020.102351) | 出版方摘要与部分正文；此前P15 | 私人司机拼车的匹配、成本分配、稳定性和预算约束已有联合研究。 |
| Lahiri、Avetian、Mohsin、Zhu，[How does price recommendation shape drivers' behavior in the carpooling market](https://sites.google.com/view/surjasamalahiri/home/research) | 作者工作论文目录及[学术研讨会摘要](https://sites.google.com/essec.edu/pse-essec-workshop/speakers)，未取得全文，不推断已正式发表或核验完整识别 | 摘要介绍利用BlaBlaCar建议价上调研究司机响应及供给变化。非强制价格建议本身不是新概念；正式选题前仍需取得完整方法作比较。 |
| Freund、van Ryzin，2025，[Pricing fast and slow: Limitations of dynamic pricing mechanisms in ride-hailing](https://doi.org/10.1016/j.trc.2025.105314) | 出版方摘要、引言、模型/结论片段；2021作者稿登记另见[SSRN](https://papers.ssrn.com/sol3/papers.cfm?abstract_id=3931844) | 模型讨论乘客等降价导致供给波动和排队替代。时间—价格选择与策略性等待也已有先例；不是本平台已观察到的事实。 |
| Alisoltani等，2025会议材料，[Dynamic Pricing and Matching in P2P Ride-Sharing](https://www.matsim.org/conferences/mum2025/abstracts/MUM25_paper_4.pdf) | 已读3页扩展摘要，不等同正式长文 | P2P场景的动态价格与匹配仿真也已出现；不把模拟幅度当可复制的现场增益。 |

以上足以说明方向拥挤，不足以断言所有具体问题都已解决。部分出版方直开返回403，本次采用其公开索引片段和作者/学术活动页面，未绕过访问限制。

## 当前小程序的价格到底是什么

- **Carpool：司机每人挂牌参考价。** [发布输入](../../pages/home/newTrip/newTrip.js:457)可手动更改；[createTrip](../../cloudfunctions/createTrip/index.js:221)保存referencePrice。预填可来自[个人常用价/平台默认](../../utils/driverRideDefaults.js:17)或[模板](../../pages/home/newTrip/newTrip.js:579)，旧记录未标来源。它不是付款记录。
- **Request：配置生成的参考价。** [newTrip](../../pages/home/newTrip/newTrip.js:483)按OD读取Request_Price；页面锁定输入，但[后端](../../cloudfunctions/createTrip/index.js:275)仍接受客户端值，不独立核验来源。不是乘客最高愿付价，也不是当时Uber/Lyft的真实报价。
- **单位需审查。** UI按每人展示，求车还有平摊说明；人数改变没有同步重新计算。团体席位、账号人数和报价单位不能推定一致。模板可含区间/自由文本，既有[展示解析](../../utils/tripManage.js:21)可能只取第一个数字，研究解析不能照搬。
- **没有完整价格历程或结算。** [加入](../../cloudfunctions/joinTrip/index.js:194)及[接单](../../cloudfunctions/tripManage/index.js:593)没有预约时价格快照；现有管理动作未发现已发布行程正式改价接口。个人默认价/模板调整不等于该行程改价。[Zelle入口](../../pages/profile/myTripDetailPassenger/myTripDetailPassenger.js:401)仅复制信息，不证实转账。

## 现在低负担补上，后续再决定是否研究定价

在已有研究授权与数据边界内，第一阶段增加被动字段，不增加价格弹窗，不改价格或默认推荐规则：

| 时点 | 增加字段 | 语义 |
| --- | --- | --- |
| 发布/源设置生效 | 金额、币种与币种依据、单位、价格类型、来源、预填金额、最终金额、配置/模板版本、是否手改 | 预填、司机主动选择和配置价格分开；客户端来源声明与服务端可验证来源分开 |
| 选择集渲染 | 实际显示金额/单位、价格表示类型、解析/显示版本、cacheAge、位置、对应行程版本 | 看见的价格可能不同于服务器当前价；区间/议价/未知不强制变单值 |
| 加入/接单 | 业务提交时referencePrice快照、价格/行程版本、membershipId、seatUnits，关联priceSeen | 只能称操作时参考价，不是已同意或已支付价格 |
| 未来有正式改价时 | 前后报价、生效时间、当时余位、原因枚举、既有预约价格保护规则 | 本次只预留事件定义，不实现自动改价或伪造历史改价 |

金额使用整数分；范围用上下界，无法确定币种/单位/金额时单列unknown，不解析成0，也不复制自由文本。历史priceVersion没有就标legacyUnknown，从启用之后开始记录。

实际约定金额与支付金额需要另行、自愿询问；可以先在愿意参加的少量用户中验证是否值得收集，不把它塞进每一次是/否成行弹窗。区分“是否按页面价结算、双方约定金额、已支付金额、尚未结算、拒答”，记录个人/整组、覆盖人数、币种与自报来源。不要读取支付账号或转账凭证，不把不愿透露当0元。

## 有条件保留的更具体问题

可探索“**临近出发或取消释放的座位，价格调整是否增加真实同行，还是引起等待、退订重订及下一次不愿提前预约**”。本平台私人司机自主报价、重复交易和跨日承诺可成为重要约束，但这些差异尚未证实构成文献空白，也不能只凭故事确立选题。

另一个测量问题是挂牌参考价、约定价和实际支付金额是否有系统差异，以及这种差异是否使仅用挂牌价的需求估计失真。它需要足够可靠的自报与可检验机制，单纯新增一个金额字段不是独立贡献。

若先导支持价格确实是重要摩擦，才设计范围明确的自愿价格建议或报价政策比较；事先明确保持既有预约承诺、客观分组范围和主要结果。正式设计要处理司机不采纳建议、共享运力和跨期学习：比较被分配到政策的全部合格用户，不能只比较采纳建议的司机。随机建议通常首先识别建议政策的效果，不能未经额外排除限制就称为纯价格弹性。

长期关联数据能控制更多可观测条件，但价格仍随司机、路线、时段、提前量和稀缺程度变化，不能直接把高低价的预约差异解释成因果。单纯机器学习拟合、扩大观察期或套用固定效应不会自动解决这个问题。

当前决定：保留价格模块的研究可能性，立即把被动价格快照纳入采集提示词；不把动态定价算法列为当前开发目标，不扩大第一版结果弹窗。
