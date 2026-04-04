import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { detectStatus, toEngineer, OrderRecord } from "@/lib/gap-detector";
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
