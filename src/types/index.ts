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
  "梅谷":  "n-umetani@beat-tech.co.jp",
  "工藤":  "a-kudo@beat-tech.co.jp",
  "小山":  "j-koyama@beat-tech.co.jp",
  "木村":  "k-kimura@beat-tech.co.jp",
  "平川":  "u-hirakawa@beat-tech.co.jp",
  "山田":  "t-yamada@beat-tech.co.jp",
  "衣笠":  "a-kinugasa@beat-tech.co.jp",
  "山口":  "t-yamaguchi@beat-tech.co.jp",
  "高山":  "m-takayama@beat-tech.co.jp",
  "杉本":  "h-sugimoto@beat-tech.co.jp",
  "田邉":  "k-tanabe@beat-tech.co.jp",
  "西川":  "r-nishikawa@beat-tech.co.jp",
  "尾上":  "h-onoue@beat-tech.co.jp",
  "緒方":  "a-ogata@beat-tech.co.jp",
};
