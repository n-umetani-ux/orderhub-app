import type { ReactNode } from "react";
import { SPEC_SECTIONS, SPEC_LAST_UPDATED } from "@/lib/spec-content";

/**
 * 仕様書ページ（表示専用・state/I/Oなし）。
 * 連続する "- " 始まりの行を1つの箇条書きリストにまとめ、それ以外は段落として描画する。
 */
function renderBody(body: readonly string[]): ReactNode[] {
  const blocks: ReactNode[] = [];
  let bullets: string[] = [];

  const flushBullets = (key: string) => {
    if (bullets.length === 0) return;
    blocks.push(
      <ul key={key} className="list-disc pl-5 space-y-1.5 text-sm leading-relaxed text-slate-700">
        {bullets.map((b, i) => <li key={i}>{b}</li>)}
      </ul>,
    );
    bullets = [];
  };

  body.forEach((line, i) => {
    if (line.startsWith("- ")) {
      bullets.push(line.slice(2));
    } else {
      flushBullets(`ul-${i}`);
      blocks.push(
        <p key={`p-${i}`} className="text-sm leading-relaxed text-slate-700">{line}</p>,
      );
    }
  });
  flushBullets("ul-end");

  return blocks;
}

export default function SpecPage() {
  return (
    <div className="max-w-3xl">
      <header className="mb-8 pb-4 border-b border-slate-200">
        <h1 className="text-2xl font-bold text-slate-900">仕様書</h1>
        <p className="text-sm text-slate-500 mt-1">最終更新: {SPEC_LAST_UPDATED}</p>
      </header>

      <div className="space-y-8">
        {SPEC_SECTIONS.map(section => (
          <section key={section.heading}>
            <h2 className="text-lg font-semibold text-slate-900 mb-2">{section.heading}</h2>
            <div className="space-y-3">{renderBody(section.body)}</div>
          </section>
        ))}
      </div>
    </div>
  );
}
