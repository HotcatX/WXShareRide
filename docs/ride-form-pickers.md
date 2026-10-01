# 路线发布日期、时间与地点选择

本文说明当前客户端行为；正式发布边界见[切库记录](backend-cutover-2026-09-30.md)。

## 使用方式

- 司机发车、乘客求车与路线列表共用中文月历；发布页按钮为“确定日期”。日期下显示青绿“X发”、橙色“X求”，统计当前城市和已选起终点的路线。
- 时间使用底部弹窗，24 小时制，小时 00–23、分钟 00–59。确认才写入表单，取消保留原值；模板和任意分钟继续支持。
- 出发地、目的地使用可搜索面板，“自选”也在同一面板填写，最多 200 字。确认后沿用参考价计算和提交时的时间校验。
- 自动区合并本账号最近最多 3 个自选地点与服务端公共推荐，和固定地点去重。每次打开先展示缓存并主动刷新，异步结果直接更新当前面板，保留搜索、自选草稿及已选值。
- 首页“我要求车”进入 `newTrip?mode=passenger`，登录或完善资料后保留乘客模式。首页社区数据保留原 24 小时缓存。

## 配置与请求

固定地点、司机/乘客地址选项及参考价格由 `GET /api/v1/locations` 提供，客户端通过 [locationConfig](../utils/locationConfig.js)共享五分钟缓存。维护入口是 [config/locationCatalog.json](../config/locationCatalog.json)及[配置同步说明](../services/backend/src/locations/README.md)。

`utils/placeCatalog.js` 提供名称、别名和稳定地点 ID 的统一查找。Fort Lee 核心区/全区域等历史报价键保留；机场具体接送点的报价必须精确匹配，不能直接套整个机场的参考价。未知报价保持未知。

动态推荐由 [placeRecommendations](../utils/placeRecommendations.js)通过已验证的采集会话读取 `/v1/place-suggestions`，传入城市、起终点侧、司机/乘客/筛选模式和另一端地点。成功结果缓存五分钟并合并在途请求；每次打开面板会绕过缓存有效期主动刷新。缓存按账号、授权范围、上下文、业务刷新标记和目录版本隔离，关闭、切号或上下文变化后的迟到响应被丢弃。服务不可用时保留固定地点和本人最近地点。推荐来源、公共候选规则和排序见[地点推荐说明](place-recommendations.md)。

旧 `getTripList({action:'places'})` 兼容请求仅验证城市并返回空的 `fromPlaces` / `toPlaces`；旧客户端继续使用其固定选项。

## 日历共享与过期

[日历控制器](../utils/rideCalendarPicker.js)、`templates/ride-calendar.wxml` 和 `styles/ride-calendar.wxss` 供列表与发布页共用。成功统计从返回时缓存五分钟；同一次运行内，身份、月份、城市、路线类型和地点筛选相同的页面共享结果与在途请求，重复使用不续期。

路线变更版本、身份、筛选或当天日期变化时使用新缓存键。失败可重试；关闭或卸载页面不取消供其他页面复用的读取，迟回包不更新已离开的页面。共享的只有统计，选中日期与草稿各页独立；发布和加入仍需后端实时校验。

## 验证入口

当前对应测试：`tests/ride-calendar.test.cjs`、`ride-calendar-shared-cache.test.cjs`、`ride-time-picker.test.cjs`、`ride-place-picker.test.cjs`、`place-recommendations.test.cjs`（均位于 `tests/`）。本次整理核对源码及链接；历史模拟器截图、测试条数和部署任务号已从当前操作说明移除，不据此声称新版已正式发布。
