import { NextRequest, NextResponse } from "next/server";
import { google } from "googleapis";
import { Readable } from "stream";

const DEFAULT_DRIVE_FOLDER_ID = process.env.GOOGLE_DRIVE_FOLDER_ID ?? "";
const SPREADSHEET_ID = process.env.GOOGLE_SHEETS_ID!;

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
  const accessToken = req.headers.get("x-google-access-token");
  if (!accessToken) {
    return NextResponse.json({ error: "アクセストークンがありません" }, { status: 401 });
  }

  try {
    const formData = await req.formData();
    const file = formData.get("file") as File | null;
    const fileName = formData.get("fileName") as string | null;

    if (!file || !fileName) {
      return NextResponse.json({ error: "file と fileName は必須です" }, { status: 400 });
    }

    const oauth2 = new google.auth.OAuth2();
    oauth2.setCredentials({ access_token: accessToken });
    const sheets = google.sheets({ version: "v4", auth: oauth2 });
    const drive = google.drive({ version: "v3", auth: oauth2 });

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

    return NextResponse.json({ link: res.data.webViewLink ?? res.data.id, folderId });
  } catch (e: unknown) {
    console.error("[drive API]", e);
    const detail = e instanceof Error ? e.message : String(e);
    const gaxiosErr = e as { response?: { status?: number; data?: unknown } };
    const apiStatus = gaxiosErr?.response?.status;
    const apiData = gaxiosErr?.response?.data;
    console.error("[drive API detail]", { detail, apiStatus, apiData });

    if (apiStatus === 401 || apiStatus === 403) {
      return NextResponse.json(
        { error: "認証が期限切れです。再ログインしてください。", needReauth: true },
        { status: 401 },
      );
    }

    return NextResponse.json(
      { error: `Driveへのアップロードに失敗しました: ${detail}`, apiStatus, apiData },
      { status: apiStatus ?? 500 },
    );
  }
}
