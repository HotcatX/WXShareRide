# 按 OpenID 查账号事件

只读工具 `diagnose-account.mjs` 从 stdin 或 root-owned 0600 JSON 文件接收 `{"openid":"…"}`，查询采集服务现有账号状态、事件时间线和批次收据。默认真实环境、最近24小时、最多50事件及50批次；`--mode test` 明确查询测试命名空间。输出保留 OpenID、participant/batch/event ID、事件白名单字段和时间，方便定位反馈；不输出 grant、token、密钥或 subject。

可信 `statistics` 云桥把 OpenID 写入一次 `research_accounts`，事件按 participant 关联。`operational_events` 视图可直接查询 `openid`、`synthetic`、`tripKey`；论文提取使用不含 OpenID 的 `eligible_real_events`。旧账号会在下一次新版 status/activate 时补齐 OpenID，不能逆算旧 HMAC；未采集、已过期或撤回删除的事件无法补回。工具的 `coverage` 明确真实180天/测试14天事件窗口，收据分别187天/30天；筛选依据服务端 `receivedAt`，事件内另有客户端 `occurredAt`。`hasMoreEvents/hasMoreBatches` 表示结果截断，可缩小时间窗。

服务端管理端点只监听受保护的 UNIX socket，不经 Caddy、不公开 HTTP。请求为 `{openid,synthetic,from,to,limit}`，时间为 epoch 毫秒、单次窗口最多180天、limit为1..100。查询不修改状态、不签发 token；恢复隔离或撤回状态不会返回无资格事件载荷，仍可看到最小批次收据解释缺失。

管理员通过安全输入源提供 JSON，**不要把 OpenID 放进命令行或 shell 历史**。使用本次部署的 collector 镜像运行（下面的 `COLLECTOR_IMAGE` 只填镜像名称，不放凭据）：

```sh
sudo docker run --rm -i --network none --read-only --user 0:0 \
  --cap-drop ALL --cap-add DAC_OVERRIDE --security-opt no-new-privileges:true \
  -v /var/lib/linkx-collector/run:/run/linkx-collector:ro \
  -v /etc/linkx-collector/admin.token:/run/linkx-admin.token:ro \
  -v /opt/linkx-collector/ops/diagnose-account.mjs:/app/ops/diagnose-account.mjs:ro \
  -v /opt/linkx-collector/ops/stop-collection.mjs:/app/ops/stop-collection.mjs:ro \
  --entrypoint node "$COLLECTOR_IMAGE" /app/ops/diagnose-account.mjs
```

只挂 socket目录、admin.token和两个脚本，不挂数据库、subject密钥、Docker socket或网络。`DAC_OVERRIDE` 仅用于连接现有 UID1000/0600 socket并读取同样受保护的 admin.token，工具仍强制验证文件所有权、权限和类型；不放宽服务现有权限。脚本复用 stop 工具的输入校验函数，导入不会执行停止操作。

需要时间筛选时追加 `--from <epoch毫秒> --to <epoch毫秒> --limit 100`，需要测试账号时追加 `--mode test`。输入文件方式另挂一个 root-owned 0600、非符号链接的 JSON 单文件，再传 `--input-file <容器内路径>`；不挂整个工单目录。stdin最多等5秒，管理请求最多3秒，不重试、不跟随重定向。输出包含内部账号身份和行为，只交给授权排障人员，不作为普通服务日志或公开研究导出。

本地合成验证：`node --test test/diagnostics.test.mjs ops/diagnose-account.test.mjs`。测试不读取生产账号或密钥。
