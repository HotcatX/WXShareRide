# 主机监控

每 30 秒启动一次短任务，读取主机 CPU `/proc/stat` 和四个固定容器的状态、CPU：`linkx-backend-backend-1`、`linkx-backend-database-1`、`linkx-collector-collector-1`、`linkx-collector-caddy-1`。主机 CPU 按两次系统计数差计算；首次为 `null`。容器与业务进程 CPU 使用单核基准，不能与主机总体百分比直接比较。

任务限额为 CPU 10%、内存 64 MiB、15 秒总超时，单次 Docker 读取最多 4 秒。不读取环境变量、逐请求日志或业务数据库，不更改容器。采样任务仅从固定路径读取既有 collector admin token，访问 collector 私有 Unix socket 和本机 backend 3101 端口；密钥不进入快照或历史。Docker socket 仅供这个主机任务使用；业务后端不挂载 Docker socket。

在服务器已保存仓库文件后，从仓库根目录执行：

```sh
sudo install -d -o root -g root -m 0755 /opt/linkx-monitor /opt/linkx-monitor/public
sudo install -d -o root -g root -m 0700 /opt/linkx-monitor/private
sudo install -o root -g root -m 0755 services/backend/scripts/host-metrics.py /opt/linkx-monitor/host-metrics.py
sudo install -o root -g root -m 0644 deploy/monitor/linkx-host-metrics.service /etc/systemd/system/linkx-host-metrics.service
sudo install -o root -g root -m 0644 deploy/monitor/linkx-host-metrics.timer /etc/systemd/system/linkx-host-metrics.timer
sudo systemd-analyze verify /etc/systemd/system/linkx-host-metrics.service /etc/systemd/system/linkx-host-metrics.timer
sudo systemctl daemon-reload
sudo systemctl start linkx-host-metrics.service
sudo systemctl enable --now linkx-host-metrics.timer
```

网络限制仅放行 AF_UNIX 与 IPv4 127.0.0.1；其他 IP 均拒绝。后端 `/internal/v1/monitor` 使用既有 collector admin token 鉴权，Caddy 不公开转发该路径。

任务只保留 `CAP_DAC_OVERRIDE`，用于读取容器 UID 1000 所有的 `0600` 密钥及连接其私有 Unix socket；不复制密钥或改变所有权。`ProtectSystem=strict` 与固定写入目录保持有效，主服务不新增权限。

Unit 先检查 `/var/run/docker.sock` 存在，再用 `ExecCondition=/usr/bin/test -S` 确认它是 socket。只运行采样任务，不启动或重启 Docker。

输出为 `/opt/linkx-monitor/public/host.json`，root 原子替换，文件 `0644`；CPU 基线放在 private 目录，文件 `0600`。将 **public 目录**只读绑定为 `/run/linkx-host`，后端设置 `HOST_METRICS_FILE=/run/linkx-host/host.json`。绑定目录能看到原子替换后的新文件；不要只绑定单个文件，也不要暴露 private 目录。

主机每 30 秒采样，前台轮询与后端读取接口缓存仍为 10 秒。采样失败保留上次快照；距采样时间超过 60 秒显示 `stale`，缺失或格式错误显示 `unavailable`，主服务继续运行。采集汇总超过读取上限时显示真实接收数量的下限，不能当作精确总量。

## 历史图表

同一短任务将 CPU 和完整分钟的请求、活动计数写入 private/metrics.sqlite，文件 `0600`，每分钟一行，30 天最多约 43,200 行，时间主键读取与淘汰。内存与磁盘不再采样或进入接口。升级会删除仅用于旧资源历史的 metrics 表，使用新结构；部署前可将该私有文件压缩备份，业务和采集数据库完全不变。

请求按直连、旧版转接、采集三组计数；排除管理接口及轮询、健康检查、静态、OPTIONS 和不存在的路由。已注册接口的失败响应仍是请求；重试每次算请求。计数只在进程内累加，不保存逐请求身份、载荷或路径，不向业务 PostgreSQL 逐请求写入。进程只保留六个完整分钟，启动/重启时第一个不完整分钟省略；缺失或超出窗口的部分记为 null，不能补零。完整健康分钟确实没有请求时才为零。

活动与采集量复用真实事件收据，按服务端接收分钟统计去重事件与现有 accounts 关联下绑定 OpenID 的唯一真实账号。活动不是在线人数、总用户或跨时段唯一用户；延迟上传按收到的时间归档，跨分钟活动人数不能相加。查询每分钟最多 10,001 条索引收据，不解压批载荷；达到上限时该历史分钟为 null，实时汇总标明下界。

每分钟发布 public/history-day.json、history-week.json、history-month.json，分别按 2 分钟、15 分钟和 1 小时分桶，每份最多 720 点/512 KiB。每个指标保留 mean、min、max、peakAt、samples，CPU 峰值来自 30 秒采样，请求和活动峰值来自完整分钟。请求三组附每分钟均值，不把长周期的均值冒充原始计数。缺失指标为 null，空窗不填零。

升级替换 sampler、backend/collector 代码和 service，timer 保持 30 秒，public 目录只读绑定保持不变。历史 SQL 最多 8 秒；CPU 限额针对单核，双核服务器最多占整机容量 5%，完整分钟历史仍每分钟只导出一次。历史写入/查询失败保留上次历史，当前 host.json 仍更新。业务后端不挂载 private SQLite 或 Docker socket。验证：`python3 services/backend/test/host-metrics.test.py`，并运行对应 Node 监控/流量和真实 PostgreSQL 隔离测试。根部署前先停止 timer、私有备份旧 metrics.sqlite；部署后启动 service 并读回新 schemaVersion 2 文件与任务状态。
