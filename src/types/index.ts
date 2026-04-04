export type EngineerStatus = "gap" | "expiring" | "normal" | "ending" | "archived";

export type EngineerType = "派遣" | "委託" | "BP" | "its" | "eng";

export interface Engineer {
  manNo: number;
  name: string;
  type: EngineerType;
  customer: string;
  code: string;
  tantou: string;
  loc: "東京" | "大阪" | "福岡";
  ending: 0 | 1;
  contract: string; // "YYYY-MM-DD|YYYY-MM-DD"
  status: EngineerStatus;
  // 稼働一覧から取得
  kubun?: string;
  activity?: number; // D列: 稼働値
}

export interface SheetsEngineer {
  manNo: string;
  kubun: string;
  name: string;
  activity: number;
  ending: number;
  customer: string;
  tantou: string;
  customerCode: string;
  loc: "東京" | "大阪" | "福岡";
}

export const STATUS_CONFIG: Record<EngineerStatus, { label: string; color: string; bg: string; ring: string }> = {
  gap:      { label: "ギャップ発生", color: "#DC2626", bg: "#FEE2E2", ring: "#FECACA" },
  expiring: { label: "期限迫る",     color: "#D97706", bg: "#FEF3C7", ring: "#FDE68A" },
  normal:   { label: "正常",         color: "#059669", bg: "#D1FAE5", ring: "#A7F3D0" },
  ending:   { label: "当月終了",     color: "#EA580C", bg: "#FED7AA", ring: "#FDBA74" },
  archived: { label: "アーカイブ候補", color: "#1F2937", bg: "#C0C7D0", ring: "#6B7280" },
};

export const DEPTS: ReadonlyArray<{ code: string; name: string; loc: string }> = [
  { code: "1010", name: "東京ITS営業部", loc: "東京" },
  { code: "1110", name: "東京ENG営業部", loc: "東京" },
  { code: "2000", name: "大阪営業部",   loc: "大阪" },
  { code: "3000", name: "福岡営業部",   loc: "福岡" },
];

export const SALES_STAFF: Record<string, string> = {
  "梅谷":  "umetani@example.com",
  "工藤":  "kudo@example.com",
  "小山":  "koyama@example.com",
  "木村":  "kimura@example.com",
  "平川":  "hirakawa@example.com",
  "山田":  "yamada@example.com",
  "衣笠":  "kinugasa@example.com",
  "山口":  "yamaguchi@example.com",
  "高山":  "takayama@example.com",
  "杉本":  "sugimoto@example.com",
  "田邉":  "tanabe@example.com",
  "西川":  "nishikawa@example.com",
  "尾上":  "onoe@example.com",
};
