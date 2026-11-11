import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import {
  AlignCenter, Bold, Code, Heading1, Heading2, Heading3, Highlighter, ImagePlus, ImageUp, Italic, Link,
  List, ListChecks, ListOrdered, Minus, Palette, Quote, Strikethrough, Table, Underline,
} from 'lucide-react';
import { adminApi } from '../../api';

// Markdown/HTML source editor with a word-processor style toolbar. The toolbar
// only ever inserts GitHub Markdown or the small inline-HTML subset the server
// sanitiser keeps (span/mark colors, <u>, <div align>), so whatever it writes
// renders identically on Web and Android.

const IMAGE_URL = /^https?:\/\/[^\s<>"'`]+\.(?:png|jpe?g|gif|webp|avif|svg|bmp)(?:[?#][^\s<>"'`]*)?$/i;

const COLORS = [
  '#ef4444', '#f97316', '#f59e0b', '#10b981', '#06b6d4',
  '#3b82f6', '#6366f1', '#8b5cf6', '#ec4899', '#6b7280',
];
const HIGHLIGHTS = ['#fde68a', '#fecaca', '#bbf7d0', '#bfdbfe', '#ddd6fe', '#fbcfe8'];

// What the server takes for a picture (services/popupImages.ts).
const UPLOAD_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];
const UPLOAD_MAX_BYTES = 3 * 1024 * 1024;

// A file as the upload route wants it: base64 without the "data:…" in front.
function base64Of(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).replace(/^data:[^,]*,/, ''));
    reader.onerror = () => reject(new Error('Die Datei konnte nicht gelesen werden'));
    reader.readAsDataURL(file);
  });
}

interface Props {
  value: string;
  onChange: (value: string) => void;
}

export function PopupEditor({ value, onChange }: Props) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const [palette, setPalette] = useState<'color' | 'highlight' | null>(null);
  // Pictures being uploaded, and what went wrong with the last one.
  const [uploading, setUploading] = useState(0);
  const [uploadError, setUploadError] = useState('');

  useEffect(() => {
    if (!palette) return;
    const close = () => setPalette(null);
    window.addEventListener('click', close);
    return () => window.removeEventListener('click', close);
  }, [palette]);

  // Replace [start, end) and keep the native undo stack where the browser
  // supports it (execCommand is deprecated but still the only way to do so).
  function replace(start: number, end: number, text: string, selStart: number, selEnd: number) {
    const el = ref.current;
    if (!el) return;
    el.focus();
    el.setSelectionRange(start, end);
    const ok = document.execCommand?.('insertText', false, text);
    if (!ok) {
      onChange(el.value.slice(0, start) + text + el.value.slice(end));
    } else {
      onChange(el.value);
    }
    requestAnimationFrame(() => {
      el.focus();
      el.setSelectionRange(start + selStart, start + selEnd);
    });
  }

  function selection() {
    const el = ref.current!;
    return { start: el.selectionStart, end: el.selectionEnd, text: el.value.slice(el.selectionStart, el.selectionEnd) };
  }

  function wrap(before: string, after: string, placeholder: string) {
    const { start, end, text } = selection();
    const inner = text || placeholder;
    replace(start, end, before + inner + after, before.length, before.length + inner.length);
  }

  // Apply a line prefix to every line touched by the selection.
  function prefixLines(prefix: (i: number) => string) {
    const el = ref.current!;
    const v = el.value;
    const lineStart = v.lastIndexOf('\n', el.selectionStart - 1) + 1;
    let lineEnd = v.indexOf('\n', el.selectionEnd);
    if (lineEnd === -1) lineEnd = v.length;
    const lines = v.slice(lineStart, lineEnd).split('\n');
    const out = lines.map((l, i) => prefix(i) + l.replace(/^(#{1,6} |> |- \[[ x]\] |- |\d+\. )/, '')).join('\n');
    replace(lineStart, lineEnd, out, out.length, out.length);
  }

  // Insert a block on its own lines.
  function block(text: string, cursorOffset = text.length) {
    const el = ref.current!;
    const { start, end } = selection();
    const before = el.value.slice(0, start);
    const lead = before === '' || before.endsWith('\n\n') ? '' : before.endsWith('\n') ? '\n' : '\n\n';
    const full = `${lead}${text}\n`;
    replace(start, end, full, lead.length + cursorOffset, lead.length + cursorOffset);
  }

  function insertLink() {
    const { text } = selection();
    const url = window.prompt('Link-Adresse (https://…)', 'https://');
    if (!url || url === 'https://') return;
    const { start, end } = selection();
    const label = text || 'Linktext';
    replace(start, end, `[${label}](${url})`, 1, 1 + label.length);
  }

  function insertImage() {
    const url = window.prompt('Bild-URL (https://…/bild.png)', 'https://');
    if (!url || url === 'https://') return;
    const alt = selection().text;
    block(`![${alt}](${url.trim()})`);
  }

  // A picture from this computer: kept in the database (so in every backup),
  // named in the text by its path; the server draws it anew as WebP.
  async function uploadImages(files: File[]) {
    const pictures = files.filter((f) => f.type.startsWith('image/'));
    if (pictures.length === 0) return;
    setUploadError('');
    for (const file of pictures) {
      if (!UPLOAD_TYPES.includes(file.type)) { setUploadError(`${file.name}: nur JPEG, PNG, WebP oder GIF`); continue; }
      if (file.size > UPLOAD_MAX_BYTES) { setUploadError(`${file.name}: höchstens 3 MB`); continue; }
      setUploading((n) => n + 1);
      try {
        const { url } = await adminApi.uploadPopupImage(await base64Of(file), file.type);
        const alt = file.name.replace(/\.[^.]+$/, '').replace(/[[\]]/g, '').slice(0, 80);
        block(`![${alt}](${url})`);
      } catch (err) {
        setUploadError(`${file.name}: ${err instanceof Error ? err.message : 'Hochladen fehlgeschlagen'}`);
      } finally {
        setUploading((n) => n - 1);
      }
    }
  }

  function color(c: string) {
    wrap(`<span style="color:${c}">`, '</span>', 'Text');
    setPalette(null);
  }

  function highlight(c: string) {
    wrap(`<mark style="background-color:${c}">`, '</mark>', 'Text');
    setPalette(null);
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (!(e.ctrlKey || e.metaKey)) return;
    const k = e.key.toLowerCase();
    if (k === 'b') { e.preventDefault(); wrap('**', '**', 'fett'); }
    else if (k === 'i') { e.preventDefault(); wrap('*', '*', 'kursiv'); }
    else if (k === 'u') { e.preventDefault(); wrap('<u>', '</u>', 'unterstrichen'); }
    else if (k === 'k') { e.preventDefault(); insertLink(); }
  }

  // Pasting a bare image link inserts it as an image straight away; a pasted
  // picture (a screenshot) is uploaded.
  function onPaste(e: React.ClipboardEvent<HTMLTextAreaElement>) {
    const files = [...e.clipboardData.files].filter((f) => f.type.startsWith('image/'));
    if (files.length > 0) {
      e.preventDefault();
      void uploadImages(files);
      return;
    }
    const text = e.clipboardData.getData('text/plain').trim();
    if (!IMAGE_URL.test(text)) return;
    e.preventDefault();
    const { start, end } = selection();
    const md = `![](${text})`;
    replace(start, end, md, md.length, md.length);
  }

  const sep = <span className="w-px h-5 mx-1 flex-shrink-0" style={{ background: 'rgb(var(--ink-rgb) / calc(0.064 * var(--veil)))' }} />;

  return (
    <div className="rounded-[14px] overflow-hidden" style={{ background: 'var(--well)', border: '1px solid transparent' }}>
      <div className="flex items-center flex-wrap gap-0.5 px-2 py-1.5 relative"
        style={{ borderBottom: '1px solid rgb(var(--ink-rgb) / calc(0.087 * var(--veil)))', background: 'rgb(var(--ink-rgb) / calc(0.05 * var(--veil)))' }}>
        <Tool title="Überschrift 1" onClick={() => prefixLines(() => '# ')}><Heading1 size={16} /></Tool>
        <Tool title="Überschrift 2" onClick={() => prefixLines(() => '## ')}><Heading2 size={16} /></Tool>
        <Tool title="Überschrift 3" onClick={() => prefixLines(() => '### ')}><Heading3 size={16} /></Tool>
        {sep}
        <Tool title="Fett (Strg+B)" onClick={() => wrap('**', '**', 'fett')}><Bold size={15} /></Tool>
        <Tool title="Kursiv (Strg+I)" onClick={() => wrap('*', '*', 'kursiv')}><Italic size={15} /></Tool>
        <Tool title="Unterstrichen (Strg+U)" onClick={() => wrap('<u>', '</u>', 'unterstrichen')}><Underline size={15} /></Tool>
        <Tool title="Durchgestrichen" onClick={() => wrap('~~', '~~', 'durchgestrichen')}><Strikethrough size={15} /></Tool>
        {sep}
        <div className="relative" onClick={(e) => e.stopPropagation()}>
          <Tool title="Textfarbe" active={palette === 'color'} onClick={() => setPalette(palette === 'color' ? null : 'color')}><Palette size={15} /></Tool>
          {palette === 'color' && (
            <Swatches colors={COLORS} onPick={color} custom />
          )}
        </div>
        <div className="relative" onClick={(e) => e.stopPropagation()}>
          <Tool title="Hervorheben" active={palette === 'highlight'} onClick={() => setPalette(palette === 'highlight' ? null : 'highlight')}><Highlighter size={15} /></Tool>
          {palette === 'highlight' && (
            <Swatches colors={HIGHLIGHTS} onPick={highlight} custom />
          )}
        </div>
        {sep}
        <Tool title="Aufzählung" onClick={() => prefixLines(() => '- ')}><List size={16} /></Tool>
        <Tool title="Nummerierte Liste" onClick={() => prefixLines((i) => `${i + 1}. `)}><ListOrdered size={16} /></Tool>
        <Tool title="Checkliste" onClick={() => prefixLines(() => '- [ ] ')}><ListChecks size={16} /></Tool>
        <Tool title="Zitat" onClick={() => prefixLines(() => '> ')}><Quote size={15} /></Tool>
        <Tool title="Code" onClick={() => wrap('`', '`', 'code')}><Code size={15} /></Tool>
        {sep}
        <Tool title="Link (Strg+K)" onClick={insertLink}><Link size={15} /></Tool>
        <Tool title="Bild hochladen (auch einfügen oder hineinziehen)" onClick={() => fileRef.current?.click()}><ImageUp size={15} /></Tool>
        <Tool title="Bild-Link" onClick={insertImage}><ImagePlus size={15} /></Tool>
        <input ref={fileRef} type="file" accept={UPLOAD_TYPES.join(',')} multiple hidden
          onChange={(e) => { const files = [...(e.target.files ?? [])]; e.target.value = ''; void uploadImages(files); }} />
        <Tool title="Tabelle" onClick={() => block('| Spalte 1 | Spalte 2 |\n| --- | --- |\n| Wert | Wert |', 2)}><Table size={15} /></Tool>
        <Tool title="Trennlinie" onClick={() => block('---')}><Minus size={15} /></Tool>
        <Tool title="Zentrieren" onClick={() => wrap('<div align="center">\n\n', '\n\n</div>', 'Zentrierter Text')}><AlignCenter size={15} /></Tool>
      </div>
      <textarea
        ref={ref}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={onKeyDown}
        onPaste={onPaste}
        onDragOver={(e) => { if ([...e.dataTransfer.items].some((i) => i.kind === 'file')) e.preventDefault(); }}
        onDrop={(e) => {
          const files = [...e.dataTransfer.files];
          if (files.length === 0) return;
          e.preventDefault();
          void uploadImages(files);
        }}
        spellCheck
        placeholder={'Schreib hier… **fett**, # Überschrift, Bild-Links werden automatisch zu Bildern.\nMarkdown und HTML funktionieren.'}
        className="w-full block px-4 py-3 text-[13.5px] leading-[1.6] font-mono resize-y outline-none scrollbar-thin"
        style={{ background: 'transparent', color: 'rgb(var(--ink-rgb) / 0.98)', minHeight: 280 }}
      />
      {(uploading > 0 || uploadError) && (
        <div className="px-4 py-2 text-[12px]" role="status" style={{ borderTop: '1px solid rgb(var(--ink-rgb) / calc(0.087 * var(--veil)))', color: uploadError ? 'var(--rose-deep)' : 'rgb(var(--ink-rgb) / 0.62)' }}>
          {uploading > 0 ? 'Bild wird hochgeladen…' : uploadError}
        </div>
      )}
    </div>
  );
}

function Tool({ title, onClick, children, active }: { title: string; onClick: () => void; children: ReactNode; active?: boolean }) {
  return (
    <button
      type="button"
      title={title}
      aria-label={title}
      // Keep the textarea selection while clicking the toolbar.
      onMouseDown={(e) => e.preventDefault()}
      onClick={onClick}
      className="w-8 h-8 flex items-center justify-center rounded-full transition-colors hover:bg-ink/[0.1]"
      style={{ color: active ? 'var(--sky-deep)' : 'rgb(var(--ink-rgb) / 0.82)', background: active ? 'rgba(60,135,215,0.14)' : undefined }}
    >
      {children}
    </button>
  );
}

function Swatches({ colors, onPick, custom }: { colors: string[]; onPick: (c: string) => void; custom?: boolean }) {
  // The native picker fires on every drag step, so a custom color is applied explicitly.
  const [customColor, setCustomColor] = useState('#6366f1');
  return (
    <div className="absolute z-30 top-9 left-0 p-2 rounded-[14px]"
      style={{ background: 'var(--well-2)', border: '1px solid transparent', width: 188 }}>
      <div className="grid grid-cols-5 gap-1.5">
        {colors.map((c) => (
          <button key={c} type="button" title={c} onMouseDown={(e) => e.preventDefault()} onClick={() => onPick(c)}
            className="w-7 h-7 rounded-full transition-transform hover:scale-110"
            style={{ background: c, border: '2px solid rgb(var(--ink-rgb) / calc(0.16 * var(--veil)))' }} />
        ))}
      </div>
      {custom && (
        <div className="mt-2 flex items-center gap-2 text-[12px]" style={{ color: 'rgb(var(--ink-rgb) / 0.74)' }}>
          <input type="color" value={customColor} onChange={(e) => setCustomColor(e.target.value)}
            className="w-7 h-7 rounded bg-transparent border-0 cursor-pointer" aria-label="Eigene Farbe wählen" />
          <button type="button" onMouseDown={(e) => e.preventDefault()} onClick={() => onPick(customColor)}
            className="flex-1 py-1 rounded-full text-[12px] font-medium"
            style={{ background: 'rgba(60,135,215,0.15)', color: 'var(--sky-deep)' }}>
            Eigene übernehmen
          </button>
        </div>
      )}
    </div>
  );
}
