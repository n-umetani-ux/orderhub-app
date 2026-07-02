/**
 * 設定シート（注文書台帳内の「設定」タブ・key/value）の読み取りユーティリティ
 *
 * /api/settings の readSettings と同じデータソース（ORDER_LEDGER_SHEET_ID の「設定」タブ）を
 * 他のAPI（例: /api/sheets の月別シートIDオーバーライド）からも再利用できるよう切り出したもの。
 */
import { google } from "googleapis";

const SPREADSHEET_ID = process.env.ORDER_LEDGER_SHEET_ID ?? process.env.GOOGLE_SHEETS_ID ?? "";
const SETTINGS_SHEET = "設定";

/** 月別シートID設定のキー接頭辞（例: sheet_2026-07） */
const SHEET_KEY_PREFIX = "sheet_";

/**
 * 設定シート（A:B の key/value）を読み取り Record<string,string> で返す。
 * 設定シート不在・読み取り失敗時は空オブジェクト {} を返す（throw しない＝フェイルオープン）。
 * 呼び出し側はこれにより「設定が読めない＝オーバーライド無し」として安全に縮退できる。
 */
export async function readSettingsMap(
  sheets: ReturnType<typeof google.sheets>,
): Promise<Record<string, string>> {
  try {
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
      range: `${SETTINGS_SHEET}!A:B`,
    });
    const rows = (res.data.values ?? []) as string[][];
    const settings: Record<string, string> = {};
    for (const row of rows.slice(1)) {
      if (row[0]) settings[row[0]] = row[1] ?? "";
    }
    return settings;
  } catch {
    // 設定シートが存在しない／権限がない等 → 空で縮退（呼び出し側がハードコードへフォールバック）
    return {};
  }
}

/**
 * readSettingsMap と同じ設定シート（A:B の key/value）を読むが、読み取り失敗時は
 * throw する（フェイルクローズ）。readSettingsMap の挙動は一切変更しない別関数。
 *
 * 「設定が読めない＝安全側で処理を止めたい」用途（締め状態の確認など）向け。
 * 呼び出し側は catch して 503 を返し、締め状態を確認できないまま登録を通さないこと。
 */
export async function readSettingsMapOrThrow(
  sheets: ReturnType<typeof google.sheets>,
): Promise<Record<string, string>> {
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: `${SETTINGS_SHEET}!A:B`,
  });
  const rows = (res.data.values ?? []) as string[][];
  const settings: Record<string, string> = {};
  for (const row of rows.slice(1)) {
    if (row[0]) settings[row[0]] = row[1] ?? "";
  }
  return settings;
}

/**
 * 設定シート（key/value）に1件を書き込む（既存キーは値を更新・無ければ追記）。
 * 設定シートが無ければ作成する。settings/route.ts の POST と同じ書き込み規則を共有化したもの。
 * サーバー側（例: closing/execute）からユーザーOAuthの sheets クライアントで呼ぶ。
 */
export async function appendOrUpdateSetting(
  sheets: ReturnType<typeof google.sheets>,
  spreadsheetId: string,
  key: string,
  value: string,
): Promise<void> {
  // 既存行を取得（シートが無い等で失敗したら空扱い）
  let rows: string[][] = [];
  try {
    const res = await sheets.spreadsheets.values.get({ spreadsheetId, range: `${SETTINGS_SHEET}!A:B` });
    rows = (res.data.values ?? []) as string[][];
  } catch {
    rows = [];
  }

  // 設定シートの存在確認・作成
  const meta = await sheets.spreadsheets.get({ spreadsheetId });
  const exists = meta.data.sheets?.some(s => s.properties?.title === SETTINGS_SHEET);
  if (!exists) {
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId,
      requestBody: { requests: [{ addSheet: { properties: { title: SETTINGS_SHEET } } }] },
    });
    await sheets.spreadsheets.values.update({
      spreadsheetId,
      range: `${SETTINGS_SHEET}!A1`,
      valueInputOption: "RAW",
      requestBody: { values: [["key", "value"]] },
    });
    rows = [["key", "value"]];
  }

  // 既存キーの行を探す（ヘッダー行はスキップ）
  let rowIdx = -1;
  for (let i = 1; i < rows.length; i++) {
    if (rows[i][0] === key) { rowIdx = i; break; }
  }

  if (rowIdx >= 0) {
    await sheets.spreadsheets.values.update({
      spreadsheetId,
      range: `${SETTINGS_SHEET}!B${rowIdx + 1}`,
      valueInputOption: "RAW",
      requestBody: { values: [[value]] },
    });
  } else {
    await sheets.spreadsheets.values.append({
      spreadsheetId,
      range: `${SETTINGS_SHEET}!A:B`,
      valueInputOption: "RAW",
      requestBody: { values: [[key, value]] },
    });
  }
}

/**
 * 設定マップから "sheet_" 接頭辞のキーだけを抽出し {"YYYY-MM": id} に正規化する純関数。
 * - "sheet_2026-08" → "2026-08"
 * - adminEmails 等の非sheetキーは除外
 * - 値が空文字（空白のみ含む）のキーは除外＝無効化（getActiveSheetIds でハードコードへフォールバックさせる）
 */
export function filterSheetKeys(settings: Record<string, string>): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(settings)) {
    if (!key.startsWith(SHEET_KEY_PREFIX)) continue;
    const trimmed = (value ?? "").trim();
    if (!trimmed) continue; // 空文字は無効化扱い → 除外
    const yearMonth = key.slice(SHEET_KEY_PREFIX.length);
    result[yearMonth] = trimmed;
  }
  return result;
}
