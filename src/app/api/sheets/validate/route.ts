import { NextRequest, NextResponse } from "next/server";
import { google } from "googleapis";
import { verifyAuth } from "@/lib/firebase-admin";
import { readSettingsMap } from "@/lib/settings";
import { SHEET_LOCS } from "@/lib/sheet-locations";

// googleapis は Node専用。Edgeで実行されないよう明示
export const runtime = "nodejs";

const DEFAULT_ADMIN = "n-umetani@beat-tech.co.jp";

/** 管理者メール一覧（未設定時はデフォルト管理者のみ。settings/route.ts と同等の判定） */
function parseAdminEmails(settings: Record<string, string>): string[] {
  const raw = settings["adminEmails"] ?? "";
  const list = raw.split(",").map(e => e.trim()).filter(Boolean);
  return list.length > 0 ? list : [DEFAULT_ADMIN];
}

/**
 * POST /api/sheets/validate  body: { sheetId: string }
 * 指定シートが「読めて」「稼働表（東京/大阪/福岡）タブを1つ以上持つ」かを軽く検証（メタデータのみ）。
 * 管理者のみ実行可。月別シートID登録の保存前チェックに使う（誤ID登録の防止＝Finding #1対策）。
 * sheetId は URL クエリに乗せるとアクセスログに残るため、リクエストボディで受け取る（Finding #2a対策）。
 */
export async function POST(req: NextRequest) {
  // ① Firebase ID Token をサーバー側で検証（自己申告ヘッダーは信用しない＝真の身元）
  const auth = await verifyAuth(req);
  if (!auth.ok) {
    return NextResponse.json({ ok: false, error: auth.error }, { status: auth.status });
  }
  const userEmail = auth.email;

  // ② ユーザーOAuthトークン（Sheets読み取り用。身元の根拠には使わない）
  const accessToken = req.headers.get("x-google-access-token");
  if (!accessToken) {
    return NextResponse.json({ ok: false, error: "アクセストークンがありません" }, { status: 401 });
  }

  // ③ 検証対象のシートID（ボディから取得。クエリに乗せずログ残留を回避）
  const body = await req.json().catch(() => null) as { sheetId?: string } | null;
  const sheetId = body?.sheetId?.trim() ?? "";
  if (!sheetId) {
    return NextResponse.json({ ok: false, reason: "シートIDが指定されていません" }, { status: 400 });
  }

  // ユーザーOAuthでSheetsクライアント生成（既存ルートと同型）
  const oauth2 = new google.auth.OAuth2();
  oauth2.setCredentials({ access_token: accessToken });
  const sheets = google.sheets({ version: "v4", auth: oauth2 });

  // ④ 管理者ゲート（設定シートの adminEmails と突合。判定根拠は ID Token 由来の userEmail）
  const settings = await readSettingsMap(sheets); // 失敗時は {} → デフォルト管理者のみ許可
  const isAdmin = parseAdminEmails(settings).includes(userEmail);
  if (!isAdmin) {
    return NextResponse.json({ ok: false, error: "管理者権限がありません" }, { status: 403 });
  }

  // ⑤ 検証本体: メタデータのみ取得（行データは読まない）
  //    実読み取り(sheets/route.ts)と同じ完全一致基準で稼働表タブを判定（緩い部分一致はしない）
  try {
    const meta = await sheets.spreadsheets.get({ spreadsheetId: sheetId });
    const titles = (meta.data.sheets?.map(s => s.properties?.title ?? "") ?? []).filter(Boolean);
    // SHEET_LOCS のキー（稼働表（東京）/（大阪）/（福岡））に完全一致するタブが1つでもあればOK
    const locs = titles.filter(t => t in SHEET_LOCS);
    const title = meta.data.properties?.title ?? "";

    if (locs.length === 0) {
      return NextResponse.json({
        ok: false,
        title,
        reason: "稼働表（東京/大阪/福岡）のいずれのタブも見つかりません（別のスプレッドシートの可能性があります）",
      });
    }
    return NextResponse.json({ ok: true, title, locs });
  } catch (e) {
    // セキュリティ: sheetId・トークン・エラー詳細はログに出さない。HTTPステータス番号のみ記録
    const status = (e as { response?: { status?: number } })?.response?.status;
    console.warn("[sheets/validate] シートメタデータ取得失敗", status ?? "");
    return NextResponse.json({
      ok: false,
      reason: "シートを読み取れません（IDの誤り、または閲覧権限がありません）",
    });
  }
}
