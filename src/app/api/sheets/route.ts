import { NextRequest, NextResponse } from "next/server";
import { google } from "googleapis";
import { toEngineer, OrderRecord } from "@/lib/gap-detector";
import { getActiveSheetIds, getOrderLedgerSheetId } from "@/lib/monthly-sheets";

const LEDGER_SHEET_ID = getOrderLedgerSheetId();

const SECTION_MARKERS = ["待機一覧", "正社員エンジニア一覧", "個人事業主エンジニア一覧", "パートナーエンジニア一覧", "ENGチーム", "ENG_BP"];
const STANDBY_SECTION = "待機一覧";
const HEADER_PATTERNS = ["manNo.", "No.", "PJcode"];

/* ────────────────────────────────────────────
   サーバーサイドキャッシュ（globalThis）
   管理者（稼働一覧にアクセス可能なユーザー）がダッシュボードを
   読み込んだ際にキャッシュし、一般ユーザーはキャッシュを参照する。
   ──────────────────────────────────────────── */
const CACHE_TTL_MS = 72 * 60 * 60 * 1000; // 72時間（管理者アクセスで随時更新）

interface ServerCache {
  /** parseRows 済みのエンジニアデータ（機密列除外済み） */
  engineers: ParsedEngineer[];
  /** manNo → 稼働月のセット */
  activeMonths: Map<string, Set<string>>;
  /** 読み込み済み月ラベル */
  loadedMonths: string[];
  /** キャッシュ作成時刻 */
  cachedAt: number;
}

// globalThis にキャッシュを保持（Vercel serverless でもコールドスタートまで維持）
const g = globalThis as unknown as { __kadouCache?: ServerCache };

function getServerCache(): ServerCache | null {
  const c = g.__kadouCache;
  if (!c) return null;
  if (Date.now() - c.cachedAt > CACHE_TTL_MS) {
    g.__kadouCache = undefined;
    return null;
  }
  return c;
}

function setServerCache(data: Omit<ServerCache, "cachedAt">) {
  g.__kadouCache = { ...data, cachedAt: Date.now() };
}

type Loc = "東京" | "大阪" | "福岡";

interface ParsedEngineer {
  manNo: string;
  kubun: string;
  name: string;
  activity: number;
  ending: number;
  customer: string;
  tantou: string;
  customerCode: string;
  loc: Loc;
}

const SHEET_LOCS: Record<string, Loc> = {
  "稼働表（東京）": "東京",
  "稼働表（大阪）": "大阪",
  "稼働表（福岡）": "福岡",
};

// 機密列（I,J-W,X = 8,9-22,23）
const SENSITIVE_COLS = new Set([8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23]);
const COL = { manNo: 0, kubun: 1, name: 2, activity: 3, ending: 4, customer: 5, tantou: 6, customerCode: 30 };

function parseRows(rows: string[][], loc: Loc) {
  const result = [];
  let inStandby = false;
  let headerFound = false;

  for (const row of rows) {
    const rowA = row[0]?.trim() ?? "";

    if (SECTION_MARKERS.some(m => rowA.includes(m))) {
      inStandby = rowA.includes(STANDBY_SECTION);
      headerFound = false;
      continue;
    }
    if (HEADER_PATTERNS.some(p => rowA.includes(p))) {
      headerFound = true;
      continue;
    }
    if (inStandby || !headerFound) continue;

    const manNo = row[COL.manNo]?.trim();
    if (!manNo || !/^\d{6}$/.test(manNo)) continue;

    const activity = parseFloat(row[COL.activity] ?? "0") || 0;
    if (activity < 0.5) continue;

    // 担当者名の正規化（「全」「全員」等のバリエーション対応）
    let tantou = row[COL.tantou]?.trim() ?? "";
    if (tantou === "全" || tantou === "全員" || tantou === "全社") {
      tantou = "全員";
    }

    result.push({
      manNo,
      kubun:        row[COL.kubun]?.trim() ?? "",
      name:         row[COL.name]?.trim() ?? "",
      activity,
      ending:       parseFloat(row[COL.ending] ?? "0") || 0,
      customer:     row[COL.customer]?.trim() ?? "",
      tantou,
      customerCode: row[COL.customerCode]?.trim() ?? "",
      loc,
    });
  }
  return result;
}

export async function GET(req: NextRequest) {
  const accessToken = req.headers.get("x-google-access-token");
  if (!accessToken) {
    return NextResponse.json({ error: "アクセストークンがありません" }, { status: 401 });
  }

  try {
    const oauth2 = new google.auth.OAuth2();
    oauth2.setCredentials({ access_token: accessToken });
    const sheets = google.sheets({ version: "v4", auth: oauth2 });

    /* ──────────────────────────────────────────
       Step 1: 稼働一覧の取得（キャッシュ付き）
       - 読み取り成功 → 管理者/幹部 → キャッシュ更新
       - 読み取り失敗 → 一般ユーザー → キャッシュから返す
       ────────────────────────────────────────── */
    let deduped: ParsedEngineer[];
    let manNoActiveMonths: Map<string, Set<string>>;
    let loadedMonths: string[];
    let fromCache = false;

    try {
      // 稼働一覧スプレッドシートを読み込み
      const activeSheets = getActiveSheetIds();
      console.log("[sheets API] 参照スプレッドシート:", activeSheets.map(s => s.label));
      const tempLoadedMonths: string[] = [];
      const tempActiveMonths = new Map<string, Set<string>>();
      const raw: ParsedEngineer[] = [];

      for (const { id: spreadsheetId, label, yearMonth } of activeSheets) {
        try {
          const meta = await sheets.spreadsheets.get({ spreadsheetId });
          const sheetNames = meta.data.sheets?.map(s => s.properties?.title ?? "") ?? [];
          const targetSheets = sheetNames.filter(n => n in SHEET_LOCS);

          for (const sheetName of targetSheets) {
            const loc = SHEET_LOCS[sheetName];
            const res = await sheets.spreadsheets.values.get({
              spreadsheetId,
              range: `${sheetName}!A:AE`,
            });
            const rows = (res.data.values ?? []) as string[][];
            const sanitized = rows.map(row =>
              row.map((cell, idx) => (SENSITIVE_COLS.has(idx) ? "" : cell))
            );
            const parsed = parseRows(sanitized, loc);
            for (const eng of parsed) {
              if (!tempActiveMonths.has(eng.manNo)) tempActiveMonths.set(eng.manNo, new Set());
              tempActiveMonths.get(eng.manNo)!.add(yearMonth);
            }
            raw.push(...parsed);
          }
          tempLoadedMonths.push(yearMonth);
          console.log(`[sheets API] ${label}シート読み込み完了`);
        } catch (err) {
          console.warn(`[sheets API] ${label}シート読み込み失敗（未作成の可能性）:`, err);
        }
      }

      // manNo で重複除去（同じ番号が複数シートに存在する場合、後のシート=翌月を優先）
      const engineerMap = new Map<string, ParsedEngineer>();
      for (const e of raw) {
        engineerMap.set(e.manNo, e);
      }

      // 全シート読み込み失敗の場合（権限不足）→ キャッシュにフォールバック
      if (engineerMap.size === 0 && tempLoadedMonths.length === 0) {
        throw new Error("稼働一覧の全シート読み込み失敗");
      }

      deduped = Array.from(engineerMap.values());
      manNoActiveMonths = tempActiveMonths;
      loadedMonths = tempLoadedMonths;

      // ✅ 読み込み成功 → キャッシュ更新
      setServerCache({ engineers: deduped, activeMonths: tempActiveMonths, loadedMonths: tempLoadedMonths });
      console.log(`[sheets API] サーバーキャッシュ更新: ${deduped.length}名`);

    } catch (sheetErr) {
      // 稼働一覧へのアクセス権がないユーザー → キャッシュを使う
      console.warn("[sheets API] 稼働一覧の読み込み失敗（権限不足）、キャッシュを確認:", sheetErr);
      const cached = getServerCache();
      if (!cached) {
        return NextResponse.json(
          { error: "稼働データのキャッシュがありません。管理者が先にダッシュボードを開いてください。", needAdminLoad: true },
          { status: 503 },
        );
      }
      deduped = cached.engineers;
      manNoActiveMonths = cached.activeMonths;
      loadedMonths = cached.loadedMonths;
      fromCache = true;
      const ageMin = Math.round((Date.now() - cached.cachedAt) / 60000);
      console.log(`[sheets API] キャッシュ使用: ${deduped.length}名（${ageMin}分前のデータ）`);
    }

    /* ──────────────────────────────────────────
       Step 2: 注文書台帳・アーカイブ（ユーザーOAuth）
       ────────────────────────────────────────── */
    let ordersByManNo = new Map<string, OrderRecord[]>();
    try {
      const ordersRes = await sheets.spreadsheets.values.get({
        spreadsheetId: LEDGER_SHEET_ID,
        range: "注文書台帳!A:D",
      });
      const ordersRows = (ordersRes.data.values ?? []) as string[][];
      for (const row of ordersRows.slice(1)) {
        if (!row[0] || !row[2] || !row[3]) continue;
        const rec: OrderRecord = { manNo: row[0], contractStart: row[2], contractEnd: row[3] };
        const arr = ordersByManNo.get(row[0]) ?? [];
        arr.push(rec);
        ordersByManNo.set(row[0], arr);
      }
    } catch {
      ordersByManNo = new Map();
    }

    // アーカイブ申請を取得（ユーザーOAuth）
    const archivedManNos = new Set<string>();
    try {
      const archiveRes = await sheets.spreadsheets.values.get({
        spreadsheetId: LEDGER_SHEET_ID,
        range: "アーカイブ申請!A:E",
      });
      const archiveRows = (archiveRes.data.values ?? []) as string[][];
      for (const row of archiveRows.slice(1)) {
        if (row[0] && (row[4] ?? "pending") !== "rejected") {
          archivedManNos.add(row[0]);
        }
      }
    } catch {
      // アーカイブ申請シートが未作成の場合は無視
    }

    /* ──────────────────────────────────────────
       Step 3: gap-detector でステータスを確定
       ────────────────────────────────────────── */
    const engineers = deduped.map(e => {
      const eng = toEngineer(e, ordersByManNo.get(e.manNo) ?? [], archivedManNos.has(e.manNo));
      const months = manNoActiveMonths.get(e.manNo);
      return {
        ...eng,
        activeMonths: months ? Array.from(months).sort() : [],
      };
    });

    return NextResponse.json({ engineers, loadedMonths, fromCache });
  } catch (e: unknown) {
    console.error("[sheets API]", e);
    return NextResponse.json({ error: "稼働一覧の取得に失敗しました" }, { status: 500 });
  }
}
