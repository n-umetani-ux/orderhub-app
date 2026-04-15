/**
 * 月別の稼働一覧スプレッドシートID管理
 *
 * 毎月の稼働一覧は別々のスプレッドシートに作成される。
 * 常に「当月 + 翌月」の2つを同時に参照し、データを結合する。
 *
 * 例: 4月 → 4月シート + 5月シート を両方読む
 *     5月 → 5月シート + 6月シート を両方読む
 *
 * 新しい月のスプレッドシートが作られたら、ここにIDを1行追加する。
 */

const MONTHLY_SHEET_IDS: Record<string, string> = {
  // "YYYY-MM" → Google Sheets ID
  "2026-04": "1kXz9Q4Puk0sE3hwfgly4Ny7Zm_YNVv2LmiQjXIBVOSg",
  "2026-05": "17QxNSoW5XTB0F9i5yl55FfINQu9W_702ltF0guVwGw4",
};

// 稼働一覧のフォールバック（環境変数）
const DEFAULT_SHEET_ID = process.env.GOOGLE_SHEETS_ID ?? "";

// 注文書管理システム専用スプレッドシート（全営業メンバーがアクセス可能）
const ORDER_LEDGER_ID = process.env.ORDER_LEDGER_SHEET_ID ?? DEFAULT_SHEET_ID;

/**
 * 現在参照すべき稼働一覧スプレッドシートIDの一覧を返す
 * 当月 + 翌月の最大2つ（存在するもののみ）
 */
export function getActiveSheetIds(): { id: string; label: string; yearMonth: string }[] {
  const now = new Date();
  const year = now.getFullYear();
  const month = now.getMonth() + 1; // 1-based

  const currentKey = `${year}-${String(month).padStart(2, "0")}`;
  const nextMonth = month === 12 ? 1 : month + 1;
  const nextYear = month === 12 ? year + 1 : year;
  const nextKey = `${nextYear}-${String(nextMonth).padStart(2, "0")}`;

  const result: { id: string; label: string; yearMonth: string }[] = [];

  if (MONTHLY_SHEET_IDS[currentKey]) {
    result.push({ id: MONTHLY_SHEET_IDS[currentKey], label: `${month}月`, yearMonth: currentKey });
  } else if (DEFAULT_SHEET_ID) {
    result.push({ id: DEFAULT_SHEET_ID, label: `${month}月`, yearMonth: currentKey });
  }

  if (MONTHLY_SHEET_IDS[nextKey]) {
    result.push({ id: MONTHLY_SHEET_IDS[nextKey], label: `${nextMonth}月`, yearMonth: nextKey });
  }

  if (result.length === 0) {
    console.warn(`[monthly-sheets] 稼働一覧のシートIDが未設定です: ${currentKey}`);
  }

  return result;
}

/**
 * 注文書台帳・アーカイブ用のスプレッドシートID（固定）
 */
export function getOrderLedgerSheetId(): string {
  return ORDER_LEDGER_ID;
}
