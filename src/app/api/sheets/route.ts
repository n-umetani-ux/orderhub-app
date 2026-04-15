import { NextRequest, NextResponse } from "next/server";
import { google } from "googleapis";
import { toEngineer, OrderRecord } from "@/lib/gap-detector";
import { getActiveSheetIds, getOrderLedgerSheetId } from "@/lib/monthly-sheets";

const LEDGER_SHEET_ID = getOrderLedgerSheetId();

const SECTION_MARKERS = ["待機一覧", "正社員エンジニア一覧", "個人事業主エンジニア一覧", "パートナーエンジニア一覧", "ENGチーム", "ENG_BP"];
const STANDBY_SECTION = "待機一覧";
const HEADER_PATTERNS = ["manNo.", "No.", "PJcode"];

/* ────────────────────────────────────────────
   サーバーサイドキャッシュ（2層構造）
   L1: globalThis メモリ（同一Vercelインスタンス内で高速）
   L2: Google Sheets「稼働キャッシュ」シート（インスタンス間で永続共有）

   管理者がダッシュボードを開く → L1 + L2 を更新
   一般ユーザー → L1 → L2 → 503 の順にフォールバック
   ──────────────────────────────────────────── */
const CACHE_TTL_MS = 72 * 60 * 60 * 1000; // 72時間
const CACHE_SHEET = "稼働キャッシュ";
const CACHE_HEADERS = ["manNo", "kubun", "name", "activity", "ending", "customer", "tantou", "customerCode", "loc", "activeMonths", "cachedAt", "loadedMonths"];

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

interface ServerCache {
  engineers: ParsedEngineer[];
  activeMonths: Map<string, Set<string>>;
  loadedMonths: string[];
  cachedAt: number;
}

// L1: globalThis メモリキャッシュ
const g = globalThis as unknown as { __kadouCache?: ServerCache };

function getL1Cache(): ServerCache | null {
  const c = g.__kadouCache;
  if (!c) return null;
  if (Date.now() - c.cachedAt > CACHE_TTL_MS) {
    g.__kadouCache = undefined;
    return null;
  }
  return c;
}

function setL1Cache(data: Omit<ServerCache, "cachedAt">) {
  g.__kadouCache = { ...data, cachedAt: Date.now() };
}

// L2: Google Sheets 永続キャッシュ（書き込み）
async function writeL2Cache(
  sheets: ReturnType<typeof google.sheets>,
  engineers: ParsedEngineer[],
  activeMonths: Map<string, Set<string>>,
  loadedMonths: string[],
) {
  try {
    // シートの存在確認・作成
    const meta = await sheets.spreadsheets.get({ spreadsheetId: LEDGER_SHEET_ID });
    const exists = meta.data.sheets?.some(s => s.properties?.title === CACHE_SHEET);
    if (!exists) {
      await sheets.spreadsheets.batchUpdate({
        spreadsheetId: LEDGER_SHEET_ID,
        requestBody: { requests: [{ addSheet: { properties: { title: CACHE_SHEET } } }] },
      });
    }

    const now = new Date().toISOString();
    const lm = JSON.stringify(loadedMonths);
    const rows = engineers.map(e => [
      e.manNo, e.kubun, e.name, String(e.activity), String(e.ending),
      e.customer, e.tantou, e.customerCode, e.loc,
      JSON.stringify(Array.from(activeMonths.get(e.manNo) ?? [])),
      now, lm,
    ]);

    // ヘッダー + データを一括書き込み（既存データをクリアして上書き）
    await sheets.spreadsheets.values.update({
      spreadsheetId: LEDGER_SHEET_ID,
      range: `${CACHE_SHEET}!A1`,
      valueInputOption: "RAW",
      requestBody: { values: [CACHE_HEADERS, ...rows] },
    });

    // 余剰行をクリア（前回より行数が少ない場合）
    const clearStart = rows.length + 2; // ヘッダー(1) + データ(rows.length) + 1
    await sheets.spreadsheets.values.clear({
      spreadsheetId: LEDGER_SHEET_ID,
      range: `${CACHE_SHEET}!A${clearStart}:L10000`,
    });

    console.log(`[sheets API] L2キャッシュ書き込み完了: ${engineers.length}名`);
  } catch (err) {
    console.warn("[sheets API] L2キャッシュ書き込み失敗:", err);
  }
}

// L2: Google Sheets 永続キャッシュ（読み込み）
async function readL2Cache(
  sheets: ReturnType<typeof google.sheets>,
): Promise<ServerCache | null> {
  try {
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId: LEDGER_SHEET_ID,
      range: `${CACHE_SHEET}!A:L`,
    });
    const rows = (res.data.values ?? []) as string[][];
    if (rows.length <= 1) return null; // ヘッダーのみ

    const engineers: ParsedEngineer[] = [];
    const activeMonths = new Map<string, Set<string>>();
    let cachedAtStr = "";
    let loadedMonths: string[] = [];

    for (const row of rows.slice(1)) {
      if (!row[0]) continue;
      const eng: ParsedEngineer = {
        manNo: row[0],
        kubun: row[1] ?? "",
        name: row[2] ?? "",
        activity: parseFloat(row[3] ?? "0") || 0,
        ending: parseFloat(row[4] ?? "0") || 0,
        customer: row[5] ?? "",
        tantou: row[6] ?? "",
        customerCode: row[7] ?? "",
        loc: (row[8] ?? "東京") as Loc,
      };
      engineers.push(eng);

      // activeMonths
      try {
        const months = JSON.parse(row[9] ?? "[]") as string[];
        activeMonths.set(eng.manNo, new Set(months));
      } catch {
        activeMonths.set(eng.manNo, new Set());
      }

      if (!cachedAtStr && row[10]) cachedAtStr = row[10];
      if (loadedMonths.length === 0 && row[11]) {
        try { loadedMonths = JSON.parse(row[11]) as string[]; } catch { /* ignore */ }
      }
    }

    if (engineers.length === 0) return null;

    const cachedAt = cachedAtStr ? new Date(cachedAtStr).getTime() : 0;
    if (Date.now() - cachedAt > CACHE_TTL_MS) {
      console.log("[sheets API] L2キャッシュ期限切れ");
      return null;
    }

    return { engineers, activeMonths, loadedMonths, cachedAt };
  } catch {
    return null;
  }
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
       Step 1: 稼働一覧の取得（2層キャッシュ付き）
       成功 → 管理者/幹部 → L1 + L2 更新
       失敗 → L1 → L2 → 503
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

      // manNo で重複除去
      const engineerMap = new Map<string, ParsedEngineer>();
      for (const e of raw) {
        engineerMap.set(e.manNo, e);
      }

      // 全シート読み込み失敗 → キャッシュにフォールバック
      if (engineerMap.size === 0 && tempLoadedMonths.length === 0) {
        throw new Error("稼働一覧の全シート読み込み失敗");
      }

      deduped = Array.from(engineerMap.values());
      manNoActiveMonths = tempActiveMonths;
      loadedMonths = tempLoadedMonths;

      // ✅ 読み込み成功 → L1 + L2 キャッシュ更新
      setL1Cache({ engineers: deduped, activeMonths: tempActiveMonths, loadedMonths: tempLoadedMonths });
      console.log(`[sheets API] L1キャッシュ更新: ${deduped.length}名`);

      // L2（Google Sheets）への書き込み
      await writeL2Cache(sheets, deduped, tempActiveMonths, tempLoadedMonths);

    } catch (sheetErr) {
      // 稼働一覧へのアクセス権がないユーザー → キャッシュを使う
      console.warn("[sheets API] 稼働一覧の読み込み失敗（権限不足）、キャッシュを確認");

      // L1 チェック
      let cached = getL1Cache();
      if (!cached) {
        // L2 チェック（Google Sheets永続キャッシュ）
        console.log("[sheets API] L1キャッシュなし → L2（Google Sheets）を確認");
        cached = await readL2Cache(sheets);
        if (cached) {
          // L2 → L1 に昇格
          setL1Cache({ engineers: cached.engineers, activeMonths: cached.activeMonths, loadedMonths: cached.loadedMonths });
        }
      }

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
