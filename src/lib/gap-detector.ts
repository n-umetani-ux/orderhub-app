import { Engineer, EngineerStatus, SheetsEngineer } from "@/types";

export interface OrderRecord {
  manNo: string;
  contractStart: string; // YYYY-MM-DD
  contractEnd: string;   // YYYY-MM-DD
}

const GAP_WARN_DAYS = 14;

function today(): Date {
  return new Date();
}

function parseDate(s: string): Date {
  return new Date(s);
}

function daysDiff(a: Date, b: Date): number {
  return Math.ceil((b.getTime() - a.getTime()) / 86400000);
}

/**
 * 稼働一覧[A] × 注文書台帳[B] のギャップ検知
 */
export function detectStatus(
  eng: SheetsEngineer,
  orders: OrderRecord[],
  isArchived = false,
): EngineerStatus {
  // アーカイブ済みは最優先
  if (isArchived) return "archived";

  // 当月終了フラグ（E列=1.0）は注文書有無に関わらず優先
  if (eng.ending >= 1.0) return "ending";

  const now = today();

  // 当月有効な注文書を抽出
  const validOrders = orders.filter(o => {
    const start = parseDate(o.contractStart);
    const end   = parseDate(o.contractEnd);
    return start <= now && now <= end;
  });

  if (validOrders.length === 0) {
    return "gap"; // ギャップ発生
  }

  // 最も遅い終了日
  const latestEnd = validOrders.reduce((max, o) => {
    const d = parseDate(o.contractEnd);
    return d > max ? d : max;
  }, parseDate(validOrders[0].contractEnd));

  const daysLeft = daysDiff(now, latestEnd);

  // 期限迫る
  if (daysLeft <= GAP_WARN_DAYS) return "expiring";

  return "normal";
}

/**
 * SheetsEngineer + 注文書一覧 → Engineer（フロント表示用）
 */
export function toEngineer(
  eng: SheetsEngineer,
  orders: OrderRecord[],
  isArchived = false,
): Engineer {
  const status = detectStatus(eng, orders, isArchived);

  // 最新の有効注文書を選ぶ
  const latest = orders
    .filter(o => parseDate(o.contractEnd) >= today())
    .sort((a, b) => parseDate(b.contractEnd).getTime() - parseDate(a.contractEnd).getTime())[0];

  const contract = latest
    ? `${latest.contractStart}|${latest.contractEnd}`
    : "";

  return {
    manNo:    parseInt(eng.manNo),
    name:     eng.name,
    type:     eng.kubun as Engineer["type"],
    customer: eng.customer,
    code:     eng.customerCode,
    tantou:   eng.tantou,
    loc:      eng.loc,
    ending:   eng.ending >= 1.0 ? 1 : 0,
    contract,
    status,
  };
}
