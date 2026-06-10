import { NextRequest } from "next/server";
import { initializeApp, getApps, cert } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";

// env値の末尾空白・改行・大文字混入で全ユーザー403にならないよう正規化（c11d0ca同型事故の予防）
const ALLOWED_DOMAIN = (process.env.NEXT_PUBLIC_ALLOWED_DOMAIN || "example.com").trim().toLowerCase();

/** firebase-admin を初期化して Auth を返す（二重初期化ガード付き） */
function getAdminAuth() {
  if (getApps().length === 0) {
    let credentials;
    try {
      credentials = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON!);
    } catch {
      // JSON.parse の例外メッセージは入力断片（秘密鍵の一部）を含み得るため、固定文言に差し替える
      throw new Error("GOOGLE_SERVICE_ACCOUNT_JSON のJSONパースに失敗しました");
    }
    // Vercel 環境変数では private_key の改行が \n エスケープのまま入る場合がある
    if (typeof credentials.private_key === "string") {
      credentials.private_key = credentials.private_key.replace(/\\n/g, "\n");
    }
    initializeApp({ credential: cert(credentials) });
  }
  return getAuth();
}

export type VerifiedAuth =
  | { ok: true; email: string; domain: string }
  | { ok: false; status: number; error: string };

/**
 * Authorization: Bearer <Firebase ID Token> を検証し、検証済みの email とドメインを返す。
 * 社内ドメイン（NEXT_PUBLIC_ALLOWED_DOMAIN）以外は拒否する。
 */
export async function verifyAuth(req: NextRequest): Promise<VerifiedAuth> {
  const authHeader = req.headers.get("authorization") ?? "";
  const idToken = authHeader.startsWith("Bearer ") ? authHeader.slice("Bearer ".length) : "";
  if (!idToken) {
    return { ok: false, status: 401, error: "認証情報がありません。再ログインしてください。" };
  }

  // 初期化失敗（env破損等のサーバー設定異常）はトークン期限切れと区別し、再ログインループを防ぐ
  let adminAuth;
  try {
    adminAuth = getAdminAuth();
  } catch (e) {
    console.error("[verifyAuth] firebase-admin 初期化失敗:", e instanceof Error ? e.message : String(e));
    return { ok: false, status: 500, error: "認証処理でエラーが発生しました(管理者に連絡してください)" };
  }

  try {
    const decoded = await adminAuth.verifyIdToken(idToken);
    const email = decoded.email ?? "";
    if (!email) {
      return { ok: false, status: 401, error: "認証情報にメールアドレスが含まれていません。再ログインしてください。" };
    }
    const domain = email.toLowerCase().split("@")[1] ?? "";
    if (domain !== ALLOWED_DOMAIN) {
      return { ok: false, status: 403, error: "社内アカウント以外ではアクセスできません" };
    }
    return { ok: true, email, domain };
  } catch (e) {
    console.error("[verifyAuth] IDトークン検証失敗:", e instanceof Error ? e.message : e);
    return { ok: false, status: 401, error: "認証の有効期限が切れています。再ログインしてください。" };
  }
}
