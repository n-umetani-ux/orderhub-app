import { NextRequest, NextResponse } from "next/server";
import { google } from "googleapis";
import { verifyAuth } from "@/lib/firebase-admin";
import { readSettingsMap } from "@/lib/settings";
import { getOrderLedgerSheetId } from "@/lib/monthly-sheets";
import {
  closingStatusKey,
  getCurrentMonthKeyJST,
  getClosingMonths,
  computeMonthlyGapCounts,
  parseClosingStatusValue,
} from "@/lib/closing";
import { readEngineerCache, readOrdersByManNo, readArchivedManNos } from "@/lib/closing-data";

// googleapis は Node専用。Edgeで実行されないよう明示
export const runtime = "nodejs";

const LEDGER_SHEET_ID = getOrderLedgerSheetId();

interface MonthStatus {
  status: "done" | "open";
  gapCount?: number;
  closedAt?: string;
  closedBy?: string;
}

/**
 * GET /api/closing/status
 * 2026-04〜当月の各月について、締め済みなら {status:"done", closedAt, closedBy}、
 * 未締めなら {status:"open", gapCount} を返す。
 * 認証は verifyAuth のみ（管理者以外も参照可。アップロード画面の締めチェックでも使う）。
 */
export async function GET(req: NextRequest) {
  const auth = await verifyAuth(req);
  if (!auth.ok) {
    return NextResponse.json({ error: auth.error }, { status: auth.status });
  }

  const accessToken = req.headers.get("x-google-access-token");
  if (!accessToken) {
    return NextResponse.json({ error: "アクセストークンがありません" }, { status: 401 });
  }

  try {
    const oauth2 = new google.auth.OAuth2();
    oauth2.setCredentials({ access_token: accessToken });
    const sheets = google.sheets({ version: "v4", auth: oauth2 });

    const months = getClosingMonths(getCurrentMonthKeyJST());

    // 設定（締め状態）・稼働キャッシュ・注文書台帳・アーカイブを並列取得（各reader は失敗時に空で縮退）
    const [settings, engineers, ordersByManNo, archived] = await Promise.all([
      readSettingsMap(sheets),
      readEngineerCache(sheets, LEDGER_SHEET_ID),
      readOrdersByManNo(sheets, LEDGER_SHEET_ID),
      readArchivedManNos(sheets, LEDGER_SHEET_ID),
    ]);

    const gapCounts = computeMonthlyGapCounts(engineers, ordersByManNo, months, archived);

    const result: Record<string, MonthStatus> = {};
    for (const m of months) {
      const closed = parseClosingStatusValue(settings[closingStatusKey(m)] ?? "");
      if (closed) {
        result[m] = { status: "done", closedAt: closed.closedAt, closedBy: closed.closedBy };
      } else {
        result[m] = { status: "open", gapCount: gapCounts[m] ?? 0 };
      }
    }

    return NextResponse.json({ months: result });
  } catch (e) {
    console.error("[closing/status]", e);
    return NextResponse.json({ error: "締め状態の取得に失敗しました" }, { status: 500 });
  }
}
