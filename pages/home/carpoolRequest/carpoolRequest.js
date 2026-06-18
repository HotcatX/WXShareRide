// pages/home/carpoolRequest/carpoolRequest.js
Page({
  data: {
    tripList: [],
    originalTripList: [],
    loading: false,

    statusBarHeight: 80,
    pageTitle: "一起打车/包车接送",

    // ✅ 三筛选（初始不选）
    fromFilterOptions: ["全部", "其他"],
    fromFilterIndex: -1,
    toFilterOptions: ["全部", "其他"],
    toFilterIndex: -1,

    enableToLinkage: true,

    fromPlaceList: [],
    toPlaceList: [],

    timeFilterOptions: ["今天", "明天", "其他"],
    timeFilterIndex: -1,

    todayDateStr: "",
    tomorrowDateStr: ""
  },

  _refreshing: false,

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

    // ✅ 先读 Request 版地点库
    await this.loadFromToOptionsFromDB();

    this.refreshStatusAndReload();
  },

  onShow() {
    this.refreshStatusAndReload();
  },

  goBack() {
    const pages = getCurrentPages()
    const prev = pages.length >= 2 ? pages[pages.length - 2] : null
    const prevRoute = prev ? (prev.route || '') : ''
  
    // ✅ 兜底：如果上一页是详情页，此时 navigateBack 会回到详情页
    // 直接切回首页，保证用户体验正确
    if (prevRoute.includes('pages/home/requestDetail/requestDetail')) {
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
  

  goPassengerNewTrip() {
    wx.navigateTo({ url: "/pages/home/passengerNewTrip/passengerNewTrip" });
  },

  goRequestDetail(e) {
    const id = e.currentTarget.dataset.id;
    if (!id) return;
    wx.navigateTo({ url: `/pages/home/requestDetail/requestDetail?id=${id}` });
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

  async loadFromToOptionsFromDB() {
    try {
      const db = wx.cloud.database();

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
        fromFilterIndex: this.data.fromFilterIndex >= 0 ? this.data.fromFilterIndex : -1,
        toFilterIndex: this.data.toFilterIndex >= 0 ? this.data.toFilterIndex : -1
      });
    } catch (e) {
      console.error("loadFromToOptionsFromDB(Departure_Request/Arrival_Request) error", e);
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
  // 状态刷新 + 列表加载
  // =========================
  async refreshStatusAndReload() {
    if (this._refreshing) return;
    this._refreshing = true;

    try {
      this.setData({ loading: true });
      wx.showLoading({ title: "刷新中..." });

      await wx.cloud.callFunction({ name: "updateCarpoolRequestStatus" });
      await this.loadTripList();
    } catch (e) {
      console.error("refreshStatusAndReload error:", e);
      wx.showToast({ title: "刷新失败", icon: "none" });
      this.setData({ loading: false });
    } finally {
      wx.hideLoading();
      this._refreshing = false;
    }
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


      trip._requestPassengerCount =
        typeof trip.passengerCount === "number" ? trip.passengerCount : 0;

      trip._showDateDivider = index === 0 || (currentDate && lastDate && currentDate !== lastDate);
      lastDate = currentDate;
    });

    return list;
  },

  async loadTripList() {
    try {
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
          originalTripList: decorated,
          tripList: decorated,
          loading: false
        });

        // 初始未选：不联动、不强制改变 toIndex
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
      console.error("loadTripList error:", err);
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

  rebuildToOptionsByFrom(selectedFrom) {
    const baseTo = this.data.toPlaceList || [];
    const baseAll = ["全部", ...baseTo, "其他"];

    if (!this.data.enableToLinkage) return baseAll;
    if (!selectedFrom || selectedFrom === "全部" || selectedFrom === "其他") return baseAll;

    const matchFrom = this.makePlaceMatcher(selectedFrom);
    const toSet = new Set();

    (this.data.originalTripList || []).forEach((trip) => {
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
    const {
      originalTripList,
      timeFilterIndex,
      todayDateStr,
      tomorrowDateStr,
      fromFilterOptions,
      fromFilterIndex,
      toFilterOptions,
      toFilterIndex
    } = this.data;

    let filtered = (originalTripList || []).slice();

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

    const addressFilteringActive = fromFilterIndex >= 0 || toFilterIndex >= 0;

    const fromSelected = fromFilterIndex >= 0 ? fromFilterOptions[fromFilterIndex] : null;
    const toSelected = toFilterIndex >= 0 ? toFilterOptions[toFilterIndex] : null;

    const fromLastIndex = fromFilterOptions.length - 1;
    const toLastIndex = toFilterOptions.length - 1;

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


      let passFrom = true;
      if (fromSelected !== null) {
        if (fromSelected !== "全部") {
          if (fromFilterIndex === fromLastIndex) {
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

      let passTo = true;
      if (toSelected !== null) {
        if (toSelected !== "全部") {
          if (toFilterIndex === toLastIndex) {
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
    this.setData({ tripList: decorated });
  },

  // =========================
  // 筛选事件
  // =========================
  onFromFilterChange(e) {
    const index = Number(e.detail.value);
    const fromSelected = this.data.fromFilterOptions[index] || "全部";

    const nextToOptions = this.rebuildToOptionsByFrom(fromSelected);

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
