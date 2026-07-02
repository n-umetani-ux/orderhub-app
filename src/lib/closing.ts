/**
 * 電帳法 月次締めのドメインロジック（純関数・テスト可能・I/Oなし）
 *
 * 締め状態は設定シート（key/value）に保存する:
 *   キー: closing_status:{YYYY-MM}（例 closing_status:2026-04）
 *   値:   done:{ISO日時}:{実行者email}（例 done:2026-06-22T10:00:00.000Z:ume@beat-tech.co.jp）
 *
 * gapCount の算出は gap-detector.selectEffectiveOrders を流用（改変しない）。
 */
import { selectEffectiveOrders, OrderRecord } from "@/lib/gap-detector";

/** 月次締めの管理開始月（dashboard / monthly-sheets の MIN_MONTH と揃える） */
export const CLOSING_MIN_MONTH = "2026-04";

/** 締め状態の設定キー接頭辞 */
export const CLOSING_KEY_PREFIX = "closing_status:";

/** ギャップ集計に必要なエンジニア情報（稼働キャッシュ由来） */
export interface ClosingEngineer {
  manNo: string;
  customerCode?: string;
  /** 稼働一覧に登場した月（YYYY-MM）。空配列は「全月稼働」とみなす（dashboard と同一） */
  activeMonths: string[];
}

/** 締め済み情報（設定値をパースした結果） */
export interface ClosedInfo {
  closedAt: string;
  closedBy: string;
}

/** YYYY-MM 形式（月は01-12）かを判定する純関数 */
export function isValidMonthKey(s: string): boolean {
  const m = /^(\d{4})-(\d{2})$/.exec(s ?? "");
  if (!m) return false;
  const mo = parseInt(m[2], 10);
  return mo >= 1 && mo <= 12;
}

/** 締め状態の設定キー（closing_status:YYYY-MM） */
export function closingStatusKey(month: string): string {
  return `${CLOSING_KEY_PREFIX}${month}`;
}

/** JST の当月キー（YYYY-MM） */
export function getCurrentMonthKeyJST(now: Date = new Date()): string {
  const fmt = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Tokyo", year: "numeric", month: "2-digit" });
  const parts = fmt.formatToParts(now);
  const y = parts.find(p => p.type === "year")?.value ?? "";
  const mo = parts.find(p => p.type === "month")?.value ?? "";
  return `${y}-${mo}`;
}

/** CLOSING_MIN_MONTH から currentMonth まで（両端含む）の YYYY-MM 配列を昇順で返す */
export function getClosingMonths(currentMonth: string): string[] {
  const result: string[] = [];
  let cursor = CLOSING_MIN_MONTH;
  let guard = 0; // 無限ループ防止（最大10年）
  while (cursor <= currentMonth && guard < 120) {
    result.push(cursor);
    const [y, m] = cursor.split("-").map(Number);
    const next = new Date(y, m, 1); // m は1始まり → Date(0始まり)の引数として翌月
    cursor = `${next.getFullYear()}-${String(next.getMonth() + 1).padStart(2, "0")}`;
    guard++;
  }
  return result;
}

/** 注文書が指定月（YYYY-MM）をカバーしているか（dashboard の orderCoversMonth と同一ロジック） */
export function orderCoversMonth(order: OrderRecord, ym: string): boolean {
  if (!order.contractStart || !order.contractEnd) return false;
  const [y, m] = ym.split("-").map(Number);
  const monthStart = new Date(y, m - 1, 1);
  const monthEnd = new Date(y, m, 0); // 月末日
  const contractStart = new Date(order.contractStart);
  const contractEnd = new Date(order.contractEnd);
  return contractStart <= monthEnd && contractEnd >= monthStart;
}

/**
 * 月ごとのギャップ件数を算出する純関数。
 * dashboard の当月ギャップ集計（counts.gap）と同じ定義を全対象月へ一般化したもの:
 *   その月に稼働対象（activeMonths が空 or 当月を含む）かつ、
 *   有効な注文書（selectEffectiveOrders 後）がその月をカバーしない エンジニアを数える。
 * アーカイブ済み（申請）の manNo は除外する。
 * 注文書の dedup は gap-detector.selectEffectiveOrders を流用（改変なし）。
 *
 * ※ dashboard の手動オーバーライド（/api/overrides）は集計に含めない
 *   （サマリーカードの counts.gap と同様。締め判定は実データ基準）。
 */
export function computeMonthlyGapCounts(
  engineers: ClosingEngineer[],
  ordersByManNo: Record<string, OrderRecord[]>,
  months: string[],
  archivedManNos: Set<string> = new Set(),
): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const m of months) counts[m] = 0;

  for (const eng of engineers) {
    if (archivedManNos.has(eng.manNo)) continue;
    const effective = selectEffectiveOrders(ordersByManNo[eng.manNo] ?? []);
    for (const m of months) {
      const activeThisMonth = eng.activeMonths.length === 0 || eng.activeMonths.includes(m);
      if (!activeThisMonth) continue;
      const covered = effective.some(o => orderCoversMonth(o, m));
      if (!covered) counts[m] += 1;
    }
  }
  return counts;
}

/**
 * 設定値 "done:{ISO}:{email}" をパースする。
 * ISO日時はコロンを含む（例 2026-06-22T10:00:00.000Z）ため、末尾セグメントを email、
 * 中間を closedAt として復元する（email にコロンは含まれない前提）。
 */
export function parseClosingStatusValue(value: string): ClosedInfo | null {
  const v = (value ?? "").trim();
  if (!v) return null;
  const parts = v.split(":");
  if (parts[0] !== "done" || parts.length < 3) return null;
  const closedBy = parts[parts.length - 1];
  const closedAt = parts.slice(1, -1).join(":");
  if (!closedAt || !closedBy) return null;
  return { closedAt, closedBy };
}

/** 締め状態の設定値 "done:{ISO}:{email}" を生成する */
export function buildClosingStatusValue(closedAt: string, closedBy: string): string {
  return `done:${closedAt}:${closedBy}`;
}

/**
 * contractStart（"YYYY-MM-DD" 等の日付文字列）から対象月キー "YYYY-MM" を取り出す。
 * 締め判定はこの月キー単位で行う（サーバー側シャットアウトの共通ロジック）。
 * 欠落・形式不正（先頭7文字が YYYY-MM でない）なら null を返す
 * → 呼び出し側は 400 で拒否する。
 */
export function contractMonthKey(contractStart: string | null | undefined): string | null {
  const month = (contractStart ?? "").trim().slice(0, 7);
  return isValidMonthKey(month) ? month : null;
}

/**
 * 設定マップ上で指定月（YYYY-MM）が締め済みかを判定する。
 * 判定は parseClosingStatusValue を流用し、締め済み判定ロジックを新設・重複させない。
 */
export function isMonthClosed(settings: Record<string, string>, month: string): boolean {
  return parseClosingStatusValue(settings[closingStatusKey(month)] ?? "") !== null;
}
