// pages/home/driverPickupList/driverPickupList.js
const LIST_REFRESH_INTERVAL = 30 * 1000;
const STATUS_REFRESH_KEY = "driverPickupListStatusRefreshAtV1";
const STATUS_REFRESH_INTERVAL = 10 * 60 * 1000;

Page({
  data: {
    requestList: [],
    originalRequestList: [],
    loading: false,

    statusBarHeight: 80,
    pageTitle: "司机接人",

    // ✅ 出发地筛选（初始不选）
    fromFilterOptions: ["全部", "其他"],
    fromFilterIndex: -1,

    // ✅ 目的地筛选（初始不选）
    toFilterOptions: ["全部", "其他"],
    toFilterIndex: -1,

    // 时间筛选（初始不选）
    timeFilterOptions: ["今天", "明天", "其他"],
    timeFilterIndex: -1,

    todayDateStr: "",
    tomorrowDateStr: "",

    showToast: false,
    toastText: "",

    // 用于“其他”判定（不含“全部/其他”）
    fromPlaceList: [],
    toPlaceList: [],

    // 是否启用“出发地 -> 目的地”联动收窄（基于当前请求列表聚合）
    enableToLinkage: true
  },

  _listLoadingPromise: null,
  _lastListLoadedAt: 0,
  _statusRefreshing: false,

  async onLoad() {
    const info = wx.getSystemInfoSync();
    this.setData({ statusBarHeight: info.statusBarHeight });

    const today = new Date();
    const tomorrow = new Date(today.getTime() + 24 * 60 * 60 * 1000);
    const fmt = (d) => {
      const y = d.getFullYear();
      const m = String(d.getMonth() + 1).padStart(2, "0");
      const day = String(d.getDate()).padStart(2, "0");
      return `${y}-${m}-${day}`;
    };

    this.setData({
      todayDateStr: fmt(today),
      tomorrowDateStr: fmt(tomorrow)
    });

    // ✅ 开启“发送给朋友/分享到朋友圈”
    wx.showShareMenu({
      withShareTicket: true,
      menus: ['shareAppMessage', 'shareTimeline']
    })

    this.loadRequestList({ showLoading: true }).then(() => {
      setTimeout(() => this.loadAddressFilterOptionsFromDB(), 200);
      setTimeout(() => this.refreshStatusInBackground(false), 800);
    });
  },

  onShow() {
    if (!this._lastListLoadedAt) return;
    if (Date.now() - this._lastListLoadedAt < LIST_REFRESH_INTERVAL) return;
    this.loadRequestList({ showLoading: false });
  },

  goBack() {
    const pages = getCurrentPages()
    const prev = pages.length >= 2 ? pages[pages.length - 2] : null
    const prevRoute = prev ? (prev.route || '') : ''
  
    // ✅ 兜底：如果上一页是详情页，此时 navigateBack 会回到详情页
    // 直接切回首页，保证用户体验正确
    if (prevRoute.includes('pages/home/driverPickupDetail/driverPickupDetail')) {
      wx.switchTab({ url: '/pages/home/home' })
      return
    }
  
    // 正常情况：从首页 navigateTo 进来，navigateBack 即可回首页
    if (pages.length > 1) {
      wx.navigateBack()
    } else {
      wx.switchTab({ url: '/pages/home/home' })
    }
  },

  // =========================
  // 适配你的地点库结构（字段名 keys 即地点）
  // =========================
  extractPlacesFromDoc(doc) {
    if (!doc || typeof doc !== "object") return [];
    return Object.keys(doc)
      .filter((k) => k && k !== "_id")
      .map((k) => String(k).trim())
      .filter(Boolean);
  },

  uniqNonEmpty(arr) {
    const seen = new Set();
    const out = [];
    (arr || []).forEach((x) => {
      const s = String(x || "").trim();
      if (!s) return;
      if (seen.has(s)) return;
      seen.add(s);
      out.push(s);
    });
    return out;
  },

  async loadAddressFilterOptionsFromDB() {
    try {
      const db = wx.cloud.database();

      // ✅ 改为读取带 Request 的两个集合
      const [depRes, arrRes] = await Promise.all([
        db.collection("Departure_Request").get(),
        db.collection("Arrival_Request").get()
      ]);

      const depDocs = depRes && depRes.data ? depRes.data : [];
      const arrDocs = arrRes && arrRes.data ? arrRes.data : [];

      const fromRaw = depDocs.flatMap((doc) => this.extractPlacesFromDoc(doc));
      const toRaw = arrDocs.flatMap((doc) => this.extractPlacesFromDoc(doc));

      const fromList = this.uniqNonEmpty(fromRaw);
      const toList = this.uniqNonEmpty(toRaw);

      this.setData({
        fromPlaceList: fromList,
        toPlaceList: toList,
        fromFilterOptions: ["全部", ...fromList, "其他"],
        toFilterOptions: ["全部", ...toList, "其他"],

        // ✅ 初始保持“不选中”（-1），不要强行变 0
        fromFilterIndex: this.data.fromFilterIndex >= 0 ? this.data.fromFilterIndex : -1,
        toFilterIndex: this.data.toFilterIndex >= 0 ? this.data.toFilterIndex : -1
      });
    } catch (e) {
      console.error("loadAddressFilterOptionsFromDB(Departure_Request/Arrival_Request) error", e);
      this.setData({
        fromPlaceList: [],
        toPlaceList: [],
        fromFilterOptions: ["全部", "其他"],
        toFilterOptions: ["全部", "其他"],
        fromFilterIndex: this.data.fromFilterIndex >= 0 ? this.data.fromFilterIndex : -1,
        toFilterIndex: this.data.toFilterIndex >= 0 ? this.data.toFilterIndex : -1
      });
    }
  },

  // =========================
  // 列表刷新逻辑
  // =========================
  async refreshStatusAndReload(forceStatusRefresh = true) {
    await this.loadRequestList({ showLoading: !this._lastListLoadedAt });
    this.refreshStatusInBackground(forceStatusRefresh);
  },

  refreshStatusInBackground(force = false) {
    if (this._statusRefreshing) return;

    const lastRefreshAt = Number(wx.getStorageSync(STATUS_REFRESH_KEY) || 0);
    if (!force && Date.now() - lastRefreshAt < STATUS_REFRESH_INTERVAL) return;

    const ids = (this.data.originalRequestList || [])
      .map(item => item && item._id)
      .filter(Boolean)
      .slice(0, 100);
    if (!ids.length) return;

    this._statusRefreshing = true;
    wx.cloud
      .callFunction({ name: "updateCarpoolRequestStatus", data: { ids } })
      .then((res) => {
        wx.setStorageSync(STATUS_REFRESH_KEY, Date.now());
        const updated = Number(res && res.result && res.result.totalUpdatedCarpoolRequest || 0);
        if (updated > 0) {
          this.loadRequestList({ showLoading: false });
        }
      })
      .catch((e) => {
        console.warn("updateCarpoolRequestStatus background error:", e);
      })
      .finally(() => {
        this._statusRefreshing = false;
      });
  },

  getFirstDeparture(trip) {
    if (!trip || !trip.departures || !trip.departures.length) return null;
    return trip.departures[0];
  },

  getTripDateTimeString(trip) {
    const dep = this.getFirstDeparture(trip);
    if (!dep || !dep.date || !dep.time) return "";
    return `${dep.date} ${dep.time}`;
  },

  // 分组标题：x月x日 周几
  formatMonthDayWeek(dateStr) {
    if (!dateStr) return "";
    const weekMap = ["日", "一", "二", "三", "四", "五", "六"];
    const dObj = new Date(`${dateStr}T00:00:00`);
    if (isNaN(dObj.getTime())) return dateStr;
    const m = dObj.getMonth() + 1;
    const d = dObj.getDate();
    const w = weekMap[dObj.getDay()];
    return `${m}月${d}日 周${w}`;
  },

  formatTimeOnly(timeStr) {
    if (!timeStr) return "";
    return timeStr.slice(0, 5);
  },

  goPickupDetail(e) {
    const id = e.currentTarget.dataset.id;
    if (!id) return;

    wx.navigateTo({
      url: `/pages/home/driverPickupDetail/driverPickupDetail?id=${id}`
    });
  },

  decorateListWithDateDivider(list) {
    let lastDate = "";

    list.forEach((trip, index) => {
      const dep = this.getFirstDeparture(trip);
      const currentDate = dep && dep.date ? dep.date : "";
      const currentTime = dep && dep.time ? dep.time : "";

      trip._dateLabel = currentDate ? this.formatMonthDayWeek(currentDate) : "";
      trip._timeLabel = currentTime ? this.formatTimeOnly(currentTime) : "";

      trip._fromAddress = dep && dep.address ? dep.address : "";
      const firstDest = (trip.destinations || []).find(d => d && String(d.address || "").trim());
      trip._toAddress = firstDest ? (firstDest.address || "") : "";


      if (index === 0) {
        trip._showDateDivider = true;
      } else {
        trip._showDateDivider = !!(currentDate && lastDate && currentDate !== lastDate);
      }

      lastDate = currentDate;
    });

    return list;
  },

  async loadRequestList(options = {}) {
    if (this._listLoadingPromise) return this._listLoadingPromise;

    this._listLoadingPromise = this._loadRequestListImpl(options).finally(() => {
      this._listLoadingPromise = null;
    });

    return this._listLoadingPromise;
  },

  async _loadRequestListImpl(options = {}) {
    const showLoading = options.showLoading !== false && !this._lastListLoadedAt;
    try {
      if (showLoading) this.setData({ loading: true });

      const res = await wx.cloud.callFunction({ name: "getCarpoolRequestList" });

      if (res.result && res.result.success) {
        const list = res.result.data || [];

        list.sort((a, b) => {
          const da = this.getTripDateTimeString(a);
          const db = this.getTripDateTimeString(b);
          if (da && db) return da.localeCompare(db);
          if (da) return -1;
          if (db) return 1;
          return 0;
        });

        const decorated = this.decorateListWithDateDivider(list);

        this.setData({
          originalRequestList: decorated,
          requestList: decorated,
          loading: false
        });
        this._lastListLoadedAt = Date.now();

        // ✅ 初始不选时，不联动、不强制改变 toIndex
        if (this.data.fromFilterIndex >= 0) {
          const fromSelected = this.data.fromFilterOptions[this.data.fromFilterIndex] || "全部";
          const nextToOptions = this.rebuildToOptionsByFrom(fromSelected);

          let nextToIndex = this.data.toFilterIndex;
          if (nextToIndex >= 0 && nextToIndex > nextToOptions.length - 1) nextToIndex = 0;

          this.setData(
            { toFilterOptions: nextToOptions, toFilterIndex: nextToIndex },
            () => this.applyAllFilters()
          );
        } else {
          this.applyAllFilters();
        }
      } else {
        wx.showToast({ title: "加载失败", icon: "none" });
        this.setData({ loading: false });
      }
    } catch (err) {
      console.error("loadRequestList error:", err);
      wx.showToast({ title: "加载失败", icon: "none" });
      this.setData({ loading: false });
    }
  },

  // =========================
  // 地址判断（Fort Lee 核心区/全区域逻辑不变）
  // =========================
  isFortLee(address) {
    if (!address) return false;
    const s = String(address);
  
    // ✅ 兼容你当前真实数据：直接是 "Fort Lee"
    if (s.indexOf("Fort Lee") >= 0) return true;
  
    // ✅ 兼容你之前的“预设文案”
    return (
      s.indexOf("Fort Lee 核心区") >= 0 ||
      s.indexOf("Fort Lee 全区域") >= 0
    );
  },
  

  isColumbia(address) {
    if (!address) return false;
    const s = String(address);
    return s.indexOf("哥大") >= 0 || s.indexOf("Columbia") >= 0;
  },

  isPresetPlace(address) {
    return this.isFortLee(address) || this.isColumbia(address);
  },

  makePlaceMatcher(place) {
    const p = String(place || "").trim();
    if (!p) return () => false;

    if (p.indexOf("Fort Lee") >= 0) return (addr) => this.isFortLee(addr);
    if (p.indexOf("哥大") >= 0 || p.indexOf("Columbia") >= 0) return (addr) => this.isColumbia(addr);

    return (addr) => !!addr && String(addr).indexOf(p) >= 0;
  },

  buildAnyFromMatchers() {
    return (this.data.fromPlaceList || []).map((x) => this.makePlaceMatcher(x));
  },

  buildAnyToMatchers() {
    return (this.data.toPlaceList || []).map((x) => this.makePlaceMatcher(x));
  },

  // ✅ 联动收窄目的地：基于当前 originalRequestList 聚合
  rebuildToOptionsByFrom(selectedFrom) {
    const baseTo = this.data.toPlaceList || [];
    const baseAll = ["全部", ...baseTo, "其他"];

    if (!this.data.enableToLinkage) return baseAll;
    if (!selectedFrom || selectedFrom === "全部" || selectedFrom === "其他") return baseAll;

    const matchFrom = this.makePlaceMatcher(selectedFrom);
    const toSet = new Set();

    (this.data.originalRequestList || []).forEach((trip) => {
      const deps = trip && trip.departures ? trip.departures : [];
      const dests = trip && trip.destinations ? trip.destinations : [];

      const hasFrom = deps.some((d) => matchFrom(d && d.address));
      if (!hasFrom) return;

      dests.forEach((d) => {
        const addr = d && d.address ? String(d.address).trim() : "";
        if (addr) toSet.add(addr);
      });
    });

    const narrowed = Array.from(toSet);
    if (narrowed.length === 0) return baseAll;

    return ["全部", ...narrowed, "其他"];
  },

  // =========================
  // 统一筛选：时间 + 出发地 + 目的地
  // =========================
  applyAllFilters() {
    const { originalRequestList, timeFilterIndex, todayDateStr, tomorrowDateStr } = this.data;
    let filtered = (originalRequestList || []).slice();

    // 时间筛选（只有用户选了才筛）
    if (timeFilterIndex >= 0) {
      filtered = filtered.filter((trip) => {
        const dep = this.getFirstDeparture(trip);
        const d = dep && dep.date ? dep.date : "";
        if (!d) return false;

        if (timeFilterIndex === 0) return d === todayDateStr;
        if (timeFilterIndex === 1) return d === tomorrowDateStr;
        return d !== todayDateStr && d !== tomorrowDateStr;
      });
    }

    const { fromFilterOptions, fromFilterIndex, toFilterOptions, toFilterIndex } = this.data;

    // ✅ 只有用户真的选择了筛选项（index>=0）才算“地址筛选激活”
    const addressFilteringActive = fromFilterIndex >= 0 || toFilterIndex >= 0;

    const fromSelected = fromFilterIndex >= 0 ? fromFilterOptions[fromFilterIndex] : null;
    const toSelected = toFilterIndex >= 0 ? toFilterOptions[toFilterIndex] : null;

    const fromLastIndex = fromFilterOptions.length - 1; // 其他
    const toLastIndex = toFilterOptions.length - 1; // 其他

    const anyFromMatchers = this.buildAnyFromMatchers();
    const anyToMatchers = this.buildAnyToMatchers();

    filtered = filtered.filter((trip) => {
      const departures = trip.departures || [];
      const destinations = trip.destinations || [];

      // ✅ 地址筛选开启时：按“存在任意有效项”做基本校验，避免第0项为空导致整条被误杀
      if (addressFilteringActive) {
        const depOK = (departures || []).some(d =>
          d && d.date && d.time && String(d.address || "").trim()
        );

        const destOK = (destinations || []).some(d =>
          d && String(d.address || "").trim()
        );

        if (!depOK || !destOK) return false;
      }


      // 出发地
      let passFrom = true;
      if (fromSelected !== null) {
        if (fromSelected !== "全部") {
          if (fromFilterIndex === fromLastIndex) {
            // 其他：不匹配任何已配置 from
            passFrom = departures.some((d) => {
              const addr = d && d.address ? String(d.address).trim() : "";
              if (!addr) return false;
              if (!anyFromMatchers || anyFromMatchers.length === 0) return !this.isPresetPlace(addr);
              const matchesAny = anyFromMatchers.some((fn) => fn(addr));
              return !matchesAny;
            });
          } else {
            const matchFrom = this.makePlaceMatcher(fromSelected);
            passFrom = departures.some((d) => matchFrom(d && d.address));
          }
        }
      }

      // 目的地
      let passTo = true;
      if (toSelected !== null) {
        if (toSelected !== "全部") {
          if (toFilterIndex === toLastIndex) {
            // 其他：不匹配任何已配置 to
            passTo = destinations.some((d) => {
              const addr = d && d.address ? String(d.address).trim() : "";
              if (!addr) return false;
              if (!anyToMatchers || anyToMatchers.length === 0) return !this.isPresetPlace(addr);
              const matchesAny = anyToMatchers.some((fn) => fn(addr));
              return !matchesAny;
            });
          } else {
            const matchTo = this.makePlaceMatcher(toSelected);
            passTo = destinations.some((d) => matchTo(d && d.address));
          }
        }
      }

      return passFrom && passTo;
    });

    const decorated = this.decorateListWithDateDivider(filtered);
    this.setData({ requestList: decorated });
  },

  // =========================
  // 筛选事件
  // =========================
  onFromFilterChange(e) {
    const index = Number(e.detail.value);
    const fromSelected = this.data.fromFilterOptions[index] || "全部";

    const nextToOptions = this.rebuildToOptionsByFrom(fromSelected);

    // ✅ 若用户此前未选择目的地（-1），保持 -1；若已选择但越界，回到 0
    let nextToIndex = this.data.toFilterIndex;
    if (nextToIndex >= 0 && nextToIndex > nextToOptions.length - 1) nextToIndex = 0;

    this.setData(
      {
        fromFilterIndex: index,
        toFilterOptions: nextToOptions,
        toFilterIndex: nextToIndex
      },
      () => this.applyAllFilters()
    );
  },

  onToFilterChange(e) {
    const index = Number(e.detail.value);
    this.setData({ toFilterIndex: index }, () => this.applyAllFilters());
  },

  onTimeFilterChange(e) {
    const index = Number(e.detail.value);
    this.setData({ timeFilterIndex: index }, () => this.applyAllFilters());
  },

  onResetFilter() {
    // ✅ 重置回“未选择”（不筛选），但保留选项中的“全部”
    const fromOptions = ["全部", ...(this.data.fromPlaceList || []), "其他"];
    const toOptions = ["全部", ...(this.data.toPlaceList || []), "其他"];

    this.setData(
      {
        fromFilterOptions: fromOptions,
        fromFilterIndex: -1,
        toFilterOptions: toOptions,
        toFilterIndex: -1,
        timeFilterIndex: -1
      },
      () => this.applyAllFilters()
    );
  },

  async onPullDownRefresh() {
    try {
      await this.refreshStatusAndReload();
    } finally {
      wx.stopPullDownRefresh();
    }
  },

    // =========================
  // 分享（好友 + 朋友圈）
  // =========================
  buildShareTitle() {
    const {
      pageTitle,
      fromFilterIndex,
      fromFilterOptions,
      toFilterIndex,
      toFilterOptions,
      timeFilterIndex,
      timeFilterOptions
    } = this.data

    const fromText =
      fromFilterIndex >= 0 ? (fromFilterOptions[fromFilterIndex] || '') : ''
    const toText =
      toFilterIndex >= 0 ? (toFilterOptions[toFilterIndex] || '') : ''
    const timeText =
      timeFilterIndex >= 0 ? (timeFilterOptions[timeFilterIndex] || '') : ''

    const parts = []
    if (fromText && fromText !== '全部') parts.push(fromText)
    if (toText && toText !== '全部') parts.push(`→ ${toText}`)
    if (timeText) parts.push(`· ${timeText}`)

    const title = `${pageTitle || '司机接人'}${parts.length ? '：' + parts.join('') : ''}`
    return String(title).trim().slice(0, 30) || '查看司机接人列表'
  },

  buildShareQuery() {
    const { fromFilterIndex, toFilterIndex, timeFilterIndex } = this.data
    const q = []
    if (fromFilterIndex >= 0) q.push(`from=${fromFilterIndex}`)
    if (toFilterIndex >= 0) q.push(`to=${toFilterIndex}`)
    if (timeFilterIndex >= 0) q.push(`time=${timeFilterIndex}`)
    return q.join('&')
  },

  onShareAppMessage() {
    const title = this.buildShareTitle()
    const query = this.buildShareQuery()

    return {
      title,
      path: `/pages/home/driverPickupList/driverPickupList${query ? '?' + query : ''}`
    }
  },

  onShareTimeline() {
    const title = this.buildShareTitle()
    const query = this.buildShareQuery()

    return {
      title,
      query: query || ''
    }
  },

});
