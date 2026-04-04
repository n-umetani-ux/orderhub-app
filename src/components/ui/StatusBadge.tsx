import { EngineerStatus, STATUS_CONFIG } from "@/types";

export function StatusBadge({ status }: { status: EngineerStatus }) {
  const c = STATUS_CONFIG[status];
  return (
    <span
      className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-xs font-semibold border"
      style={{ color: c.color, background: c.bg, borderColor: c.ring }}
    >
      <span
        className="w-1.5 h-1.5 rounded-full inline-block"
        style={{ background: c.color }}
      />
      {c.label}
    </span>
  );
}
