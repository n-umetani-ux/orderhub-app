"use client";

import { useState, useEffect, useCallback, Fragment } from "react";
import { createPortal } from "react-dom";
import { useAuth } from "@/lib/auth-context";
import { extractSheetId } from "@/lib/sheet-id";
import { extractFolderId } from "@/lib/folder-id";

type Screen = "dashboard" | "upload" | "spec";

// 月別シートID登録フォームの選択肢
const YEAR_OPTIONS = ["2026", "2027"];
const MONTH_OPTIONS = ["01", "02", "03", "04", "05", "06", "07", "08", "09", "10", "11", "12"];

/** 月次締めの各月ステータス（/api/closing/status のレスポンス） */
interface MonthClosingStatus {
  status: "done" | "open";
  gapCount?: number;
  closedAt?: string;
  closedBy?: string;
}

/** 移動対象プレビュー1行（/api/closing/preview のレスポンス） */
interface MovePreviewRow {
  fileName: string;
  name: string;
  manNo: string;
  customerCode: string;
  contractStart: string;
  contractEnd: string;
  effective: boolean;
  hasDriveFile: boolean;
}
interface MovePreviewResult {
  month: string;
  rows: MovePreviewRow[];
  total: number;
  hiddenCount: number;
}

/** "2026-04" → "2026年4月" */
function monthJpLabel(ym: string): string {
  const [y, m] = ym.split("-");
  return `${y}年${parseInt(m, 10)}月`;
}

/** ISO日時 → YYYY-MM-DD（パース不要。先頭10文字） */
function shortDate(iso: string): string {
  return (iso ?? "").slice(0, 10);
}

interface SidebarProps {
  screen: Screen;
  onNavigate: (s: Screen) => void;
  gapCount: number;
  onAdminChange?: (isAdmin: boolean) => void;
}

const DEFAULT_DRIVE_FOLDER_ID = process.env.NEXT_PUBLIC_DRIVE_FOLDER_ID || "1oCHSWVMh1XVI0yNBmbbi9bK-O8qwrR5k";

export function Sidebar({ screen, onNavigate, gapCount, onAdminChange }: SidebarProps) {
  const { user, accessToken, getIdToken, signOut } = useAuth();
  const name = user?.displayName?.split(" ")[0] ?? user?.email ?? "";
  const initial = name.charAt(0);

  const [showSettings, setShowSettings] = useState(false);
  const [isAdmin, setIsAdmin] = useState(false);
  const [driveFolderId, setDriveFolderId] = useState(DEFAULT_DRIVE_FOLDER_ID);
  const [adminEmails, setAdminEmails] = useState("");
  const [settingsInput, setSettingsInput] = useState("");
  const [adminInput, setAdminInput] = useState("");
  const [saving, setSaving] = useState(false);
  const [saveMsg, setSaveMsg] = useState<string | null>(null);

  // 月別 稼働一覧シートID
  const [sheetOverrides, setSheetOverrides] = useState<Record<string, string>>({});
  const [newYear, setNewYear] = useState(YEAR_OPTIONS[0]);
  const [newMonth, setNewMonth] = useState("");
  const [newSheetInput, setNewSheetInput] = useState("");
  const [validating, setValidating] = useState(false);
  const [sheetMsg, setSheetMsg] = useState<string | null>(null);

  // 電帳法 一時とりまとめフォルダ（月次締め後の注文書PDF移動先）
  const [closingFolderId, setClosingFolderId] = useState("");
  const [closingFolderName, setClosingFolderName] = useState("");
  const [closingInput, setClosingInput] = useState("");
  const [closingValidating, setClosingValidating] = useState(false);
  const [closingMsg, setClosingMsg] = useState<string | null>(null);

  // 月次締め管理（各月のギャップ件数・締め状態）
  const [monthCloseStatus, setMonthCloseStatus] = useState<Record<string, MonthClosingStatus>>({});
  const [monthCloseLoading, setMonthCloseLoading] = useState(false);
  const [monthCloseActive, setMonthCloseActive] = useState<string | null>(null); // 締め実行中の月
  const [monthCloseMsg, setMonthCloseMsg] = useState<string | null>(null);
  const [confirmCloseMonth, setConfirmCloseMonth] = useState<string | null>(null);
  const [confirmCancelMonth, setConfirmCancelMonth] = useState<string | null>(null); // 締め解除の確認対象月
  // 移動対象プレビュー（月ごとに展開・読み取りのみ）
  const [previewMonth, setPreviewMonth] = useState<string | null>(null);
  const [previewData, setPreviewData] = useState<MovePreviewResult | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);

  const userEmail = user?.email ?? "";

  // 設定を読み込み（管理者判定含む）
  const loadSettings = useCallback(async () => {
    if (!userEmail || !accessToken) return;
    try {
      const idToken = await getIdToken();
      if (!idToken) {
        // 無言で設定未読込のまま放置せず、サーバーの401応答に委ねる
        console.warn("[Sidebar] IDトークンを取得できませんでした。認証なしで設定取得を試行します");
      }
      const r = await fetch("/api/settings", {
        headers: {
          ...(idToken ? { "Authorization": `Bearer ${idToken}` } : {}),
          "x-google-access-token": accessToken,
        },
      });
      const d = await r.json();
      setIsAdmin(d.isAdmin === true);
      if (d.settings?.driveFolderId) {
        setDriveFolderId(d.settings.driveFolderId);
        setSettingsInput(d.settings.driveFolderId);
      }
      if (d.settings?.adminEmails) {
        setAdminEmails(d.settings.adminEmails);
        setAdminInput(d.settings.adminEmails);
      }
      // 月別シートID（sheet_YYYY-MM）を抽出。空値は無効化済みなので除外
      const overrides: Record<string, string> = {};
      for (const [k, v] of Object.entries((d.settings ?? {}) as Record<string, string>)) {
        if (k.startsWith("sheet_") && v) overrides[k.slice("sheet_".length)] = v;
      }
      setSheetOverrides(overrides);
      // 電帳法 一時とりまとめフォルダID（保存済みならIDを表示。フォルダ名は検証時のみ取得可能）
      if (d.settings?.closing_archive_folder_id) {
        setClosingFolderId(d.settings.closing_archive_folder_id);
        setClosingInput(d.settings.closing_archive_folder_id);
      }
    } catch { /* ignore */ }
  }, [userEmail, accessToken, getIdToken]);

  useEffect(() => { loadSettings(); }, [loadSettings]);

  // 管理者ステータスを親に通知
  useEffect(() => { onAdminChange?.(isAdmin); }, [isAdmin, onAdminChange]);

  const saveSetting = async (key: string, value: string) => {
    const idToken = await getIdToken();
    if (!idToken) throw new Error("認証情報がありません。再ログインしてください。");
    const headers: Record<string, string> = { "Content-Type": "application/json", "Authorization": `Bearer ${idToken}` };
    if (accessToken) headers["x-google-access-token"] = accessToken;
    const r = await fetch("/api/settings", {
      method: "POST",
      headers,
      body: JSON.stringify({ key, value }),
    });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error ?? "保存に失敗しました");
    return data;
  };

  const handleSaveSettings = async () => {
    setSaving(true);
    setSaveMsg(null);
    try {
      // DriveフォルダIDを保存
      let folderId = settingsInput.trim();
      const urlMatch = folderId.match(/\/folders\/([a-zA-Z0-9_-]+)/);
      if (urlMatch) folderId = urlMatch[1];

      // 逐次実行（同時書き込みの競合を回避）
      if (adminInput.trim()) {
        await saveSetting("adminEmails", adminInput.trim());
        setAdminEmails(adminInput.trim());
      }
      if (folderId) {
        await saveSetting("driveFolderId", folderId);
        setDriveFolderId(folderId);
      }

      setSaveMsg("保存しました");
      setTimeout(() => setSaveMsg(null), 2000);
    } catch (err) {
      setSaveMsg(err instanceof Error ? err.message : "保存に失敗しました");
    } finally {
      setSaving(false);
    }
  };

  // 月別シートID: 検証してから保存（Finding #1対策）
  const handleAddSheet = async () => {
    setSheetMsg(null);
    if (!newMonth) { setSheetMsg("月を選択してください"); return; }
    const ym = `${newYear}-${newMonth}`;
    const id = extractSheetId(newSheetInput);
    if (!id) { setSheetMsg("シートID または URL が不正です"); return; }

    setValidating(true);
    try {
      const idToken = await getIdToken();
      const headers: Record<string, string> = { "Content-Type": "application/json" };
      if (idToken) headers["Authorization"] = `Bearer ${idToken}`;
      if (accessToken) headers["x-google-access-token"] = accessToken;

      // 保存前に検証（読めて稼働表タブがあるか）。sheetId はボディで送る（ログ残留回避）
      const r = await fetch("/api/sheets/validate", {
        method: "POST",
        headers,
        body: JSON.stringify({ sheetId: id }),
      });
      const d = await r.json();
      if (!r.ok || !d.ok) {
        setSheetMsg(d.reason ?? d.error ?? "検証に失敗しました");
        return;
      }

      // 検証OK → 保存
      await saveSetting(`sheet_${ym}`, id);
      setSheetOverrides(prev => ({ ...prev, [ym]: id }));
      setNewSheetInput("");
      setSheetMsg(`${ym} を登録しました${d.title ? `（${d.title}）` : ""}`);
    } catch (err) {
      setSheetMsg(err instanceof Error ? err.message : "登録に失敗しました");
    } finally {
      setValidating(false);
    }
  };

  // 月別シートID: 無効化（空保存 → filterSheetKeys が除外しハードコードへフォールバック）
  const handleDisableSheet = async (ym: string) => {
    setSheetMsg(null);
    try {
      await saveSetting(`sheet_${ym}`, "");
      setSheetOverrides(prev => {
        const next = { ...prev };
        delete next[ym];
        return next;
      });
      setSheetMsg(`${ym} を無効化しました`);
    } catch (err) {
      setSheetMsg(err instanceof Error ? err.message : "無効化に失敗しました");
    }
  };

  // 電帳法 一時とりまとめフォルダ: Drive で存在＆フォルダ種別を検証してから保存
  const handleSaveClosingFolder = async () => {
    setClosingMsg(null);
    const id = extractFolderId(closingInput);
    if (!id) { setClosingMsg("❌ フォルダID または URL が不正です"); return; }

    setClosingValidating(true);
    try {
      const idToken = await getIdToken();
      const headers: Record<string, string> = { "Content-Type": "application/json" };
      if (idToken) headers["Authorization"] = `Bearer ${idToken}`;
      if (accessToken) headers["x-google-access-token"] = accessToken;

      // 保存前に検証（フォルダとして存在するか）。folderId はボディで送る（ログ残留回避）
      const r = await fetch("/api/drive/validate-folder", {
        method: "POST",
        headers,
        body: JSON.stringify({ folderId: id }),
      });
      const d = await r.json();
      if (!r.ok || !d.ok) {
        setClosingMsg(`❌ ${d.error ?? "フォルダが見つかりません。IDを確認してください"}`);
        return;
      }

      // 検証OK → 保存
      await saveSetting("closing_archive_folder_id", id);
      setClosingFolderId(id);
      setClosingFolderName(d.name ?? "");
      setClosingMsg(`✅ 保存しました（フォルダ名: ${d.name ?? id}）`);
    } catch (err) {
      setClosingMsg(`❌ ${err instanceof Error ? err.message : "保存に失敗しました"}`);
    } finally {
      setClosingValidating(false);
    }
  };

  // 月次締め: 各月のギャップ件数・締め状態を取得
  const loadMonthClose = useCallback(async () => {
    if (!accessToken) return;
    setMonthCloseLoading(true);
    try {
      const idToken = await getIdToken();
      const headers: Record<string, string> = { "x-google-access-token": accessToken };
      if (idToken) headers["Authorization"] = `Bearer ${idToken}`;
      const r = await fetch("/api/closing/status", { headers });
      const d = await r.json();
      if (r.ok && d.months) setMonthCloseStatus(d.months as Record<string, MonthClosingStatus>);
    } catch {
      /* ignore */
    } finally {
      setMonthCloseLoading(false);
    }
  }, [accessToken, getIdToken]);

  // 設定モーダルを開いたとき（管理者のみ）に締め状態を読み込む
  useEffect(() => {
    if (showSettings && isAdmin) loadMonthClose();
  }, [showSettings, isAdmin, loadMonthClose]);

  // 月次締め: 確認後に締めを実行
  const handleCloseMonth = async (month: string) => {
    setConfirmCloseMonth(null);
    setMonthCloseMsg(null);
    setMonthCloseActive(month);
    try {
      const idToken = await getIdToken();
      const headers: Record<string, string> = { "Content-Type": "application/json" };
      if (idToken) headers["Authorization"] = `Bearer ${idToken}`;
      if (accessToken) headers["x-google-access-token"] = accessToken;
      const r = await fetch("/api/closing/execute", {
        method: "POST",
        headers,
        body: JSON.stringify({ month }),
      });
      const d = await r.json();
      if (!r.ok || !d.ok) {
        setMonthCloseMsg(`❌ ${d.error ?? "締めに失敗しました"}`);
        return;
      }
      setMonthCloseStatus(prev => ({
        ...prev,
        [month]: { status: "done", closedAt: d.closedAt, closedBy: d.closedBy },
      }));
      setMonthCloseMsg(`✅ ${monthJpLabel(month)}を締めました`);
    } catch (err) {
      setMonthCloseMsg(`❌ ${err instanceof Error ? err.message : "締めに失敗しました"}`);
    } finally {
      setMonthCloseActive(null);
    }
  };

  // 月次締め: 確認後に締め解除を実行（誤締めの取り消し。解除後は同月開始の登録が可能に戻る）
  const handleCancelMonth = async (month: string) => {
    setConfirmCancelMonth(null);
    setMonthCloseMsg(null);
    setMonthCloseActive(month);
    try {
      const idToken = await getIdToken();
      const headers: Record<string, string> = { "Content-Type": "application/json" };
      if (idToken) headers["Authorization"] = `Bearer ${idToken}`;
      if (accessToken) headers["x-google-access-token"] = accessToken;
      const r = await fetch("/api/closing/cancel", {
        method: "POST",
        headers,
        body: JSON.stringify({ month }),
      });
      const d = await r.json();
      if (!r.ok || !d.ok) {
        setMonthCloseMsg(`❌ ${d.error ?? "締め解除に失敗しました"}`);
        return;
      }
      // 解除後は未締め（open）へ戻す。ギャップ件数は最新値を再取得して反映
      setMonthCloseStatus(prev => ({
        ...prev,
        [month]: { status: "open", gapCount: prev[month]?.gapCount ?? 0 },
      }));
      setMonthCloseMsg(`✅ ${monthJpLabel(month)}の締めを解除しました`);
      loadMonthClose();
    } catch (err) {
      setMonthCloseMsg(`❌ ${err instanceof Error ? err.message : "締め解除に失敗しました"}`);
    } finally {
      setMonthCloseActive(null);
    }
  };

  // 移動対象プレビュー: 月の展開/折りたたみ（読み取りのみ・Phase C-2 前の目視確認）
  const togglePreview = async (month: string) => {
    if (previewMonth === month) {
      setPreviewMonth(null);
      setPreviewData(null);
      return;
    }
    setPreviewMonth(month);
    setPreviewData(null);
    setPreviewLoading(true);
    try {
      const idToken = await getIdToken();
      const headers: Record<string, string> = {};
      if (idToken) headers["Authorization"] = `Bearer ${idToken}`;
      if (accessToken) headers["x-google-access-token"] = accessToken;
      const r = await fetch(`/api/closing/preview?month=${encodeURIComponent(month)}`, { headers });
      const d = await r.json();
      if (r.ok && Array.isArray(d.rows)) {
        setPreviewData(d as MovePreviewResult);
      } else {
        setMonthCloseMsg(`❌ ${d.error ?? "プレビューの取得に失敗しました"}`);
        setPreviewData({ month, rows: [], total: 0, hiddenCount: 0 });
      }
    } catch {
      setPreviewData({ month, rows: [], total: 0, hiddenCount: 0 });
    } finally {
      setPreviewLoading(false);
    }
  };

  const driveUrl = `https://drive.google.com/drive/folders/${driveFolderId}`;

  return (
    <aside className="w-52 shrink-0 flex flex-col bg-gradient-to-b from-slate-900 to-slate-800 h-screen sticky top-0">
      {/* Logo */}
      <div className="px-5 py-5 border-b border-white/10">
        <div className="flex items-center gap-2">
          <span className="text-xl">📋</span>
          <span className="text-lg font-extrabold tracking-tight" style={{ color: "#ffffff", WebkitTextFillColor: "#ffffff" }}>注文書管理システム</span>
        </div>
        <p className="text-xs mt-1" style={{ color: "#94a3b8", WebkitTextFillColor: "#94a3b8" }}>期間ギャップ管理</p>
      </div>

      {/* Nav */}
      <nav className="flex-1 px-3 py-4 space-y-1">
        {([
          { id: "dashboard" as Screen, icon: "📊", label: "担当案件・ギャップ管理", badge: gapCount },
          { id: "upload"    as Screen, icon: "📤", label: "新着アップロード・更新",  badge: 0 },
        ] as const).map(item => (
          <button
            key={item.id}
            onClick={() => onNavigate(item.id)}
            className={`flex items-center gap-2.5 w-full px-3 py-2.5 rounded-lg text-sm text-left transition-all
              ${screen === item.id
                ? "bg-blue-500/15 text-blue-300 font-semibold"
                : "text-slate-400 hover:bg-white/5 hover:text-slate-200"}`}
          >
            <span className="text-base">{item.icon}</span>
            <span className="flex-1">{item.label}</span>
            {item.badge > 0 && (
              <span className="bg-red-600 text-white text-[10px] font-bold px-1.5 py-0.5 rounded-full">
                {item.badge}
              </span>
            )}
          </button>
        ))}
        {/* Drive folder link */}
        <a
          href={driveUrl}
          target="_blank"
          rel="noreferrer"
          className="flex items-center gap-2.5 w-full px-3 py-2.5 rounded-lg text-sm text-left transition-all hover:bg-white/5"
          style={{ color: "#94a3b8", WebkitTextFillColor: "#94a3b8" }}
        >
          <span className="text-base">📁</span>
          <span className="flex-1">注文書PDF フォルダ</span>
          <span className="text-[10px]" style={{ color: "#94a3b8", WebkitTextFillColor: "#94a3b8" }}>↗</span>
        </a>
        {/* Spec (管理者のみ表示) */}
        {isAdmin && (
          <button
            onClick={() => onNavigate("spec")}
            className={`flex items-center gap-2.5 w-full px-3 py-2.5 rounded-lg text-sm text-left transition-all
              ${screen === "spec"
                ? "bg-blue-500/15 text-blue-300 font-semibold"
                : "text-slate-400 hover:bg-white/5 hover:text-slate-200"}`}
          >
            <span className="text-base">📄</span>
            <span className="flex-1">仕様書</span>
          </button>
        )}
        {/* Settings (管理者のみ表示) */}
        {isAdmin && (
          <button
            onClick={() => { setShowSettings(!showSettings); setSettingsInput(driveFolderId); setAdminInput(adminEmails); setSaveMsg(null); }}
            className="flex items-center gap-2.5 w-full px-3 py-2.5 rounded-lg text-sm text-left transition-all text-slate-400 hover:bg-white/5 hover:text-slate-200"
          >
            <span className="text-base">⚙</span>
            <span className="flex-1" style={{ color: "#94a3b8", WebkitTextFillColor: "#94a3b8" }}>管理者設定</span>
          </button>
        )}
      </nav>

      {/* Settings modal — portalでbody直下に描画してz-index問題を回避 */}
      {showSettings && createPortal(
        <div className="fixed inset-0 flex items-center justify-center bg-black/40" style={{ zIndex: 9999 }} onClick={() => setShowSettings(false)}>
          <div className="bg-white rounded-xl shadow-2xl p-6 w-full max-w-md mx-4" onClick={ev => ev.stopPropagation()}>
            <h2 className="text-lg font-bold mb-4" style={{ color: "#111827" }}>管理者設定</h2>

            {/* Admin emails setting */}
            <div className="mb-5">
              <label className="block text-sm font-medium mb-1" style={{ color: "#374151" }}>
                管理者メールアドレス
              </label>
              <p className="text-xs mb-2" style={{ color: "#6b7280" }}>
                カンマ区切りで複数指定できます
              </p>
              <textarea
                value={adminInput}
                onChange={e => setAdminInput(e.target.value)}
                placeholder="user1@beat-tech.co.jp,user2@beat-tech.co.jp"
                rows={3}
                className="w-full px-3 py-2 rounded-lg border border-slate-300 text-sm resize-none"
                style={{ color: "#111827", backgroundColor: "#fff" }}
              />
            </div>

            {/* Drive folder setting */}
            <div className="mb-5">
              <label className="block text-sm font-medium mb-1" style={{ color: "#374151" }}>
                注文書PDF 保存先フォルダ
              </label>
              <p className="text-xs mb-2" style={{ color: "#6b7280" }}>
                Google DriveのフォルダIDまたはURLを入力してください
              </p>
              <input
                value={settingsInput}
                onChange={e => setSettingsInput(e.target.value)}
                placeholder="フォルダID or URL"
                className="w-full px-3 py-2 rounded-lg border border-slate-300 text-sm"
                style={{ color: "#111827", backgroundColor: "#fff" }}
              />
            </div>

            {/* Monthly sheet IDs setting */}
            <div className="mb-5">
              <label className="block text-sm font-medium mb-1" style={{ color: "#374151" }}>
                月別 稼働一覧シートID
              </label>
              <p className="text-xs mb-2" style={{ color: "#6b7280" }}>
                月ごとの稼働一覧スプレッドシートを登録します（保存前に読めるか検証します）
              </p>

              {/* 登録済み一覧 */}
              {Object.keys(sheetOverrides).length > 0 && (
                <div className="mb-3 space-y-1">
                  {Object.entries(sheetOverrides).sort(([a], [b]) => a.localeCompare(b)).map(([ym, id]) => (
                    <div key={ym} className="flex items-center gap-2 text-xs">
                      <span className="font-mono font-semibold" style={{ color: "#111827" }}>{ym}</span>
                      <span className="flex-1 truncate font-mono" style={{ color: "#6b7280" }}>{id}</span>
                      <button
                        onClick={() => handleDisableSheet(ym)}
                        className="px-2 py-0.5 rounded border border-slate-300 text-xs hover:bg-slate-50 shrink-0"
                        style={{ color: "#dc2626" }}
                      >
                        無効化
                      </button>
                    </div>
                  ))}
                </div>
              )}

              {/* 追加フォーム */}
              <div className="flex items-center gap-2 mb-2">
                <select
                  value={newYear}
                  onChange={e => setNewYear(e.target.value)}
                  className="px-2 py-2 rounded-lg border border-slate-300 text-sm"
                  style={{ color: "#111827", backgroundColor: "#fff" }}
                >
                  {YEAR_OPTIONS.map(y => <option key={y} value={y}>{y}年</option>)}
                </select>
                <select
                  value={newMonth}
                  onChange={e => setNewMonth(e.target.value)}
                  className="px-2 py-2 rounded-lg border border-slate-300 text-sm"
                  style={{ color: "#111827", backgroundColor: "#fff" }}
                >
                  <option value="">月</option>
                  {MONTH_OPTIONS.map(m => <option key={m} value={m}>{parseInt(m, 10)}月</option>)}
                </select>
              </div>
              <input
                value={newSheetInput}
                onChange={e => setNewSheetInput(e.target.value)}
                placeholder="シートID or URL"
                className="w-full px-3 py-2 rounded-lg border border-slate-300 text-sm mb-2"
                style={{ color: "#111827", backgroundColor: "#fff" }}
              />
              <div className="flex items-center gap-3">
                <button
                  onClick={handleAddSheet}
                  disabled={validating}
                  className="px-3 py-1.5 rounded-lg bg-emerald-600 text-white text-sm font-semibold hover:bg-emerald-700 transition-colors disabled:opacity-50"
                >
                  {validating ? "検証中…" : "検証して追加"}
                </button>
                {sheetMsg && (
                  <span
                    className="text-xs"
                    style={{ color: sheetMsg.includes("登録") || sheetMsg.includes("無効化") ? "#059669" : "#dc2626" }}
                  >
                    {sheetMsg}
                  </span>
                )}
              </div>
            </div>

            {/* 電帳法 一時とりまとめフォルダ setting */}
            <div className="mb-5">
              <label className="block text-sm font-medium mb-1" style={{ color: "#374151" }}>
                電帳法 一時とりまとめフォルダ
              </label>
              <p className="text-xs mb-2" style={{ color: "#6b7280" }}>
                月次締め後、注文書PDFの移動先となる共有ドライブ上のフォルダIDを設定します
              </p>

              {/* 現在の設定値 */}
              {closingFolderId && (
                <div className="mb-2 text-xs">
                  <span style={{ color: "#6b7280" }}>現在: </span>
                  <span className="font-mono" style={{ color: "#111827" }}>
                    {closingFolderName || closingFolderId}
                  </span>
                </div>
              )}

              <input
                value={closingInput}
                onChange={e => setClosingInput(e.target.value)}
                placeholder="フォルダID or URL"
                className="w-full px-3 py-2 rounded-lg border border-slate-300 text-sm mb-2"
                style={{ color: "#111827", backgroundColor: "#fff" }}
              />
              <div className="flex items-center gap-3">
                <button
                  onClick={handleSaveClosingFolder}
                  disabled={closingValidating}
                  className="px-3 py-1.5 rounded-lg bg-emerald-600 text-white text-sm font-semibold hover:bg-emerald-700 transition-colors disabled:opacity-50"
                >
                  {closingValidating ? "検証中…" : "検証して保存"}
                </button>
                {closingMsg && (
                  <span
                    className="text-xs"
                    style={{ color: closingMsg.startsWith("✅") ? "#059669" : "#dc2626" }}
                  >
                    {closingMsg}
                  </span>
                )}
              </div>
            </div>

            {/* 月次締め管理 */}
            <div className="mb-5">
              <label className="block text-sm font-medium mb-1" style={{ color: "#374151" }}>
                月次締め管理
              </label>
              <p className="text-xs mb-2" style={{ color: "#6b7280" }}>
                各月のギャップが0件になったら締めを実行します。締め後は同月開始の注文書登録ができなくなります。
              </p>

              {monthCloseLoading ? (
                <p className="text-xs" style={{ color: "#6b7280" }}>読み込み中…</p>
              ) : Object.keys(monthCloseStatus).length === 0 ? (
                <p className="text-xs" style={{ color: "#6b7280" }}>対象月がありません</p>
              ) : (
                <div className="space-y-1.5">
                  {Object.entries(monthCloseStatus)
                    .sort(([a], [b]) => a.localeCompare(b))
                    .map(([ym, st]) => (
                      <Fragment key={ym}>
                      <div className="flex items-center gap-2 text-xs">
                        <span className="font-semibold w-16 shrink-0" style={{ color: "#111827" }}>
                          {monthJpLabel(ym)}
                        </span>
                        {st.status === "done" ? (
                          <>
                            <span className="flex-1 truncate" style={{ color: "#6b7280" }} title={st.closedBy}>
                              🔒 締め済み {shortDate(st.closedAt ?? "")} {st.closedBy ?? ""}
                            </span>
                            <button
                              onClick={() => setConfirmCancelMonth(ym)}
                              disabled={monthCloseActive === ym}
                              className="px-2 py-0.5 rounded border border-red-300 text-red-600 font-semibold hover:bg-red-50 transition-colors disabled:opacity-50 shrink-0"
                            >
                              {monthCloseActive === ym ? "解除中…" : "締め解除"}
                            </button>
                          </>
                        ) : (
                          <>
                            <span
                              className="px-1.5 py-0.5 rounded font-semibold shrink-0"
                              style={(st.gapCount ?? 0) === 0
                                ? { backgroundColor: "#dcfce7", color: "#16a34a" }
                                : { backgroundColor: "#fef2f2", color: "#dc2626" }}
                            >
                              ギャップ {st.gapCount ?? 0}件
                            </span>
                            {(st.gapCount ?? 0) === 0 ? (
                              <>
                                <span style={{ color: "#16a34a" }}>✅ 締め可能</span>
                                <button
                                  onClick={() => setConfirmCloseMonth(ym)}
                                  disabled={monthCloseActive === ym}
                                  className="ml-auto px-2 py-0.5 rounded bg-emerald-600 text-white font-semibold hover:bg-emerald-700 transition-colors disabled:opacity-50 shrink-0"
                                >
                                  {monthCloseActive === ym ? "締め中…" : "締める"}
                                </button>
                              </>
                            ) : (
                              <span style={{ color: "#d97706" }}>⚠️ 未完了</span>
                            )}
                          </>
                        )}
                      </div>

                      {/* 移動対象プレビュー（読み取りのみ・展開式） */}
                      <div className="pl-16">
                        <button
                          onClick={() => togglePreview(ym)}
                          className="text-xs text-blue-600 hover:underline"
                        >
                          {previewMonth === ym ? "▾ 移動対象を隠す" : "▸ 移動対象プレビュー"}
                        </button>
                        {previewMonth === ym && (
                          <div className="mt-1 rounded border border-slate-200 bg-slate-50 p-2">
                            {previewLoading ? (
                              <p className="text-xs" style={{ color: "#6b7280" }}>読み込み中…</p>
                            ) : previewData ? (
                              <>
                                <p className="text-xs font-semibold mb-1" style={{ color: "#111827" }}>
                                  移動対象 {previewData.total}件
                                  <span style={{ color: "#6b7280" }}>（うち dedup隠れ {previewData.hiddenCount}件）</span>
                                </p>
                                {previewData.total === 0 ? (
                                  <p className="text-xs" style={{ color: "#6b7280" }}>対象行がありません</p>
                                ) : (
                                  <div className="space-y-0.5">
                                    {previewData.rows.map((row, i) => (
                                      <div key={i} className="flex items-center gap-1.5 text-xs">
                                        <span className="shrink-0" title={row.effective ? "有効" : "dedupで隠れた古い行"}>
                                          {row.effective ? "🟢" : "⚪"}
                                        </span>
                                        <span className="flex-1 truncate" style={{ color: "#374151" }} title={row.fileName}>
                                          {row.fileName || "（ファイル名なし）"}
                                        </span>
                                        <span className="shrink-0" style={{ color: "#6b7280" }}>{row.name}</span>
                                        <span className="shrink-0" title={row.hasDriveFile ? "Driveリンクあり" : "Driveリンクなし"}>
                                          {row.hasDriveFile ? "🔗" : "—"}
                                        </span>
                                      </div>
                                    ))}
                                  </div>
                                )}
                              </>
                            ) : null}
                          </div>
                        )}
                      </div>
                      </Fragment>
                    ))}
                </div>
              )}

              {monthCloseMsg && (
                <p className="mt-2 text-xs" style={{ color: monthCloseMsg.startsWith("✅") ? "#059669" : "#dc2626" }}>
                  {monthCloseMsg}
                </p>
              )}
            </div>

            <div className="flex items-center gap-3">
              <button
                onClick={handleSaveSettings}
                disabled={saving}
                className="px-4 py-2 rounded-lg bg-blue-600 text-white text-sm font-semibold hover:bg-blue-700 transition-colors disabled:opacity-50"
              >
                {saving ? "保存中…" : "保存"}
              </button>
              <button
                onClick={() => setShowSettings(false)}
                className="px-4 py-2 rounded-lg border border-slate-300 text-sm font-semibold hover:bg-slate-50 transition-colors"
                style={{ color: "#374151" }}
              >
                閉じる
              </button>
              {saveMsg && (
                <span className="text-sm" style={{ color: saveMsg === "保存しました" ? "#059669" : "#dc2626" }}>
                  {saveMsg}
                </span>
              )}
            </div>

            {/* 月次締めの確認ダイアログ */}
            {confirmCloseMonth && (
              <div
                className="fixed inset-0 flex items-center justify-center bg-black/40"
                style={{ zIndex: 10000 }}
                onClick={() => setConfirmCloseMonth(null)}
              >
                <div className="bg-white rounded-xl shadow-2xl p-5 w-full max-w-sm mx-4" onClick={ev => ev.stopPropagation()}>
                  <p className="text-sm mb-4" style={{ color: "#111827" }}>
                    {monthJpLabel(confirmCloseMonth)}の注文書を締めます。この操作は取り消せません。よろしいですか？
                  </p>
                  <div className="flex items-center justify-end gap-3">
                    <button
                      onClick={() => setConfirmCloseMonth(null)}
                      className="px-4 py-2 rounded-lg border border-slate-300 text-sm font-semibold hover:bg-slate-50 transition-colors"
                      style={{ color: "#374151" }}
                    >
                      キャンセル
                    </button>
                    <button
                      onClick={() => handleCloseMonth(confirmCloseMonth)}
                      className="px-4 py-2 rounded-lg bg-emerald-600 text-white text-sm font-semibold hover:bg-emerald-700 transition-colors"
                    >
                      締める
                    </button>
                  </div>
                </div>
              </div>
            )}

            {/* 月次締め解除の確認ダイアログ（誤締めの取り消し） */}
            {confirmCancelMonth && (
              <div
                className="fixed inset-0 flex items-center justify-center bg-black/40"
                style={{ zIndex: 10000 }}
                onClick={() => setConfirmCancelMonth(null)}
              >
                <div className="bg-white rounded-xl shadow-2xl p-5 w-full max-w-sm mx-4" onClick={ev => ev.stopPropagation()}>
                  <p className="text-sm mb-4" style={{ color: "#111827" }}>
                    {monthJpLabel(confirmCancelMonth)}の締めを解除します。解除後は同月開始の注文書を再び登録できるようになります。よろしいですか？
                  </p>
                  <div className="flex items-center justify-end gap-3">
                    <button
                      onClick={() => setConfirmCancelMonth(null)}
                      className="px-4 py-2 rounded-lg border border-slate-300 text-sm font-semibold hover:bg-slate-50 transition-colors"
                      style={{ color: "#374151" }}
                    >
                      キャンセル
                    </button>
                    <button
                      onClick={() => handleCancelMonth(confirmCancelMonth)}
                      className="px-4 py-2 rounded-lg bg-red-600 text-white text-sm font-semibold hover:bg-red-700 transition-colors"
                    >
                      締め解除
                    </button>
                  </div>
                </div>
              </div>
            )}
          </div>
        </div>,
        document.body
      )}

      {/* User */}
      <div className="px-5 py-4 border-t border-white/10">
        <div className="flex items-center gap-2">
          <div className="w-8 h-8 rounded-full bg-blue-500 flex items-center justify-center text-sm font-bold text-white shrink-0">
            {initial}
          </div>
          <div className="overflow-hidden">
            <p className="text-sm font-semibold truncate" style={{ color: "#ffffff", WebkitTextFillColor: "#ffffff" }}>{name}</p>
            <p className="text-xs truncate" style={{ color: "#cbd5e1", WebkitTextFillColor: "#cbd5e1" }}>{user?.email}</p>
          </div>
        </div>
        <button
          onClick={signOut}
          className="mt-3 w-full text-xs transition-colors text-left"
          style={{ color: "#94a3b8", WebkitTextFillColor: "#94a3b8" }}
        >
          ログアウト
        </button>
      </div>
    </aside>
  );
}
