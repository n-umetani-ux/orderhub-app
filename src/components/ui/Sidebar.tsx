"use client";

import { useAuth } from "@/lib/auth-context";

type Screen = "dashboard" | "upload";

interface SidebarProps {
  screen: Screen;
  onNavigate: (s: Screen) => void;
  gapCount: number;
}

export function Sidebar({ screen, onNavigate, gapCount }: SidebarProps) {
  const { user, signOut } = useAuth();
  const name = user?.displayName?.split(" ")[0] ?? user?.email ?? "";
  const initial = name.charAt(0);

  return (
    <aside className="w-52 shrink-0 flex flex-col bg-gradient-to-b from-slate-900 to-slate-800 h-screen sticky top-0">
      {/* Logo */}
      <div className="px-5 py-5 border-b border-white/10">
        <div className="flex items-center gap-2">
          <span className="text-xl">📋</span>
          <span className="text-lg font-extrabold text-white tracking-tight">OrderHub</span>
        </div>
        <p className="text-xs text-slate-500 mt-1">注文書 期間ギャップ管理</p>
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
          href="https://drive.google.com/drive/folders/1jIhIKa9b-Kzv3niWIsMRw51GS4IVjPFo"
          target="_blank"
          rel="noreferrer"
          className="flex items-center gap-2.5 w-full px-3 py-2.5 rounded-lg text-sm text-left transition-all text-slate-400 hover:bg-white/5 hover:text-slate-200"
        >
          <span className="text-base">📁</span>
          <span className="flex-1">注文書PDF フォルダ</span>
          <span className="text-[10px] text-slate-500">↗</span>
        </a>
      </nav>

      {/* User */}
      <div className="px-5 py-4 border-t border-white/10">
        <div className="flex items-center gap-2">
          <div className="w-8 h-8 rounded-full bg-blue-500 flex items-center justify-center text-sm font-bold text-white shrink-0">
            {initial}
          </div>
          <div className="overflow-hidden">
            <p className="text-sm font-semibold text-white truncate">{name}</p>
            <p className="text-xs text-slate-300 truncate">{user?.email}</p>
          </div>
        </div>
        <button
          onClick={signOut}
          className="mt-3 w-full text-xs text-slate-500 hover:text-slate-300 transition-colors text-left"
        >
          ログアウト
        </button>
      </div>
    </aside>
  );
}
