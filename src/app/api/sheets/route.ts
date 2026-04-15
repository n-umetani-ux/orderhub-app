import { NextRequest, NextResponse } from "next/server";
import { google } from "googleapis";
import { toEngineer, OrderRecord } from "@/lib/gap-detector";
import { getActiveSheetIds, getOrderLedgerSheetId } from "@/lib/monthly-sheets";

const LEDGER_SHEET_ID = getOrderLedgerSheetId();

const SECTION_MARKERS = ["待機一覧", "正社員エンジニア一覧", "個人事業主エンジニア一覧", "パートナーエンジニア一覧", "ENGチーム", "ENG_BP"];
const STANDBY_SECTION = "待機一覧";
const HEADER_PATTERNS = ["manNo.", "No.", "PJcode"];

type Loc = "東京" | "大阪" | "福岡";
const SHEET_LOCS: Record<string, Loc> = {
  "稼働表（東京）": "東京",
  "稼働表（大阪）": "大阪",
  "稼働表（福岡）": "福岡",
};

// 機密列（I,J-W,X = 8,9-22,23）
const SENSITIVE_COLS = new Set([8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23]);
const COL = { manNo: 0, kubun: 1, name: 2, activity: 3, ending: 4, customer: 5, tantou: 6, customerCode: 30 };

/** サービスアカウント（稼働一覧スプレッドシート読み取り用 — 個別にアクセス権あり） */
function getServiceSheets() {
  const credentials = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON!);
  const auth = new google.auth.GoogleAuth({
    credentials,
    scopes: ["https://www.googleapis.com/auth/spreadsheets.readonly"],
  });
  return google.sheets({ version: "v4", auth });
}

function parseRows(rows: string[][], loc: Loc) {
  const result = [];
  let inStandby = false;
  let headerFound = false;

  for (const row of rows) {
    const rowA = row[0]?.trim() ?? "";

    if (SECTION_MARKERS.some(m => rowA.includes(m))) {
      inStandby = rowA.includes(STANDBY_SECTION);
      headerFound = false;
      continue;
    }
    if (HEADER_PATTERNS.some(p => rowA.includes(p))) {
      headerFound = true;
      continue;
    }
    if (inStandby || !headerFound) continue;

    const manNo = row[COL.manNo]?.trim();
    if (!manNo || !/^\d{6}$/.test(manNo)) continue;

    const activity = parseFloat(row[COL.activity] ?? "0") || 0;
    if (activity < 0.5) continue;

    // 担当者名の正規化（「全」「全員」等のバリエーション対応）
    let tantou = row[COL.tantou]?.trim() ?? "";
    if (tantou === "全" || tantou === "全員" || tantou === "全社") {
      tantou = "全員";
    }

    result.push({
      manNo,
      kubun:        row[COL.kubun]?.trim() ?? "",
      name:         row[COL.name]?.trim() ?? "",
      activity,
      ending:       parseFloat(row[COL.ending] ?? "0") || 0,
      customer:     row[COL.customer]?.trim() ?? "",
      tantou,
      customerCode: row[COL.customerCode]?.trim() ?? "",
      loc,
    });
  }
  return result;
}

export async function GET(req: NextRequest) {
  const accessToken = req.headers.get("x-google-access-token");
  if (!accessToken) {
    return NextResponse.json({ error: "アクセストークンがありません" }, { status: 401 });
  }

  try {
    // 稼働一覧: サービスアカウントで読み取り（全ユーザー共通、個別アクセス権あり）
    const saSheets = getServiceSheets();
    // 注文書台帳・アーカイブ: ユーザーOAuthで読み取り
    const oauth2 = new google.auth.OAuth2();
    oauth2.setCredentials({ access_token: accessToken });
    const userSheets = google.sheets({ version: "v4", auth: oauth2 });

    // 当月＋翌月の稼働一覧スプレッドシートを両方読む
    const activeSheets = getActiveSheetIds();
    console.log("[sheets API] 参照スプレッドシート:", activeSheets.map(s => s.label));
    const loadedMonths: string[] = [];

    const manNoActiveMonths = new Map<string, Set<string>>();
    const raw = [];
    for (const { id: spreadsheetId, label, yearMonth } of activeSheets) {
      try {
        const meta = await saSheets.spreadsheets.get({ spreadsheetId });
        const sheetNames = meta.data.sheets?.map(s => s.properties?.title ?? "") ?? [];
        const targetSheets = sheetNames.filter(n => n in SHEET_LOCS);

        for (const sheetName of targetSheets) {
          const loc = SHEET_LOCS[sheetName];
          const res = await saSheets.spreadsheets.values.get({
            spreadsheetId,
            range: `${sheetName}!A:AE`,
          });
          const rows = (res.data.values ?? []) as string[][];
          const sanitized = rows.map(row =>
            row.map((cell, idx) => (SENSITIVE_COLS.has(idx) ? "" : cell))
          );
          const parsed = parseRows(sanitized, loc);
          for (const eng of parsed) {
            if (!manNoActiveMonths.has(eng.manNo)) manNoActiveMonths.set(eng.manNo, new Set());
            manNoActiveMonths.get(eng.manNo)!.add(yearMonth);
          }
          raw.push(...parsed);
        }
        loadedMonths.push(yearMonth);
        console.log(`[sheets API] ${label}シート読み込み完了`);
      } catch (err) {
        console.warn(`[sheets API] ${label}シート読み込み失敗（未作成の可能性）:`, err);
      }
    }

    // manNo で重複除去（同じ番号が複数シートに存在する場合、後のシート=翌月を優先）
    const engineerMap = new Map<string, typeof raw[0]>();
    for (const e of raw) {
      engineerMap.set(e.manNo, e);
    }
    const deduped = Array.from(engineerMap.values());

    // 注文書台帳を取得してギャップ検知に使用（ユーザーOAuth）
    let ordersByManNo = new Map<string, OrderRecord[]>();
    try {
      const ordersRes = await userSheets.spreadsheets.values.get({
        spreadsheetId: LEDGER_SHEET_ID,
        range: "注文書台帳!A:D",
      });
      const ordersRows = (ordersRes.data.values ?? []) as string[][];
      for (const row of ordersRows.slice(1)) {
        if (!row[0] || !row[2] || !row[3]) continue;
        const rec: OrderRecord = { manNo: row[0], contractStart: row[2], contractEnd: row[3] };
        const arr = ordersByManNo.get(row[0]) ?? [];
        arr.push(rec);
        ordersByManNo.set(row[0], arr);
      }
    } catch {
      ordersByManNo = new Map();
    }

    // アーカイブ申請を取得（ユーザーOAuth）
    const archivedManNos = new Set<string>();
    try {
      const archiveRes = await userSheets.spreadsheets.values.get({
        spreadsheetId: LEDGER_SHEET_ID,
        range: "アーカイブ申請!A:E",
      });
      const archiveRows = (archiveRes.data.values ?? []) as string[][];
      for (const row of archiveRows.slice(1)) {
        if (row[0] && (row[4] ?? "pending") !== "rejected") {
          archivedManNos.add(row[0]);
        }
      }
    } catch {
      // アーカイブ申請シートが未作成の場合は無視
    }

    // gap-detector でステータスを確定 + activeMonths を付与
    const engineers = deduped.map(e => {
      const eng = toEngineer(e, ordersByManNo.get(e.manNo) ?? [], archivedManNos.has(e.manNo));
      const months = manNoActiveMonths.get(e.manNo);
      return {
        ...eng,
        activeMonths: months ? Array.from(months).sort() : [],
      };
    });

    return NextResponse.json({ engineers, loadedMonths });
  } catch (e: unknown) {
    console.error("[sheets API]", e);
    return NextResponse.json({ error: "稼働一覧の取得に失敗しました" }, { status: 500 });
  }
}
