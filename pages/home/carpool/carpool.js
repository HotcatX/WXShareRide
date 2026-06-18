// pages/home/carpool/carpool.js
Page({
  data: {
    carpoolList: [],
    originalCarpoolList: [],
    loading: false,
    statusBarHeight: 80,
    pageTitle: "出行路线列表",

    // ✅ 三筛选：出发地/目的地/时间（初始不选）
    fromFilterOptions: ["全部", "其他"],
    fromFilterIndex: -1,
    toFilterOptions: ["全部", "其他"],
    toFilterIndex: -1,

    // 可选：联动收窄目的地
    enableToLinkage: true,

    fromPlaceList: [],
    toPlaceList: [],

    timeFilterOptions: ["今天", "明天", "其他"],
    timeFilterIndex: -1,

    todayDateStr: "",
    tomorrowDateStr: ""
  },

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

    // ✅ 读取 Departure / Arrival
    await this.loadFromToOptionsFromDB();

    // 加载列表
    this.loadCarpoolList();

    // ✅ 开启“发送给朋友/分享到朋友圈”
    wx.showShareMenu({
      withShareTicket: true,
      menus: ['shareAppMessage', 'shareTimeline']
    })

  },

  onShow() {
    this.refreshStatusAndLoadList();
  },

  goBack() {
    const pages = getCurrentPages()
    const prev = pages.length >= 2 ? pages[pages.length - 2] : null
    const prevRoute = prev ? (prev.route || '') : ''
  
    // ✅ 兜底：如果上一页是详情页，此时 navigateBack 会回到详情页
    // 直接切回首页，保证用户体验正确
    if (prevRoute.includes('pages/home/tripDetail/tripDetail')) {
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

  async loadFromToOptionsFromDB() {
    try {
      const db = wx.cloud.database();

      const [depRes, arrRes] = await Promise.all([
        db.collection("Departure").get(),
        db.collection("Arrival").get()
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
      console.error("loadFromToOptionsFromDB(Departure/Arrival) error", e);
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
  // 状态刷新
  // =========================
  refreshStatusAndLoadList() {
    wx.showLoading({ title: "更新中..." });
    wx.cloud
      .callFunction({ name: "updateCarpoolStatus" })
      .then(() => this.loadCarpoolList())
      .catch((err) => {
        console.error("updateCarpoolStatus error:", err);
        return this.loadCarpoolList();
      })
      .finally(() => wx.hideLoading());
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

  decorateListWithDateDivider(list) {
    let lastDate = "";
    const weekMap = ["日", "一", "二", "三", "四", "五", "六"];

    list.forEach((trip, index) => {
      const dep = this.getFirstDeparture(trip);
      const currentDate = dep && dep.date ? dep.date : "";
      const currentTime = dep && dep.time ? dep.time : "";

      if (currentDate) {
        const dObj = new Date(`${currentDate}T00:00:00`);
        const weekDay = weekMap[dObj.getDay()];
        trip._dateLabel = `${currentDate} 周${weekDay}`;
      } else {
        trip._dateLabel = "";
      }

      trip._timeLabel = currentTime || "";

      trip._fromAddress = dep && dep.address ? dep.address : "";
      trip._toAddress =
        trip.destinations && trip.destinations.length > 0
          ? trip.destinations[0].address || ""
          : "";

      trip._showDateDivider = index === 0 || (currentDate && lastDate && currentDate !== lastDate);
      lastDate = currentDate;
    });

    return list;
  },

  async loadCarpoolList() {
    try {
      wx.showLoading({ title: "加载路线中..." });
      const res = await wx.cloud.callFunction({ name: "getCarpoolList" });
      wx.hideLoading();

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
          originalCarpoolList: decorated,
          carpoolList: decorated,
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
        wx.showToast({ title: "路线加载失败", icon: "none" });
        this.setData({ loading: false });
      }
    } catch (err) {
      console.error("loadCarpoolList error:", err);
      wx.showToast({ title: "路线加载失败", icon: "none" });
      this.setData({ loading: false });
    }
  },

  // =========================
  // 地址判断（Fort Lee 核心区/全区域逻辑不变）
  // =========================
  isFortLee(address) {
    if (!address) return false;
    const s = String(address);
  
    // ✅ 兼容你当前数据：直接是 "Fort Lee"
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

    (this.data.originalCarpoolList || []).forEach((trip) => {
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
      originalCarpoolList,
      timeFilterIndex,
      todayDateStr,
      tomorrowDateStr,
      fromFilterOptions,
      fromFilterIndex,
      toFilterOptions,
      toFilterIndex
    } = this.data;

    let filtered = (originalCarpoolList || []).slice();

    // 时间筛选
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

      // 初始不筛选：不做字段完整性过滤
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
    this.setData({ carpoolList: decorated });
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

  goTripDetail(e) {
    const tripId = e.currentTarget.dataset.id;
    wx.navigateTo({ url: `/pages/home/tripDetail/tripDetail?id=${tripId}` });
  },

  async onPullDownRefresh() {
    try {
      await this.refreshStatusAndLoadList();
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

    const title = `${pageTitle || '路线列表'}${parts.length ? '：' + parts.join('') : ''}`
    return String(title).trim().slice(0, 30) || '查看路线列表'
  },

  buildShareQuery() {
    const { fromFilterIndex, toFilterIndex, timeFilterIndex } = this.data
    const q = []

    // 只要用户有选择（>=0），就带上；-1 不带
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
      path: `/pages/home/carpool/carpool${query ? '?' + query : ''}`
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
