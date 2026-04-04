import { describe, it, expect } from "vitest";
import { parseRows, SENSITIVE_COLS } from "@/lib/sheets";

// COL indices: manNo=0, kubun=1, name=2, activity=3, ending=4, customer=5, tantou=6, customerCode=30

/** 31列分の空行を生成し、指定カラムだけ埋めるヘルパー */
function makeRow(fields: Record<number, string>): string[] {
  const row = new Array(31).fill("");
  for (const [idx, val] of Object.entries(fields)) {
    row[Number(idx)] = val;
  }
  return row;
}

const HEADER_ROW = makeRow({ 0: "manNo." });
const SECTION_REGULAR = makeRow({ 0: "正社員エンジニア一覧" });
const SECTION_STANDBY = makeRow({ 0: "待機一覧" });

function validEngineerRow(manNo = "170156", overrides: Record<number, string> = {}) {
  return makeRow({
    0: manNo,
    1: "派遣",
    2: "テスト太郎",
    3: "1.0",
    4: "0",
    5: "テスト株式会社",
    6: "梅谷",
    30: "C0105",
    ...overrides,
  });
}

describe("parseRows", () => {
  it("正常なデータを抽出できる", () => {
    const rows = [SECTION_REGULAR, HEADER_ROW, validEngineerRow()];
    const result = parseRows(rows, "東京");

    expect(result).toHaveLength(1);
    expect(result[0].manNo).toBe("170156");
    expect(result[0].name).toBe("テスト太郎");
    expect(result[0].kubun).toBe("派遣");
    expect(result[0].activity).toBe(1.0);
    expect(result[0].customer).toBe("テスト株式会社");
    expect(result[0].tantou).toBe("梅谷");
    expect(result[0].customerCode).toBe("C0105");
    expect(result[0].loc).toBe("東京");
  });

  it("待機一覧セクションはスキップされる", () => {
    const rows = [
      SECTION_STANDBY,
      HEADER_ROW,
      validEngineerRow("111111"),
      SECTION_REGULAR,
      HEADER_ROW,
      validEngineerRow("222222"),
    ];
    const result = parseRows(rows, "東京");

    expect(result).toHaveLength(1);
    expect(result[0].manNo).toBe("222222");
  });

  it("ヘッダー未検出前の行はスキップされる", () => {
    const rows = [
      SECTION_REGULAR,
      // ヘッダー行なし
      validEngineerRow(),
    ];
    const result = parseRows(rows, "東京");
    expect(result).toHaveLength(0);
  });

  it("3種類のヘッダーパターンを検出する", () => {
    for (const header of ["manNo.", "No.", "PJcode"]) {
      const headerRow = makeRow({ 0: header });
      const rows = [SECTION_REGULAR, headerRow, validEngineerRow()];
      const result = parseRows(rows, "東京");
      expect(result).toHaveLength(1);
    }
  });

  it("manNoが6桁でない行はスキップされる", () => {
    const rows = [
      SECTION_REGULAR,
      HEADER_ROW,
      validEngineerRow("12345"),   // 5桁 → スキップ
      validEngineerRow("1234567"), // 7桁 → スキップ
      validEngineerRow("abcdef"),  // 非数字 → スキップ
      validEngineerRow("170156"),  // 正常
    ];
    const result = parseRows(rows, "東京");
    expect(result).toHaveLength(1);
    expect(result[0].manNo).toBe("170156");
  });

  it("activity < 0.5 の行はスキップされる", () => {
    const rows = [
      SECTION_REGULAR,
      HEADER_ROW,
      validEngineerRow("111111", { 3: "0.0" }),  // 0 → スキップ
      validEngineerRow("222222", { 3: "0.3" }),  // 0.3 → スキップ
      validEngineerRow("333333", { 3: "0.5" }),  // 0.5 → 含む
      validEngineerRow("444444", { 3: "1.0" }),  // 1.0 → 含む
    ];
    const result = parseRows(rows, "東京");
    expect(result).toHaveLength(2);
    expect(result.map(e => e.manNo)).toEqual(["333333", "444444"]);
  });

  it("拠点が正しく設定される", () => {
    const rows = [SECTION_REGULAR, HEADER_ROW, validEngineerRow()];

    expect(parseRows(rows, "東京")[0].loc).toBe("東京");
    expect(parseRows(rows, "大阪")[0].loc).toBe("大阪");
    expect(parseRows(rows, "福岡")[0].loc).toBe("福岡");
  });

  it("endingフラグが正しくパースされる", () => {
    const rows = [
      SECTION_REGULAR,
      HEADER_ROW,
      validEngineerRow("111111", { 4: "1.0" }),
      validEngineerRow("222222", { 4: "" }),
      validEngineerRow("333333", { 4: "0" }),
    ];
    const result = parseRows(rows, "東京");
    expect(result[0].ending).toBe(1.0);
    expect(result[1].ending).toBe(0);
    expect(result[2].ending).toBe(0);
  });

  it("複数セクションを正しく処理する", () => {
    const rows = [
      SECTION_REGULAR,
      HEADER_ROW,
      validEngineerRow("111111"),
      makeRow({ 0: "個人事業主エンジニア一覧" }),
      makeRow({ 0: "No." }),
      validEngineerRow("222222"),
    ];
    const result = parseRows(rows, "東京");
    expect(result).toHaveLength(2);
  });

  it("空行は無視される", () => {
    const rows = [
      SECTION_REGULAR,
      HEADER_ROW,
      makeRow({}),  // 空行
      validEngineerRow(),
    ];
    const result = parseRows(rows, "東京");
    expect(result).toHaveLength(1);
  });
});

describe("SENSITIVE_COLS", () => {
  it("I列(8)からX列(23)までが含まれる", () => {
    expect(SENSITIVE_COLS.has(8)).toBe(true);   // I列
    expect(SENSITIVE_COLS.has(14)).toBe(true);  // O列(原価)
    expect(SENSITIVE_COLS.has(23)).toBe(true);  // X列(粗利)
    expect(SENSITIVE_COLS.size).toBe(16);       // 8〜23の16列
  });

  it("機密でない列は含まれない", () => {
    expect(SENSITIVE_COLS.has(0)).toBe(false);  // manNo
    expect(SENSITIVE_COLS.has(6)).toBe(false);  // tantou
    expect(SENSITIVE_COLS.has(7)).toBe(false);  // H列
    expect(SENSITIVE_COLS.has(24)).toBe(false); // Y列
    expect(SENSITIVE_COLS.has(30)).toBe(false); // AE列(customerCode)
  });
});
