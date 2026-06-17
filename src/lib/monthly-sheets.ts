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
  "2026-07": "1gUyeepYyOF-a2ql87LXwwMv261w99iBgUlpr4pqkcoM",
};

// 稼働一覧のフォールバック（環境変数）
const DEFAULT_SHEET_ID = process.env.GOOGLE_SHEETS_ID ?? "";

// 注文書管理システム専用スプレッドシート（全営業メンバーがアクセス可能）
const ORDER_LEDGER_ID = process.env.ORDER_LEDGER_SHEET_ID ?? DEFAULT_SHEET_ID;

/** 管理開始月（これより前の月は参照しない） */
const MIN_MONTH = "2026-04";

/**
 * 現在参照すべき稼働一覧スプレッドシートIDの一覧を返す
 * MIN_MONTH から当月 + 翌月までの全月。各月のIDは以下の3段で解決する:
 *   1. overrides[月]（設定シート由来。最優先）
 *   2. MONTHLY_SHEET_IDS[月]（ハードコード）
 *   3. DEFAULT_SHEET_ID（env GOOGLE_SHEETS_ID。当月のみ）
 *
 * overrides を省略すると 2→3 のみ（=従来の挙動と完全一致／後方互換）。
 * 純関数（関数内でI/Oはしない）。overrides は呼び出し側が設定シートから読んで渡す。
 */
export function getActiveSheetIds(overrides?: Record<string, string>): { id: string; label: string; yearMonth: string }[] {
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

    // 3段マージ: overrides → ハードコード → env(当月のみ)
    // ※ overrides[cursor] が空文字の場合は falsy なのでハードコードへフォールバックする
    //    （UI側で月を「無効化」する際は空文字を保存する想定。filterSheetKeys で除外済みだが二重に安全）
    if (overrides?.[cursor]) {
      result.push({ id: overrides[cursor], label, yearMonth: cursor });
    } else if (MONTHLY_SHEET_IDS[cursor]) {
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
