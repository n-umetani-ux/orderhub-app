"use client";

import { useState, useEffect, useCallback } from "react";
import { useAuth } from "@/lib/auth-context";

type Screen = "dashboard" | "upload";

interface SidebarProps {
  screen: Screen;
  onNavigate: (s: Screen) => void;
  gapCount: number;
  onAdminChange?: (isAdmin: boolean) => void;
}

const DEFAULT_DRIVE_FOLDER_ID = process.env.NEXT_PUBLIC_DRIVE_FOLDER_ID || "1jIhIKa9b-Kzv3niWIsMRw51GS4IVjPFo";

export function Sidebar({ screen, onNavigate, gapCount, onAdminChange }: SidebarProps) {
  const { user, accessToken, signOut } = useAuth();
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

  const userEmail = user?.email ?? "";

  // 設定を読み込み（管理者判定含む）
  const loadSettings = useCallback(async () => {
    if (!accessToken) return;
    try {
      const r = await fetch("/api/settings", {
        headers: { "x-google-access-token": accessToken, "x-user-email": userEmail },
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
    } catch { /* ignore */ }
  }, [accessToken, userEmail]);

  useEffect(() => { loadSettings(); }, [loadSettings]);

  // 管理者ステータスを親に通知
  useEffect(() => { onAdminChange?.(isAdmin); }, [isAdmin, onAdminChange]);

  const saveSetting = async (key: string, value: string) => {
    const r = await fetch("/api/settings", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-google-access-token": accessToken!, "x-user-email": userEmail },
      body: JSON.stringify({ key, value }),
    });
    return r.json();
  };

  const handleSaveSettings = async () => {
    if (!accessToken) return;
    setSaving(true);
    setSaveMsg(null);
    try {
      // DriveフォルダIDを保存
      let folderId = settingsInput.trim();
      const urlMatch = folderId.match(/\/folders\/([a-zA-Z0-9_-]+)/);
      if (urlMatch) folderId = urlMatch[1];

      const results = await Promise.all([
        folderId ? saveSetting("driveFolderId", folderId) : Promise.resolve({ ok: true }),
        adminInput.trim() ? saveSetting("adminEmails", adminInput.trim()) : Promise.resolve({ ok: true }),
      ]);

      const failed = results.find(r => !r.ok);
      if (failed) {
        setSaveMsg(failed.error ?? "保存に失敗しました");
      } else {
        if (folderId) setDriveFolderId(folderId);
        if (adminInput.trim()) setAdminEmails(adminInput.trim());
        setSaveMsg("保存しました");
        setTimeout(() => setSaveMsg(null), 2000);
      }
    } catch {
      setSaveMsg("保存に失敗しました");
    } finally {
      setSaving(false);
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

      {/* Settings modal */}
      {showSettings && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onClick={() => setShowSettings(false)}>
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
          </div>
        </div>
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
