import { NextRequest, NextResponse } from "next/server";
import { google } from "googleapis";

const SPREADSHEET_ID = process.env.GOOGLE_SHEETS_ID!;
const ORDERS_SHEET = "注文書台帳";

const HEADERS = [
  "manNo", "name", "contractStart", "contractEnd",
  "fileName", "driveLink", "dept", "customerCode", "customerName",
  "targetType", "uploadedAt", "uploadedBy",
];

async function ensureSheet(sheets: ReturnType<typeof google.sheets>, spreadsheetId: string) {
  const meta = await sheets.spreadsheets.get({ spreadsheetId });
  const exists = meta.data.sheets?.some(s => s.properties?.title === ORDERS_SHEET);
  if (!exists) {
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId,
      requestBody: { requests: [{ addSheet: { properties: { title: ORDERS_SHEET } } }] },
    });
    await sheets.spreadsheets.values.update({
      spreadsheetId,
      range: `${ORDERS_SHEET}!A1`,
      valueInputOption: "RAW",
      requestBody: { values: [HEADERS] },
    });
  } else {
    // ヘッダー行がなければ挿入
    const check = await sheets.spreadsheets.values.get({
      spreadsheetId,
      range: `${ORDERS_SHEET}!A1:A1`,
    });
    if (!check.data.values?.length) {
      await sheets.spreadsheets.values.update({
        spreadsheetId,
        range: `${ORDERS_SHEET}!A1`,
        valueInputOption: "RAW",
        requestBody: { values: [HEADERS] },
      });
    }
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
      range: `${ORDERS_SHEET}!A:L`,
    });

    const rows = (res.data.values ?? []) as string[][];
    if (rows.length <= 1) return NextResponse.json({ orders: [] });

    const orders = rows.slice(1)
      .filter(row => row[0] && row[2] && row[3])
      .map(row => ({
        manNo:        row[0] ?? "",
        name:         row[1] ?? "",
        contractStart: row[2] ?? "",
        contractEnd:  row[3] ?? "",
        fileName:     row[4] ?? "",
        driveLink:    row[5] ?? "",
        dept:         row[6] ?? "",
        customerCode: row[7] ?? "",
        customerName: row[8] ?? "",
        targetType:   row[9] ?? "",
        uploadedAt:   row[10] ?? "",
        uploadedBy:   row[11] ?? "",
      }));

    return NextResponse.json({ orders });
  } catch (e: unknown) {
    console.error("[orders GET]", e);
    // シートが存在しない場合は空配列を返す
    return NextResponse.json({ orders: [] });
  }
}

export async function POST(req: NextRequest) {
  const accessToken = req.headers.get("x-google-access-token");
  if (!accessToken) {
    return NextResponse.json({ error: "アクセストークンがありません" }, { status: 401 });
  }

  try {
    const body = await req.json() as {
      manNo: string | number;
      name: string;
      contractStart: string;
      contractEnd: string;
      fileName: string;
      driveLink: string;
      dept: string;
      customerCode: string;
      customerName: string;
      targetType: string;
      uploadedBy?: string;
    };

    const oauth2 = new google.auth.OAuth2();
    oauth2.setCredentials({ access_token: accessToken });
    const sheets = google.sheets({ version: "v4", auth: oauth2 });

    await ensureSheet(sheets, SPREADSHEET_ID);

    await sheets.spreadsheets.values.append({
      spreadsheetId: SPREADSHEET_ID,
      range: `${ORDERS_SHEET}!A:L`,
      valueInputOption: "RAW",
      requestBody: {
        values: [[
          String(body.manNo),
          body.name,
          body.contractStart,
          body.contractEnd,
          body.fileName,
          body.driveLink,
          body.dept,
          body.customerCode,
          body.customerName,
          body.targetType,
          new Date().toISOString(),
          body.uploadedBy ?? "",
        ]],
      },
    });

    return NextResponse.json({ ok: true });
  } catch (e: unknown) {
    console.error("[orders POST]", e);
    return NextResponse.json({ error: "注文書台帳への記録に失敗しました" }, { status: 500 });
  }
}
