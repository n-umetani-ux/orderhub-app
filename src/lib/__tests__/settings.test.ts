import { describe, it, expect } from "vitest";
import { readSettingsMapOrThrow, filterSheetKeys } from "@/lib/settings";

// readSettingsMapOrThrow に渡す sheets クライアントの最小フェイク
type SheetsArg = Parameters<typeof readSettingsMapOrThrow>[0];
function fakeSheets(getImpl: () => Promise<unknown>): SheetsArg {
  return { spreadsheets: { values: { get: getImpl } } } as unknown as SheetsArg;
}

describe("readSettingsMapOrThrow（締め判定用・フェイルクローズ）", () => {
  it("設定シートを key/value マップに変換して返す（ヘッダー行はスキップ）", async () => {
    const sheets = fakeSheets(async () => ({
      data: {
        values: [
          ["key", "value"], // ヘッダー行 → 除外
          ["closing_status:2026-05", "done:2026-06-22T10:00:00.000Z:ume@beat-tech.co.jp"],
          ["adminEmails", "a@b.co.jp"],
          ["emptyVal"], // 値なし → ""
        ],
      },
    }));
    const map = await readSettingsMapOrThrow(sheets);
    expect(map["closing_status:2026-05"]).toBe("done:2026-06-22T10:00:00.000Z:ume@beat-tech.co.jp");
    expect(map["adminEmails"]).toBe("a@b.co.jp");
    expect(map["emptyVal"]).toBe("");
    expect(map["key"]).toBeUndefined(); // ヘッダー行は含めない
  });

  it("値が無い（values 欠落）場合は空マップ", async () => {
    const sheets = fakeSheets(async () => ({ data: {} }));
    expect(await readSettingsMapOrThrow(sheets)).toEqual({});
  });

  it("読み取り失敗時は throw する（readSettingsMap と違いフェイルオープンしない → 呼び出し側が503）", async () => {
    const sheets = fakeSheets(async () => {
      throw new Error("token expired");
    });
    await expect(readSettingsMapOrThrow(sheets)).rejects.toThrow();
  });
});

// 既存の純関数を併せて軽く回帰確認（設定マップ経由の締めキーが誤って sheet_ 扱いされないこと）
describe("filterSheetKeys", () => {
  it("closing_status: など非 sheet_ キーは月別シートIDに混入しない", () => {
    const result = filterSheetKeys({
      "sheet_2026-07": "ID07",
      "closing_status:2026-05": "done:...:ume",
      "adminEmails": "a@b.co.jp",
    });
    expect(result).toEqual({ "2026-07": "ID07" });
  });
});
