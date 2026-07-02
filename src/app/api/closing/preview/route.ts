import { NextRequest, NextResponse } from "next/server";
import { google } from "googleapis";
import { verifyAuth } from "@/lib/firebase-admin";
import { readSettingsMap } from "@/lib/settings";
import { getOrderLedgerSheetId } from "@/lib/monthly-sheets";
import {
  CLOSING_MIN_MONTH,
  getCurrentMonthKeyJST,
  isValidMonthKey,
  buildMovePreview,
} from "@/lib/closing";
import { readOrderRowsForPreview } from "@/lib/closing-data";

// googleapis は Node専用。Edgeで実行されないよう明示
export const runtime = "nodejs";

const LEDGER_SHEET_ID = getOrderLedgerSheetId();
const DEFAULT_ADMIN = "n-umetani@beat-tech.co.jp";

/** 管理者メール一覧（未設定時はデフォルト管理者のみ。execute / cancel と同一パターン） */
function parseAdminEmails(settings: Record<string, string>): string[] {
  const raw = settings["adminEmails"] ?? "";
  const list = raw.split(",").map(e => e.trim()).filter(Boolean);
  return list.length > 0 ? list : [DEFAULT_ADMIN];
}

/**
 * GET /api/closing/preview?month=YYYY-MM
 * 対象月開始（contractStart の月 = 指定月）の台帳行を全件、移動対象プレビューとして返す（読み取りのみ）。
 * 各行に effective（dedup で有効か隠れた古い行か）と hasDriveFile（driveLink 有無）を付与する。
 * Phase C-2（実PDF移動）前の目視確認・dedup可視化用。PDF移動や書き込みは一切行わない。
 * 認証は verifyAuth + adminEmails（管理者のみ・execute / cancel と同一ゲート）。
 */
export async function GET(req: NextRequest) {
  const auth = await verifyAuth(req);
  if (!auth.ok) {
    return NextResponse.json({ error: auth.error }, { status: auth.status });
  }
  const userEmail = auth.email;

  const accessToken = req.headers.get("x-google-access-token");
  if (!accessToken) {
    return NextResponse.json({ error: "アクセストークンがありません" }, { status: 401 });
  }

  // 月のバリデーション（YYYY-MM 形式 + 締め対象範囲。execute / cancel と同一）
  const month = req.nextUrl.searchParams.get("month")?.trim() ?? "";
  if (!month || !isValidMonthKey(month)) {
    return NextResponse.json({ error: "月の形式が不正です（YYYY-MM）" }, { status: 400 });
  }
  const currentMonth = getCurrentMonthKeyJST();
  if (month < CLOSING_MIN_MONTH || month > currentMonth) {
    return NextResponse.json({ error: "締め対象の範囲外の月です" }, { status: 400 });
  }

  try {
    const oauth2 = new google.auth.OAuth2();
    oauth2.setCredentials({ access_token: accessToken });
    const sheets = google.sheets({ version: "v4", auth: oauth2 });

    const settings = await readSettingsMap(sheets);

    // 管理者ゲート（判定根拠は ID Token 由来の userEmail）
    if (!parseAdminEmails(settings).includes(userEmail)) {
      return NextResponse.json({ error: "管理者権限がありません" }, { status: 403 });
    }

    // 台帳を読み、dedup分類 + 対象月フィルタ（純関数）。書き込みなし。
    const all = await readOrderRowsForPreview(sheets, LEDGER_SHEET_ID);
    const preview = buildMovePreview(all, month);

    return NextResponse.json(preview);
  } catch (e) {
    console.error("[closing/preview]", e);
    return NextResponse.json({ error: "移動対象プレビューの取得に失敗しました" }, { status: 500 });
  }
}
