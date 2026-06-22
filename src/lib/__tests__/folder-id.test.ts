import { describe, it, expect } from "vitest";
import { extractFolderId } from "@/lib/folder-id";

describe("extractFolderId", () => {
  it("Drive フォルダURL からIDを抽出する", () => {
    expect(extractFolderId("https://drive.google.com/drive/folders/1AbC-_xyz123"))
      .toBe("1AbC-_xyz123");
  });

  it("クエリ付きURL（?usp=sharing）でもID部分だけ取れる", () => {
    expect(extractFolderId("https://drive.google.com/drive/folders/1AbC-_xyz123?usp=sharing"))
      .toBe("1AbC-_xyz123");
  });

  it("裸のIDはそのまま返す", () => {
    expect(extractFolderId("1AbC-_xyz123")).toBe("1AbC-_xyz123");
  });

  it("前後の空白はトリムする", () => {
    expect(extractFolderId("  1AbC-_xyz123  ")).toBe("1AbC-_xyz123");
  });

  it("Sheets URL は Drive フォルダではないので空文字", () => {
    expect(extractFolderId("https://docs.google.com/spreadsheets/d/1SheetId/edit")).toBe("");
  });

  it("空文字・空白のみは空文字", () => {
    expect(extractFolderId("")).toBe("");
    expect(extractFolderId("   ")).toBe("");
  });

  it("ID文字種以外を含む不正入力は空文字", () => {
    expect(extractFolderId("not a valid id !!!")).toBe("");
    expect(extractFolderId("https://example.com/foo")).toBe("");
  });
});
