/**
 * 月別の稼働一覧スプレッドシートID管理
 *
 * 毎月の稼働一覧は別々のスプレッドシートに作成されるため、
 * 年月 → スプレッドシートID のマッピングを管理する。
 *
 * 新しい月のスプレッドシートが作られたら、ここに追加する。
 */

const MONTHLY_SHEET_IDS: Record<string, string> = {
  // "YYYY-MM" → Google Sheets ID
  "2026-04": "1kXz9Q4Puk0sE3hwfgly4Ny7Zm_YNVv2LmiQjXIBVOSg",
  "2026-05": "17QxNSoW5XTB0F9i5yl55FfINQu9W_702ltF0guVwGw4",
};

// デフォルト（MONTHLY_SHEET_IDSにない月の場合のフォールバック）
const DEFAULT_SHEET_ID = process.env.GOOGLE_SHEETS_ID ?? "";

/**
 * 現在の年月に対応する稼働一覧のスプレッドシートIDを返す
 */
export function getCurrentMonthSheetId(): string {
  const now = new Date();
  const key = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
  return MONTHLY_SHEET_IDS[key] ?? DEFAULT_SHEET_ID;
}

/**
 * 指定年月に対応する稼働一覧のスプレッドシートIDを返す
 */
export function getSheetIdForMonth(year: number, month: number): string {
  const key = `${year}-${String(month).padStart(2, "0")}`;
  return MONTHLY_SHEET_IDS[key] ?? DEFAULT_SHEET_ID;
}

/**
 * 注文書台帳・アーカイブ用のスプレッドシートID（固定）
 */
export function getOrderLedgerSheetId(): string {
  return DEFAULT_SHEET_ID;
}
