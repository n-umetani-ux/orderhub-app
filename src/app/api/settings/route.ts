import { NextRequest, NextResponse } from "next/server";
import { google } from "googleapis";

const SPREADSHEET_ID = process.env.GOOGLE_SHEETS_ID!;
const SETTINGS_SHEET = "設定";

/**
 * 設定シートの構造: A列=key, B列=value
 * 特殊キー:
 *   "adminEmails" → カンマ区切りの管理者メールアドレス一覧
 *   "driveFolderId" → Drive保存先フォルダID
 */
async function ensureSettingsSheet(sheets: ReturnType<typeof google.sheets>, spreadsheetId: string) {
  const meta = await sheets.spreadsheets.get({ spreadsheetId });
  const exists = meta.data.sheets?.some(s => s.properties?.title === SETTINGS_SHEET);
  if (!exists) {
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId,
      requestBody: { requests: [{ addSheet: { properties: { title: SETTINGS_SHEET } } }] },
    });
    // ヘッダー + 初期管理者を一括書き込み
    await sheets.spreadsheets.values.update({
      spreadsheetId,
      range: `${SETTINGS_SHEET}!A1`,
      valueInputOption: "RAW",
      requestBody: {
        values: [
          ["key", "value"],
          ["adminEmails", "n-umetani@beat-tech.co.jp"],
        ],
      },
    });
  }
}

/** 管理者メール一覧を取得 */
function parseAdminEmails(settings: Record<string, string>): string[] {
  const raw = settings["adminEmails"] ?? "";
  return raw.split(",").map(e => e.trim()).filter(Boolean);
}

export async function GET(req: NextRequest) {
  const accessToken = req.headers.get("x-google-access-token");
  if (!accessToken) {
    return NextResponse.json({ error: "アクセストークンがありません" }, { status: 401 });
  }

  // リクエスト元のメールアドレス（管理者判定用）
  const userEmail = req.headers.get("x-user-email") ?? "";

  try {
    const oauth2 = new google.auth.OAuth2();
    oauth2.setCredentials({ access_token: accessToken });
    const sheets = google.sheets({ version: "v4", auth: oauth2 });

    await ensureSettingsSheet(sheets, SPREADSHEET_ID);

    const res = await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
      range: `${SETTINGS_SHEET}!A:B`,
    });

    const rows = (res.data.values ?? []) as string[][];
    const settings: Record<string, string> = {};
    for (const row of rows.slice(1)) {
      if (row[0]) settings[row[0]] = row[1] ?? "";
    }

    const adminEmails = parseAdminEmails(settings);
    const isAdmin = adminEmails.includes(userEmail);

    return NextResponse.json({ settings, isAdmin });
  } catch (e: unknown) {
    console.error("[settings GET]", e);
    return NextResponse.json({ settings: {}, isAdmin: false });
  }
}

export async function POST(req: NextRequest) {
  const accessToken = req.headers.get("x-google-access-token");
  if (!accessToken) {
    return NextResponse.json({ error: "アクセストークンがありません" }, { status: 401 });
  }

  const userEmail = req.headers.get("x-user-email") ?? "";

  try {
    const body = await req.json() as { key: string; value: string };
    if (!body.key) {
      return NextResponse.json({ error: "key は必須です" }, { status: 400 });
    }

    const oauth2 = new google.auth.OAuth2();
    oauth2.setCredentials({ access_token: accessToken });
    const sheets = google.sheets({ version: "v4", auth: oauth2 });

    // 管理者チェック
    await ensureSettingsSheet(sheets, SPREADSHEET_ID);
    const checkRes = await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
      range: `${SETTINGS_SHEET}!A:B`,
    });
    const checkRows = (checkRes.data.values ?? []) as string[][];
    const currentSettings: Record<string, string> = {};
    for (const row of checkRows.slice(1)) {
      if (row[0]) currentSettings[row[0]] = row[1] ?? "";
    }
    const adminEmails = parseAdminEmails(currentSettings);
    if (!adminEmails.includes(userEmail)) {
      return NextResponse.json({ error: "管理者権限がありません" }, { status: 403 });
    }

    // 既存の設定を再利用（管理者チェックで取得済み）
    const rows = checkRows;

    // 既存キーの行を探す
    let rowIdx = -1;
    for (let i = 1; i < rows.length; i++) {
      if (rows[i][0] === body.key) { rowIdx = i; break; }
    }

    if (rowIdx >= 0) {
      // 既存行を更新
      await sheets.spreadsheets.values.update({
        spreadsheetId: SPREADSHEET_ID,
        range: `${SETTINGS_SHEET}!B${rowIdx + 1}`,
        valueInputOption: "RAW",
        requestBody: { values: [[body.value]] },
      });
    } else {
      // 新規行を追加
      await sheets.spreadsheets.values.append({
        spreadsheetId: SPREADSHEET_ID,
        range: `${SETTINGS_SHEET}!A:B`,
        valueInputOption: "RAW",
        requestBody: { values: [[body.key, body.value]] },
      });
    }

    return NextResponse.json({ ok: true });
  } catch (e: unknown) {
    console.error("[settings POST]", e);
    return NextResponse.json({ error: "設定の保存に失敗しました" }, { status: 500 });
  }
}
