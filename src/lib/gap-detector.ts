import { Engineer, EngineerStatus, SheetsEngineer } from "@/types";

export interface OrderRecord {
  manNo: string;
  contractStart: string; // YYYY-MM-DD
  contractEnd: string;   // YYYY-MM-DD
  uploadedAt?: string;   // ISO日時（登録日時）。dedup の世代判定キー。任意・後方互換
  customerCode?: string; // 顧客コード。dedup のグループキー（別顧客の並行稼働を別系列に）。任意・後方互換
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

/**
 * 同一manNo・同一顧客で「期間が重なる」注文書のうち最新行を正とし、それに隠れる古い行を除外する。
 * 短縮・差し替え時に古い広い行が残ってギャップを見逃すのを防ぐための前処理。
 *
 * - グループキー: manNo + customerCode。別顧客の並行稼働（半稼働0.5×2社など）は
 *   別系列として保持し、誤って dedup しない。
 * - 最新判定: 第1キー uploadedAt(ISO文字列)降順（空文字は最古扱い）、
 *   第2キー（tiebreaker）元配列インデックス降順（後方＝新しい）。
 * - 新しい順に貪欲採用し、既に採用した（より新しい）行と期間が重なる古い行のみ drop。
 * - 重ならない連続契約（例: 4-6月 + 7-9月）は両方保持する。
 * - 重なり判定式は既存と同形: aStart <= bEnd && bStart <= aEnd。
 *
 * カバレッジ/ギャップ計算専用の純粋関数。表示用リストには適用しないこと。
 * @returns 採用された行のみ。元の並び順を維持して返す。
 */
export function selectEffectiveOrders<T extends OrderRecord>(orders: T[]): T[] {
  // 元インデックスを保持（tiebreaker と最終的な並び順復元に使用）
  const indexed = orders.map((o, i) => ({ o, i }));

  // manNo + customerCode ごとにグループ化（customerCode 欠損は空文字で揃える）
  const groups = new Map<string, { o: T; i: number }[]>();
  for (const item of indexed) {
    const key = `${String(item.o.manNo)}|${item.o.customerCode ?? ""}`;
    const arr = groups.get(key) ?? [];
    arr.push(item);
    groups.set(key, arr);
  }

  const keptIndices = new Set<number>();

  for (const group of groups.values()) {
    // 新しい順にソート（uploadedAt 降順 → 同値/欠損は元index 降順）
    const sorted = [...group].sort((a, b) => {
      const ua = a.o.uploadedAt ?? "";
      const ub = b.o.uploadedAt ?? "";
      if (ua !== ub) {
        if (ua === "") return 1;  // a が古い → 後ろへ
        if (ub === "") return -1; // b が古い → a を前へ
        return ua < ub ? 1 : -1;  // ISO文字列の大きい（新しい）方を前へ
      }
      return b.i - a.i; // 後方インデックス（新しい）を前へ
    });

    const keptInGroup: T[] = [];
    for (const { o, i } of sorted) {
      const start = parseDate(o.contractStart);
      const end   = parseDate(o.contractEnd);
      const overlapsKept = keptInGroup.some(k => {
        const ks = parseDate(k.contractStart);
        const ke = parseDate(k.contractEnd);
        return start <= ke && ks <= end; // 期間が重なる
      });
      if (!overlapsKept) {
        keptInGroup.push(o);
        keptIndices.add(i);
      }
    }
  }

  // 元の並び順を維持して採用行のみ返す
  return indexed.filter(item => keptIndices.has(item.i)).map(item => item.o);
}
