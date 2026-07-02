import { describe, it, expect, beforeEach, vi } from "vitest";
import { NextRequest } from "next/server";
import { closingStatusKey, buildClosingStatusValue, isMonthClosed } from "@/lib/closing";

// --- モック共有状態（vi.hoisted で mock ファクトリより先に初期化を保証） ---
const state = vi.hoisted(() => ({
  auth: undefined as unknown,
  settingsRows: [] as string[][],
}));
const updateSpy = vi.hoisted(() => vi.fn());
const appendSpy = vi.hoisted(() => vi.fn());

// verifyAuth はネットワーク検証を伴うためモック（execute と同じ認証パターン）
vi.mock("@/lib/firebase-admin", () => ({
  verifyAuth: () => Promise.resolve(state.auth),
}));

// googleapis の sheets クライアントを最小フェイクに差し替え
vi.mock("googleapis", () => ({
  google: {
    auth: { OAuth2: class { setCredentials() {} } },
    sheets: () => ({
      spreadsheets: {
        values: {
          get: () => Promise.resolve({ data: { values: state.settingsRows } }),
          update: (args: unknown) => { updateSpy(args); return Promise.resolve({}); },
          append: (args: unknown) => { appendSpy(args); return Promise.resolve({}); },
        },
        // appendOrUpdateSetting の設定シート存在確認（「設定」タブありとして作成をスキップ）
        get: () => Promise.resolve({ data: { sheets: [{ properties: { title: "設定" } }] } }),
        batchUpdate: () => Promise.resolve({}),
      },
    }),
  },
}));

import { POST } from "./route";

const ADMIN = "n-umetani@beat-tech.co.jp";
const MONTH = "2026-05";

function makeReq(body: unknown): NextRequest {
  return new NextRequest("http://localhost/api/closing/cancel", {
    method: "POST",
    headers: {
      authorization: "Bearer dummy",
      "x-google-access-token": "tok",
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

describe("POST /api/closing/cancel", () => {
  beforeEach(() => {
    updateSpy.mockClear();
    appendSpy.mockClear();
    // 既定: 管理者・対象月は締め済み
    state.auth = { ok: true, email: ADMIN, domain: "beat-tech.co.jp" };
    state.settingsRows = [
      ["key", "value"],
      [closingStatusKey(MONTH), buildClosingStatusValue("2026-06-22T10:00:00.000Z", ADMIN)],
    ];
  });

  it("締め済み月を管理者が解除できる（cancelled: を書き込み・解除後は未締め扱い）", async () => {
    const res = await POST(makeReq({ month: MONTH }));
    expect(res.status).toBe(200);
    const json = await res.json() as { ok: boolean; month: string; cancelledBy: string };
    expect(json.ok).toBe(true);
    expect(json.month).toBe(MONTH);
    expect(json.cancelledBy).toBe(ADMIN);

    // 書き込まれた値が cancelled: 始まり → ステップ①ゲートが開く
    expect(updateSpy).toHaveBeenCalledTimes(1);
    const written = (updateSpy.mock.calls[0][0] as { requestBody: { values: string[][] } })
      .requestBody.values[0][0];
    expect(written.startsWith("cancelled:")).toBe(true);
    expect(isMonthClosed({ [closingStatusKey(MONTH)]: written }, MONTH)).toBe(false);
  });

  it("非管理者は 403（解除を書き込まない）", async () => {
    state.auth = { ok: true, email: "sales@beat-tech.co.jp", domain: "beat-tech.co.jp" };
    state.settingsRows = [
      ["key", "value"],
      ["adminEmails", ADMIN], // sales は管理者に含まれない
      [closingStatusKey(MONTH), buildClosingStatusValue("2026-06-22T10:00:00.000Z", ADMIN)],
    ];
    const res = await POST(makeReq({ month: MONTH }));
    expect(res.status).toBe(403);
    expect(updateSpy).not.toHaveBeenCalled();
    expect(appendSpy).not.toHaveBeenCalled();
  });

  it("未締め月は 409（締められていない）", async () => {
    state.settingsRows = [["key", "value"]]; // 締めフラグなし
    const res = await POST(makeReq({ month: MONTH }));
    expect(res.status).toBe(409);
    const json = await res.json() as { error: string };
    expect(json.error).toContain("締められていません");
    expect(updateSpy).not.toHaveBeenCalled();
    expect(appendSpy).not.toHaveBeenCalled();
  });

  it("月形式が不正なら 400", async () => {
    const res = await POST(makeReq({ month: "2026/05" }));
    expect(res.status).toBe(400);
    expect(updateSpy).not.toHaveBeenCalled();
  });
});
