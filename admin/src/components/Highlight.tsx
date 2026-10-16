// A name with the searched part marked.
export function Highlight({ text, query }: { text: string; query: string }) {
  const q = query.trim().toLowerCase();
  const at = q ? text.toLowerCase().indexOf(q) : -1;
  if (at < 0) return <>{text}</>;
  return <>{text.slice(0, at)}<mark className="hl">{text.slice(at, at + q.length)}</mark>{text.slice(at + q.length)}</>;
}
