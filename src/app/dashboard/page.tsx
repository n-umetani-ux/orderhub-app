"use client";

import { useState, useMemo, useEffect, useRef } from "react";
import { Engineer, STATUS_CONFIG, DEPTS, SALES_STAFF } from "@/types";
import { StatusBadge } from "@/components/ui/StatusBadge";
import { useAuth } from "@/lib/auth-context";
import { loadCache, saveCache, formatCachedAt } from "@/lib/sheets-cache";

const LOCS = ["全拠点", "東京", "大阪", "福岡"] as const;
const STATUS_FILTER_LABELS = ["全て", "ギャップ発生", "期限迫る", "正常", "当月終了"];

function daysRemaining(contract: string): number | null {
  if (!contract) return null;
  const end = new Date(contract.split("|")[1]);
  const now = new Date();
  return Math.ceil((end.getTime() - now.getTime()) / 86400000);
}

interface DashboardPageProps {
  onSwitch: (e: Engineer) => void;
  onGapCountChange?: (n: number) => void;
}

export default function DashboardPage({ onSwitch, onGapCountChange }: DashboardPageProps) {
  const { user, accessToken, reauth } = useAuth();
  const [engineers, setEngineers] = useState<Engineer[]>([]);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [cachedAt, setCachedAt] = useState<string | null>(null);
  const [fetchError, setFetchError] = useState<string | null>(null);
  const [locFilter, setLocFilter] = useState("全拠点");
  const [statusFilter, setStatusFilter] = useState("全て");
  const [myOnly, setMyOnly] = useState(false);
  const [search, setSearch] = useState("");
  const [expandedRow, setExpandedRow] = useState<number | null>(null);

  // 現在のユーザー名（メールアドレスからマッピング）
  const currentTantou = useMemo(() => {
    const email = user?.email ?? "";
    return Object.entries(SALES_STAFF).find(([, v]) => v === email)?.[0] ?? "";
  }, [user]);

  const syncFromSheets = async () => {
    if (!accessToken) return;
    setSyncing(true);
    setFetchError(null);
    try {
      const r = await fetch("/api/sheets", {
        headers: { "x-google-access-token": accessToken },
      });
      const d = await r.json();
      if (r.status === 401 || r.status === 403) {
        setFetchError("アクセストークンが期限切れです。「再認証が必要です」ボタンを押してください。");
      } else if (d.error) {
        setFetchError(d.error);
      } else {
        setEngineers(d.engineers ?? []);
        saveCache(user?.email ?? "", d.engineers ?? []);
        setCachedAt(new Date().toISOString());
      }
    } catch {
      setFetchError("データ取得に失敗しました");
    } finally {
      setSyncing(false);
    }
  };

  // 初回: キャッシュがあればすぐ表示、なければ API へ（accessToken 確定後）
  useEffect(() => {
    const cache = loadCache(user?.email ?? "");
    if (cache) {
      setEngineers(cache.engineers as Engineer[]);
      setCachedAt(cache.cachedAt);
      setLoading(false);
      return;
    }
    // キャッシュなし: accessToken が来たら取得
    if (accessToken) {
      syncFromSheets().finally(() => setLoading(false));
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [accessToken]);

  const handleArchive = (manNo: number) => {
    setEngineers(prev => prev.map(e => e.manNo === manNo ? { ...e, status: "archived" } : e));
  };

  const filtered = useMemo(() => {
    return engineers.filter(e => {
      if (e.status === "archived") return false;
      if (locFilter !== "全拠点" && e.loc !== locFilter) return false;
      if (statusFilter !== "全て") {
        const key = Object.entries(STATUS_CONFIG).find(([, v]) => v.label === statusFilter)?.[0];
        if (key && e.status !== key) return false;
      }
      if (myOnly && e.tantou !== currentTantou && e.tantou !== "全員") return false;
      if (search && !e.name.includes(search) && !String(e.manNo).includes(search) && !e.customer.includes(search)) return false;
      return true;
    });
  }, [engineers, locFilter, statusFilter, myOnly, currentTantou, search]);

  const counts = useMemo(() => {
    const active = engineers.filter(e => e.status !== "archived");
    const byLoc: Record<string, Record<string, number>> = {};
    LOCS.slice(1).forEach(l => { byLoc[l] = { gap: 0, expiring: 0, normal: 0, ending: 0 }; });
    active.forEach(e => { if (byLoc[e.loc]) byLoc[e.loc][e.status] = (byLoc[e.loc][e.status] ?? 0) + 1; });
    return {
      total: active.length,
      gap:      active.filter(e => e.status === "gap").length,
      expiring: active.filter(e => e.status === "expiring").length,
      ending:   active.filter(e => e.status === "ending").length,
      normal:   active.filter(e => e.status === "normal").length,
      byLoc,
    };
  }, [engineers]);

  const prevGapRef = useRef(-1);
  useEffect(() => {
    if (onGapCountChange && counts.gap !== prevGapRef.current) {
      prevGapRef.current = counts.gap;
      onGapCountChange(counts.gap);
    }
  }, [counts.gap, onGapCountChange]);

  const sortOrder: Record<string, number> = { gap: 0, expiring: 1, ending: 2, normal: 3 };
  const sorted = [...filtered].sort((a, b) => (sortOrder[a.status] ?? 9) - (sortOrder[b.status] ?? 9));

  return (
    <div>
      {/* Header */}
      <div className="flex justify-between items-start mb-7">
        <div>
          <h1 className="text-xl font-bold text-slate-900 tracking-tight">担当案件一覧・更新ステータス</h1>
          <p className="text-sm text-slate-700 mt-1">稼働一覧 × 注文書台帳</p>
        </div>
        <div className="flex items-center gap-2">
          {cachedAt && (
            <span className="text-xs text-slate-600">最終取得: {formatCachedAt(cachedAt)}</span>
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
                {syncing ? "取得中…" : "稼働一覧を同期"}
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
          {/* Metrics */}
          <div className="grid grid-cols-4 gap-3.5 mb-6">
            {[
              { label: "監視中",      val: counts.total,    color: "#3b82f6", bg: "#eff6ff", border: "#bfdbfe", icon: "👥" },
              { label: "ギャップ発生", val: counts.gap,      color: "#dc2626", bg: "#fef2f2", border: "#fecaca", icon: "🚨" },
              { label: "期限14日以内", val: counts.expiring, color: "#d97706", bg: "#fffbeb", border: "#fde68a", icon: "⏰" },
              { label: "当月終了",    val: counts.ending,   color: "#ea580c", bg: "#fff7ed", border: "#fed7aa", icon: "📅" },
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

          {/* Location breakdown */}
          <div className="flex gap-2.5 mb-5 flex-wrap">
            {Object.entries(counts.byLoc).map(([loc, c]) => (
              <div key={loc} className="flex items-center gap-2 px-3.5 py-1.5 rounded-lg bg-slate-50 border border-slate-200 text-xs">
                <span className="font-semibold text-slate-700">{loc}</span>
                <span className="text-red-600">⬤ {c.gap}</span>
                <span className="text-amber-600">⬤ {c.expiring}</span>
                <span className="text-orange-600">⬤ {c.ending}</span>
                <span className="text-emerald-600">⬤ {c.normal}</span>
              </div>
            ))}
          </div>

          {/* Filters */}
          <div className="flex gap-2.5 items-center mb-5 flex-wrap">
            <select
              value={locFilter}
              onChange={e => setLocFilter(e.target.value)}
              className="px-3 py-2 rounded-lg border border-slate-300 text-sm bg-white text-slate-700"
            >
              {LOCS.map(l => <option key={l}>{l}</option>)}
            </select>
            <select
              value={statusFilter}
              onChange={e => setStatusFilter(e.target.value)}
              className="px-3 py-2 rounded-lg border border-slate-300 text-sm bg-white text-slate-700"
            >
              {STATUS_FILTER_LABELS.map(s => <option key={s}>{s}</option>)}
            </select>
            <label className={`flex items-center gap-1.5 px-3 py-2 rounded-lg border text-sm cursor-pointer transition-all
              ${myOnly ? "bg-blue-50 border-blue-300 text-blue-700" : "bg-white border-slate-300 text-slate-600"}`}>
              <input type="checkbox" checked={myOnly} onChange={e => setMyOnly(e.target.checked)} className="accent-blue-500" />
              自分の担当のみ（{currentTantou || "—"}）
            </label>
            <div className="ml-auto relative">
              <span className="absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-400 text-sm">🔍</span>
              <input
                value={search}
                onChange={e => setSearch(e.target.value)}
                placeholder="氏名・番号・顧客で検索"
                className="pl-8 pr-3 py-2 rounded-lg border border-slate-300 text-sm w-52 bg-white text-slate-700"
              />
            </div>
          </div>

          {/* Table */}
          <div className="rounded-xl border border-slate-200 overflow-hidden">
            <div className="grid grid-cols-[120px_90px_1fr_1fr_90px_56px_150px_80px] px-4 py-2.5 bg-slate-50 border-b border-slate-200 text-xs font-semibold text-slate-700">
              <span>ステータス</span>
              <span>manNo.</span>
              <span>氏名</span>
              <span>顧客企業</span>
              <span>担当</span>
              <span>拠点</span>
              <span>契約期間</span>
              <span />
            </div>

            {sorted.length === 0 && (
              <div className="py-10 text-center text-slate-600 text-sm">該当する案件がありません</div>
            )}

            {sorted.map(e => {
              const days = daysRemaining(e.contract);
              const [start, end] = (e.contract || "").split("|");
              const isExpanded = expandedRow === e.manNo;
              return (
                <div key={e.manNo}>
                  <div
                    onClick={() => setExpandedRow(isExpanded ? null : e.manNo)}
                    className={`grid grid-cols-[120px_90px_1fr_1fr_90px_56px_150px_80px] px-4 py-3 items-center text-sm border-b border-slate-50 cursor-pointer transition-colors
                      ${e.status === "gap" ? "bg-red-50 hover:bg-red-100" : isExpanded ? "bg-slate-50" : "bg-white hover:bg-slate-50"}`}
                  >
                    <span><StatusBadge status={e.status} /></span>
                    <span className="font-mono text-xs text-slate-700">{e.manNo}</span>
                    <span className="font-semibold text-slate-900">
                      {e.name}
                      {e.type === "BP" && (
                        <span className="ml-1.5 text-[10px] px-1.5 py-0.5 rounded bg-indigo-100 text-indigo-700">BP</span>
                      )}
                    </span>
                    <span className="text-slate-800">{e.customer}</span>
                    <span className="text-slate-700 text-xs">{e.tantou}</span>
                    <span className="text-xs text-slate-700">{e.loc}</span>
                    <span className={`text-xs ${days !== null && days < 0 ? "text-red-600" : days !== null && days <= 14 ? "text-amber-600" : "text-slate-700"}`}>
                      {start} 〜 {end}
                    </span>
                    <span className="text-right text-xs text-slate-600">{isExpanded ? "▲" : "▼"}</span>
                  </div>

                  {isExpanded && (
                    <div className="px-4 py-3 pl-56 bg-slate-50 border-b border-slate-200 flex items-center gap-4">
                      <span className="text-xs text-slate-700">
                        残日数:{" "}
                        <b className={days === null ? "" : days < 0 ? "text-red-600" : days <= 14 ? "text-amber-600" : "text-emerald-600"}>
                          {days === null ? "—" : days < 0 ? `${Math.abs(days)}日超過` : `${days}日`}
                        </b>
                      </span>
                      <span className="text-xs text-slate-700">顧客コード: <b>{e.code}</b></span>
                      <span className="text-xs text-slate-700">区分: {e.type}</span>
                      <div className="ml-auto flex gap-2">
                        <button
                          onClick={ev => { ev.stopPropagation(); onSwitch(e); }}
                          className="px-3.5 py-1.5 rounded-lg border border-blue-300 bg-blue-50 text-blue-700 text-xs font-semibold hover:bg-blue-100 transition-colors"
                        >
                          注文書アップロード
                        </button>
                        <button
                          onClick={ev => { ev.stopPropagation(); handleArchive(e.manNo); }}
                          className="px-3.5 py-1.5 rounded-lg border border-slate-300 bg-white text-slate-700 text-xs font-semibold hover:bg-slate-100 transition-colors"
                        >
                          アーカイブ申請
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>

          <p className="mt-2.5 text-xs text-slate-600 text-right">
            {sorted.length} 件表示 / 全 {engineers.filter(e => e.status !== "archived").length} 件
          </p>
        </>
      )}
    </div>
  );
}
