import { NextRequest, NextResponse } from "next/server";
import { google } from "googleapis";
import { Readable } from "stream";

const DEFAULT_DRIVE_FOLDER_ID = process.env.GOOGLE_DRIVE_FOLDER_ID ?? "";
const SPREADSHEET_ID = process.env.GOOGLE_SHEETS_ID!;

/** サービスアカウントで認証（トークン期限切れなし・共有ドライブアクセス可） */
function getServiceAuth() {
  const credentials = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON!);
  return new google.auth.GoogleAuth({
    credentials,
    scopes: [
      "https://www.googleapis.com/auth/drive",
      "https://www.googleapis.com/auth/spreadsheets.readonly",
    ],
  });
}

/** 設定シートからDriveフォルダIDを取得（未設定なら環境変数のデフォルト） */
async function getDriveFolderId(sheets: ReturnType<typeof google.sheets>): Promise<string> {
  try {
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
      range: "設定!A:B",
    });
    const rows = (res.data.values ?? []) as string[][];
    for (const row of rows) {
      if (row[0] === "driveFolderId" && row[1]) return row[1];
    }
  } catch {
    // 設定シートが無い場合は無視
  }
  return DEFAULT_DRIVE_FOLDER_ID;
}

export async function POST(req: NextRequest) {
  try {
    const formData = await req.formData();
    const file = formData.get("file") as File | null;
    const fileName = formData.get("fileName") as string | null;

    if (!file || !fileName) {
      return NextResponse.json({ error: "file と fileName は必須です" }, { status: 400 });
    }

    const auth = getServiceAuth();
    const sheets = google.sheets({ version: "v4", auth });
    const drive = google.drive({ version: "v3", auth });

    const folderId = await getDriveFolderId(sheets);
    if (!folderId) {
      return NextResponse.json({ error: "GOOGLE_DRIVE_FOLDER_ID が未設定です" }, { status: 500 });
    }

    const buffer = Buffer.from(await file.arrayBuffer());
    const stream = Readable.from(buffer);

    const res = await drive.files.create({
      requestBody: {
        name: fileName,
        parents: [folderId],
      },
      media: {
        mimeType: "application/pdf",
        body: stream,
      },
      fields: "id, webViewLink",
      supportsAllDrives: true,
    });

    return NextResponse.json({ link: res.data.webViewLink ?? res.data.id });
  } catch (e: unknown) {
    console.error("[drive API]", e);
    const detail = e instanceof Error ? e.message : String(e);
    const gaxiosErr = e as { response?: { status?: number; data?: unknown } };
    const apiStatus = gaxiosErr?.response?.status;
    const apiData = gaxiosErr?.response?.data;
    console.error("[drive API detail]", { detail, apiStatus, apiData });
    return NextResponse.json(
      { error: `Driveへのアップロードに失敗しました: ${detail}`, apiStatus, apiData },
      { status: apiStatus ?? 500 },
    );
  }
}
