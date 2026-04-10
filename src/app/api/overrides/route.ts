import { NextRequest, NextResponse } from "next/server";
import { google } from "googleapis";

const SPREADSHEET_ID = process.env.GOOGLE_SHEETS_ID!;
const OVERRIDES_SHEET = "手動オーバーライド";

const HEADERS = ["manNo", "yearMonth", "status", "updatedBy", "updatedAt"];

async function ensureSheet(sheets: ReturnType<typeof google.sheets>, spreadsheetId: string) {
  const meta = await sheets.spreadsheets.get({ spreadsheetId });
  const exists = meta.data.sheets?.some(s => s.properties?.title === OVERRIDES_SHEET);
  if (!exists) {
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId,
      requestBody: { requests: [{ addSheet: { properties: { title: OVERRIDES_SHEET } } }] },
    });
    await sheets.spreadsheets.values.update({
      spreadsheetId,
      range: `${OVERRIDES_SHEET}!A1`,
      valueInputOption: "RAW",
      requestBody: { values: [HEADERS] },
    });
  }
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

    const res = await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
      range: `${OVERRIDES_SHEET}!A:E`,
    });

    const rows = (res.data.values ?? []) as string[][];
    const overrides = rows.slice(1)
      .filter(r => r[0] && r[1] && r[2])
      .map(r => ({
        manNo: r[0],
        yearMonth: r[1],
        status: r[2] as "covered" | "gap" | "na",
        updatedBy: r[3] ?? "",
        updatedAt: r[4] ?? "",
      }));

    return NextResponse.json({ overrides });
  } catch {
    return NextResponse.json({ overrides: [] });
  }
}

export async function POST(req: NextRequest) {
  const accessToken = req.headers.get("x-google-access-token");
  if (!accessToken) {
    return NextResponse.json({ error: "アクセストークンがありません" }, { status: 401 });
  }

  try {
    const body = await req.json() as {
      manNo: string;
      yearMonth: string;
      status: "covered" | "gap" | "na" | "auto";
      updatedBy: string;
    };

    const oauth2 = new google.auth.OAuth2();
    oauth2.setCredentials({ access_token: accessToken });
    const sheets = google.sheets({ version: "v4", auth: oauth2 });

    await ensureSheet(sheets, SPREADSHEET_ID);

    // 既存のオーバーライドを読み込み
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
      range: `${OVERRIDES_SHEET}!A:E`,
    });
    const rows = (res.data.values ?? []) as string[][];

    // 同じ manNo + yearMonth の行を探す
    let rowIdx = -1;
    for (let i = 1; i < rows.length; i++) {
      if (rows[i][0] === body.manNo && rows[i][1] === body.yearMonth) {
        rowIdx = i;
        break;
      }
    }

    if (body.status === "auto") {
      // "auto" = オーバーライドを削除（行をクリア）
      if (rowIdx >= 0) {
        await sheets.spreadsheets.values.update({
          spreadsheetId: SPREADSHEET_ID,
          range: `${OVERRIDES_SHEET}!A${rowIdx + 1}:E${rowIdx + 1}`,
          valueInputOption: "RAW",
          requestBody: { values: [["", "", "", "", ""]] },
        });
      }
    } else if (rowIdx >= 0) {
      // 既存行を更新
      await sheets.spreadsheets.values.update({
        spreadsheetId: SPREADSHEET_ID,
        range: `${OVERRIDES_SHEET}!A${rowIdx + 1}:E${rowIdx + 1}`,
        valueInputOption: "RAW",
        requestBody: { values: [[body.manNo, body.yearMonth, body.status, body.updatedBy, new Date().toISOString()]] },
      });
    } else {
      // 新規行を追加
      await sheets.spreadsheets.values.append({
        spreadsheetId: SPREADSHEET_ID,
        range: `${OVERRIDES_SHEET}!A:E`,
        valueInputOption: "RAW",
        requestBody: { values: [[body.manNo, body.yearMonth, body.status, body.updatedBy, new Date().toISOString()]] },
      });
    }

    return NextResponse.json({ ok: true });
  } catch (e: unknown) {
    console.error("[overrides POST]", e);
    return NextResponse.json({ error: "オーバーライドの保存に失敗しました" }, { status: 500 });
  }
}
