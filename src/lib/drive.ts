import { google } from "googleapis";
import { Readable } from "stream";

const DRIVE_FOLDER_ID = process.env.GOOGLE_DRIVE_FOLDER_ID!;

function getAuthClient() {
  const credentials = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON!);
  const auth = new google.auth.GoogleAuth({
    credentials,
    scopes: ["https://www.googleapis.com/auth/drive.file"],
  });
  return auth;
}

export async function uploadToDrive(
  fileName: string,
  fileBuffer: Buffer
): Promise<string> {
  const authClient = getAuthClient();
  const drive = google.drive({ version: "v3", auth: authClient });

  const stream = Readable.from(fileBuffer);

  const res = await drive.files.create({
    requestBody: {
      name: fileName,
      parents: [DRIVE_FOLDER_ID],
    },
    media: {
      mimeType: "application/pdf",
      body: stream,
    },
    fields: "id, webViewLink",
  });

  return res.data.webViewLink ?? res.data.id ?? "";
}

export async function listOrderFiles(folderIdOverride?: string): Promise<Array<{
  id: string;
  name: string;
  webViewLink: string;
  createdTime: string;
}>> {
  const authClient = getAuthClient();
  const drive = google.drive({ version: "v3", auth: authClient });

  const res = await drive.files.list({
    q: `'${folderIdOverride ?? DRIVE_FOLDER_ID}' in parents and trashed = false`,
    fields: "files(id, name, webViewLink, createdTime)",
    orderBy: "createdTime desc",
  });

  return (res.data.files ?? []) as Array<{
    id: string;
    name: string;
    webViewLink: string;
    createdTime: string;
  }>;
}
