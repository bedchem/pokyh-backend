import { Megaphone, X } from 'lucide-react';

// Faithful mock-ups of how a popup renders in each client. The content CSS
// below is mirrored in pokyh-frontend (components/AnnouncementPopup.tsx) and
// POKYH_ANDROID (ui/popups/AnnouncementPopup.kt) — keep them in sync.

export type PreviewTheme = 'light' | 'dark';

const ANDROID_TOKENS: Record<PreviewTheme, Record<string, string>> = {
  light: {
    '--bg': '#F5F2ED', '--card': '#FFFFFF', '--text': '#1C1A17', '--text2': '#6C655C', '--accent': '#6366F1', '--link': '#4F46E5',
    '--nested': '#ECECEB', '--card-alt': '#EEEAE3', '--sep': '#F0ECE5',
    '--peri': '#DEDDFB', '--peri-ink': '#4A46A6', '--butter': '#F7E7AC', '--butter-ink': '#85641A',
    '--sage': '#D5E4D0', '--sage-ink': '#4B6E45',
  },
  dark: {
    '--bg': '#111114', '--card': '#1B1B1F', '--text': '#F2F2F4', '--text2': '#9C9CA2', '--accent': '#6366F1', '--link': '#BAB8F4',
    '--nested': '#232323', '--card-alt': '#26262B', '--sep': '#232327',
    '--peri': '#24244C', '--peri-ink': '#BAB8F4', '--butter': '#473B16', '--butter-ink': '#EBD79A',
    '--sage': '#23351E', '--sage-ink': '#B4D0AD',
  },
};

const WEB_TOKENS: Record<PreviewTheme, Record<string, string>> = {
  light: {
    '--bg': '#F1F0F8', '--surface': '#FAFAFA', '--card': '#F5F4FC', '--card-alt': '#ECEAF6', '--border': '#E0DEEE',
    '--text': '#0D0C1A', '--text2': '#5A5870', '--accent': '#6366F1',
  },
  dark: {
    '--bg': '#09090C', '--surface': '#111116', '--card': '#18181E', '--card-alt': '#20202A', '--border': '#222230',
    '--text': '#F0F0F8', '--text2': '#8A8A9C', '--accent': '#6366F1',
  },
};

const ANDROID_CSS = `
.pp-android{font-family:Roboto,system-ui,-apple-system,sans-serif;font-size:15px;line-height:1.55;color:var(--text);overflow-wrap:anywhere}
.pp-android>:first-child{margin-top:0}.pp-android>:last-child{margin-bottom:0}
.pp-android h1{font-size:22px;line-height:1.25;font-weight:800;letter-spacing:-.02em;margin:18px 0 8px}
.pp-android h2{font-size:19px;line-height:1.3;font-weight:700;letter-spacing:-.01em;margin:16px 0 6px}
.pp-android h3{font-size:16px;font-weight:600;margin:14px 0 4px}
.pp-android p{margin:0 0 10px}
.pp-android a{color:var(--link);font-weight:600;text-decoration:none}
.pp-android img{max-width:100%;height:auto;border-radius:18px;display:block;margin:10px 0}
.pp-android blockquote{margin:10px 0;padding:10px 14px;border-radius:16px;background:var(--butter);color:var(--butter-ink)}
.pp-android blockquote p{margin:0}
.pp-android code{background:var(--sage);color:var(--sage-ink);padding:1px 6px;border-radius:7px;font-size:.88em}
.pp-android pre{background:var(--nested);padding:12px 14px;border-radius:16px;overflow-x:auto}
.pp-android pre code{background:none;color:inherit;padding:0}
.pp-android ul,.pp-android ol{padding-left:22px;margin:0 0 10px}
.pp-android ul{list-style:disc}.pp-android ol{list-style:decimal}
.pp-android li{margin:3px 0}
.pp-android li:has(>input[type=checkbox]){list-style:none;margin-left:-20px}
.pp-android input[type=checkbox]{accent-color:var(--accent);margin:0 6px 0 0;vertical-align:-2px}
.pp-android hr{border:0;height:2px;border-radius:2px;background:var(--sep);margin:14px 0}
.pp-android table{border-collapse:separate;border-spacing:0;width:100%;border-radius:16px;overflow:hidden;margin:10px 0;font-size:14px}
.pp-android th{background:var(--peri);color:var(--peri-ink);font-weight:700;text-align:left;padding:8px 12px}
.pp-android td{background:var(--nested);padding:8px 12px}
.pp-android tr:nth-child(even) td{background:var(--card-alt)}
.pp-android mark{color:#1C1A17;border-radius:5px;padding:0 4px}
.pp-android details{background:var(--nested);border-radius:16px;padding:10px 14px;margin:10px 0}
.pp-android summary{font-weight:600;cursor:pointer}
`;

const WEB_CSS = `
.pp-web { font-family: Inter, -apple-system, 'Segoe UI', system-ui, sans-serif; font-size: 14.5px; line-height: 1.6; color: var(--text); overflow-wrap: anywhere; }
.pp-web > :first-child { margin-top: 0; }
.pp-web > :last-child { margin-bottom: 0; }
.pp-web h1 { font-size: 22px; line-height: 1.3; font-weight: 700; letter-spacing: -0.02em; margin: 18px 0 8px; }
.pp-web h2 { font-size: 18px; line-height: 1.35; font-weight: 600; letter-spacing: -0.01em; margin: 16px 0 6px; }
.pp-web h3 { font-size: 15.5px; font-weight: 600; margin: 14px 0 4px; }
.pp-web p { margin: 0 0 10px; }
.pp-web a { color: var(--accent); text-decoration: underline; text-underline-offset: 2px; }
.pp-web img { max-width: 100%; height: auto; border-radius: 16px; display: block; margin: 10px 0; }
.pp-web blockquote { margin: 10px 0; padding: 8px 14px; border-left: 3px solid var(--accent); background: var(--card); border-radius: 0 12px 12px 0; color: var(--text2); }
.pp-web blockquote p { margin: 0; }
.pp-web code { background: var(--card-alt); padding: 1px 6px; border-radius: 6px; font-size: 0.88em; }
.pp-web pre { background: var(--card); padding: 12px 14px; border-radius: 14px; overflow-x: auto; }
.pp-web pre code { background: none; padding: 0; }
.pp-web ul, .pp-web ol { padding-left: 22px; margin: 0 0 10px; }
.pp-web ul { list-style: disc; }
.pp-web ol { list-style: decimal; }
.pp-web li { margin: 3px 0; }
.pp-web li:has(> input[type=checkbox]) { list-style: none; margin-left: -20px; }
.pp-web input[type=checkbox] { accent-color: var(--accent); margin: 0 6px 0 0; vertical-align: -2px; }
.pp-web hr { border: 0; border-top: 1px solid var(--border); margin: 14px 0; }
.pp-web table { border-collapse: separate; border-spacing: 0; width: 100%; margin: 10px 0; font-size: 13.5px; border-radius: 14px; overflow: hidden; background: var(--card); }
.pp-web th, .pp-web td { padding: 7px 12px; text-align: left; }
.pp-web th { background: var(--card-alt); font-weight: 600; }
.pp-web tr + tr td { border-top: 1px solid var(--border); }
.pp-web mark { color: #0D0C1A; border-radius: 4px; padding: 0 3px; }
.pp-web details { background: var(--card); border-radius: 14px; padding: 10px 14px; margin: 10px 0; }
.pp-web summary { font-weight: 600; cursor: pointer; }
`;

interface Props {
  title: string;
  html: string;
  theme: PreviewTheme;
}

export function AndroidPopupPreview({ title, html, theme }: Props) {
  const t = ANDROID_TOKENS[theme];
  return (
    <div className="mx-auto" style={{ width: 300 }}>
      <style>{ANDROID_CSS}</style>
      <div className="relative overflow-hidden"
        style={{ ...t, height: 600, borderRadius: 40, background: 'var(--bg)', boxShadow: '0 0 0 8px #2c2c2e, 0 20px 50px rgba(0,0,0,0.6)' } as React.CSSProperties}>
        {/* Status bar + faux app behind the scrim */}
        <div className="flex justify-between px-6 pt-3 text-[11px] font-semibold" style={{ color: 'var(--text)' }}>
          <span>9:41</span><span>▾ ▴ ▮</span>
        </div>
        <div className="px-5 pt-4 flex flex-col gap-3 opacity-60">
          <div className="h-7 w-28 rounded-full" style={{ background: 'var(--card)' }} />
          <div className="h-24 rounded-[24px]" style={{ background: 'var(--card)' }} />
          <div className="grid grid-cols-2 gap-3">
            <div className="h-20 rounded-[24px]" style={{ background: 'var(--peri)' }} />
            <div className="h-20 rounded-[24px]" style={{ background: 'var(--butter)' }} />
          </div>
        </div>
        <div className="absolute inset-0 flex items-center justify-center p-4" style={{ background: theme === 'dark' ? 'rgba(0,0,0,0.6)' : 'rgba(28,26,23,0.38)' }}>
          <div className="w-full flex flex-col" style={{ background: 'var(--card)', borderRadius: 28, maxHeight: 520, padding: 20, boxShadow: '0 24px 48px rgba(58,46,31,0.22)' }}>
            <div className="flex items-center gap-3 mb-3">
              <div className="w-11 h-11 flex items-center justify-center flex-shrink-0" style={{ background: 'var(--peri)', color: 'var(--peri-ink)', borderRadius: 14 }}>
                <Megaphone size={20} />
              </div>
              <div className="text-[19px] font-bold leading-tight tracking-[-0.01em]" style={{ color: 'var(--text)', fontFamily: 'Roboto,system-ui,sans-serif' }}>
                {title || 'Titel'}
              </div>
            </div>
            <div className="overflow-y-auto scrollbar-thin min-h-0 -mx-1 px-1">
              <div className="pp-android" dangerouslySetInnerHTML={{ __html: html }} />
            </div>
            <div className="mt-4 h-[48px] rounded-full flex items-center justify-center text-[15px] font-semibold flex-shrink-0"
              style={{ background: 'var(--accent)', color: '#fff' }}>
              Verstanden
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

export function WebPopupPreview({ title, html, theme }: Props) {
  const t = WEB_TOKENS[theme];
  return (
    <div>
      <style>{WEB_CSS}</style>
      <div className="overflow-hidden rounded-[14px]" style={{ ...t, background: 'var(--bg)', boxShadow: '0 0 0 1px rgba(255,255,255,0.08), 0 20px 50px rgba(0,0,0,0.5)' } as React.CSSProperties}>
        {/* Browser chrome */}
        <div className="flex items-center gap-2 px-3 h-9" style={{ background: theme === 'dark' ? '#18181E' : '#E4E3EE' }}>
          <span className="w-2.5 h-2.5 rounded-full bg-[#ff5f57]" /><span className="w-2.5 h-2.5 rounded-full bg-[#febc2e]" /><span className="w-2.5 h-2.5 rounded-full bg-[#28c840]" />
          <div className="ml-3 flex-1 h-5 rounded-md text-[10.5px] flex items-center px-2" style={{ background: 'var(--bg)', color: 'var(--text2)' }}>pokyh.com/home</div>
        </div>
        <div className="relative" style={{ height: 520 }}>
          <div className="flex h-full opacity-60">
            <div className="w-40 h-full p-3 flex flex-col gap-2" style={{ background: 'var(--surface)', borderRight: '1px solid var(--border)' }}>
              {[0, 1, 2, 3, 4].map((i) => <div key={i} className="h-6 rounded-lg" style={{ background: i === 0 ? 'rgba(99,102,241,0.15)' : 'var(--card-alt)' }} />)}
            </div>
            <div className="flex-1 p-5 grid grid-cols-2 gap-3 content-start">
              {[0, 1, 2, 3].map((i) => <div key={i} className="h-24 rounded-2xl" style={{ background: 'var(--surface)', border: '1px solid var(--border)' }} />)}
            </div>
          </div>
          <div className="absolute inset-0 flex items-center justify-center p-6"
            style={{ background: theme === 'dark' ? 'rgba(0,0,0,0.55)' : 'rgba(13,12,26,0.3)', backdropFilter: 'blur(4px)' }}>
            <div className="w-full flex flex-col" style={{ maxWidth: 440, maxHeight: 470, background: 'var(--surface)', borderRadius: 28, boxShadow: '0 24px 64px rgba(0,0,0,0.3)' }}>
              <div className="flex items-start gap-3 px-5 pt-5 pb-3">
                <div className="flex-1 min-w-0">
                  <div className="inline-flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider mb-1" style={{ color: 'var(--accent)' }}>
                    <Megaphone size={12} /> Mitteilung
                  </div>
                  <div className="text-[19px] font-bold leading-snug" style={{ color: 'var(--text)', fontFamily: 'Inter,system-ui,sans-serif' }}>{title || 'Titel'}</div>
                </div>
                <div className="w-9 h-9 rounded-full flex items-center justify-center flex-shrink-0" style={{ background: 'var(--card)', color: 'var(--text2)' }}>
                  <X size={18} />
                </div>
              </div>
              <div className="px-5 overflow-y-auto scrollbar-thin min-h-0">
                <div className="pp-web" dangerouslySetInnerHTML={{ __html: html }} />
              </div>
              <div className="px-5 pt-4 pb-5 flex-shrink-0">
                <div className="w-full h-11 rounded-xl flex items-center justify-center text-[15px] font-semibold" style={{ background: 'var(--accent)', color: '#fff' }}>Verstanden</div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
