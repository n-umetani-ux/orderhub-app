import { google } from "googleapis";
import { SheetsEngineer } from "@/types";

const SPREADSHEET_ID = process.env.GOOGLE_SHEETS_ID!;

// セクション名マーカー（稼働一覧）
const SECTION_MARKERS = [
  "待機一覧",
  "正社員エンジニア一覧",
  "個人事業主エンジニア一覧",
  "パートナーエンジニア一覧",
  "ENGチーム",
  "ENG_BP",
];
const STANDBY_SECTION = "待機一覧";
// 対象外セクション（ダッシュボードから除外）
const EXCLUDED_SECTIONS = ["ENGチーム", "ENG_BP"];
const HEADER_PATTERNS = ["manNo.", "No.", "PJcode"];

type Loc = "東京" | "大阪" | "福岡";

const SHEET_LOCS: Record<string, Loc> = {
  "稼働表（東京）": "東京",
  "稼働表（大阪）": "大阪",
  "稼働表（福岡）": "福岡",
};

function getAuthClient() {
  const credentials = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON!);
  const auth = new google.auth.GoogleAuth({
    credentials,
    scopes: ["https://www.googleapis.com/auth/spreadsheets.readonly"],
  });
  return auth;
}

// AE列のインデックス = 30 (0-based)
const COL = { manNo: 0, kubun: 1, name: 2, activity: 3, ending: 4, customer: 5, tantou: 6, customerCode: 30 };

// 機密列: I(8), J-W(9-22), O(14), X(23) → API層で除外（返さない）
export const SENSITIVE_COLS = new Set([8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23]);

export function parseRows(rows: string[][], loc: Loc): SheetsEngineer[] {
  const result: SheetsEngineer[] = [];
  let inStandby = false;
  let inExcluded = false;
  let headerRowIdx = -1;

  for (let i = 0; i < rows.length; i++) {
    const rowA = rows[i][0]?.trim() ?? "";

    // セクション検出
    if (SECTION_MARKERS.some(m => rowA.includes(m))) {
      inStandby = rowA.includes(STANDBY_SECTION);
      inExcluded = EXCLUDED_SECTIONS.some(s => rowA.includes(s));
      headerRowIdx = -1;
      continue;
    }

    // ヘッダー行検出
    if (HEADER_PATTERNS.some(p => rowA.includes(p))) {
      headerRowIdx = i;
      continue;
    }

    // 待機一覧・対象外セクションは除外
    if (inStandby || inExcluded) continue;

    // ヘッダー未検出はスキップ
    if (headerRowIdx === -1) continue;

    const manNoRaw = rows[i][COL.manNo]?.trim();
    if (!manNoRaw || !/^\d{6}$/.test(manNoRaw)) continue;

    const activity = parseFloat(rows[i][COL.activity] ?? "0") || 0;
    if (activity < 0.5) continue; // 稼働0.5未満は除外

    result.push({
      manNo:        manNoRaw,
      kubun:        rows[i][COL.kubun]?.trim() ?? "",
      name:         rows[i][COL.name]?.trim() ?? "",
      activity,
      ending:       parseFloat(rows[i][COL.ending] ?? "0") || 0,
      customer:     rows[i][COL.customer]?.trim() ?? "",
      tantou:       rows[i][COL.tantou]?.trim() ?? "",
      customerCode: rows[i][COL.customerCode]?.trim() ?? "",
      loc,
    });
  }

  return result;
}

export async function fetchActiveEngineers(): Promise<SheetsEngineer[]> {
  const authClient = getAuthClient();
  const sheets = google.sheets({ version: "v4", auth: authClient });

  // 全シート情報を取得
  const meta = await sheets.spreadsheets.get({ spreadsheetId: SPREADSHEET_ID });
  const sheetNames = meta.data.sheets?.map(s => s.properties?.title ?? "") ?? [];

  const targetSheets = sheetNames.filter(n => Object.keys(SHEET_LOCS).includes(n));

  const all: SheetsEngineer[] = [];

  for (const sheetName of targetSheets) {
    const loc = SHEET_LOCS[sheetName];
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
      range: `${sheetName}!A:AE`,
    });

    const rows = (res.data.values ?? []) as string[][];
    // 機密列を除去してからパース（A:AE内の除外）
    const sanitized = rows.map(row =>
      row.map((cell, idx) => (SENSITIVE_COLS.has(idx) ? "" : cell))
    );
    all.push(...parseRows(sanitized, loc));
  }

  return all;
}
