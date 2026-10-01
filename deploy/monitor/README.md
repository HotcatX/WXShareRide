# 主机监控

每 30 秒启动一次短任务，读取主机 `/proc`、根盘容量和四个固定容器的状态、CPU、内存：`linkx-backend-backend-1`、`linkx-backend-database-1`、`linkx-collector-collector-1`、`linkx-collector-caddy-1`。主机 CPU 按两次系统计数差计算；首次为 `null`。容器与业务进程 CPU 使用单核基准，不能与主机总体百分比直接比较。

任务限额为 CPU 5%、内存 64 MiB、9 秒总超时，单次 Docker 读取最多 4 秒。不读取环境变量、日志、数据库或密钥，不更改容器。Docker socket 仅供这个主机任务使用；业务后端不挂载 Docker socket。

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

Unit 先检查 `/var/run/docker.sock` 存在，再用 `ExecCondition=/usr/bin/test -S` 确认它是 socket。只运行采样任务，不启动或重启 Docker。

输出为 `/opt/linkx-monitor/public/host.json`，root 原子替换，文件 `0644`；CPU 基线放在 private 目录，文件 `0600`。将 **public 目录**只读绑定为 `/run/linkx-host`，后端设置 `HOST_METRICS_FILE=/run/linkx-host/host.json`。绑定目录能看到原子替换后的新文件；不要只绑定单个文件，也不要暴露 private 目录。

主机每 30 秒采样，前台轮询与后端读取接口缓存仍为 10 秒。采样失败保留上次快照；距采样时间超过 60 秒显示 `stale`，缺失或格式错误显示 `unavailable`，主服务继续运行。采集汇总超过读取上限时显示真实接收数量的下限，不能当作精确总量。

## 历史图表

同一短任务把主机 CPU、内存和磁盘样本按分钟合并到 private/metrics.sqlite，文件 `0600`。每分钟最多一行，30 天约 43,200 行，预计小于 10 MB；按时间主键查询，每分钟删除超过 30 天的历史。CPU 对有效样本求均值，内存和磁盘对该时段样本求均值。

每分钟更新 public/history-day.json、history-week.json、history-month.json，分别使用 2 分钟、15 分钟和 1 小时时段，每份最多 720 点，三份总载荷最多 512 KiB。历史不足时仅显示已有样本，不补零或伪造天数。历史存储/查询失败保留旧历史文件，当前 host.json 仍正常更新。

升级时替换 host-metrics.py 即可，原 unit、timer 和目录只读绑定继续使用。不要把 private 目录或 SQLite 文件挂给业务后端；历史读取只读 public 目录。验证命令：`python3 services/backend/test/host-metrics.test.py`。生产升级后先运行一次 service，再查看生成文件的采样时间与 timer 状态。
