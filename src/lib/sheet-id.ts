/**
 * スプレッドシートID抽出ユーティリティ（純関数・テスト可能）
 *
 * 管理者がシートID欄に貼り付けるのは「裸のID」または「SheetsのURL」の両方が想定される。
 * URL なら /spreadsheets/d/<ID>/ からIDを取り出し、裸IDはそのまま返す。
 * Drive URL や不正入力は空文字を返す（呼び出し側で「不正」として弾く）。
 */

/** Sheets URL からID部分を取り出す正規表現（/spreadsheets/d/<ID>） */
const SHEETS_URL_RE = /\/spreadsheets\/d\/([a-zA-Z0-9_-]+)/;
/** 裸のシートID（ID文字種のみで構成される） */
const BARE_ID_RE = /^[a-zA-Z0-9_-]+$/;

export function extractSheetId(input: string): string {
  const s = (input ?? "").trim();
  if (!s) return "";

  // 1. Sheets URL（/edit#gid=0 や ?usp=sharing が付いていてもID部分だけ取れる）
  const urlMatch = s.match(SHEETS_URL_RE);
  if (urlMatch) return urlMatch[1];

  // 2. 裸のID（全体がID文字種のみ）
  if (BARE_ID_RE.test(s)) return s;

  // 3. それ以外（Drive URL・余計な文字を含む不正入力）は空
  return "";
}
