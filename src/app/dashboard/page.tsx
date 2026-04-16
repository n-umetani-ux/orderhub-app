"use client";

import { useState, useMemo, useEffect, useRef, useCallback } from "react";
import { Engineer, STATUS_CONFIG, DEPTS, SALES_STAFF } from "@/types";
import { useAuth } from "@/lib/auth-context";
import { loadCache, saveCache, formatCachedAt } from "@/lib/sheets-cache";

const LOCS = ["全拠点", "東京", "大阪", "福岡"] as const;

const AUTO_REFRESH_MS = 5 * 60 * 1000;

/** 注文書レコード */
interface OrderRecord {
  manNo: string;
  name: string;
  contractStart: string;
  contractEnd: string;
}

/** YYYY-MM 形式の月キーを生成 */
function monthKey(year: number, month: number): string {
  return `${year}-${String(month).padStart(2, "0")}`;
}

/** 月キーから表示ラベル（4月, 5月...）を生成 */
function monthLabel(key: string): string {
  const m = parseInt(key.split("-")[1], 10);
  return `${m}月`;
}

/** 当月から N ヶ月先までの月キー配列 */
function generateMonths(count: number): string[] {
  const now = new Date();
  const result: string[] = [];
  for (let i = 0; i < count; i++) {
    const d = new Date(now.getFullYear(), now.getMonth() + i, 1);
    result.push(monthKey(d.getFullYear(), d.getMonth() + 1));
  }
  return result;
}

/** 注文書が特定の月をカバーしているかチェック */
function orderCoversMonth(order: OrderRecord, ym: string): boolean {
  if (!order.contractStart || !order.contractEnd) return false;
  const [y, m] = ym.split("-").map(Number);
  const monthStart = new Date(y, m - 1, 1);
  const monthEnd = new Date(y, m, 0); // 月末日
  const contractStart = new Date(order.contractStart);
  const contractEnd = new Date(order.contractEnd);
  // 契約期間と月が重なるかチェック
  return contractStart <= monthEnd && contractEnd >= monthStart;
}

interface DashboardPageProps {
  onSwitch: (e: Engineer) => void;
  onGapCountChange?: (n: number) => void;
  isAdmin?: boolean;
}

export default function DashboardPage({ onSwitch, onGapCountChange, isAdmin = false }: DashboardPageProps) {
  const { user, accessToken, reauth } = useAuth();
  const [engineers, setEngineers] = useState<Engineer[]>([]);
  const [orders, setOrders] = useState<OrderRecord[]>([]);
  const [loadedMonths, setLoadedMonths] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [cachedAt, setCachedAt] = useState<string | null>(null);
  const [fetchError, setFetchError] = useState<string | null>(null);
  const [overrides, setOverrides] = useState<Record<string, Record<string, "covered" | "gap" | "na">>>({});
  const [locFilter, setLocFilter] = useState("全拠点");
  const [myOnly, setMyOnly] = useState(false);
  const [search, setSearch] = useState("");
  const [overrideMenu, setOverrideMenu] = useState<{ manNo: number; ym: string; x: number; y: number } | null>(null);
  const [savingOverride, setSavingOverride] = useState(false);

  const currentTantou = useMemo(() => {
    const email = user?.email ?? "";
    return Object.entries(SALES_STAFF).find(([, v]) => v === email)?.[0] ?? "";
  }, [user]);

  const syncFromSheets = useCallback(async () => {
    if (!accessToken) return;
    setSyncing(true);
    setFetchError(null);
    try {
      // エンジニア一覧と注文書台帳とオーバーライドを並列取得
      const [sheetsRes, ordersRes, overridesRes] = await Promise.all([
        fetch("/api/sheets", { headers: { "x-google-access-token": accessToken } }),
        fetch("/api/orders", { headers: { "x-google-access-token": accessToken } }),
        fetch("/api/overrides", { headers: { "x-google-access-token": accessToken } }),
      ]);
      const sheetsData = await sheetsRes.json();
      const ordersData = await ordersRes.json();
      const overridesData = await overridesRes.json();

      if (sheetsRes.status === 401 || sheetsRes.status === 403) {
        setFetchError("アクセストークンが期限切れです。「再認証が必要です」ボタンを押してください。");
      } else if (sheetsData.error) {
        setFetchError(sheetsData.error);
      } else {
        setEngineers(sheetsData.engineers ?? []);
        setOrders(ordersData.orders ?? []);
        setLoadedMonths(sheetsData.loadedMonths ?? []);
        // オーバーライドをマップに変換
        const oMap: Record<string, Record<string, "covered" | "gap" | "na">> = {};
        for (const o of (overridesData.overrides ?? []) as { manNo: string; yearMonth: string; status: "covered" | "gap" | "na" }[]) {
          if (!oMap[o.manNo]) oMap[o.manNo] = {};
          oMap[o.manNo][o.yearMonth] = o.status;
        }
        setOverrides(oMap);
        saveCache(user?.email ?? "", sheetsData.engineers ?? [], sheetsData.loadedMonths ?? []);
        setCachedAt(new Date().toISOString());
      }
    } catch {
      setFetchError("データ取得に失敗しました");
    } finally {
      setSyncing(false);
    }
  }, [accessToken, user?.email]);

  useEffect(() => {
    const cache = loadCache(user?.email ?? "");
    if (cache) {
      setEngineers(cache.engineers as Engineer[]);
      setCachedAt(cache.cachedAt);
      setLoadedMonths(cache.loadedMonths ?? []);
      setLoading(false);
      // ordersとoverridesはキャッシュしないのでAPIから取得
      if (accessToken) {
        Promise.all([
          fetch("/api/orders", { headers: { "x-google-access-token": accessToken } }).then(r => r.json()),
          fetch("/api/overrides", { headers: { "x-google-access-token": accessToken } }).then(r => r.json()),
        ]).then(([ordersData, overridesData]) => {
          setOrders(ordersData.orders ?? []);
          const oMap: Record<string, Record<string, "covered" | "gap" | "na">> = {};
          for (const o of (overridesData.overrides ?? []) as { manNo: string; yearMonth: string; status: "covered" | "gap" | "na" }[]) {
            if (!oMap[o.manNo]) oMap[o.manNo] = {};
            oMap[o.manNo][o.yearMonth] = o.status;
          }
          setOverrides(oMap);
        }).catch(() => {});
      }
      return;
    }
    if (accessToken) {
      syncFromSheets().finally(() => setLoading(false));
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [accessToken]);

  useEffect(() => {
    if (!accessToken) return;
    const interval = setInterval(() => { syncFromSheets(); }, AUTO_REFRESH_MS);
    const handleVisibility = () => {
      if (document.visibilityState === "visible") syncFromSheets();
    };
    document.addEventListener("visibilitychange", handleVisibility);
    return () => {
      clearInterval(interval);
      document.removeEventListener("visibilitychange", handleVisibility);
    };
  }, [accessToken, syncFromSheets]);

  // フィルタ
  const filtered = useMemo(() => {
    return engineers.filter(e => {
      if (e.status === "archived") return false;
      if (locFilter !== "全拠点" && e.loc !== locFilter) return false;
      if (myOnly && e.tantou !== currentTantou && e.tantou !== "全員") return false;
      if (search && !e.name.includes(search) && !String(e.manNo).includes(search) && !e.customer.includes(search)) return false;
      return true;
    });
  }, [engineers, locFilter, myOnly, currentTantou, search]);

  // 注文書をmanNoでグループ化
  const ordersByManNo = useMemo(() => {
    const map: Record<string, OrderRecord[]> = {};
    orders.forEach(o => {
      const key = String(o.manNo);
      if (!map[key]) map[key] = [];
      map[key].push(o);
    });
    return map;
  }, [orders]);

  // カレンダー月の算出: 当月〜全員カバー月+1ヶ月 (最大12ヶ月)
  const calendarMonths = useMemo(() => {
    const maxMonths = 12;
    const allMonths = generateMonths(maxMonths);

    // 全員がカバーされている最初の月を見つけてそこで切る
    let lastNeededIdx = 0;
    for (let i = 0; i < allMonths.length; i++) {
      const ym = allMonths[i];
      const hasGap = filtered.some(e => {
        const engOrders = ordersByManNo[String(e.manNo)] ?? [];
        return !engOrders.some(o => orderCoversMonth(o, ym));
      });
      if (hasGap) lastNeededIdx = i;
    }
    // ギャップがある月+1ヶ月を表示（最低3ヶ月は表示）
    const showCount = Math.max(3, Math.min(lastNeededIdx + 2, maxMonths));
    return allMonths.slice(0, showCount);
  }, [filtered, ordersByManNo]);

  // 各エンジニアの月別カバレッジ計算
  // "covered" = 注文書あり, "gap" = 稼働中だが注文書なし, "na" = その月は稼働対象外
  const coverageMap = useMemo(() => {
    const map: Record<number, Record<string, "covered" | "gap" | "na">> = {};
    filtered.forEach(e => {
      const engOrders = ordersByManNo[String(e.manNo)] ?? [];
      const activeMonths = e.activeMonths ?? [];
      const engOverrides = overrides[String(e.manNo)] ?? {};
      const months: Record<string, "covered" | "gap" | "na"> = {};
      calendarMonths.forEach(ym => {
        // 手動オーバーライドがあれば優先
        if (engOverrides[ym]) {
          months[ym] = engOverrides[ym];
          return;
        }
        const hasCovering = engOrders.some(o => orderCoversMonth(o, ym));
        if (hasCovering) {
          months[ym] = "covered";
        } else {
          const isActiveThisMonth = activeMonths.length === 0 || activeMonths.includes(ym);
          months[ym] = isActiveThisMonth ? "gap" : "na";
        }
      });
      map[e.manNo] = months;
    });
    return map;
  }, [filtered, ordersByManNo, calendarMonths, overrides]);

  // サマリー統計
  const counts = useMemo(() => {
    const active = engineers.filter(e => e.status !== "archived");
    // 当月のギャップ数
    const currentMonth = calendarMonths[0];
    let gapCount = 0;
    let expiringCount = 0;
    let normalCount = 0;

    active.forEach(e => {
      const engOrders = ordersByManNo[String(e.manNo)] ?? [];
      const activeMonths = e.activeMonths ?? [];
      // 当月に稼働対象かチェック
      const isActiveThisMonth = activeMonths.length === 0 || (currentMonth && activeMonths.includes(currentMonth));
      if (!isActiveThisMonth) return; // 当月稼働対象外はカウントしない

      const coveredThisMonth = currentMonth && engOrders.some(o => orderCoversMonth(o, currentMonth));
      if (!coveredThisMonth) {
        gapCount++;
      } else {
        const nextMonth = calendarMonths[1];
        const isActiveNextMonth = activeMonths.length === 0 || (nextMonth && activeMonths.includes(nextMonth));
        const coveredNextMonth = nextMonth && isActiveNextMonth && engOrders.some(o => orderCoversMonth(o, nextMonth));
        if (!coveredNextMonth && isActiveNextMonth) {
          expiringCount++;
        } else {
          normalCount++;
        }
      }
    });

    return {
      total: active.length,
      gap: gapCount,
      expiring: expiringCount,
      normal: normalCount,
      archived: engineers.filter(e => e.status === "archived").length,
    };
  }, [engineers, ordersByManNo, calendarMonths]);

  const prevGapRef = useRef(-1);
  useEffect(() => {
    if (onGapCountChange && counts.gap !== prevGapRef.current) {
      prevGapRef.current = counts.gap;
      onGapCountChange(counts.gap);
    }
  }, [counts.gap, onGapCountChange]);

  // ソート: ギャップが多い人を上に
  const sorted = useMemo(() => {
    return [...filtered].sort((a, b) => {
      const aGaps = calendarMonths.filter(ym => coverageMap[a.manNo]?.[ym] === "gap").length;
      const bGaps = calendarMonths.filter(ym => coverageMap[b.manNo]?.[ym] === "gap").length;
      return bGaps - aGaps; // ギャップが多い順
    });
  }, [filtered, calendarMonths, coverageMap]);

  // オーバーライドセルの右クリックメニューを閉じる
  useEffect(() => {
    const handleClick = () => setOverrideMenu(null);
    document.addEventListener("click", handleClick);
    return () => document.removeEventListener("click", handleClick);
  }, []);

  const handleOverride = async (status: "covered" | "gap" | "na" | "auto") => {
    if (!overrideMenu || !accessToken) return;
    setSavingOverride(true);
    try {
      const r = await fetch("/api/overrides", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-google-access-token": accessToken },
        body: JSON.stringify({
          manNo: String(overrideMenu.manNo),
          yearMonth: overrideMenu.ym,
          status,
          updatedBy: user?.email ?? "",
        }),
      });
      const d = await r.json();
      if (d.ok) {
        if (status === "auto") {
          // オーバーライド削除
          setOverrides(prev => {
            const next = { ...prev };
            const key = String(overrideMenu.manNo);
            if (next[key]) {
              const { [overrideMenu.ym]: _, ...rest } = next[key];
              next[key] = rest;
            }
            return next;
          });
        } else {
          // オーバーライド設定
          setOverrides(prev => {
            const key = String(overrideMenu.manNo);
            return { ...prev, [key]: { ...(prev[key] ?? {}), [overrideMenu.ym]: status } };
          });
        }
      }
    } catch { /* ignore */ }
    setSavingOverride(false);
    setOverrideMenu(null);
  };

  // 月ヘッダーの列幅を動的計算
  const monthColWidth = "56px";
  const gridCols = `56px 140px ${calendarMonths.map(() => monthColWidth).join(" ")} 80px`;

  return (
    <div>
      {/* Header */}
      <div className="flex justify-between items-start mb-5">
        <div>
          <h1 className="text-xl font-bold tracking-tight" style={{ color: "#0f172a" }}>注文書カバレッジ管理</h1>
          <p className="text-sm mt-1" style={{ color: "#4b5563" }}>稼働データ × 注文書台帳 — カレンダービュー</p>
        </div>
        <div className="flex items-center gap-2">
          {cachedAt && (
            <span className="text-xs" style={{ color: "#6b7280" }}>最終取得: {formatCachedAt(cachedAt)}</span>
          )}
          {!accessToken ? (
            <button
              onClick={reauth}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-amber-50 border border-amber-300 hover:bg-amber-100 transition-colors"
            >
              <span className="w-2 h-2 rounded-full bg-amber-500" />
              <span className="text-xs font-semibold text-amber-700">再認証が必要です</span>
            </button>
          ) : (
            <button
              onClick={syncFromSheets}
              disabled={syncing}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-emerald-50 border border-emerald-200 hover:bg-emerald-100 transition-colors disabled:opacity-50"
            >
              <span className={`w-2 h-2 rounded-full bg-emerald-500 ${syncing ? "animate-pulse" : ""}`} />
              <span className="text-xs font-semibold text-emerald-700">
                {syncing ? "取得中…" : "データを同期"}
              </span>
            </button>
          )}
        </div>
      </div>

      {fetchError && (
        <div className="mb-4 px-4 py-3 rounded-lg bg-red-50 border border-red-200 text-red-700 text-sm">{fetchError}</div>
      )}

      {loading ? (
        <div className="flex items-center justify-center py-20">
          <div className="w-8 h-8 border-2 border-blue-500 border-t-transparent rounded-full animate-spin" />
        </div>
      ) : (
        <>
          {/* サマリーカード */}
          <div className="grid grid-cols-4 gap-3.5 mb-5">
            {[
              { label: "当月ギャップ", val: counts.gap, color: "#dc2626", bg: "#fef2f2", border: "#fecaca", icon: "🚨" },
              { label: "来月切れ", val: counts.expiring, color: "#d97706", bg: "#fffbeb", border: "#fde68a", icon: "⏰" },
              { label: "正常カバー", val: counts.normal, color: "#059669", bg: "#ecfdf5", border: "#a7f3d0", icon: "✓" },
              { label: "監視中", val: counts.total, color: "#3b82f6", bg: "#eff6ff", border: "#bfdbfe", icon: "👥" },
            ].map(m => (
              <div key={m.label} className="relative overflow-hidden rounded-xl p-4" style={{ background: m.bg, border: `1.5px solid ${m.border}` }}>
                <p className="text-xs font-medium mb-1" style={{ color: m.color }}>{m.label}</p>
                <div className="flex items-baseline gap-1">
                  <span className="text-3xl font-black leading-none" style={{ color: m.color }}>{m.val}</span>
                  <span className="text-sm opacity-70" style={{ color: m.color }}>件</span>
                </div>
                <span className="absolute right-3 top-3 text-2xl opacity-40">{m.icon}</span>
              </div>
            ))}
          </div>

          {/* 凡例 */}
          <div className="flex gap-5 mb-3 text-xs" style={{ color: "#6b7280" }}>
            <span className="flex items-center gap-1.5">
              <span className="w-5 h-5 rounded flex items-center justify-center text-[11px] font-bold" style={{ backgroundColor: "#dcfce7", color: "#16a34a" }}>○</span>
              注文書あり
            </span>
            <span className="flex items-center gap-1.5">
              <span className="w-5 h-5 rounded flex items-center justify-center text-[10px] font-bold" style={{ backgroundColor: "#fef2f2", color: "#dc2626" }}>未</span>
              注文書なし（ギャップ）
            </span>
            <span className="flex items-center gap-1.5">
              <span className="w-5 h-5 rounded" style={{ backgroundColor: "#f1f5f9" }} />
              稼働終了
            </span>
            <span className="flex items-center gap-1.5">
              <span className="w-1.5 h-1.5 rounded-full" style={{ backgroundColor: "#3b82f6" }} />
              稼働データ読み込み済み
              {loadedMonths.length > 0 && (
                <span style={{ color: "#3b82f6" }}>（{loadedMonths.map(ym => monthLabel(ym)).join("・")}）</span>
              )}
            </span>
            <span className="flex items-center gap-1.5">
              <span className="w-1.5 h-1.5 rounded-full" style={{ backgroundColor: "#8b5cf6" }} />
              手動オーバーライド
            </span>
          </div>

          {/* フィルタ */}
          <div className="flex gap-2.5 items-center mb-4 flex-wrap">
            <select
              value={locFilter}
              onChange={e => setLocFilter(e.target.value)}
              className="px-3 py-2 rounded-lg border border-slate-300 text-sm"
              style={{ color: "#111827", backgroundColor: "#fff" }}
            >
              {LOCS.map(l => <option key={l}>{l}</option>)}
            </select>
            <label className={`flex items-center gap-1.5 px-3 py-2 rounded-lg border text-sm cursor-pointer transition-all
              ${myOnly ? "bg-blue-50 border-blue-300 text-blue-700" : "bg-white border-slate-300"}`}
              style={myOnly ? {} : { color: "#374151" }}
            >
              <input type="checkbox" checked={myOnly} onChange={e => setMyOnly(e.target.checked)} className="accent-blue-500" />
              自分の担当のみ（{currentTantou || "—"}）
            </label>
            <div className="ml-auto relative">
              <span className="absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-400 text-sm">🔍</span>
              <input
                value={search}
                onChange={e => setSearch(e.target.value)}
                placeholder="氏名・番号・顧客で検索"
                className="pl-8 pr-3 py-2 rounded-lg border border-slate-300 text-sm w-52"
                style={{ color: "#111827", backgroundColor: "#fff" }}
              />
            </div>
          </div>

          {/* カレンダーテーブル */}
          <div className="rounded-xl border border-slate-200 overflow-x-auto" style={{ backgroundColor: "#fff" }}>
            <table className="w-full border-collapse" style={{ minWidth: "600px" }}>
              <thead>
                <tr style={{ backgroundColor: "#f8fafc" }}>
                  <th className="text-left px-3 py-2.5 text-xs font-semibold border-b border-slate-200 sticky left-0 z-10" style={{ color: "#374151", backgroundColor: "#f8fafc", width: "56px" }}>
                    manNo.
                  </th>
                  <th className="text-left px-3 py-2.5 text-xs font-semibold border-b border-slate-200 sticky left-14 z-10" style={{ color: "#374151", backgroundColor: "#f8fafc", width: "140px" }}>
                    氏名
                  </th>
                  {calendarMonths.map((ym, i) => {
                    const hasData = loadedMonths.includes(ym);
                    return (
                      <th
                        key={ym}
                        className={`text-center px-1 py-2.5 text-xs font-semibold border-b ${i === 0 ? "border-l-2 border-l-blue-300" : ""}`}
                        style={{
                          color: i === 0 ? "#2563eb" : "#374151",
                          width: monthColWidth,
                          borderBottomWidth: hasData ? "3px" : undefined,
                          borderBottomColor: hasData ? "#3b82f6" : undefined,
                        }}
                      >
                        <div className="flex flex-col items-center gap-0.5">
                          {monthLabel(ym)}
                          {hasData && (
                            <span className="w-1.5 h-1.5 rounded-full" style={{ backgroundColor: "#3b82f6" }} />
                          )}
                        </div>
                      </th>
                    );
                  })}
                  <th className="text-center px-2 py-2.5 text-xs font-semibold border-b border-slate-200" style={{ color: "#374151", width: "80px" }}>
                    操作
                  </th>
                </tr>
              </thead>
              <tbody>
                {sorted.length === 0 && (
                  <tr>
                    <td colSpan={calendarMonths.length + 3} className="py-10 text-center text-sm" style={{ color: "#6b7280" }}>
                      該当する案件がありません
                    </td>
                  </tr>
                )}
                {sorted.map(e => {
                  const coverage = coverageMap[e.manNo] ?? {};
                  const hasAnyGap = calendarMonths.some(ym => coverage[ym] === "gap");
                  const isEnding = e.ending === 1;

                  return (
                    <tr
                      key={e.manNo}
                      className={`border-b border-slate-50 transition-colors ${
                        hasAnyGap ? "hover:bg-red-50/50" : "hover:bg-slate-50"
                      }`}
                      style={isEnding ? { opacity: 0.5, backgroundColor: "#f8fafc" } : {}}
                    >
                      {/* manNo */}
                      <td className="px-3 py-2 text-xs font-mono sticky left-0 z-10" style={{ color: "#374151", backgroundColor: hasAnyGap ? "#fef2f2" : "#fff" }}>
                        {e.manNo}
                      </td>
                      {/* 氏名 */}
                      <td className="px-3 py-2 sticky left-14 z-10" style={{ backgroundColor: hasAnyGap ? "#fef2f2" : "#fff" }}>
                        <div className="text-sm font-semibold truncate" style={{ color: "#111827", maxWidth: "130px" }}>
                          {e.name}
                          {e.type === "BP" && (
                            <span className="ml-1 text-[9px] px-1 py-0.5 rounded bg-indigo-100 text-indigo-700">BP</span>
                          )}
                        </div>
                        <div className="text-[10px] truncate" style={{ color: "#9ca3af", maxWidth: "130px" }}>
                          {e.customer}
                        </div>
                      </td>
                      {/* 月別セル */}
                      {calendarMonths.map((ym, i) => {
                        const status = coverage[ym];
                        const isOverridden = !!overrides[String(e.manNo)]?.[ym];
                        return (
                          <td
                            key={ym}
                            className={`text-center py-2 relative ${isAdmin ? "cursor-pointer" : ""} ${i === 0 ? "border-l-2 border-l-blue-300" : ""}`}
                            style={{
                              backgroundColor: status === "na" ? "#f8fafc" :
                                status === "covered" ? "#f0fdf4" :
                                status === "gap" ? "#fef2f2" : "#f8fafc",
                            }}
                            onContextMenu={isAdmin ? (ev => {
                              ev.preventDefault();
                              setOverrideMenu({ manNo: e.manNo, ym, x: ev.clientX, y: ev.clientY });
                            }) : undefined}
                          >
                            {status === "na" ? (
                              <span style={{ color: "#cbd5e1", fontSize: "11px" }}>—</span>
                            ) : status === "covered" ? (
                              <span style={{ color: "#16a34a", fontSize: "13px", fontWeight: 700 }}>○</span>
                            ) : (
                              <span style={{ color: "#dc2626", fontSize: "11px", fontWeight: 700 }}>未</span>
                            )}
                            {isOverridden && (
                              <span className="absolute top-0.5 right-0.5 w-1.5 h-1.5 rounded-full" style={{ backgroundColor: "#8b5cf6" }} title="手動オーバーライド" />
                            )}
                          </td>
                        );
                      })}
                      {/* 操作 */}
                      <td className="text-center px-2 py-2">
                        {!isEnding && hasAnyGap && (
                          <button
                            onClick={() => onSwitch(e)}
                            className="px-2 py-1 rounded text-[10px] font-semibold bg-blue-50 border border-blue-200 text-blue-700 hover:bg-blue-100 transition-colors"
                          >
                            登録
                          </button>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          <p className="mt-2.5 text-xs text-right" style={{ color: "#6b7280" }}>
            {sorted.length} 件表示 / 全 {engineers.filter(e => e.status !== "archived").length} 件
            {counts.archived > 0 && (
              <span className="ml-2" style={{ color: "#9ca3af" }}>（アーカイブ候補: {counts.archived}件）</span>
            )}
          </p>

          {isAdmin && (
            <p className="mt-1 text-[10px]" style={{ color: "#9ca3af" }}>
              右クリックでセルの手動オーバーライドが可能です
            </p>
          )}
        </>
      )}

      {/* オーバーライド右クリックメニュー */}
      {overrideMenu && (
        <div
          className="fixed z-50 bg-white rounded-lg shadow-xl border border-slate-200 py-1 min-w-[140px]"
          style={{ left: overrideMenu.x, top: overrideMenu.y }}
          onClick={ev => ev.stopPropagation()}
        >
          <div className="px-3 py-1.5 text-[10px] font-semibold border-b border-slate-100" style={{ color: "#6b7280" }}>
            手動オーバーライド
          </div>
          {([
            { status: "covered" as const, label: "○ カバー済み", color: "#16a34a" },
            { status: "gap" as const, label: "未 ギャップ", color: "#dc2626" },
            { status: "na" as const, label: "— 対象外", color: "#9ca3af" },
            { status: "auto" as const, label: "自動（解除）", color: "#6b7280" },
          ]).map(opt => (
            <button
              key={opt.status}
              onClick={() => handleOverride(opt.status)}
              disabled={savingOverride}
              className="w-full text-left px-3 py-1.5 text-xs hover:bg-slate-50 transition-colors disabled:opacity-50"
              style={{ color: opt.color }}
            >
              {opt.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
