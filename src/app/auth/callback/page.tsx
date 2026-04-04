"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { getRedirectResult, signOut } from "firebase/auth";
import { auth, ALLOWED_DOMAIN } from "@/lib/firebase";

export default function AuthCallbackPage() {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    getRedirectResult(auth)
      .then((result) => {
        if (!result) {
          // リダイレクト結果なし → ログインページへ
          router.replace("/login");
          return;
        }
        const email = result.user.email ?? "";
        if (!email.endsWith(`@${ALLOWED_DOMAIN}`)) {
          signOut(auth).then(() => {
            setError(`このサービスは @${ALLOWED_DOMAIN} のアカウントのみ利用できます`);
          });
          return;
        }
        router.replace("/");
      })
      .catch((e: unknown) => {
        setError(e instanceof Error ? e.message : "認証エラーが発生しました");
      });
  }, [router]);

  if (error) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-slate-950">
        <div className="bg-slate-900 border border-red-700 rounded-xl p-8 max-w-sm w-full mx-4 text-center">
          <p className="text-red-400 text-sm mb-4">{error}</p>
          <button
            onClick={() => router.replace("/login")}
            className="px-4 py-2 rounded-lg bg-slate-700 text-white text-sm hover:bg-slate-600 transition-colors"
          >
            ログインに戻る
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-slate-950">
      <div className="w-8 h-8 border-2 border-blue-500 border-t-transparent rounded-full animate-spin" />
    </div>
  );
}
