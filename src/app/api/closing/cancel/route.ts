import { NextRequest, NextResponse } from "next/server";
import { google } from "googleapis";
import { verifyAuth } from "@/lib/firebase-admin";
import { readSettingsMap, appendOrUpdateSetting } from "@/lib/settings";
import { getOrderLedgerSheetId } from "@/lib/monthly-sheets";
import {
  CLOSING_MIN_MONTH,
  closingStatusKey,
  getCurrentMonthKeyJST,
  isValidMonthKey,
  isMonthClosed,
  buildCancelledStatusValue,
} from "@/lib/closing";

// googleapis は Node専用。Edgeで実行されないよう明示
export const runtime = "nodejs";

const LEDGER_SHEET_ID = getOrderLedgerSheetId();
const DEFAULT_ADMIN = "n-umetani@beat-tech.co.jp";

/** 管理者メール一覧（未設定時はデフォルト管理者のみ。execute と同一パターン） */
function parseAdminEmails(settings: Record<string, string>): string[] {
  const raw = settings["adminEmails"] ?? "";
  const list = raw.split(",").map(e => e.trim()).filter(Boolean);
  return list.length > 0 ? list : [DEFAULT_ADMIN];
}

/**
 * POST /api/closing/cancel  body: { month: "YYYY-MM" }
 * 誤締めの取り消し（ステップ②）。closing_status:{month} を cancelled:{ISO}:{email} に更新し、
 * ステップ①のサーバー側ゲートを開く（同月開始の注文書を再び登録可能に戻す）。
 * 「解除→登録→再締め」フローの解除部分。再締めは execute を再実行すればよい。
 * 認証は verifyAuth + adminEmails（管理者のみ・execute と同一ゲート）。
 *   - 未締め → 409 / 形式不正・範囲外 → 400
 */
export async function POST(req: NextRequest) {
  const auth = await verifyAuth(req);
  if (!auth.ok) {
    return NextResponse.json({ ok: false, error: auth.error }, { status: auth.status });
  }
  const userEmail = auth.email;

  const accessToken = req.headers.get("x-google-access-token");
  if (!accessToken) {
    return NextResponse.json({ ok: false, error: "アクセストークンがありません" }, { status: 401 });
  }

  // 月のバリデーション（YYYY-MM 形式 + 締め対象範囲。execute と同一）
  const body = await req.json().catch(() => null) as { month?: string } | null;
  const month = body?.month?.trim() ?? "";
  if (!month || !isValidMonthKey(month)) {
    return NextResponse.json({ ok: false, error: "月の形式が不正です（YYYY-MM）" }, { status: 400 });
  }
  const currentMonth = getCurrentMonthKeyJST();
  if (month < CLOSING_MIN_MONTH || month > currentMonth) {
    return NextResponse.json({ ok: false, error: "締め対象の範囲外の月です" }, { status: 400 });
  }

  try {
    const oauth2 = new google.auth.OAuth2();
    oauth2.setCredentials({ access_token: accessToken });
    const sheets = google.sheets({ version: "v4", auth: oauth2 });

    const settings = await readSettingsMap(sheets);

    // 管理者ゲート（判定根拠は ID Token 由来の userEmail）
    if (!parseAdminEmails(settings).includes(userEmail)) {
      return NextResponse.json({ ok: false, error: "管理者権限がありません" }, { status: 403 });
    }

    // 締め済みでなければ解除できない（未締め・既に解除済みは 409）
    if (!isMonthClosed(settings, month)) {
      return NextResponse.json({ ok: false, error: "この月は締められていません" }, { status: 409 });
    }

    // 解除を記録（closing_status:{month} = cancelled:{ISO}:{email}）→ ①のゲートが開く
    const cancelledAt = new Date().toISOString();
    const cancelledBy = userEmail;
    await appendOrUpdateSetting(sheets, LEDGER_SHEET_ID, closingStatusKey(month), buildCancelledStatusValue(cancelledAt, cancelledBy));

    return NextResponse.json({ ok: true, month, cancelledAt, cancelledBy });
  } catch (e) {
    console.error("[closing/cancel]", e);
    return NextResponse.json({ ok: false, error: "締め解除に失敗しました" }, { status: 500 });
  }
}
