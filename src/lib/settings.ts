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
