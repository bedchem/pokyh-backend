import { useState, useEffect, useCallback, useRef } from 'react';
import { Image, ImagePlus, Trash2, RefreshCw } from 'lucide-react';
import { adminApi } from '../api';
import { useToast } from '../components/Toast';

interface SubjectRow {
  key: string;
  longName: string;
  shortName: string;
  hasImage: boolean;
  mimeType: string | null;
  updatedAt: string | null;
}

function SubjectCard({
  row,
  onUploaded,
  onDeleted,
}: {
  row: SubjectRow;
  onUploaded: (key: string) => void;
  onDeleted: (key: string) => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const { showToast } = useToast();

  const imgUrl = row.hasImage
    ? `/api/admin/subject-images/${encodeURIComponent(row.key)}/preview`
    : null;

  const handleFile = useCallback(async (file: File) => {
    if (!file.type.startsWith('image/')) {
      showToast('Nur Bilddateien erlaubt', 'error');
      return;
    }
    setUploading(true);
    try {
      const data = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve((reader.result as string).split(',')[1]!);
        reader.onerror = reject;
        reader.readAsDataURL(file);
      });
      await adminApi.uploadSubjectImage(row.key, data, file.type);
      showToast(`Bild für "${row.longName}" gespeichert`, 'success');
      onUploaded(row.key);
    } catch (e) {
      showToast(e instanceof Error ? e.message : 'Upload fehlgeschlagen', 'error');
    } finally {
      setUploading(false);
    }
  }, [row.key, row.longName, onUploaded, showToast]);

  const handleDelete = useCallback(async () => {
    setDeleting(true);
    try {
      await adminApi.deleteSubjectImage(row.key);
      showToast(`Bild für "${row.longName}" gelöscht`, 'success');
      onDeleted(row.key);
    } catch (e) {
      showToast(e instanceof Error ? e.message : 'Fehler beim Löschen', 'error');
    } finally {
      setDeleting(false);
    }
  }, [row.key, row.longName, onDeleted, showToast]);

  return (
    <div
      className="flex items-center gap-3 p-3 rounded-xl transition-colors"
      style={{ background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.07)' }}
      onDragOver={e => e.preventDefault()}
      onDrop={e => { e.preventDefault(); const f = e.dataTransfer.files[0]; if (f) handleFile(f); }}
    >
      {/* Thumbnail */}
      <div
        className="w-12 h-12 rounded-lg flex-shrink-0 flex items-center justify-center overflow-hidden"
        style={{ background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.08)' }}
      >
        {imgUrl ? (
          <img src={imgUrl} alt={row.longName} className="w-full h-full object-cover" onError={e => { (e.currentTarget as HTMLImageElement).style.display = 'none'; }} />
        ) : (
          <Image size={18} style={{ color: '#3a3a4e' }} />
        )}
      </div>

      {/* Name */}
      <div className="flex-1 min-w-0">
        <p className="text-sm font-semibold truncate" style={{ color: '#f0f0f5' }}>{row.longName}</p>
        {row.shortName && row.shortName !== row.longName && (
          <p className="text-xs" style={{ color: '#4a4a5e' }}>{row.shortName}</p>
        )}
      </div>

      {/* Actions */}
      <div className="flex gap-2 flex-shrink-0">
        <button
          onClick={() => inputRef.current?.click()}
          disabled={uploading}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold transition-all disabled:opacity-50"
          style={{
            background: 'rgba(99,102,241,0.12)',
            border: '1px solid rgba(99,102,241,0.25)',
            color: '#818cf8',
          }}
          onMouseEnter={e => { (e.currentTarget as HTMLElement).style.background = 'rgba(99,102,241,0.22)'; }}
          onMouseLeave={e => { (e.currentTarget as HTMLElement).style.background = 'rgba(99,102,241,0.12)'; }}
        >
          {uploading
            ? <span className="w-3.5 h-3.5 border border-indigo-400 border-t-transparent rounded-full animate-spin" />
            : <ImagePlus size={13} />
          }
          {row.hasImage ? 'Ersetzen' : 'Bild hinzu'}
        </button>

        {row.hasImage && (
          <button
            onClick={handleDelete}
            disabled={deleting}
            className="flex items-center justify-center w-8 h-8 rounded-lg transition-all disabled:opacity-50"
            style={{ background: 'rgba(255,69,58,0.1)', border: '1px solid rgba(255,69,58,0.2)', color: '#ff453a' }}
            onMouseEnter={e => { (e.currentTarget as HTMLElement).style.background = 'rgba(255,69,58,0.2)'; }}
            onMouseLeave={e => { (e.currentTarget as HTMLElement).style.background = 'rgba(255,69,58,0.1)'; }}
            title="Bild löschen"
          >
            {deleting
              ? <span className="w-3 h-3 border border-red-400 border-t-transparent rounded-full animate-spin" />
              : <Trash2 size={13} />
            }
          </button>
        )}
      </div>

      <input
        ref={inputRef}
        type="file"
        accept="image/*"
        style={{ display: 'none' }}
        onChange={e => { const f = e.target.files?.[0]; if (f) handleFile(f); e.target.value = ''; }}
      />
    </div>
  );
}

export function SubjectImagesPage() {
  const [rows, setRows] = useState<SubjectRow[]>([]);
  const [loading, setLoading] = useState(true);
  const { showToast } = useToast();

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const data = await adminApi.listSubjectImages();
      setRows(data);
    } catch (e) {
      showToast(e instanceof Error ? e.message : 'Fehler', 'error');
    } finally {
      setLoading(false);
    }
  }, [showToast]);

  useEffect(() => { load(); }, [load]);

  const handleUploaded = useCallback((key: string) => {
    setRows(prev => prev.map(r => r.key === key ? { ...r, hasImage: true } : r));
  }, []);

  const handleDeleted = useCallback((key: string) => {
    setRows(prev => prev.map(r => r.key === key ? { ...r, hasImage: false, mimeType: null, updatedAt: null } : r));
  }, []);

  const withImg    = rows.filter(r => r.hasImage);
  const withoutImg = rows.filter(r => !r.hasImage);

  return (
    <div>
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-xl font-bold" style={{ color: '#f0f0f5' }}>Fachbilder</h1>
          <p className="text-sm mt-0.5" style={{ color: '#4a4a5e' }}>
            Bilder für Unterrichtsfächer — sichtbar für alle User im Stundenplan-Popup
          </p>
        </div>
        <button
          onClick={load}
          disabled={loading}
          className="flex items-center gap-2 px-3 py-2 rounded-lg text-sm font-medium transition-all disabled:opacity-50"
          style={{ background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.1)', color: '#8b8b9b' }}
        >
          <RefreshCw size={14} className={loading ? 'animate-spin' : ''} />
          Aktualisieren
        </button>
      </div>

      {loading ? (
        <div className="flex items-center justify-center py-20">
          <div className="w-7 h-7 border-2 border-indigo-500 border-t-transparent rounded-full animate-spin" />
        </div>
      ) : rows.length === 0 ? (
        <div className="text-center py-20" style={{ color: '#4a4a5e' }}>
          <Image size={36} className="mx-auto mb-3 opacity-40" />
          <p className="text-sm">Noch keine Fächer bekannt.<br />Stundenplan im Frontend aufrufen, dann erscheinen sie hier.</p>
        </div>
      ) : (
        <div className="flex flex-col gap-8">
          {withoutImg.length > 0 && (
            <section>
              <div className="flex items-center gap-2 mb-3">
                <span className="text-xs font-bold uppercase tracking-widest" style={{ color: '#4a4a5e' }}>Kein Bild</span>
                <span className="text-xs font-bold px-2 py-0.5 rounded-full" style={{ background: 'rgba(255,255,255,0.06)', color: '#4a4a5e' }}>{withoutImg.length}</span>
              </div>
              <div className="flex flex-col gap-2">
                {withoutImg.map(r => (
                  <SubjectCard key={r.key} row={r} onUploaded={handleUploaded} onDeleted={handleDeleted} />
                ))}
              </div>
            </section>
          )}

          {withImg.length > 0 && (
            <section>
              <div className="flex items-center gap-2 mb-3">
                <span className="text-xs font-bold uppercase tracking-widest" style={{ color: '#818cf8' }}>Bild hinzugefügt</span>
                <span className="text-xs font-bold px-2 py-0.5 rounded-full" style={{ background: 'rgba(99,102,241,0.15)', color: '#818cf8' }}>{withImg.length}</span>
              </div>
              <div className="flex flex-col gap-2">
                {withImg.map(r => (
                  <SubjectCard key={r.key} row={r} onUploaded={handleUploaded} onDeleted={handleDeleted} />
                ))}
              </div>
            </section>
          )}
        </div>
      )}
    </div>
  );
}
