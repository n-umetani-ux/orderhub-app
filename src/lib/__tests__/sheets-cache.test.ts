import { describe, it, expect, beforeEach, vi } from "vitest";
import { loadCache, saveCache, clearCache, formatCachedAt } from "@/lib/sheets-cache";

// localStorage のモック
const store: Record<string, string> = {};
const localStorageMock = {
  getItem: vi.fn((key: string) => store[key] ?? null),
  setItem: vi.fn((key: string, val: string) => { store[key] = val; }),
  removeItem: vi.fn((key: string) => { delete store[key]; }),
  clear: vi.fn(() => { for (const k in store) delete store[k]; }),
  get length() { return Object.keys(store).length; },
  key: vi.fn((i: number) => Object.keys(store)[i] ?? null),
};
vi.stubGlobal("localStorage", localStorageMock);

beforeEach(() => {
  localStorageMock.clear();
  vi.clearAllMocks();
});

describe("saveCache / loadCache", () => {
  it("保存したデータを読み込める", () => {
    const engineers = [{ manNo: "170156", name: "テスト太郎" }];
    saveCache("test@example.com", engineers);

    const result = loadCache("test@example.com");
    expect(result).not.toBeNull();
    expect(result!.engineers).toEqual(engineers);
    expect(result!.cachedAt).toBeTruthy();
  });

  it("異なるメールアドレスのキャッシュは分離される", () => {
    saveCache("a@example.com", [{ id: 1 }]);
    saveCache("b@example.com", [{ id: 2 }]);

    expect(loadCache("a@example.com")!.engineers).toEqual([{ id: 1 }]);
    expect(loadCache("b@example.com")!.engineers).toEqual([{ id: 2 }]);
  });

  it("キャッシュが存在しない場合はnullを返す", () => {
    expect(loadCache("nobody@example.com")).toBeNull();
  });
});

describe("clearCache", () => {
  it("キャッシュを削除できる", () => {
    saveCache("test@example.com", []);
    expect(loadCache("test@example.com")).not.toBeNull();

    clearCache("test@example.com");
    expect(loadCache("test@example.com")).toBeNull();
  });
});

describe("formatCachedAt", () => {
  it("ISO文字列を日本語フォーマットに変換する", () => {
    const result = formatCachedAt("2026-04-04T09:30:00Z");
    // ロケールによりフォーマットは異なるが、数字が含まれることを確認
    expect(result).toMatch(/4/);  // 月
    expect(result).toMatch(/\d{1,2}:\d{2}/);  // 時:分
  });
});
