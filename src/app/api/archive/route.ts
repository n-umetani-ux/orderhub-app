import { NextRequest, NextResponse } from "next/server";
import { google } from "googleapis";

const SPREADSHEET_ID = process.env.ORDER_LEDGER_SHEET_ID ?? process.env.GOOGLE_SHEETS_ID!;
const ARCHIVE_SHEET = "アーカイブ申請";

const HEADERS = ["manNo", "name", "requestedBy", "requestedAt", "status"];

async function ensureSheet(sheets: ReturnType<typeof google.sheets>, spreadsheetId: string) {
  const meta = await sheets.spreadsheets.get({ spreadsheetId });
  const exists = meta.data.sheets?.some(s => s.properties?.title === ARCHIVE_SHEET);
  if (!exists) {
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId,
      requestBody: { requests: [{ addSheet: { properties: { title: ARCHIVE_SHEET } } }] },
    });
    await sheets.spreadsheets.values.update({
      spreadsheetId,
      range: `${ARCHIVE_SHEET}!A1`,
      valueInputOption: "RAW",
      requestBody: { values: [HEADERS] },
    });
  }
}

/** GET: アーカイブ申請一覧を取得 */
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
      range: `${ARCHIVE_SHEET}!A:E`,
    });

    const rows = (res.data.values ?? []) as string[][];
    if (rows.length <= 1) return NextResponse.json({ archives: [] });

    const archives = rows.slice(1)
      .filter(row => row[0])
      .map(row => ({
        manNo:       row[0] ?? "",
        name:        row[1] ?? "",
        requestedBy: row[2] ?? "",
        requestedAt: row[3] ?? "",
        status:      row[4] ?? "pending",
      }));

    return NextResponse.json({ archives });
  } catch {
    return NextResponse.json({ archives: [] });
  }
}

/** POST: アーカイブ申請を登録 */
export async function POST(req: NextRequest) {
  const accessToken = req.headers.get("x-google-access-token");
  if (!accessToken) {
    return NextResponse.json({ error: "アクセストークンがありません" }, { status: 401 });
  }

  try {
    const body = await req.json() as {
      manNo: string | number;
      name: string;
      requestedBy: string;
    };

    const oauth2 = new google.auth.OAuth2();
    oauth2.setCredentials({ access_token: accessToken });
    const sheets = google.sheets({ version: "v4", auth: oauth2 });

    await ensureSheet(sheets, SPREADSHEET_ID);

    await sheets.spreadsheets.values.append({
      spreadsheetId: SPREADSHEET_ID,
      range: `${ARCHIVE_SHEET}!A:E`,
      valueInputOption: "RAW",
      requestBody: {
        values: [[
          String(body.manNo),
          body.name,
          body.requestedBy,
          new Date().toISOString(),
          "pending",
        ]],
      },
    });

    return NextResponse.json({ ok: true });
  } catch (e: unknown) {
    console.error("[archive POST]", e);
    return NextResponse.json({ error: "アーカイブ申請に失敗しました" }, { status: 500 });
  }
}
