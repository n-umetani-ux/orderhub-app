import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { getActiveSheetIds } from "@/lib/monthly-sheets";
import { filterSheetKeys } from "@/lib/settings";

// 当月を 2026-06 に固定（走査範囲 MIN_MONTH(2026-04)〜当月+翌月(2026-07) が決定論的になる）
const NOW = new Date("2026-06-17T00:00:00+09:00");

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

// ─── getActiveSheetIds: 3段マージ ───

describe("getActiveSheetIds (overrides マージ)", () => {
  it("1. overrides がハードコードより優先される", () => {
    const baseline = getActiveSheetIds();
    const baseJune = baseline.find(r => r.yearMonth === "2026-06");

    const result = getActiveSheetIds({ "2026-06": "OVERRIDE_JUNE_ID" });
    const june = result.find(r => r.yearMonth === "2026-06");

    expect(june?.id).toBe("OVERRIDE_JUNE_ID");
    // ハードコード値とは別物であること（実際に上書きされている）
    expect(june?.id).not.toBe(baseJune?.id);
    // 他の月は影響を受けない
    expect(result.find(r => r.yearMonth === "2026-05")?.id)
      .toBe(baseline.find(r => r.yearMonth === "2026-05")?.id);
  });

  it("2. overrides の値が空文字ならハードコードへ縮退する", () => {
    const baseline = getActiveSheetIds();
    const baseJune = baseline.find(r => r.yearMonth === "2026-06");

    const result = getActiveSheetIds({ "2026-06": "" });
    const june = result.find(r => r.yearMonth === "2026-06");

    // 空文字は falsy → ハードコードの値が使われる
    expect(june?.id).toBe(baseJune?.id);
    expect(june?.id).toBeTruthy();
  });

  it("3. overrides 省略時は従来挙動と完全一致（後方互換）", () => {
    const baseline = getActiveSheetIds();
    expect(getActiveSheetIds(undefined)).toEqual(baseline);
    expect(getActiveSheetIds({})).toEqual(baseline);
  });

  it("4. overrides もハードコードも無い当月は env(DEFAULT_SHEET_ID) が効く", async () => {
    // DEFAULT_SHEET_ID はモジュールロード時に env を読むため、resetModules + stubEnv + 再import で検証
    vi.resetModules();
    vi.stubEnv("GOOGLE_SHEETS_ID", "ENV_FALLBACK_ID");
    // 当月をハードコード未登録の月(2026-08)に設定 → env フォールバック経路に入る
    vi.setSystemTime(new Date("2026-08-17T00:00:00+09:00"));

    const mod = await import("@/lib/monthly-sheets");
    const result = mod.getActiveSheetIds();
    const aug = result.find(r => r.yearMonth === "2026-08");

    expect(aug?.id).toBe("ENV_FALLBACK_ID");
  });

  it("5. 走査範囲外の月を overrides に入れても結果に含まれない", () => {
    const baseline = getActiveSheetIds();
    const result = getActiveSheetIds({ "2027-01": "FUTURE_ID" });

    expect(result.find(r => r.yearMonth === "2027-01")).toBeUndefined();
    // 範囲外指定は全体に影響しない
    expect(result).toEqual(baseline);
  });
});

// ─── filterSheetKeys ───

describe("filterSheetKeys", () => {
  it("sheet_ 接頭辞のキーを {YYYY-MM: id} に正規化する", () => {
    const result = filterSheetKeys({ "sheet_2026-08": "ABC_ID" });
    expect(result).toEqual({ "2026-08": "ABC_ID" });
  });

  it("sheet_ 以外のキー（adminEmails 等）は除外する", () => {
    const result = filterSheetKeys({
      adminEmails: "a@example.com",
      driveFolderId: "FOLDER_ID",
      "sheet_2026-08": "ABC_ID",
    });
    expect(result).toEqual({ "2026-08": "ABC_ID" });
  });

  it("値が空文字のキーは除外する（無効化＝フォールバックさせる）", () => {
    const result = filterSheetKeys({
      "sheet_2026-08": "",
      "sheet_2026-09": "  ", // 空白のみも除外
      "sheet_2026-10": "VALID_ID",
    });
    expect(result).toEqual({ "2026-10": "VALID_ID" });
  });

  it("空オブジェクトは空オブジェクトを返す", () => {
    expect(filterSheetKeys({})).toEqual({});
  });
});
