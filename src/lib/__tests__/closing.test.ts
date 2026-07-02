import { describe, it, expect } from "vitest";
import {
  isValidMonthKey,
  closingStatusKey,
  getClosingMonths,
  orderCoversMonth,
  computeMonthlyGapCounts,
  parseClosingStatusValue,
  buildClosingStatusValue,
  buildCancelledStatusValue,
  contractMonthKey,
  isMonthClosed,
  buildMovePreview,
  type ClosingEngineer,
  type PreviewOrderRow,
} from "@/lib/closing";
import { OrderRecord } from "@/lib/gap-detector";

describe("isValidMonthKey", () => {
  it("YYYY-MM（01-12）を許可する", () => {
    expect(isValidMonthKey("2026-04")).toBe(true);
    expect(isValidMonthKey("2026-12")).toBe(true);
    expect(isValidMonthKey("2026-01")).toBe(true);
  });
  it("形式違い・範囲外は拒否する", () => {
    expect(isValidMonthKey("2026-13")).toBe(false);
    expect(isValidMonthKey("2026-00")).toBe(false);
    expect(isValidMonthKey("2026-4")).toBe(false);
    expect(isValidMonthKey("2026/04")).toBe(false);
    expect(isValidMonthKey("")).toBe(false);
    expect(isValidMonthKey("abc")).toBe(false);
  });
});

describe("closingStatusKey", () => {
  it("接頭辞付きのキーを返す", () => {
    expect(closingStatusKey("2026-04")).toBe("closing_status:2026-04");
  });
});

describe("getClosingMonths", () => {
  it("2026-04 から当月まで両端含めて昇順で返す", () => {
    expect(getClosingMonths("2026-06")).toEqual(["2026-04", "2026-05", "2026-06"]);
  });
  it("当月が開始月と同じなら1件", () => {
    expect(getClosingMonths("2026-04")).toEqual(["2026-04"]);
  });
  it("年をまたぐ", () => {
    expect(getClosingMonths("2027-01")).toEqual([
      "2026-04", "2026-05", "2026-06", "2026-07", "2026-08", "2026-09",
      "2026-10", "2026-11", "2026-12", "2027-01",
    ]);
  });
  it("当月が開始月より前なら空", () => {
    expect(getClosingMonths("2026-03")).toEqual([]);
  });
});

describe("orderCoversMonth", () => {
  const o = (s: string, e: string): OrderRecord => ({ manNo: "1", contractStart: s, contractEnd: e });
  it("契約期間が月と重なればカバー", () => {
    expect(orderCoversMonth(o("2026-04-01", "2026-06-30"), "2026-05")).toBe(true);
    expect(orderCoversMonth(o("2026-04-15", "2026-04-20"), "2026-04")).toBe(true);
  });
  it("月初・月末の端をまたぐケースもカバー", () => {
    expect(orderCoversMonth(o("2026-05-31", "2026-07-01"), "2026-06")).toBe(true);
  });
  it("重ならなければ非カバー", () => {
    expect(orderCoversMonth(o("2026-04-01", "2026-04-30"), "2026-05")).toBe(false);
  });
  it("日付欠損は非カバー", () => {
    expect(orderCoversMonth(o("", "2026-06-30"), "2026-05")).toBe(false);
  });
});

describe("computeMonthlyGapCounts", () => {
  const months = ["2026-04", "2026-05"];

  it("注文書なしの稼働者はギャップ、ありはカバー", () => {
    const engineers: ClosingEngineer[] = [
      { manNo: "100001", activeMonths: ["2026-04", "2026-05"] }, // ギャップ
      { manNo: "100002", activeMonths: ["2026-04", "2026-05"] }, // 4-5月カバー
    ];
    const orders: Record<string, OrderRecord[]> = {
      "100002": [{ manNo: "100002", contractStart: "2026-04-01", contractEnd: "2026-05-31" }],
    };
    expect(computeMonthlyGapCounts(engineers, orders, months)).toEqual({ "2026-04": 1, "2026-05": 1 });
  });

  it("その月に非稼働ならギャップに数えない", () => {
    const engineers: ClosingEngineer[] = [
      { manNo: "100001", activeMonths: ["2026-05"] }, // 4月は対象外
    ];
    expect(computeMonthlyGapCounts(engineers, {}, months)).toEqual({ "2026-04": 0, "2026-05": 1 });
  });

  it("activeMonths 空は全月稼働扱い", () => {
    const engineers: ClosingEngineer[] = [{ manNo: "100001", activeMonths: [] }];
    expect(computeMonthlyGapCounts(engineers, {}, months)).toEqual({ "2026-04": 1, "2026-05": 1 });
  });

  it("アーカイブ済みは除外", () => {
    const engineers: ClosingEngineer[] = [{ manNo: "100001", activeMonths: ["2026-04", "2026-05"] }];
    expect(computeMonthlyGapCounts(engineers, {}, months, new Set(["100001"]))).toEqual({ "2026-04": 0, "2026-05": 0 });
  });

  it("dedup: 短縮で隠れる古い行は無視され、ギャップが顕在化する", () => {
    // 4-9月の古い行を、後から登録した4-6月の新しい行が上書き → 7月以降は非カバー
    const engineers: ClosingEngineer[] = [{ manNo: "100001", customerCode: "C1", activeMonths: ["2026-06", "2026-07"] }];
    const orders: Record<string, OrderRecord[]> = {
      "100001": [
        { manNo: "100001", customerCode: "C1", contractStart: "2026-04-01", contractEnd: "2026-09-30", uploadedAt: "2026-04-01T00:00:00Z" },
        { manNo: "100001", customerCode: "C1", contractStart: "2026-04-01", contractEnd: "2026-06-30", uploadedAt: "2026-06-01T00:00:00Z" },
      ],
    };
    const result = computeMonthlyGapCounts(engineers, orders, ["2026-06", "2026-07"]);
    expect(result).toEqual({ "2026-06": 0, "2026-07": 1 });
  });
});

describe("parseClosingStatusValue / buildClosingStatusValue", () => {
  it("done:{ISO}:{email} をパースできる（ISOのコロンを保持）", () => {
    const parsed = parseClosingStatusValue("done:2026-06-22T10:00:00.000Z:ume@beat-tech.co.jp");
    expect(parsed).toEqual({ closedAt: "2026-06-22T10:00:00.000Z", closedBy: "ume@beat-tech.co.jp" });
  });
  it("build → parse でラウンドトリップする", () => {
    const v = buildClosingStatusValue("2026-06-22T10:00:00.000Z", "a@b.co.jp");
    expect(v).toBe("done:2026-06-22T10:00:00.000Z:a@b.co.jp");
    expect(parseClosingStatusValue(v)).toEqual({ closedAt: "2026-06-22T10:00:00.000Z", closedBy: "a@b.co.jp" });
  });
  it("未締め・空・不正値は null", () => {
    expect(parseClosingStatusValue("")).toBeNull();
    expect(parseClosingStatusValue("open")).toBeNull();
    expect(parseClosingStatusValue("done:")).toBeNull();
    expect(parseClosingStatusValue("done:onlyone")).toBeNull();
  });
});

// 締め済み月シャットアウト（Finding F-1）の判定ロジック
describe("contractMonthKey", () => {
  it("契約開始日（YYYY-MM-DD）から対象月 YYYY-MM を取り出す", () => {
    expect(contractMonthKey("2026-05-01")).toBe("2026-05");
    expect(contractMonthKey("2026-05-31")).toBe("2026-05");
    expect(contractMonthKey("2026-05")).toBe("2026-05"); // 月のみでも可
  });
  it("前後の空白はトリムして判定する", () => {
    expect(contractMonthKey("  2026-05-01  ")).toBe("2026-05");
  });
  it("欠落・不正な入力は null（呼び出し側は400で拒否）", () => {
    expect(contractMonthKey("")).toBeNull();
    expect(contractMonthKey("   ")).toBeNull();
    expect(contractMonthKey(null)).toBeNull();
    expect(contractMonthKey(undefined)).toBeNull();
    expect(contractMonthKey("2026/05/01")).toBeNull();
    expect(contractMonthKey("2026-13-01")).toBeNull(); // 月範囲外
  });
});

describe("isMonthClosed", () => {
  // 2026-05 のみ締め済みの設定マップ
  const settings: Record<string, string> = {
    [closingStatusKey("2026-05")]: buildClosingStatusValue("2026-06-22T10:00:00.000Z", "ume@beat-tech.co.jp"),
  };

  it("締め済み月は true（登録拒否＝409相当）", () => {
    expect(isMonthClosed(settings, "2026-05")).toBe(true);
  });
  it("未締め月・設定なしは false（登録通過）", () => {
    expect(isMonthClosed(settings, "2026-04")).toBe(false);
    expect(isMonthClosed(settings, "2026-06")).toBe(false);
    expect(isMonthClosed({}, "2026-05")).toBe(false);
  });
  it("月境界: 締め月(2026-05)の前月末・翌月頭は別月として通過し、当月末は拒否", () => {
    // 前月末 2026-04-30 → 2026-04（未締め＝通過）
    expect(isMonthClosed(settings, contractMonthKey("2026-04-30")!)).toBe(false);
    // 当月末 2026-05-31 → 2026-05（締め済み＝拒否）
    expect(isMonthClosed(settings, contractMonthKey("2026-05-31")!)).toBe(true);
    // 翌月頭 2026-06-01 → 2026-06（未締め＝通過）
    expect(isMonthClosed(settings, contractMonthKey("2026-06-01")!)).toBe(false);
  });
});

// 締め解除（ステップ②・案a: cancelled: 記録）
describe("buildCancelledStatusValue / 解除後のゲート挙動", () => {
  it("cancelled:{ISO}:{email} を生成する", () => {
    expect(buildCancelledStatusValue("2026-07-02T00:00:00.000Z", "ume@beat-tech.co.jp"))
      .toBe("cancelled:2026-07-02T00:00:00.000Z:ume@beat-tech.co.jp");
  });
  it("解除値は締め済みと解釈されず、isMonthClosed が false（ステップ①ゲートが開く）", () => {
    const key = closingStatusKey("2026-05");
    // 締め済み → true
    const closed = { [key]: buildClosingStatusValue("2026-06-22T10:00:00.000Z", "ume@beat-tech.co.jp") };
    expect(isMonthClosed(closed, "2026-05")).toBe(true);
    // 解除でセル値を cancelled: に更新 → false（登録可能に戻る）
    const cancelled = { [key]: buildCancelledStatusValue("2026-07-02T00:00:00.000Z", "ume@beat-tech.co.jp") };
    expect(isMonthClosed(cancelled, "2026-05")).toBe(false);
    // parseClosingStatusValue も cancelled: は null（done: 以外は締め済みでない）
    expect(parseClosingStatusValue(cancelled[key])).toBeNull();
  });
});

// 移動対象プレビューの分類（ステップ③）
describe("buildMovePreview", () => {
  const mk = (
    o: Partial<PreviewOrderRow> & { manNo: string; contractStart: string; contractEnd: string },
  ): PreviewOrderRow => ({ name: "", fileName: "", driveLink: "", customerCode: "C1", uploadedAt: "", ...o });

  it("差し替え: 新row=有効🟢+Driveあり / 旧row=dedup隠れ⚪+Driveなし（対象月に両方返る）", () => {
    const rows: PreviewOrderRow[] = [
      mk({ manNo: "100", fileName: "old.pdf", contractStart: "2026-04-01", contractEnd: "2026-09-30", uploadedAt: "2026-04-01T00:00:00Z", driveLink: "" }),
      mk({ manNo: "100", fileName: "new.pdf", contractStart: "2026-04-01", contractEnd: "2026-06-30", uploadedAt: "2026-06-01T00:00:00Z", driveLink: "http://drive/new" }),
    ];
    const res = buildMovePreview(rows, "2026-04");
    expect(res.total).toBe(2);
    expect(res.hiddenCount).toBe(1);
    const neu = res.rows.find(r => r.fileName === "new.pdf")!;
    const old = res.rows.find(r => r.fileName === "old.pdf")!;
    expect(neu.effective).toBe(true);
    expect(neu.hasDriveFile).toBe(true);
    expect(old.effective).toBe(false);
    expect(old.hasDriveFile).toBe(false);
  });

  it("連続契約（期間が重ならない）は両方 effective=true（dedupで消えない）", () => {
    const rows: PreviewOrderRow[] = [
      mk({ manNo: "200", fileName: "q1.pdf", contractStart: "2026-04-01", contractEnd: "2026-06-30", driveLink: "http://d/1" }),
      mk({ manNo: "200", fileName: "q2.pdf", contractStart: "2026-07-01", contractEnd: "2026-09-30", driveLink: "http://d/2" }),
    ];
    const apr = buildMovePreview(rows, "2026-04");
    expect(apr.total).toBe(1);
    expect(apr.hiddenCount).toBe(0);
    expect(apr.rows[0].effective).toBe(true);
    const jul = buildMovePreview(rows, "2026-07");
    expect(jul.total).toBe(1);
    expect(jul.rows[0].effective).toBe(true);
  });

  it("対象月フィルタ境界: contractStart の月が一致する行のみ返る（前月末・翌月頭は対象外）", () => {
    const rows: PreviewOrderRow[] = [
      mk({ manNo: "300", fileName: "mar.pdf", contractStart: "2026-03-31", contractEnd: "2026-08-31" }),
      mk({ manNo: "301", fileName: "apr1.pdf", contractStart: "2026-04-01", contractEnd: "2026-04-30" }),
      mk({ manNo: "302", fileName: "apr30.pdf", contractStart: "2026-04-30", contractEnd: "2026-10-31" }),
      mk({ manNo: "303", fileName: "may.pdf", contractStart: "2026-05-01", contractEnd: "2026-09-30" }),
    ];
    const apr = buildMovePreview(rows, "2026-04");
    expect(apr.rows.map(r => r.fileName).sort()).toEqual(["apr1.pdf", "apr30.pdf"]);
    expect(apr.total).toBe(2);
  });

  it("別顧客の並行稼働は別系列で保持（誤ってdedup隠れにしない）・Driveリンク有無を区別", () => {
    const rows: PreviewOrderRow[] = [
      mk({ manNo: "400", customerCode: "C1", fileName: "c1.pdf", contractStart: "2026-04-01", contractEnd: "2026-06-30", driveLink: "http://d/c1" }),
      mk({ manNo: "400", customerCode: "C2", fileName: "c2.pdf", contractStart: "2026-04-01", contractEnd: "2026-06-30", driveLink: "   " }),
    ];
    const res = buildMovePreview(rows, "2026-04");
    expect(res.total).toBe(2);
    expect(res.hiddenCount).toBe(0);
    expect(res.rows.every(r => r.effective)).toBe(true);
    expect(res.rows.find(r => r.fileName === "c1.pdf")!.hasDriveFile).toBe(true);
    expect(res.rows.find(r => r.fileName === "c2.pdf")!.hasDriveFile).toBe(false); // 空白のみは無し扱い
  });
});
