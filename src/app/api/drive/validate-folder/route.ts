import { NextRequest, NextResponse } from "next/server";
import { google } from "googleapis";
import { verifyAuth } from "@/lib/firebase-admin";
import { readSettingsMap } from "@/lib/settings";

// googleapis は Node専用。Edgeで実行されないよう明示
export const runtime = "nodejs";

const DEFAULT_ADMIN = "n-umetani@beat-tech.co.jp";
const FOLDER_MIME = "application/vnd.google-apps.folder";
/** フォルダID文字種チェック（英数字・ハイフン・アンダースコアのみ、最大200文字） */
const FOLDER_ID_RE = /^[a-zA-Z0-9_-]{1,200}$/;

/** 管理者メール一覧（未設定時はデフォルト管理者のみ。sheets/validate と同等の判定） */
function parseAdminEmails(settings: Record<string, string>): string[] {
  const raw = settings["adminEmails"] ?? "";
  const list = raw.split(",").map(e => e.trim()).filter(Boolean);
  return list.length > 0 ? list : [DEFAULT_ADMIN];
}

/**
 * POST /api/drive/validate-folder  body: { folderId: string }
 * 指定フォルダが「存在し」「mimeType が Drive フォルダ」かを検証（メタデータのみ）。
 * 管理者のみ実行可。電帳法_一時とりまとめフォルダID の保存前チェックに使う。
 * 共有ドライブ上のフォルダを想定し supportsAllDrives: true を指定する。
 */
export async function POST(req: NextRequest) {
  // ① Firebase ID Token をサーバー側で検証（自己申告ヘッダーは信用しない＝真の身元）
  const auth = await verifyAuth(req);
  if (!auth.ok) {
    return NextResponse.json({ ok: false, error: auth.error }, { status: auth.status });
  }
  const userEmail = auth.email;

  // ② ユーザーOAuthトークン（Drive読み取り用。身元の根拠には使わない）
  const accessToken = req.headers.get("x-google-access-token");
  if (!accessToken) {
    return NextResponse.json({ ok: false, error: "アクセストークンがありません" }, { status: 401 });
  }

  // ③ 検証対象のフォルダID（ボディから取得。クエリに乗せずログ残留を回避）
  const body = await req.json().catch(() => null) as { folderId?: string } | null;
  const folderId = body?.folderId?.trim() ?? "";
  if (!folderId) {
    return NextResponse.json({ ok: false, error: "フォルダIDが指定されていません" }, { status: 400 });
  }
  if (!FOLDER_ID_RE.test(folderId)) {
    return NextResponse.json({ ok: false, error: "フォルダIDの形式が不正です" }, { status: 400 });
  }

  // ユーザーOAuthでクライアント生成（既存ルートと同型）
  const oauth2 = new google.auth.OAuth2();
  oauth2.setCredentials({ access_token: accessToken });
  const sheets = google.sheets({ version: "v4", auth: oauth2 });
  const drive = google.drive({ version: "v3", auth: oauth2 });

  // ④ 管理者ゲート（設定シートの adminEmails と突合。判定根拠は ID Token 由来の userEmail）
  const settings = await readSettingsMap(sheets); // 失敗時は {} → デフォルト管理者のみ許可
  const isAdmin = parseAdminEmails(settings).includes(userEmail);
  if (!isAdmin) {
    return NextResponse.json({ ok: false, error: "管理者権限がありません" }, { status: 403 });
  }

  // ⑤ 検証本体: メタデータのみ取得し、フォルダであることを確認
  try {
    const res = await drive.files.get({
      fileId: folderId,
      fields: "id,name,mimeType",
      supportsAllDrives: true,
    });
    if (res.data.mimeType !== FOLDER_MIME) {
      return NextResponse.json({ ok: false, error: "指定されたIDはフォルダではありません" });
    }
    return NextResponse.json({ ok: true, name: res.data.name ?? "" });
  } catch (e) {
    // セキュリティ: folderId・トークン・エラー詳細はログに出さない。HTTPステータス番号のみ記録
    const status = (e as { response?: { status?: number } })?.response?.status;
    console.warn("[drive/validate-folder] フォルダメタデータ取得失敗", status ?? "");
    return NextResponse.json({
      ok: false,
      error: "フォルダが見つかりません。IDを確認してください",
    });
  }
}
