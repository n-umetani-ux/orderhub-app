/**
 * 月次締めのギャップ再計算に使う注文書台帳・稼働キャッシュ・アーカイブ申請の読み取り（I/O）。
 *
 * 稼働一覧（月別スプレッドシート）の再パースは行わず、ダッシュボードが維持している
 * L2キャッシュ「稼働キャッシュ」タブのスナップショットを流用する（軽量・パース重複を避ける）。
 * いずれも読めない場合は空で縮退し、呼び出し側（status/execute）でハンドリングする。
 */
import { google } from "googleapis";
import { OrderRecord } from "@/lib/gap-detector";
import { ClosingEngineer } from "@/lib/closing";

const CACHE_SHEET = "稼働キャッシュ";

/**
 * 稼働キャッシュ（L2）から manNo / customerCode / activeMonths を読む（ギャップ集計用）。
 * 列順は api/sheets/route.ts の CACHE_HEADERS と一致:
 *   0:manNo 1:kubun 2:name 3:activity 4:ending 5:customer 6:tantou 7:customerCode 8:loc 9:activeMonths …
 */
export async function readEngineerCache(
  sheets: ReturnType<typeof google.sheets>,
  ledgerId: string,
): Promise<ClosingEngineer[]> {
  try {
    const res = await sheets.spreadsheets.values.get({ spreadsheetId: ledgerId, range: `${CACHE_SHEET}!A:L` });
    const rows = (res.data.values ?? []) as string[][];
    if (rows.length <= 1) return [];
    const result: ClosingEngineer[] = [];
    for (const row of rows.slice(1)) {
      const manNo = row[0]?.trim();
      if (!manNo) continue;
      let activeMonths: string[] = [];
      try { activeMonths = JSON.parse(row[9] ?? "[]") as string[]; } catch { activeMonths = []; }
      result.push({ manNo, customerCode: row[7] ?? "", activeMonths });
    }
    return result;
  } catch {
    return [];
  }
}

/** 注文書台帳を manNo 別の OrderRecord[] に読み込む（dedup の世代判定に uploadedAt を含む） */
export async function readOrdersByManNo(
  sheets: ReturnType<typeof google.sheets>,
  ledgerId: string,
): Promise<Record<string, OrderRecord[]>> {
  const map: Record<string, OrderRecord[]> = {};
  try {
    const res = await sheets.spreadsheets.values.get({ spreadsheetId: ledgerId, range: "注文書台帳!A:K" });
    const rows = (res.data.values ?? []) as string[][];
    for (const row of rows.slice(1)) {
      if (!row[0] || !row[2] || !row[3]) continue;
      const rec: OrderRecord = {
        manNo: row[0],
        contractStart: row[2],
        contractEnd: row[3],
        uploadedAt: row[10] ?? "",
        customerCode: row[7] ?? "",
      };
      (map[row[0]] ??= []).push(rec);
    }
  } catch {
    // 台帳が無ければ空
  }
  return map;
}

/** アーカイブ申請（rejected 以外）の manNo 集合（dashboard と同じく gap 集計から除外する） */
export async function readArchivedManNos(
  sheets: ReturnType<typeof google.sheets>,
  ledgerId: string,
): Promise<Set<string>> {
  const set = new Set<string>();
  try {
    const res = await sheets.spreadsheets.values.get({ spreadsheetId: ledgerId, range: "アーカイブ申請!A:E" });
    const rows = (res.data.values ?? []) as string[][];
    for (const row of rows.slice(1)) {
      if (row[0] && (row[4] ?? "pending") !== "rejected") set.add(row[0]);
    }
  } catch {
    // アーカイブ申請シートが無ければ空
  }
  return set;
}
