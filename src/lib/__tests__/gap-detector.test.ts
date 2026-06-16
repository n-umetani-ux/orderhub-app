import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { detectStatus, toEngineer, selectEffectiveOrders, OrderRecord } from "@/lib/gap-detector";
import type { SheetsEngineer } from "@/types";

// テスト用の基準日を 2026-04-04 に固定
const NOW = new Date("2026-04-04T09:00:00Z");

function makeEng(overrides: Partial<SheetsEngineer> = {}): SheetsEngineer {
  return {
    manNo: "170156",
    kubun: "派遣",
    name: "テスト太郎",
    activity: 1.0,
    ending: 0,
    customer: "テスト株式会社",
    tantou: "梅谷",
    customerCode: "C0105",
    loc: "東京",
    ...overrides,
  };
}

function makeOrder(start: string, end: string): OrderRecord {
  return { manNo: "170156", contractStart: start, contractEnd: end };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
});

// ─── detectStatus ───

describe("detectStatus", () => {
  it("isArchived=true → archived", () => {
    const eng = makeEng();
    const orders = [makeOrder("2026-04-01", "2026-06-30")];
    expect(detectStatus(eng, orders, true)).toBe("archived");
  });

  it("ending=1.0 → ending（注文書ありでも）", () => {
    const eng = makeEng({ ending: 1.0 });
    const orders = [makeOrder("2026-04-01", "2026-06-30")];
    expect(detectStatus(eng, orders)).toBe("ending");
  });

  it("ending=1.0 + 注文書なし → ending（gapではない）", () => {
    const eng = makeEng({ ending: 1.0 });
    expect(detectStatus(eng, [])).toBe("ending");
  });

  it("有効注文書なし → gap", () => {
    const eng = makeEng();
    expect(detectStatus(eng, [])).toBe("gap");
  });

  it("過去の注文書のみ → gap", () => {
    const eng = makeEng();
    const orders = [makeOrder("2025-01-01", "2025-12-31")];
    expect(detectStatus(eng, orders)).toBe("gap");
  });

  it("未来の注文書のみ → gap", () => {
    const eng = makeEng();
    const orders = [makeOrder("2026-05-01", "2026-08-31")];
    expect(detectStatus(eng, orders)).toBe("gap");
  });

  it("残日数14日以内 → expiring", () => {
    const eng = makeEng();
    // 2026-04-04 + 10日 = 2026-04-14
    const orders = [makeOrder("2026-04-01", "2026-04-14")];
    expect(detectStatus(eng, orders)).toBe("expiring");
  });

  it("残日数ちょうど14日 → expiring", () => {
    const eng = makeEng();
    const orders = [makeOrder("2026-04-01", "2026-04-18")];
    expect(detectStatus(eng, orders)).toBe("expiring");
  });

  it("残日数15日以上 → normal", () => {
    const eng = makeEng();
    const orders = [makeOrder("2026-04-01", "2026-06-30")];
    expect(detectStatus(eng, orders)).toBe("normal");
  });

  it("複数注文書 → 最も遅い終了日で判定", () => {
    const eng = makeEng();
    const orders = [
      makeOrder("2026-04-01", "2026-04-10"), // 6日 → expiring
      makeOrder("2026-04-01", "2026-06-30"), // 87日 → normal
    ];
    // 最遅は06-30 → normal
    expect(detectStatus(eng, orders)).toBe("normal");
  });

  it("archived は ending より優先", () => {
    const eng = makeEng({ ending: 1.0 });
    expect(detectStatus(eng, [], true)).toBe("archived");
  });
});

// ─── toEngineer ───

describe("toEngineer", () => {
  it("基本変換が正しい", () => {
    const eng = makeEng();
    const orders = [makeOrder("2026-04-01", "2026-06-30")];
    const result = toEngineer(eng, orders);

    expect(result.manNo).toBe(170156);
    expect(result.name).toBe("テスト太郎");
    expect(result.type).toBe("派遣");
    expect(result.customer).toBe("テスト株式会社");
    expect(result.code).toBe("C0105");
    expect(result.tantou).toBe("梅谷");
    expect(result.loc).toBe("東京");
    expect(result.ending).toBe(0);
    expect(result.contract).toBe("2026-04-01|2026-06-30");
    expect(result.status).toBe("normal");
  });

  it("ending=1.0 → ending=1", () => {
    const eng = makeEng({ ending: 1.0 });
    const result = toEngineer(eng, []);
    expect(result.ending).toBe(1);
    expect(result.status).toBe("ending");
  });

  it("注文書なし → contract空文字", () => {
    const eng = makeEng();
    const result = toEngineer(eng, []);
    expect(result.contract).toBe("");
    expect(result.status).toBe("gap");
  });

  it("isArchived=true → status=archived", () => {
    const eng = makeEng();
    const orders = [makeOrder("2026-04-01", "2026-06-30")];
    const result = toEngineer(eng, orders, true);
    expect(result.status).toBe("archived");
  });

  it("複数注文書 → 最新終了日の注文書をcontractに使用", () => {
    const eng = makeEng();
    const orders = [
      makeOrder("2026-03-01", "2026-04-30"),
      makeOrder("2026-05-01", "2026-07-31"),
    ];
    const result = toEngineer(eng, orders);
    expect(result.contract).toBe("2026-05-01|2026-07-31");
  });
});

// ─── selectEffectiveOrders ───

function ord(start: string, end: string, uploadedAt = "", manNo = "170156", customerCode = ""): OrderRecord {
  return { manNo, contractStart: start, contractEnd: end, uploadedAt, customerCode };
}

describe("selectEffectiveOrders", () => {
  it("短縮: 旧4-9 + 新4-6 → 新4-6のみ採用（旧4-9を除外）", () => {
    const orders = [
      ord("2026-04-01", "2026-09-30", "2026-04-01T00:00:00Z"), // 旧（広い）
      ord("2026-04-01", "2026-06-30", "2026-04-10T00:00:00Z"), // 新（短縮後）
    ];
    const result = selectEffectiveOrders(orders);
    expect(result).toHaveLength(1);
    expect(result[0].contractEnd).toBe("2026-06-30");
  });

  it("延長: 旧4-6 + 新4-9 → 新4-9のみ採用（旧4-6を除外）", () => {
    const orders = [
      ord("2026-04-01", "2026-06-30", "2026-04-01T00:00:00Z"), // 旧
      ord("2026-04-01", "2026-09-30", "2026-04-10T00:00:00Z"), // 新（延長後）
    ];
    const result = selectEffectiveOrders(orders);
    expect(result).toHaveLength(1);
    expect(result[0].contractEnd).toBe("2026-09-30");
  });

  it("連続: 4-6 + 7-9（重ならない）→ 両方保持", () => {
    const orders = [
      ord("2026-04-01", "2026-06-30", "2026-04-01T00:00:00Z"),
      ord("2026-07-01", "2026-09-30", "2026-06-20T00:00:00Z"),
    ];
    const result = selectEffectiveOrders(orders);
    expect(result).toHaveLength(2);
    expect(result.map(o => o.contractEnd)).toEqual(["2026-06-30", "2026-09-30"]); // 元の並び順を維持
  });

  it("uploadedAt欠損フォールバック: 両方空 → 配列後方を新しいとみなす（旧4-9を除外）", () => {
    const orders = [
      ord("2026-04-01", "2026-09-30", ""), // 配列前方＝古い扱い
      ord("2026-04-01", "2026-06-30", ""), // 配列後方＝新しい扱い
    ];
    const result = selectEffectiveOrders(orders);
    expect(result).toHaveLength(1);
    expect(result[0].contractEnd).toBe("2026-06-30");
  });

  it("3件チェーン: 4-9 / 4-6 / 7-9 混在 → 重なる古い4-9のみ除外、連続は保持", () => {
    const orders = [
      ord("2026-04-01", "2026-09-30", "2026-04-01T00:00:00Z"), // 旧（最古・広い）
      ord("2026-04-01", "2026-06-30", "2026-04-10T00:00:00Z"), // 新（短縮後）
      ord("2026-07-01", "2026-09-30", "2026-06-20T00:00:00Z"), // 新（連続）
    ];
    const result = selectEffectiveOrders(orders);
    expect(result).toHaveLength(2);
    expect(result.map(o => o.contractEnd).sort()).toEqual(["2026-06-30", "2026-09-30"]);
  });

  it("多顧客並行: 同一manNo・顧客X(4-6) + 顧客Y(5-9・重なる) → 別顧客なので両方保持", () => {
    const orders = [
      ord("2026-04-01", "2026-06-30", "2026-04-01T00:00:00Z", "170156", "C0001"), // 顧客X
      ord("2026-05-01", "2026-09-30", "2026-04-10T00:00:00Z", "170156", "C0002"), // 顧客Y（期間は重なる）
    ];
    const result = selectEffectiveOrders(orders);
    expect(result).toHaveLength(2); // customerCode が異なるため dedup されない
  });

  it("同一顧客内の短縮: 顧客X 旧4-9 + 新4-6 → 新4-6のみ採用（顧客内 dedup は効く）", () => {
    const orders = [
      ord("2026-04-01", "2026-09-30", "2026-04-01T00:00:00Z", "170156", "C0001"), // 旧
      ord("2026-04-01", "2026-06-30", "2026-04-10T00:00:00Z", "170156", "C0001"), // 新（短縮後）
    ];
    const result = selectEffectiveOrders(orders);
    expect(result).toHaveLength(1);
    expect(result[0].contractEnd).toBe("2026-06-30");
  });
});
