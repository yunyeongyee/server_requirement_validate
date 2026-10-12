/** 클립보드의 HTML 표를 탭 구분 텍스트로 바꾼다. 빈 칸을 보존하고 병합 셀(colspan/rowspan)은
 *  값을 첫 칸에만 두고 나머지는 비워 둔다(rowspan 은 아래 행에 같은 값을 반복해 행 의미를 유지).
 *  표가 없으면 null → 기본 붙여넣기(일반 텍스트)를 그대로 쓴다. */
export function clipboardTableText(event: { clipboardData: DataTransfer | null }): string | null {
  const html = event.clipboardData?.getData("text/html");
  if (!html || !/<table/i.test(html)) return null;
  const table = new DOMParser().parseFromString(html, "text/html").querySelector("table");
  if (!table) return null;
  const grid: string[][] = [];
  Array.from(table.querySelectorAll("tr")).forEach((tr, r) => {
    const row: string[] = grid[r] ?? (grid[r] = []);
    let col = 0;
    const take = () => { while (row[col] !== undefined) col += 1; };
    Array.from(tr.children).forEach((cell) => {
      if (!/^t[dh]$/i.test(cell.tagName)) return;
      take();
      const text = (cell.textContent || "").replace(/\s+/g, " ").trim();
      const colspan = Math.max(1, Number(cell.getAttribute("colspan")) || 1);
      const rowspan = Math.max(1, Number(cell.getAttribute("rowspan")) || 1);
      for (let k = 0; k < colspan; k += 1) row[col + k] = k === 0 ? text : "";
      for (let d = 1; d < rowspan; d += 1) {
        const below = grid[r + d] ?? (grid[r + d] = []);
        below[col] = text;
        for (let k = 1; k < colspan; k += 1) below[col + k] = "";
      }
      col += colspan;
    });
  });
  const rows = grid.map((row) => Array.from(row, (c) => c ?? "").join("\t")).filter((line) => line.trim());
  return rows.length ? rows.join("\n") : null;
}

/** textarea onPaste 에서: 표면 가로채 탭 텍스트를 커서 위치에 넣는다. */
export function pasteTable(event: React.ClipboardEvent<HTMLTextAreaElement>, apply: (next: string) => void): void {
  const text = clipboardTableText(event);
  if (text == null) return;
  event.preventDefault();
  const area = event.currentTarget;
  const { selectionStart: a, selectionEnd: b, value } = area;
  apply(value.slice(0, a) + text + value.slice(b));
}
