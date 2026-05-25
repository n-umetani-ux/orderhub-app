/**
 * 月別の稼働一覧スプレッドシートID管理
 *
 * 毎月の稼働一覧は別々のスプレッドシートに作成される。
 * MIN_MONTH(管理開始月) から「当月 + 翌月」までの全月を同時に参照する。
 *
 * 例: 現在が2026-05 → ["2026-04", "2026-05", "2026-06"] を読む
 *     現在が2026-08 → ["2026-04"〜"2026-09"] を読む
 *
 * 新しい月のスプレッドシートが作られたら、ここにIDを1行追加する。
 */

const MONTHLY_SHEET_IDS: Record<string, string> = {
  // "YYYY-MM" → Google Sheets ID
  "2026-04": "1kXz9Q4Puk0sE3hwfgly4Ny7Zm_YNVv2LmiQjXIBVOSg",
  "2026-05": "17QxNSoW5XTB0F9i5yl55FfINQu9W_702ltF0guVwGw4",
  "2026-06": "1MM6JJhyO7ZQ08sckbDGEImc1tiuv98E7BdEoE40W3W0",
};

// 稼働一覧のフォールバック（環境変数）
const DEFAULT_SHEET_ID = process.env.GOOGLE_SHEETS_ID ?? "";

// 注文書管理システム専用スプレッドシート（全営業メンバーがアクセス可能）
const ORDER_LEDGER_ID = process.env.ORDER_LEDGER_SHEET_ID ?? DEFAULT_SHEET_ID;

/** 管理開始月（これより前の月は参照しない） */
const MIN_MONTH = "2026-04";

/**
 * 現在参照すべき稼働一覧スプレッドシートIDの一覧を返す
 * MIN_MONTH から当月 + 翌月までの全月（MONTHLY_SHEET_IDS に登録済みのもののみ）
 */
export function getActiveSheetIds(): { id: string; label: string; yearMonth: string }[] {
  // JST で当月キーを取得
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "2-digit",
  });
  const parts = fmt.formatToParts(new Date());
  const y = parts.find(p => p.type === "year")?.value ?? "";
  const mo = parts.find(p => p.type === "month")?.value ?? "";
  const currentKey = `${y}-${mo}`;

  // 翌月キー（parseInt(mo) は 1-based なので Date の 0-based month 引数として使うと +1 になる）
  const nextDate = new Date(parseInt(y), parseInt(mo), 1);
  const nextKey = `${nextDate.getFullYear()}-${String(nextDate.getMonth() + 1).padStart(2, "0")}`;

  const result: { id: string; label: string; yearMonth: string }[] = [];

  // MIN_MONTH から翌月まですべての月を走査
  let cursor = MIN_MONTH;
  while (cursor <= nextKey) {
    const [cy, cm] = cursor.split("-").map(Number);
    const label = `${cm}月`;

    if (MONTHLY_SHEET_IDS[cursor]) {
      result.push({ id: MONTHLY_SHEET_IDS[cursor], label, yearMonth: cursor });
    } else if (cursor === currentKey && DEFAULT_SHEET_ID) {
      // 当月のみ環境変数フォールバック
      result.push({ id: DEFAULT_SHEET_ID, label, yearMonth: cursor });
    }

    // 翌月へ進む
    const next = new Date(cy, cm, 1);
    cursor = `${next.getFullYear()}-${String(next.getMonth() + 1).padStart(2, "0")}`;
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
