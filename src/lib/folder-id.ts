/**
 * Drive フォルダID抽出ユーティリティ（純関数・テスト可能）
 *
 * 管理者がフォルダID欄に貼り付けるのは「裸のID」または「DriveフォルダのURL」の両方が想定される。
 * URL なら /drive/folders/<ID> からIDを取り出し、裸IDはそのまま返す。
 * Sheets URL や不正入力は空文字を返す（呼び出し側で「不正」として弾く）。
 *
 * sheet-id.ts（extractSheetId）の Drive 版。同じ思想で対になる。
 */

/** Drive フォルダURL からID部分を取り出す正規表現（/drive/folders/<ID>） */
const FOLDERS_URL_RE = /\/folders\/([a-zA-Z0-9_-]+)/;
/** 裸のフォルダID（ID文字種のみで構成される） */
const BARE_ID_RE = /^[a-zA-Z0-9_-]+$/;

export function extractFolderId(input: string): string {
  const s = (input ?? "").trim();
  if (!s) return "";

  // 1. Drive フォルダURL（?usp=sharing 等が付いていてもID部分だけ取れる）
  const urlMatch = s.match(FOLDERS_URL_RE);
  if (urlMatch) return urlMatch[1];

  // 2. 裸のID（全体がID文字種のみ）
  if (BARE_ID_RE.test(s)) return s;

  // 3. それ以外（Sheets URL・余計な文字を含む不正入力）は空
  return "";
}
