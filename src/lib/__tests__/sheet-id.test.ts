import { describe, it, expect } from "vitest";
import { extractSheetId } from "@/lib/sheet-id";

describe("extractSheetId", () => {
  it("Sheets URL からIDを抽出する", () => {
    expect(extractSheetId("https://docs.google.com/spreadsheets/d/1AbC-_xyz123/edit"))
      .toBe("1AbC-_xyz123");
  });

  it("クエリ/フラグメント付きURL（/edit#gid=0・?usp=sharing）でもID部分だけ取れる", () => {
    expect(extractSheetId("https://docs.google.com/spreadsheets/d/1AbC-_xyz123/edit#gid=0"))
      .toBe("1AbC-_xyz123");
    expect(extractSheetId("https://docs.google.com/spreadsheets/d/1AbC-_xyz123/edit?usp=sharing"))
      .toBe("1AbC-_xyz123");
  });

  it("裸のIDはそのまま返す", () => {
    expect(extractSheetId("1AbC-_xyz123")).toBe("1AbC-_xyz123");
  });

  it("前後の空白はトリムする", () => {
    expect(extractSheetId("  1AbC-_xyz123  ")).toBe("1AbC-_xyz123");
  });

  it("Drive フォルダURLは Sheets ではないので空文字", () => {
    expect(extractSheetId("https://drive.google.com/drive/folders/1FolderId")).toBe("");
  });

  it("空文字・空白のみは空文字", () => {
    expect(extractSheetId("")).toBe("");
    expect(extractSheetId("   ")).toBe("");
  });

  it("ID文字種以外を含む不正入力は空文字", () => {
    expect(extractSheetId("not a valid id !!!")).toBe("");
    expect(extractSheetId("https://example.com/foo")).toBe("");
  });
});
