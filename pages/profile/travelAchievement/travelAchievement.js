// pages/profile/travelAchievement/travelAchievement.js
Page({
  data: {
    statusBarHeight: 0,
    activeRole: "driver",
    user: { nickName: "", avatarUrl: "" },

    // ✅ 1) 不再使用 mmbiz.qlogo.cn 作为默认头像，改成本地资源（必须确保该文件存在）
    defaultAvatar: "/images/default-avatar.png",

    // ✅ 2) 页面实际绑定用这个，避免脏 URL、避免 mmbiz 默认头像导致 400
    safeAvatarUrl: "/images/default-avatar.png",

    driverTitle: "老司机",
    loading: false,
    errorMsg: "",
    stats: {
      driver: { tripCount: 0, riderCount: 0, totalIncome: "0.00" },
      passenger: { tripCount: 0, carpoolCount: 0, daysCount: 0 },
    },
  },

  onLoad() {
    const sys = wx.getSystemInfoSync();
    const statusBarHeight = sys.statusBarHeight || 0;

    const localUser =
      wx.getStorageSync("userInfo") ||
      (getApp && getApp().globalData && getApp().globalData.userInfo) ||
      {};

    const avatarUrlRaw = localUser.avatarUrl || localUser.avatar || "";
    const safeAvatarUrl = this.buildSafeAvatarUrl(avatarUrlRaw);

    this.setData({
      statusBarHeight,
      user: {
        nickName: localUser.nickName || localUser.nickname || "",
        avatarUrl: avatarUrlRaw,
      },
      safeAvatarUrl,
    });

    this.loadTripStats();
  },

  // ✅ 清洗并兜底头像 URL：空/非法/已知高风险域名（开发者工具常 400）→ 用本地默认头像
  buildSafeAvatarUrl(url) {
    const fallback = this.data.defaultAvatar || "/images/default-avatar.png";
    if (!url || typeof url !== "string") return fallback;

    const clean = url.trim().replace(/&amp;/g, "&");

    // 空串兜底
    if (!clean) return fallback;

    // 你这次报错域名：mmbiz.qlogo.cn（开发者工具/部分环境可能 400）
    // 作为默认头像/兜底头像不建议依赖它；如果用户头像就是它，先允许尝试加载，失败再切 fallback
    // 这里不强制拦截用户头像，只负责清洗；真正失败在 onAvatarError 里兜底即可
    return clean;
  },

  // ✅ image 加载失败事件：直接切换到默认头像，避免一直报错刷屏
  onAvatarError() {
    // 避免重复 setData
    if (this.data.safeAvatarUrl === this.data.defaultAvatar) return;
    this.setData({ safeAvatarUrl: this.data.defaultAvatar });
  },

  goBack() {
    wx.navigateBack({ delta: 1 });
  },


  onSwitchRole(e) {
    const role = e.currentTarget.dataset.role;
    if (!role) return;
    this.setData({ activeRole: role });
  },
  
  async loadTripStats() {
    this.setData({ loading: true, errorMsg: "" });
  
    try {
      // 复用你朋友的云函数：getMyTripHistory
      const res = await wx.cloud.callFunction({
        name: "getMyTripHistory",
        data: {},
      });
  
      // 兼容不同返回结构
      const raw = res && res.result ? res.result : {};
      const trips = Array.isArray(raw?.data)
        ? raw.data
        : Array.isArray(raw)
        ? raw
        : Array.isArray(raw?.list)
        ? raw.list
        : [];
  
      const stats = this.computeStatsFromTrips(trips);
      const driverTitle = this.getDriverTitle(stats.driver.tripCount);
  
      this.setData({
        stats,
        driverTitle,
        loading: false,
      });
    } catch (err) {
      console.error("[travelAchievement] loadTripStats error:", err);
      this.setData({
        loading: false,
        errorMsg: "暂时无法加载数据（先用框架）。",
      });
    }
  },
  
  computeStatsFromTrips(trips) {
    const safeTrips = Array.isArray(trips) ? trips : [];
  
    const isDriver = (t) =>
      (t?.historyRole || t?.role || "").toLowerCase() === "driver";
    const isPassenger = (t) =>
      (t?.historyRole || t?.role || "").toLowerCase() === "passenger";
  
    const driverTrips = safeTrips.filter(isDriver);
    const passengerTrips = safeTrips.filter(isPassenger);
  
    const riderCount = driverTrips.reduce(
      (sum, t) => sum + this.getPassengerCount(t),
      0
    );
  
    const totalIncomeNum = driverTrips.reduce(
      (sum, t) => sum + this.getIncome(t),
      0
    );
  
    const daySet = new Set(
      passengerTrips
        .map((t) => this.getTripDateKey(t))
        .filter((x) => typeof x === "string" && x.length > 0)
    );
  
    return {
      driver: {
        tripCount: driverTrips.length,
        riderCount,
        totalIncome: totalIncomeNum.toFixed(2),
      },
      passenger: {
        tripCount: passengerTrips.length,
        carpoolCount: passengerTrips.length, // 先按“乘车=拼车”占位，后续你有字段再精确
        daysCount: daySet.size,
      },
    };
  },
  
  getPassengerCount(t) {
    // 尽量兼容字段名
    const candidates = [
      t?.passengerCount,
      t?.passengerNum,
      t?.passengers?.length,
      t?.joinedPassengers?.length,
      t?.members?.length,
      t?.pickedCount,
    ];
  
    for (const v of candidates) {
      const n = Number(v);
      if (Number.isFinite(n)) return n;
    }
    return 0;
  },
  
  getIncome(t) {
    // 尽量兼容字段名（字符串也能解析）
    const candidates = [t?.income, t?.totalIncome, t?.price, t?.fee, t?.amount];
  
    for (const v of candidates) {
      const n = Number(v);
      if (Number.isFinite(n)) return n;
      if (typeof v === "string") {
        const p = parseFloat(v.replace(/[^\d.]/g, ""));
        if (Number.isFinite(p)) return p;
      }
    }
    return 0;
  },
  
  getTripDateKey(t) {
    const candidates = [
      t?.date,
      t?.day,
      t?.startDate,
      t?.startTime,
      t?.departTime,
      t?.time,
      t?.createdAt,
      t?.updateTime,
      t?.updatedAt,
    ];
  
    const raw = candidates.find((x) => x !== undefined && x !== null && x !== "");
    if (!raw) return "";
  
    const d = this.toDate(raw);
    if (!d) return "";
  
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, "0");
    const dd = String(d.getDate()).padStart(2, "0");
    return `${y}-${m}-${dd}`;
  },
  
  toDate(x) {
    if (x instanceof Date) return x;
  
    // 时间戳（秒/毫秒）
    if (typeof x === "number") {
      const ms = x < 2e10 ? x * 1000 : x;
      const d = new Date(ms);
      return Number.isNaN(d.getTime()) ? null : d;
    }
  
    if (typeof x === "string") {
      // 兼容 "YYYY-MM-DD HH:mm" / "YYYY/MM/DD" 等
      const s = x.replace(/-/g, "/");
      const d = new Date(s);
      return Number.isNaN(d.getTime()) ? null : d;
    }
  
    return null;
  },
  
  getDriverTitle(driverTripCount) {
    const n = Number(driverTripCount) || 0;
    if (n >= 50) return "王牌司机";
    if (n >= 20) return "老司机";
    if (n >= 5) return "熟练司机";
    return "新手司机";
  },
  
});