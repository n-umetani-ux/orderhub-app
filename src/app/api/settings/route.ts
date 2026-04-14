import { NextRequest, NextResponse } from "next/server";
import { google } from "googleapis";

const SPREADSHEET_ID = process.env.GOOGLE_SHEETS_ID!;
const SETTINGS_SHEET = "設定";
const DEFAULT_ADMIN = "n-umetani@beat-tech.co.jp";

/** 読み取り専用のSheetsクライアント */
function getReadonlyClient() {
  const credentials = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON!);
  const auth = new google.auth.GoogleAuth({
    credentials,
    scopes: ["https://www.googleapis.com/auth/spreadsheets.readonly"],
  });
  return google.sheets({ version: "v4", auth });
}

/** 設定シートを読み取り（読み取り専用、シートがなければデフォルト値を返す） */
async function readSettingsReadonly(): Promise<{ settings: Record<string, string>; rows: string[][] }> {
  const sheets = getReadonlyClient();

  try {
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
      range: `${SETTINGS_SHEET}!A:B`,
    });
    const rows = (res.data.values ?? []) as string[][];
    const settings: Record<string, string> = {};
    for (const row of rows.slice(1)) {
      if (row[0]) settings[row[0]] = row[1] ?? "";
    }
    // adminEmailsが空の場合はデフォルトを返す
    if (!settings["adminEmails"]) {
      settings["adminEmails"] = DEFAULT_ADMIN;
    }
    return { settings, rows };
  } catch {
    // 設定シートが存在しない場合 → デフォルト値を返す
    return {
      settings: { adminEmails: DEFAULT_ADMIN },
      rows: [["key", "value"], ["adminEmails", DEFAULT_ADMIN]],
    };
  }
}

/** 管理者メール一覧を取得 */
function parseAdminEmails(settings: Record<string, string>): string[] {
  const raw = settings["adminEmails"] ?? "";
  return raw.split(",").map(e => e.trim()).filter(Boolean);
}

export async function GET(req: NextRequest) {
  const userEmail = req.headers.get("x-user-email") ?? "";

  try {
    const { settings } = await readSettingsReadonly();
    const adminEmails = parseAdminEmails(settings);
    const isAdmin = adminEmails.includes(userEmail);

    return NextResponse.json({ settings, isAdmin });
  } catch (e: unknown) {
    console.error("[settings GET]", e);
    // 完全にエラーの場合もデフォルト管理者は認識する
    const isAdmin = userEmail === DEFAULT_ADMIN;
    return NextResponse.json({ settings: { adminEmails: DEFAULT_ADMIN }, isAdmin });
  }
}

export async function POST(req: NextRequest) {
  const userEmail = req.headers.get("x-user-email") ?? "";
  const accessToken = req.headers.get("x-google-access-token");
  if (!accessToken) {
    return NextResponse.json({ error: "アクセストークンがありません" }, { status: 401 });
  }

  try {
    const body = await req.json() as { key: string; value: string };
    if (!body.key) {
      return NextResponse.json({ error: "key は必須です" }, { status: 400 });
    }

    // 管理者チェック（読み取り専用サービスアカウントで確認）
    const { settings, rows } = await readSettingsReadonly();
    const adminEmails = parseAdminEmails(settings);
    if (!adminEmails.includes(userEmail)) {
      return NextResponse.json({ error: "管理者権限がありません" }, { status: 403 });
    }

    // ユーザーのOAuthトークンで書き込み（スプレッドシートの編集権限を利用）
    const oauth2 = new google.auth.OAuth2();
    oauth2.setCredentials({ access_token: accessToken });
    const sheets = google.sheets({ version: "v4", auth: oauth2 });

    // 設定シートが存在するか確認、なければ作成
    try {
      const meta = await sheets.spreadsheets.get({ spreadsheetId: SPREADSHEET_ID });
      const exists = meta.data.sheets?.some(s => s.properties?.title === SETTINGS_SHEET);
      if (!exists) {
        await sheets.spreadsheets.batchUpdate({
          spreadsheetId: SPREADSHEET_ID,
          requestBody: { requests: [{ addSheet: { properties: { title: SETTINGS_SHEET } } }] },
        });
        await sheets.spreadsheets.values.update({
          spreadsheetId: SPREADSHEET_ID,
          range: `${SETTINGS_SHEET}!A1`,
          valueInputOption: "RAW",
          requestBody: { values: [["key", "value"], ["adminEmails", DEFAULT_ADMIN]] },
        });
      }
    } catch (e) {
      console.error("[settings POST] シート作成エラー:", e);
    }

    // 既存キーの行を探す
    let rowIdx = -1;
    for (let i = 1; i < rows.length; i++) {
      if (rows[i][0] === body.key) { rowIdx = i; break; }
    }

    if (rowIdx >= 0) {
      await sheets.spreadsheets.values.update({
        spreadsheetId: SPREADSHEET_ID,
        range: `${SETTINGS_SHEET}!B${rowIdx + 1}`,
        valueInputOption: "RAW",
        requestBody: { values: [[body.value]] },
      });
    } else {
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
    const msg = e instanceof Error ? e.message : "不明なエラー";
    return NextResponse.json({ error: `設定の保存に失敗しました: ${msg}` }, { status: 500 });
  }
}
