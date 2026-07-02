import { NextRequest, NextResponse } from "next/server";
import { google } from "googleapis";
import { Readable } from "stream";
import { readSettingsMapOrThrow } from "@/lib/settings";
import { contractMonthKey, isMonthClosed } from "@/lib/closing";

const DEFAULT_DRIVE_FOLDER_ID = process.env.GOOGLE_DRIVE_FOLDER_ID ?? "";
const SPREADSHEET_ID = process.env.ORDER_LEDGER_SHEET_ID ?? process.env.GOOGLE_SHEETS_ID!;

/** 設定シートからDriveフォルダIDを取得（未設定なら環境変数のデフォルト） */
async function getDriveFolderId(sheets: ReturnType<typeof google.sheets>): Promise<string> {
  try {
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
      range: "設定!A:B",
    });
    const rows = (res.data.values ?? []) as string[][];
    for (const row of rows) {
      if (row[0] === "driveFolderId" && row[1]) return row[1].trim();
    }
  } catch {
    // 設定シートが無い場合は無視
  }
  return DEFAULT_DRIVE_FOLDER_ID;
}

/** トークンのスコープを確認 */
async function getTokenScopes(token: string): Promise<string> {
  try {
    const res = await fetch(`https://www.googleapis.com/oauth2/v1/tokeninfo?access_token=${token}`);
    const data = await res.json();
    return data.scope ?? "scope不明";
  } catch {
    return "tokeninfo取得失敗";
  }
}

/** フォルダのメタデータを取得して存在確認 */
async function checkFolderAccess(drive: ReturnType<typeof google.drive>, folderId: string): Promise<{ ok: boolean; detail: string; status?: number }> {
  try {
    const res = await drive.files.get({
      fileId: folderId,
      fields: "id, name, mimeType, driveId, capabilities",
      supportsAllDrives: true,
    });
    return { ok: true, detail: JSON.stringify({ name: res.data.name, mimeType: res.data.mimeType, driveId: res.data.driveId }) };
  } catch (e: unknown) {
    const gErr = e as { response?: { status?: number; data?: unknown }; code?: number };
    const status = gErr?.response?.status ?? gErr?.code;
    return { ok: false, detail: `status=${status} data=${JSON.stringify(gErr?.response?.data)}`, status };
  }
}

/** 顧客サブフォルダを検索し、なければ作成して ID を返す
 *  作成後に再検索して最初のIDを採用（並行アップロード時のフォルダ重複対策） */
async function getOrCreateCustomerFolder(
  drive: ReturnType<typeof google.drive>,
  parentFolderId: string,
  customerCode: string,
): Promise<string> {
  const escaped = customerCode.replace(/'/g, "\\'");
  const folderQuery = `name='${escaped}' and '${parentFolderId}' in parents and mimeType='application/vnd.google-apps.folder' and trashed=false`;
  const listOpts = { fields: "files(id)", supportsAllDrives: true, includeItemsFromAllDrives: true } as const;

  const existing = await drive.files.list({ q: folderQuery, ...listOpts });
  if ((existing.data.files ?? []).length > 0) {
    return existing.data.files![0].id!;
  }

  await drive.files.create({
    requestBody: {
      name: customerCode,
      mimeType: "application/vnd.google-apps.folder",
      parents: [parentFolderId],
    },
    fields: "id",
    supportsAllDrives: true,
  });

  // 作成後に再検索 → 2個できた場合も最初のIDに統一
  const verify = await drive.files.list({ q: folderQuery, ...listOpts });
  const firstId = (verify.data.files ?? [])[0]?.id;
  if (!firstId) throw new Error(`顧客フォルダ作成後の再検索失敗: ${customerCode}`);
  return firstId;
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
    const customerCode = ((formData.get("customerCode") as string | null) ?? "").trim();
    const contractStart = ((formData.get("contractStart") as string | null) ?? "").trim();

    if (!file || !fileName) {
      return NextResponse.json({ error: "file と fileName は必須です" }, { status: 400 });
    }

    // 締め済み月への登録をサーバー側でシャットアウト（Phase A/B Finding F-1）
    // 判定は /api/orders と統一（contractStart の月 YYYY-MM 単位）。欠落は 400 で拒否。
    const month = contractMonthKey(contractStart);
    if (!month) {
      return NextResponse.json({ error: "契約開始日が指定されていません" }, { status: 400 });
    }

    const oauth2 = new google.auth.OAuth2();
    oauth2.setCredentials({ access_token: accessToken });
    const sheets = google.sheets({ version: "v4", auth: oauth2 });
    const drive = google.drive({ version: "v3", auth: oauth2 });

    const parentFolderId = (await getDriveFolderId(sheets)).trim();
    if (!parentFolderId) {
      return NextResponse.json({ error: "GOOGLE_DRIVE_FOLDER_ID が未設定です" }, { status: 500 });
    }

    // デバッグ: トークンスコープとフォルダアクセスを事前チェック
    const [scopes, folderCheck] = await Promise.all([
      getTokenScopes(accessToken),
      checkFolderAccess(drive, parentFolderId),
    ]);
    console.log("[drive debug]", { scopes, parentFolderId, folderCheck });

    if (!folderCheck.ok) {
      const folderError = folderCheck.status === 401
        ? "ログインの有効期限が切れました。一度ログアウトして、再ログイン後にもう一度お試しください。"
        : "フォルダにアクセスできません";
      return NextResponse.json({
        error: folderError,
        _debug: { scopes, parentFolderId, folderCheck: folderCheck.detail },
      }, { status: 403 });
    }

    // 締め済み月への登録をサーバー側でシャットアウト（Phase A/B Finding F-1）。
    // トークン有効性が folderCheck 通過で確定した後に判定する。これにより
    // トークン失効時は既存の再認証/再ログイン導線が先に働き（自動リトライUX維持）、
    // 再認証後の有効トークンで締め状態を読む。それでも読めない場合のみ 503（フェイルクローズ）。
    // 判定は /api/orders と統一（contractStart の月 YYYY-MM 単位）。Drive書き込みより前を維持。
    let closingSettings: Record<string, string>;
    try {
      closingSettings = await readSettingsMapOrThrow(sheets);
    } catch {
      return NextResponse.json(
        { error: "締め状態を確認できませんでした。再ログインして再試行してください" },
        { status: 503 },
      );
    }
    if (isMonthClosed(closingSettings, month)) {
      return NextResponse.json(
        { error: "この月は締め済みです。管理者に連絡してください" },
        { status: 409 },
      );
    }

    // 顧客サブフォルダへ振り分け（失敗時は親フォルダにフォールバック）
    let uploadFolderId = parentFolderId;
    if (customerCode) {
      try {
        uploadFolderId = await getOrCreateCustomerFolder(drive, parentFolderId, customerCode);
        console.log("[drive POST] 顧客フォルダ決定", { customerCode, uploadFolderId });
      } catch {
        console.warn("[drive POST] 顧客フォルダ取得/作成失敗。親フォルダに保存します", { customerCode });
      }
    }

    const buffer = Buffer.from(await file.arrayBuffer());
    const stream = Readable.from(buffer);

    const res = await drive.files.create({
      requestBody: {
        name: fileName,
        parents: [uploadFolderId],
      },
      media: {
        mimeType: "application/pdf",
        body: stream,
      },
      fields: "id, webViewLink",
      supportsAllDrives: true,
    });

    return NextResponse.json({ link: res.data.webViewLink ?? res.data.id, folderId: uploadFolderId });
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

/** Drive内に同名ファイルが存在するか検索する
 *  失敗時は exists:false を返し、保存処理を止めない */
export async function GET(req: NextRequest) {
  const accessToken = req.headers.get("x-google-access-token");
  if (!accessToken) return NextResponse.json({ exists: false });

  try {
    const fileName     = req.nextUrl.searchParams.get("fileName") ?? "";
    const customerCode = (req.nextUrl.searchParams.get("customerCode") ?? "").trim();
    if (!fileName) return NextResponse.json({ exists: false });

    const oauth2 = new google.auth.OAuth2();
    oauth2.setCredentials({ access_token: accessToken });
    const sheets = google.sheets({ version: "v4", auth: oauth2 });
    const drive  = google.drive({ version: "v3", auth: oauth2 });

    const parentFolderId = (await getDriveFolderId(sheets)).trim();
    if (!parentFolderId) return NextResponse.json({ exists: false });

    const fileEscaped = fileName.replace(/'/g, "\\'");
    const listOpts = { fields: "files(id)", supportsAllDrives: true, includeItemsFromAllDrives: true } as const;

    // 顧客フォルダ内の検索（customerCode がある場合）
    let customerFolderHits = 0;
    if (customerCode) {
      const ccEscaped = customerCode.replace(/'/g, "\\'");
      const folderRes = await drive.files.list({
        q: `name='${ccEscaped}' and '${parentFolderId}' in parents and mimeType='application/vnd.google-apps.folder' and trashed=false`,
        ...listOpts,
      });
      const customerFolderId = (folderRes.data.files ?? [])[0]?.id;
      if (customerFolderId) {
        const fileRes = await drive.files.list({
          q: `name='${fileEscaped}' and '${customerFolderId}' in parents and trashed=false`,
          ...listOpts,
        });
        customerFolderHits = (fileRes.data.files ?? []).length;
      }
    }

    // 親フォルダ直下の検索（既存フラット保存済みとの重複チェック）
    const parentRes = await drive.files.list({
      q: `name='${fileEscaped}' and '${parentFolderId}' in parents and trashed=false`,
      ...listOpts,
    });
    const parentFolderHits = (parentRes.data.files ?? []).length;

    console.log("[drive GET] 重複チェック", { fileName, customerCode, customerFolderHits, parentFolderHits });
    return NextResponse.json({ exists: customerFolderHits + parentFolderHits > 0 });
  } catch {
    // 検索失敗は exists:false として保存を止めない
    return NextResponse.json({ exists: false });
  }
}
