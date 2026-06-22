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
  computeMonthlyGapCounts,
  parseClosingStatusValue,
  buildClosingStatusValue,
} from "@/lib/closing";
import { readEngineerCache, readOrdersByManNo, readArchivedManNos } from "@/lib/closing-data";

// googleapis は Node専用。Edgeで実行されないよう明示
export const runtime = "nodejs";

const LEDGER_SHEET_ID = getOrderLedgerSheetId();
const DEFAULT_ADMIN = "n-umetani@beat-tech.co.jp";

/** 管理者メール一覧（未設定時はデフォルト管理者のみ。他の管理者ゲートと同等） */
function parseAdminEmails(settings: Record<string, string>): string[] {
  const raw = settings["adminEmails"] ?? "";
  const list = raw.split(",").map(e => e.trim()).filter(Boolean);
  return list.length > 0 ? list : [DEFAULT_ADMIN];
}

/**
 * POST /api/closing/execute  body: { month: "YYYY-MM" }
 * 対象月のギャップを再計算し0件のときのみ、設定シートに締めフラグを書き込む。
 * 認証は verifyAuth + adminEmails（管理者のみ）。
 *   - ギャップ>0 → 400 / 既に締め済み → 409 / 形式不正・範囲外 → 400
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

  // 月のバリデーション（YYYY-MM 形式 + 締め対象範囲）
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

    // すでに締め済みなら 409
    if (parseClosingStatusValue(settings[closingStatusKey(month)] ?? "")) {
      return NextResponse.json({ ok: false, error: "この月はすでに締め済みです" }, { status: 409 });
    }

    // ギャップ再計算（0件以外は締め不可）
    const [engineers, ordersByManNo, archived] = await Promise.all([
      readEngineerCache(sheets, LEDGER_SHEET_ID),
      readOrdersByManNo(sheets, LEDGER_SHEET_ID),
      readArchivedManNos(sheets, LEDGER_SHEET_ID),
    ]);

    // 稼働データ未ロード（キャッシュ空）だとギャップ0と誤判定し得るため、安全側で拒否
    if (engineers.length === 0) {
      return NextResponse.json(
        { ok: false, error: "稼働データが読み込まれていません。ダッシュボードを開いてから再実行してください" },
        { status: 409 },
      );
    }

    const gapCount = computeMonthlyGapCounts(engineers, ordersByManNo, [month], archived)[month] ?? 0;
    if (gapCount > 0) {
      return NextResponse.json(
        { ok: false, error: `ギャップが${gapCount}件あるため締められません`, gapCount },
        { status: 400 },
      );
    }

    // 締めフラグを書き込み（closing_status:{month} = done:{ISO}:{email}）
    const closedAt = new Date().toISOString();
    const closedBy = userEmail;
    await appendOrUpdateSetting(sheets, LEDGER_SHEET_ID, closingStatusKey(month), buildClosingStatusValue(closedAt, closedBy));

    return NextResponse.json({ ok: true, month, closedAt, closedBy });
  } catch (e) {
    console.error("[closing/execute]", e);
    return NextResponse.json({ ok: false, error: "締め処理に失敗しました" }, { status: 500 });
  }
}
