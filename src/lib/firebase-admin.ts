import { NextRequest } from "next/server";

// ── Firebase ID Token のサーバー側検証（fetchベース・ライブラリ非依存）──
// 旧実装は firebase-admin(verifyIdToken)を使っていたが、Vercel(Turbopack)で
// 外部モジュールのロードに失敗するため、Identity Toolkit の accounts:lookup を
// fetch で叩く方式に置き換えた。これにより firebase-admin への依存を完全に排除。
// 検証対象は Firebase ID Token(iss=securetoken.google.com)であり、Google OIDC用の
// oauth2.googleapis.com/tokeninfo とは別物なので使わない。

// env値の末尾空白・改行・大文字混入で全ユーザー403にならないよう正規化（c11d0ca同型事故の予防）
const ALLOWED_DOMAIN = (process.env.NEXT_PUBLIC_ALLOWED_DOMAIN || "example.com").trim().toLowerCase();
const FIREBASE_API_KEY = process.env.NEXT_PUBLIC_FIREBASE_API_KEY ?? "";

// Identity Toolkit: ID Token を渡すと有効性(署名・期限・プロジェクト整合)を
// Google 側で検証し、検証済みユーザー情報(email/emailVerified)を返す
const LOOKUP_ENDPOINT = "https://identitytoolkit.googleapis.com/v1/accounts:lookup";

export type VerifiedAuth =
  | { ok: true; email: string; domain: string }
  | { ok: false; status: number; error: string };

/**
 * Authorization: Bearer <Firebase ID Token> を検証し、検証済みの email とドメインを返す。
 * 社内ドメイン（NEXT_PUBLIC_ALLOWED_DOMAIN）以外・未確認メールは拒否する。
 * 偽造不可能な ID Token のみを信頼し、ヘッダーの自己申告は一切信用しない。
 */
export async function verifyAuth(req: NextRequest): Promise<VerifiedAuth> {
  const authHeader = req.headers.get("authorization") ?? "";
  const idToken = authHeader.startsWith("Bearer ") ? authHeader.slice("Bearer ".length) : "";
  if (!idToken) {
    return { ok: false, status: 401, error: "認証情報がありません。再ログインしてください。" };
  }

  // APIキー未設定はサーバー設定異常。トークン期限切れ(401)と区別し再ログインループを防ぐ
  if (!FIREBASE_API_KEY) {
    console.error("[verifyAuth] NEXT_PUBLIC_FIREBASE_API_KEY が未設定です");
    return { ok: false, status: 500, error: "認証処理でエラーが発生しました(管理者に連絡してください)" };
  }

  // Identity Toolkit へ問い合わせ。ネットワーク失敗はサーバー異常(500)として分離
  let res: Response;
  try {
    res = await fetch(`${LOOKUP_ENDPOINT}?key=${encodeURIComponent(FIREBASE_API_KEY)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ idToken }),
      // ネットワーク断・無応答で関数が固まらないよう5秒で打ち切る
      signal: AbortSignal.timeout(5000),
    });
  } catch (e) {
    // タイムアウト(AbortSignal.timeout は TimeoutError、保険で AbortError も)はサーバー一時異常として扱う
    const name = e instanceof Error ? e.name : "";
    if (name === "TimeoutError" || name === "AbortError") {
      console.error("[verifyAuth] accounts:lookup タイムアウト");
      return { ok: false, status: 500, error: "認証サービスが応答しません(時間をおいて再度お試しください)" };
    }
    // URL/keyはログに出さない（秘密情報漏洩経路を作らない）
    console.error("[verifyAuth] accounts:lookup 通信失敗:", e instanceof Error ? e.message : String(e));
    return { ok: false, status: 500, error: "認証処理でエラーが発生しました(管理者に連絡してください)" };
  }

  const data = await res.json().catch(() => null) as
    | { users?: { email?: string; emailVerified?: boolean }[]; error?: { message?: string } }
    | null;

  if (!res.ok) {
    // 401(トークン起因)と500(サーバー/設定起因)はHTTPステータスで一次分岐する。
    // 文字列一致は誤分類・将来の文言変更に弱いため使わない(5/22型の誤診断回避)。
    if (res.status >= 500 || res.status === 429) {
      // Google側の障害・レート制限。再ログインを促さない
      console.error("[verifyAuth] accounts:lookup 一時障害:", res.status);
      return { ok: false, status: 500, error: "認証サービスが一時的に利用できません(時間をおいて再度お試しください)" };
    }
    if (res.status === 400 || res.status === 401) {
      // トークン無効・期限切れ
      return { ok: false, status: 401, error: "認証の有効期限が切れています。再ログインしてください。" };
    }
    // 想定外(403等)は安全側でサーバー/設定異常として扱う
    console.error("[verifyAuth] accounts:lookup 想定外ステータス:", res.status);
    return { ok: false, status: 500, error: "認証処理でエラーが発生しました(管理者に連絡してください)" };
  }

  const user = data?.users?.[0];
  if (!user || !user.email) {
    return { ok: false, status: 401, error: "認証情報にメールアドレスが含まれていません。再ログインしてください。" };
  }

  // email_verified を必須化（Google以外のサインインプロバイダ混入時の防御 / #1 HIGH残課題の解消）
  if (user.emailVerified !== true) {
    return { ok: false, status: 403, error: "メールアドレスが未確認のアカウントではアクセスできません" };
  }

  const email = user.email;
  const domain = email.toLowerCase().split("@")[1] ?? "";
  if (domain !== ALLOWED_DOMAIN) {
    return { ok: false, status: 403, error: "社内アカウント以外ではアクセスできません" };
  }

  return { ok: true, email, domain };
}
