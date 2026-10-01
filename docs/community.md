# 公告与拼车群

社区配置由 PostgreSQL 保存。小程序使用 `GET /api/v1/community`；普通管理员与最高管理员均可通过 `GET/POST /api/v1/admin/community` 修改公告和群二维码。

保存提交 `{expectedVersion, config}` 和固定 `Idempotency-Key`。版本冲突需要刷新；超时后重试同一原键与正文。保存、版本历史和图片引用在同一事务提交，不能直接修改数据库 JSON 绕过这条合同。

| 配置 | 用途 |
| --- | --- |
| `group` | 群入口的开关、标题、二维码文件 ID 和有效期；启用时必须有可读取图片和未来有效期 |
| `announcement` | 公告 ID、标题、正文、图片、自动展示开关和展示时间 |
| `showGroupImage` | 使用当前群二维码；公告有效期不会超过群有效期 |
| `maxShows`、`intervalHours` | 小程序本地自动展示次数和间隔，以公告 ID 区分不同公告 |
| `startAt`、`endAt` | 生效与结束时间；空值表示该侧不限制 |

关闭自动展示仍可通过手动入口查看有效公告。标题和正文支持长按选择复制；没有新增复制按钮。管理员修改纯文字时保留原二维码文件 ID。

图片通过受控上传接口取得 UUID，内容中不保存对象存储路径或永久公开网址。公开图片读取仍由当前配置、有效期和文件权限决定；历史版本保留图片引用，不能在更新时删除旧图片。复制其他文件 ID 不会新增图片访问权限。

配置与验证以 [社区 schema](../services/backend/src/community/schemas.ts)、[服务](../services/backend/src/community/service.ts) 和 [PostgreSQL 测试](../services/backend/test/community.integration.test.ts) 为准。旧 CloudBase 管理动作、集合字段和旧部署验收已退出当前操作说明。
