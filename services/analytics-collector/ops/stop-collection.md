# 客服核验后的管理员停止采集

本期不新增弹窗、按钮、报名或采集设置页。用户通过个人中心已有“客服”入口提出停止请求；客服/管理员先核验请求者与当前小程序账号的归属及真实停止意图，然后在采集主机上运行本工具。工具不发送任何客服消息，也不能代替归属核验。

`stop-collection.mjs` 只支持固定 AppID `wx8a8a389199aa2a0e` 的停止操作，只连接本机 `127.0.0.1:3000/internal/v1/research/participation`。它先取当前状态，再以该版本执行一次 `withdraw`；从未启用的账号也写入撤回标记，阻断之后自动启用。已经关闭直接返回已关闭。它不含 `activate`、重开、删除业务行程或修改其他账号的功能。

客户端正式环境使用真实命名空间，develop/trial使用独立test命名空间。本工具固定派生 `linkx-research-account-v1` **真实命名空间**，不支持关闭或清理test授权；不要为清理测试而对同账号运行此工具。当前镜像以服务器实际部署记录为准，不依据此操作指南猜测版本。

`src/compat/legacy.mjs` 保留已有作用域、说明版本、loopback路由和 `/etc/linkx-research-ops` 路径。它们是 `TEMPORARY COMPATIBILITY`：下一版正式发布验证成功后，还需完成账号授权与运维配置迁移才能改名或删除；源码目录改名不改变密钥或用户身份。

## 安装条件

- 主机不安装 Node.js。管理员使用已部署的 Node.js 24 Docker 镜像启动一次性工具容器，root 用户、只读文件系统、移除 capabilities，仅挂载运维密钥和脚本；不进入正在运行的 collector 容器。
- `/etc/linkx-research-ops/subject.key`：与 CloudBase `statistics` 参与桥使用相同的 64 位十六进制 subject 密钥。目录由 root 独占（0700），文件 root 所有且 0600。该新增副本仅供主机管理员工具，不挂入 collector 容器。
- `/etc/linkx-research-ops/bridge.key`：参与桥接 HMAC 密钥的 root-only 运维副本，文件 root 所有且 0600。它与 collector 使用的 `/etc/linkx-collector/bridge.key` 值相同，但原文件保留 UID 1000/0600 给容器读取，不放宽原文件权限。subject/bridge 两种密钥必须不同，不能复用 publicStats 密钥。
- 输入 JSON 文件也须 root 所有、0600、普通文件、非符号链接，最多 4096 字节。只有 `openid` 一个字段，不接受客户端提供的研究 subject。

subject 密钥现有两个受限位置：CloudBase 私有部署包，以及主机 root 专用运维目录。不能再描述为“绝不离开 CloudBase”。它不进入客户端、研究数据库、普通日志、镜像或 collector 挂载。密钥变更必须同步双方并有映射迁移安排，不能独立替换一端后误以为仍能找到原账号。

## 执行

不要把原始 openid 放在命令行参数、命令字符串、shell 历史、环境变量、工单日志或截图里。安全渠道提供的输入格式为只含 `openid` 的 JSON 对象。优先由可信输入源通过 stdin 提供，再执行以下命令；命令本身不包含账号值：

```sh
sudo docker run --rm -i --network host --read-only --cap-drop ALL \
  --security-opt no-new-privileges:true --user 0:0 \
  -v /etc/linkx-research-ops:/etc/linkx-research-ops:ro \
  -v /opt/linkx-collector/ops/stop-collection.mjs:/app/ops/stop-collection.mjs:ro \
  -v /opt/linkx-collector/src/compat/legacy.mjs:/app/src/compat/legacy.mjs:ro \
  --entrypoint node "$COLLECTOR_IMAGE" /app/ops/stop-collection.mjs
```

`COLLECTOR_IMAGE` 填当前已部署镜像名称，不放凭据。仅挂载上面的运维密钥目录、脚本和兼容常量三个只读路径，不挂载数据库、业务文件或Docker socket。host网络让工具访问宿主loopback的固定服务地址。不要为了管道使用包含原始账号值的 `echo`/shell 命令。stdin 最长等5秒，每次本机请求最多3秒，最多两次请求，不跟随重定向，不自动重试。

若确需 `--input-file`，另把已准备的root-owned0600 JSON单文件只读挂载到工具容器，再传容器内文件路径；不要挂整个工单或用户数据目录。脚本仍会检查所有权、权限、类型和大小。优先使用可信stdin，避免留下原始账号临时文件。

成功仅输出 `ok/status/alreadyClosed`，失败仅输出 `ok/status/error`；不输出原始账号、研究键、密钥、token、版本或响应正文。`ok=true,status=revoked` 表示读取时已经关闭或本次服务端撤回已确认。它不表示旧备份已经立即物理擦除。

若发生 `STATE_CONFLICT`、`OPERATION_SUPERSEDED` 或网络超时，结果按未知/未确认处理。**不要自动重跑或重新取版本撤回**：先核查期间是否发生了新授权，以及原停止请求是否仍对应当前授权；必要时再次确认请求范围，再由管理员决定新的一次操作。脚本本身不会把旧请求作用到后来新建的 grant。首次写入可能已成功但 ACK 丢失，后续经核验的执行可从状态读回确认，不能仅因报错宣称停止失败或已经成功。

处理完成后按运维规则清理含原始账号的临时输入文件；普通文件删除不等于所有介质上的安全擦除。不将该文件复制到备份或研究导出。维护用途/说明版本时同步兼容常量及所有已部署调用方；版本不匹配时工具拒绝操作，不尝试绕过校验。

## 测试

```sh
node --test ops/stop-collection.test.mjs
```

上述测试在本地开发环境运行，生产主机无需安装运行时。测试只用合成身份、临时私有文件和模拟传输；导入模块不会读取主机密钥或连接真实服务。

历史验收记录（2026-09-23，不表示当前运行状态）：当时开发者工具测试后的清理由部署负责人另行执行，只删除synthetic=1、purpose=ride-research-v1、截至1790190142676的11批/28事件载荷；测试和真实eligible事件均0，保留最小去重收据及1个active测试授权供后续测试。该清理没有使用本停止工具，没有撤销真实或测试身份，也不表示所有控制元数据已删除。
