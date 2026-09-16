# 管理功能迁至独立网站

## 2026-09-10 变更

原 `pages/market/marketTrade/marketTrade` 隐藏管理员入口已移除，包括手势、假错误密码框、六位处理码、会话恢复、本地管理令牌、批量草稿表单、管理图片上传和相关样式。该页继续承担已卖 / 已买交易列表、分页、详情与微信号复制。

`marketApi` 中对应旧小程序管理员动作和六位码认证已移除。网站管理仍复用该函数，新增分离的 HTTP Bearer 鉴权分支；正常小程序 list/create/update/delete、公开预览和公告读取保持原身份边界。

网站源码位于相邻仓库 `../wx.web`，管理前端 `../wx.web/admin`，不随小程序代码上传。部署与日常维护见该仓库 README。

## 接口与权限

- 静态网站：首页 `/`，独立后台 `/admin/`，公开导航不展示管理员链接。
- HTTP 路由：`/admin-api` → 现有 `marketApi`，保留 Event 云函数类型。
- 公网调用进入专用 `webAdmin` handler，仅接受固定动作、精确来源白名单和通过校验的管理员会话。
- 用户名 + scrypt 密码摘要；无注册、六位码或开发环境万能口令。
- 服务端每次校验账号启用状态和密码版本，随机令牌哈希落库，8 小时有效。
- 登录尝试使用事务限流；上传检查真实图像格式和账号归属；商品、模板及公告变更记审计。

数据库新增/补齐并设 ADMINONLY：`WebAdminAccounts`、`WebAdminSettings`、`WebAdminLoginAttempts`、`WebAdminSessions`、`WebAdminUploads`、`WebAdminAuditLogs`、`CommunityConfigHistory`、`MarketImportBatches`、`MarketAdminTemplates`。后两项旧代码曾引用但实际没有集合，不删除任何历史商品。

网站商品使用 `ownerKey` + `managedByAccountId`，不伪造微信 `_openid`。普通小程序用户不能借网页商品身份更新它。旧管理员真实微信身份发布的商品保留兼容读取/编辑边界；显式另一个网站账号拥有的记录不可跨账号编辑。

## 去重与恢复

每条发布以 ownerKey + clientRequestId 导出确定 ID。批次、内容摘要及审计记录永久保留。网络中断后重试原快照，返回原商品 ID，避免重复创建。未知提交结果不允许直接修改并换请求 ID。

商品编辑要求 expectedVersion；同请求重放可返回原结果，其他版本冲突拒绝覆盖。公告与历史备份、审计在同一事务提交，重复保存不会额外推进版本。

## 公告热更

网站“群码与公告”写入 `community_config/main`。自动弹出初始关闭；手动查看逻辑见 `community-hot-update.md`。群二维码以新的 `cloud://` 路径保存，旧图留作历史恢复；不把临时下载 URL 存为持久配置。

未附着的网站图片会保留上传记录，但现有清理函数只处理旧 market 路径，暂不自动删除 web-admin 路径，以免误删群码或回滚所需图片。

## 2026-09-16 图片上传修复

CloudBase HTTP 网关对 JSON/文本请求体限制为 100 KB；原先图片转 Base64 后放入 JSON，即使图片小于后台标示的 2 MB，也会被网关拒绝为 `413 EXCEED_MAX_PAYLOAD_SIZE`。该网关错误没有 CORS 头，浏览器只能显示连接失败。相同原图使用 `application/octet-stream` 后可通过网关的二进制通道，函数按 `isBase64Encoded` 解码并读取原 JSON 上传参数。

仅 `uploadImage` 使用二进制传输；其他后台动作仍使用 JSON。来源白名单、Bearer 会话、最大 2 MB、真实图片格式、账号归属、哈希去重和审计均保持原校验。后端 `webAdmin.js` 应先于新版管理前端部署，继续兼容旧客户端的小图 JSON 上传。无需新增函数、集合或临时分块。

限制依据：[CloudBase EXCEED_MAX_PAYLOAD_SIZE](https://docs.cloudbase.net/en/error-code/EXCEED_MAX_PAYLOAD_SIZE)。生产接口已只读复现原图 143,841 字节 JSON 被网关拒绝；二进制同字节请求可进入函数。

微信保存的部分 JPEG 会在 EOI 结束标记后附加元数据，原先强制最后两字节为 EOI 会误拒绝完整图片。`webAdminContent.js` 现在按 JPEG 分段边界检查帧、扫描与结束标记，允许尾部附加数据，保留原图全部字节；不会把 EXIF 内嵌的 EOI 当作完整图片。对应测试覆盖微信附加数据、渐进扫描、截断及伪造图片。

本次群码替换为用户提供的 NYNJ 生活服务原图，群码展示到期和公告结束时间同步设置为 2027-09-16（纽约时间），保留其他公告设置和旧图。先直接更新版本 5，再通过修复后的管理接口验证原图上传和保存，最终版本为 6，图片位于 `web-admin/admin/2135e9c3edef1a69634101c89222b944.jpg`；回读文件与原图 107,802 字节完全一致。该设置控制小程序展示，不改变微信本身的二维码有效性。原配置及更新记录备份于仓库外 `CloudFunctionBackups/WXCarGoods/community-2026-09-16/`。

验证：442 项小程序/云函数测试、9 项管理前端测试通过。两个后端文件增量部署成功，腾讯云 `/admin/index.html` 和新 JS 产物与本地构建一致；小程序模拟器已确认显示完整新二维码。

## 验证

- 小程序/云函数：`node --test tests/*.test.cjs`，168 项通过。
- 小程序 5 个页面/组件的 WXML/WXSS 编译共 10 项通过。
- 网站构建及模型/API/静态产物测试位于 `../wx.web`。
- 真实 HTTPS 7 项已通过：未登录 401、错误来源 403、登录 / 会话 / bootstrap / 登出 200、已登出令牌再次调用 401。另以官方函数调用验证 SDK 事务、配置读取正常。未发布测试商品或改动现有群二维码。
- 已启用个人版环境已有 HTTP 访问总开关，保持原套餐、超限设置、函数和数据库权限；未创建订单。

云函数部署前代码、云端初始化记录和初始账号交付文件保存在仓库外的 `CloudFunctionBackups/WXCarGoods/2026-09-10/`。密码不入 Git、静态目录或日志。
