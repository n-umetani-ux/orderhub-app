import { NextRequest, NextResponse } from "next/server";
import { google } from "googleapis";
import { Readable } from "stream";

const DEFAULT_DRIVE_FOLDER_ID = process.env.GOOGLE_DRIVE_FOLDER_ID ?? "";
const SPREADSHEET_ID = process.env.GOOGLE_SHEETS_ID!;

/** サービスアカウントでSheetsクライアント（設定読み取り用） */
function getServiceSheets() {
  const credentials = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON!);
  const auth = new google.auth.GoogleAuth({
    credentials,
    scopes: ["https://www.googleapis.com/auth/spreadsheets.readonly"],
  });
  return google.sheets({ version: "v4", auth });
}

/** 設定シートからDriveフォルダIDを取得（未設定なら環境変数のデフォルト） */
async function getDriveFolderId(): Promise<string> {
  try {
    const sheets = getServiceSheets();
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

    // ユーザーのOAuthトークンでDrive操作（共有ドライブへのアクセス権限あり）
    const oauth2 = new google.auth.OAuth2();
    oauth2.setCredentials({ access_token: accessToken });
    const drive = google.drive({ version: "v3", auth: oauth2 });

    const folderId = await getDriveFolderId();
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

    // トークン期限切れの場合は401を返す（フロントで再認証を促す）
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
