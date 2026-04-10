"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { useAuth } from "@/lib/auth-context";
import { Sidebar } from "@/components/ui/Sidebar";
import DashboardPage from "@/app/dashboard/page";
import UploadPage from "@/app/upload/page";
import { Engineer } from "@/types";

type Screen = "dashboard" | "upload";

export default function Home() {
  const { user, loading } = useAuth();
  const router = useRouter();
  const [screen, setScreen] = useState<Screen>("dashboard");
  const [prefill, setPrefill] = useState<Engineer | null>(null);
  const [gapCount, setGapCount] = useState(0);
  const [isAdmin, setIsAdmin] = useState(false);

  useEffect(() => {
    if (!loading && !user) router.replace("/login");
  }, [user, loading, router]);

  if (loading || !user) {
    return (
      <div className="min-h-screen flex items-center justify-center" style={{ backgroundColor: "#f8fafc" }}>
        <div className="w-8 h-8 border-2 border-blue-500 border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  const handleSwitch = (e: Engineer) => {
    setPrefill(e);
    setScreen("upload");
  };

  const handleNavigate = (s: Screen) => {
    setScreen(s);
    if (s === "dashboard") setPrefill(null);
  };

  return (
    <div className="flex min-h-screen font-sans bg-slate-50">
      <Sidebar screen={screen} onNavigate={handleNavigate} gapCount={gapCount} onAdminChange={setIsAdmin} />
      <main className="flex-1 px-9 py-7 max-w-[1100px] overflow-auto">
        {screen === "dashboard" && (
          <DashboardPage onSwitch={handleSwitch} onGapCountChange={setGapCount} isAdmin={isAdmin} />
        )}
        {screen === "upload" && (
          <UploadPage prefill={prefill} onBack={() => handleNavigate("dashboard")} />
        )}
      </main>
    </div>
  );
}
