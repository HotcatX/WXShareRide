# 文档索引

当前业务数据以 PostgreSQL 为准。日常维护先看下面的说明；已完成的旧审计、部署清单和修复验收从当前目录删除，历史证据保存在固定 Git 提交中。

## 运行与数据

| 文档 | 用途 |
| --- | --- |
| [后端说明](../services/backend/README.md) | 业务服务结构、接口与本地验证 |
| [业务数据合同](../services/backend/SCHEMA.md) | 身份、行程、市场、图片、管理与迁移字段的统一合同 |
| [后端运维](../services/backend/ops/README.md) | 部署、备份与恢复工具 |
| [主机监控](../deploy/monitor/README.md) | 30 秒采样、30 天历史、只读挂载及资源上限 |
| [云函数部署边界](../cloudfunctions/DEPLOYMENT.md) | 正常部署名单、同一 PostgreSQL 的兼容入口及已退役入口 |
| [采集服务](../services/analytics-collector/README.md) | 行为采集、存储与服务维护 |
| [9 月 30 日切库记录](backend-cutover-2026-09-30.md) | 当时的交接、生产核验、旧入口清理与发布限制 |

切库记录按时间保留过程证据，早期状态不代表后续最终状态。其历史 `data/...` 路径保持原样；私有导出、恢复包和部署回执的现存位置、归档内路径见本地 `data/README.md`。这些私有材料不进入 Git。

## 功能与研究

| 文档 | 内容 |
| --- | --- |
| [路线表单选择器](ride-form-pickers.md) | 日期、时间、地点与共享日历 |
| [地点推荐与数据设计](place-recommendations.md) | 地点目录、推荐规则和研究所需记录 |
| [公告与拼车群入口](community.md) | 社区配置及展示规则 |
| [个人拼车计次](ride-completion-stats.md) | 完成次数、角色及计数边界 |
| [公开统计](public-statistics.md) | 公共统计读取、缓存及运维 |
| [出行研究数据合同](ride-research-data-contract.md) | 行为事件、业务事实、回访与研究解释限制 |

## 历史报告

已完成或被现行说明取代的报告不再保留展开副本。全部原文在 [清理前的 docs 快照](https://github.com/HotcatX/WXShareRide/tree/b8af79069735e921e36a6165d9f5acc1dbc88809/docs)，以下按主题提供入口：

- 后端重写、调用与成本：[合并审计](https://github.com/HotcatX/WXShareRide/blob/b8af79069735e921e36a6165d9f5acc1dbc88809/docs/backend-call-migration-audit-2026-09-25.md)。历史调用量和成本口径仅适用于报告中的观察范围。
- 旧数据库与字段映射：[数据审计](https://github.com/HotcatX/WXShareRide/blob/b8af79069735e921e36a6165d9f5acc1dbc88809/docs/backend-data-audit-2026-09-25.md)、[行程契约审计](https://github.com/HotcatX/WXShareRide/blob/b8af79069735e921e36a6165d9f5acc1dbc88809/docs/backend-ride-contract-2026-09-25.md)。同一快照中保留身份、座位、城市、价格与旧市场字段报告。
- 地点与采集升级：[9 月 24 日部署验收](https://github.com/HotcatX/WXShareRide/blob/b8af79069735e921e36a6165d9f5acc1dbc88809/docs/backend-deployment-2026-09-24.md)。旧触发器和部署顺序以当时记录为限。
- 旧云函数清理：[9 月 8 日审计](https://github.com/HotcatX/WXShareRide/blob/b8af79069735e921e36a6165d9f5acc1dbc88809/docs/cloudfunctions-audit-2026-09-08.md)。当前保留入口以现行部署边界为准。
- 网站管理、朋友圈、登录、求车联系与缓存修复：[历史目录](https://github.com/HotcatX/WXShareRide/tree/b8af79069735e921e36a6165d9f5acc1dbc88809/docs)。当前行为由对应源码、数据合同和功能说明维护。

历史源码、测试命令和部署步骤用于追溯当时实现；恢复和发布使用当前运维说明及同一 PostgreSQL 主库。
