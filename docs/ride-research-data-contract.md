# 出行行为采集接口与数据合同

数据语义初版：2026-09-23。当前运行读回见[后端部署记录](backend-foundation-deployment-2026-09-25.md)，不以代码存在推断真实用户已在上传。实时协议以采集服务 README 和校验器为准。

## 当前产品范围

用户要求仅更新现有隐私政策，不新增同意引导、弹窗、按钮、采集设置或管理页。旧方案的主动报名要求已被本期产品指令替代。本期是 `privacy_notice` 下的首期行为观测与研究准备，**技术启用不是用户明确同意研究的证据**；后续正式研究再利用/发表按实际用途另行评估。

研究仅 `release` 5%，`develop/trial` 0%；共用publicStats匿名安装桶，但公共统计自己的develop/trial仍100%。桶仅本地工程分流，不是平台版本灰度、研究随机化或用户同意。首次服务端 `none` 可自动 `activate`；`active` 复用当前技术授权；`revoked` 绝不自动重开。

本期页面只接入出行 `page_view`、明确日期的显式 `search_submitted`、无候选明细且 `candidatesComplete=false` 的 `result_set_rendered`。不采卡片几何曝光，不把搜索当明确出行意向，不从past/点击/访问推断成行。P0业务outbox、可信tripKey结果回访、明确意向/时间窗、完整候选和价格实验均是后续工作。

## 事件与字段

批次为 `{schemaVersion:1,batchId,events:[...]}`。事件包含 `eventId,eventName,schemaVersion,occurredAt,data`，`sessionId`可选。时间为Unix毫秒，服务器另记接收时间；事件允许最近7天及最多未来5分钟。一个批次内eventId不可重复。

以下是接收器协议白名单，**只有前三项在本期页面触发**，其余存在不等于已采集：

| 事件 | 必填data | 可选data |
| --- | --- | --- |
| page_view | page | 无 |
| search_submitted | searchId,tripType,serviceDate | originArea,destinationArea,partySize,intentId |
| result_set_rendered | searchId,selectionSetId,source,renderedCount,loadedDateCount,hasMore,candidatesComplete | zeroReason,candidates（本期不填candidates） |
| result_card_visible | selectionSetId,tripKey,tripType,position,visibilityBucket | 无 |
| trip_detail_opened | tripKey,tripType,source | 无 |
| contact_entry_clicked | tripKey,tripType,method | 无 |
| no_suitable_option | searchId,reason | intentId |
| collection_diagnostic | reason,droppedCount | 无 |

未知字段和自由文本拒绝。标识符为16–80位A–Z/a–z/0–9/_/-不透明字符串；格式通过不证明去标识化。原始openid、姓名、电话、微信号、车牌、支付账号、聊天、精确住址和备注不得编码塞进标识符或载荷。粗区域仅fort_lee/columbia/other/unknown，日期为2000–2099有效YYYY-MM-DD，人数1–8，行程类型carpool/request，搜索还可all。

渲染来源区分network/cache；真实加载范围、hasMore和零结果/错误语义必须保留。预取不算展示，渲染不等于注意力。候选协议最多50项，若将来candidatesComplete=true必须数组存在且长度等于renderedCount；本期恒false，不能据此复原完整选择集。参考价整数分仅是参考价，currency为USD或unknown，不是支付或成交事实。

## 云身份与技术授权

统一CloudBase入口为 `statistics`，分派公共统计读取、定时同步和 `status/activate/withdraw`。旧getPublicStats/syncPublicStatsReplica兼容旧包/旧timer，可能多一次函数执行；业务事务内评分与累计更新不拆出。已有文件/内部服务名research-collector不因此代表全部业务迁移。

身份只来自本次 `context.environment/environ` 的平台字段：固定当前AppID、wx_client/wx_devtools来源、本人OPENID，拒绝客户端自报身份、跨应用身份与process.env/getWXContext全局回退。云端生成用途隔离的HMAC账号假名accountSubject，原始OPENID不传入collector。subject密钥存在于CloudBase私有包及主机root专用运维目录，不挂容器；客户端不持有任何服务密钥。

SQLite保存技术启用、grant和关闭状态。`confirmed=true`、`acceptedPurposeVersion`是SDK兼容字段名，仅说明服务端技术授权，不证明主动研究同意。日志和分析不得把activate改记成consent。目的为ride-research-v1，当前说明版本ride-research-notice-2026-09-23。

token为Ed25519 JWT：固定alg=EdDSA/typ=JWT/kid，claims包含iss,aud,sub,grantId,statusVersion,purposeVersion,iat,exp,jti。sub为participantKey，默认有效900秒、配置60–900秒；客户端接收tokenExpiresAtMs且只存内存。验签固定公钥，拒绝客户端指定算法/远程密钥；短token不代替实时授权检查。

同一participant的statusVersion单调递增，synthetic类别不可改变；旧授权撤回后不可再激活，重新启用须新grant。当前前端没有重新启用已revoked账号的入口或自动流程。批次事务同时核对当前active/grant/用途/版本，因此旧token即使未过期也不能在撤回后写入。

## 接口与幂等

| 接口 | 用途与认证 |
| --- | --- |
| GET /healthz | 只返回健康，不暴露账号/载荷 |
| POST /v1/batches | Bearer短期token；返回ok,batchId,payloadHash,eventCount,receivedAt,duplicate |
| POST /internal/v1/research/participation | 独立HMAC，仅可信云桥与root运维工具使用；status/activate/withdraw |
| UNIX socket /v1/status、/v1/participants/state、/v1/tokens、/v1/recovery/complete | 独立管理密钥；不发布公网 |

参与客户端请求严格为action/requestId/expectedStatusVersion/purposeVersion/noticeVersion。云桥另加accountSubject，客户端不能指定它。预期版本0表示尚无状态。签名正文最大8192字节；三个头各一次：毫秒X-Linkx-Timestamp、16字节随机数的32位小写hex X-Linkx-Nonce、X-Linkx-Signature。签名为HMAC-SHA256(keyBytes,timestamp+'\n'+nonce+'\n'+rawBody)，key为专用hex解码的32字节，不复用公共统计密钥。时间窗±5分钟，nonce持久化至timestamp+5分钟，重复拒绝。

操作按(accountSubject,requestId)及摘要幂等；同ID异内容拒绝，已被后续版本取代返回OPERATION_SUPERSEDED。新操作必须匹配当前版本。重试可用新nonce但保留原requestId/动作/预期版本，不能重新取最新版本自动执行旧操作。未启用账号的withdraw也建立版本化关闭标记，阻断迟到activate。status可返回active但无session（停采/恢复隔离等），不能因此允许上传，可信停止操作仍可执行。

批次只接受未压缩UTF-8 application/json，1–50条、最大65,536字节；必须为紧凑JSON.stringify原始字符串，重复键/额外空白导致重序列化不同则拒绝。收到正文后再次验证token有效期。无效token401，当前授权不符403，冲突409，事件字段422，超限413，不支持类型415，限流429，存储或恢复隔离503。

SQLite WAL+synchronous=FULL；BEGIN IMMEDIATE中完成当前授权核对、收据与载荷提交，再ACK。批次唯一(participantKey,batchId)，原始UTF-8字节SHA-256相同才允许幂等重试；相同ID不同内容/授权冲突。event_receipts按(participantKey,eventId)另做跨批去重，事件摘要对键排序；eligible_events只取首次接收，不能把重试增加为新观测。400/401等拒绝不等于业务行程失败。

## 客户端与停止

本地队列ride_research_queue_v1按participant/grant/版本/用途隔离，切账号或授权改变清旧队列。仅正式版资格、有效技术授权和前台允许入队。缺token时已授权事件可暂存但不上传；401需续期、403停队列并清理、409/422停自动重试、429/5xx退避。配置前台15秒合批、首批尽快，一次仅一个在途；不承诺后台持续上传。

队列最多500条、256KiB、7天；每批≤50条且≤64KiB。只有ACK的ok/batchId/hash/count匹配才出队，丢ACK保留原批次字节。持久化失败不冒充成功；过期不可变批次整批放弃并记丢失，不改原batchId正文。

本期没有新增停止按钮或管理页。用户从个人中心既有客服提出请求，核验本人后管理员运行[stop-collection工具](../services/analytics-collector/ops/stop-collection.md)：原openid仅stdin或root-owned0600文件；root-only subject/bridge副本；固定loopback status→单次withdraw CAS；未知账号可写关闭标记，不activate、不重试冲突，不输出ID/key/token/正文。底层SDK withdraw只清本地，不能代替服务端停止；只有服务端确认才能确认跨设备停止。

## 保留与恢复

真实载荷从receivedAt计保留策略180天；分析视图先排除过期项，物理清理有维护周期尾差。本机备份滚动7天。真实事件/批次收据在载荷已清且超过187天后清理；操作收据187天，nonce按时间窗清理。合成载荷14天/收据30天。账号假名映射、当前状态、撤回grant标记当前不自动到期删除，用于维持可靠关闭，不当作行为观测。

撤回事务删在线载荷并保存最少阻断信息；不承诺WAL/旧备份/介质所有副本瞬时物理擦除。本机每日备份采用SQLite在线备份及integrity_check，0600；不是直接复制运行中的主文件。容量默认数据库页1GiB、剩余空间保护256MiB，WAL/备份另计；磁盘满不ACK。当前没有COS异机备份，ACK不保证整盘丢失时零数据损失。

restore-check仅生成新候选、不覆盖运行库；候选先关闭恢复gate，再校验/原子发布。gate关闭时接收、签token和分析视图受阻。恢复完成会删除旧真实载荷、撤销旧真实grant并递增版本，**无条件锁旧说明版本，空旧备份也一样**，防止备份后发生但丢失的停止被旧请求复活。新说明版本同步云/服务/客户端，但不自动重开revoked；恢复后的重新启用另行处理。不能仅凭integrity_check就认定已恢复最新状态。

## 验证与上线缺项

有效回归覆盖丢ACK原样重试、重启、撤回、满盘不ACK、HMAC、CAS、恢复空库阻断和保留验证。部署读回以[后端部署记录](backend-foundation-deployment-2026-09-25.md)为准，旧测试不能证明后续版本发布完成。

Caddy只代理明确路径，collector Node仅宿主机loopback，管理socket不公开；独立公开统计另有sidecar。实际开关、statistics部署、正式包审核/发布、首个真实批次、维护任务与root停止工具安装仍由部署负责人记录。三类观测不构成完整论文数据：P0outbox、结果回访、可信关联、时间窗和选择集仍需补采；无回答永远不能补成否。
