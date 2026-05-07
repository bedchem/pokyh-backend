import { useState, useEffect, useCallback, useRef } from 'react';
import { Image, ImagePlus, Trash2, RefreshCw, Check, X, Crop } from 'lucide-react';
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

interface CropModal {
  file: File;
  base64: string;
  objectUrl: string;
  naturalWidth: number;
  naturalHeight: number;
  subject: string;
  longName: string;
  // selection in display px (null = full image)
  sel: { x: number; y: number; w: number; h: number } | null;
}

function CropOverlay({
  modal,
  onConfirm,
  onCancel,
  uploading,
}: {
  modal: CropModal;
  onConfirm: (crop: { left: number; top: number; width: number; height: number } | null) => void;
  onCancel: () => void;
  uploading: boolean;
}) {
  const imgRef = useRef<HTMLImageElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [sel, setSel] = useState<{ x: number; y: number; w: number; h: number } | null>(null);
  const dragStart = useRef<{ x: number; y: number } | null>(null);
  const [dragging, setDragging] = useState(false);

  const getRelPos = (e: React.MouseEvent): { x: number; y: number } => {
    const rect = containerRef.current!.getBoundingClientRect();
    return {
      x: Math.max(0, Math.min(e.clientX - rect.left, rect.width)),
      y: Math.max(0, Math.min(e.clientY - rect.top, rect.height)),
    };
  };

  const handleMouseDown = (e: React.MouseEvent) => {
    e.preventDefault();
    const pos = getRelPos(e);
    dragStart.current = pos;
    setSel(null);
    setDragging(true);
  };

  const handleMouseMove = (e: React.MouseEvent) => {
    if (!dragging || !dragStart.current) return;
    const pos = getRelPos(e);
    const x = Math.min(pos.x, dragStart.current.x);
    const y = Math.min(pos.y, dragStart.current.y);
    const w = Math.abs(pos.x - dragStart.current.x);
    const h = Math.abs(pos.y - dragStart.current.y);
    if (w > 4 && h > 4) setSel({ x, y, w, h });
  };

  const handleMouseUp = () => {
    setDragging(false);
    dragStart.current = null;
  };

  const handleConfirm = () => {
    if (!sel || !imgRef.current) {
      onConfirm(null);
      return;
    }
    const dispW = imgRef.current.offsetWidth;
    const dispH = imgRef.current.offsetHeight;
    const scaleX = modal.naturalWidth / dispW;
    const scaleY = modal.naturalHeight / dispH;
    onConfirm({
      left:   Math.round(sel.x * scaleX),
      top:    Math.round(sel.y * scaleY),
      width:  Math.round(sel.w * scaleX),
      height: Math.round(sel.h * scaleY),
    });
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      style={{ background: 'rgba(0,0,0,0.75)', backdropFilter: 'blur(4px)' }}
      onClick={e => { if (e.target === e.currentTarget) onCancel(); }}
    >
      <div
        className="flex flex-col rounded-2xl overflow-hidden max-w-2xl w-full"
        style={{ background: '#1a1a2e', border: '1px solid rgba(255,255,255,0.1)', maxHeight: '90vh' }}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4" style={{ borderBottom: '1px solid rgba(255,255,255,0.07)' }}>
          <div className="flex items-center gap-2">
            <Crop size={16} style={{ color: '#818cf8' }} />
            <span className="font-semibold text-sm" style={{ color: '#f0f0f5' }}>Bild zuschneiden</span>
            <span className="text-xs px-2 py-0.5 rounded-full" style={{ background: 'rgba(99,102,241,0.15)', color: '#818cf8' }}>{modal.longName}</span>
          </div>
          <button onClick={onCancel} style={{ color: '#4a4a5e' }} className="hover:text-white transition-colors">
            <X size={18} />
          </button>
        </div>

        {/* Crop area */}
        <div className="overflow-auto p-4 flex-1">
          <p className="text-xs mb-1" style={{ color: '#4a4a5e' }}>
            Ziehe einen Bereich zum Ausschneiden — oder lass es leer für das ganze Bild.
          </p>
          <p className="text-xs mb-3" style={{ color: '#3a3a5e' }}>
            Das Popup zeigt das Bild im Querformat (ca. 3:1) — schneide am besten breiter als hoch aus.
          </p>
          <div
            ref={containerRef}
            className="relative inline-block cursor-crosshair select-none"
            style={{ maxWidth: '100%', userSelect: 'none' }}
            onMouseDown={handleMouseDown}
            onMouseMove={handleMouseMove}
            onMouseUp={handleMouseUp}
            onMouseLeave={handleMouseUp}
          >
            <img
              ref={imgRef}
              src={modal.objectUrl}
              alt="crop preview"
              style={{ display: 'block', maxWidth: '100%', maxHeight: '60vh', borderRadius: '8px' }}
              draggable={false}
            />
            {/* Dimming overlay */}
            {sel && (
              <>
                <div style={{ position: 'absolute', inset: 0, background: 'rgba(0,0,0,0.45)', borderRadius: '8px', pointerEvents: 'none' }} />
                {/* Clear crop window */}
                <div style={{
                  position: 'absolute',
                  left: sel.x, top: sel.y, width: sel.w, height: sel.h,
                  boxShadow: '0 0 0 9999px rgba(0,0,0,0.45)',
                  border: '2px solid #818cf8',
                  borderRadius: '2px',
                  pointerEvents: 'none',
                }} />
              </>
            )}
          </div>
          {sel && (
            <p className="text-xs mt-2" style={{ color: '#818cf8' }}>
              Verhältnis: {sel.h > 0 ? (sel.w / sel.h).toFixed(1) : '–'}:1
              {' '}— Popup nutzt ca. 3:1 ({Math.round(sel.w)} × {Math.round(sel.h)} px)
            </p>
          )}
        </div>

        {/* Footer */}
        <div className="flex gap-3 px-5 py-4 justify-end" style={{ borderTop: '1px solid rgba(255,255,255,0.07)' }}>
          {sel && (
            <button
              onClick={() => setSel(null)}
              className="text-xs px-3 py-2 rounded-lg transition-all"
              style={{ background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.1)', color: '#8b8b9b' }}
            >
              Auswahl löschen
            </button>
          )}
          <button
            onClick={onCancel}
            disabled={uploading}
            className="text-xs px-3 py-2 rounded-lg transition-all disabled:opacity-50"
            style={{ background: 'rgba(255,69,58,0.1)', border: '1px solid rgba(255,69,58,0.2)', color: '#ff453a' }}
          >
            Abbrechen
          </button>
          <button
            onClick={handleConfirm}
            disabled={uploading}
            className="flex items-center gap-1.5 text-xs px-4 py-2 rounded-lg font-semibold transition-all disabled:opacity-50"
            style={{ background: 'rgba(99,102,241,0.2)', border: '1px solid rgba(99,102,241,0.35)', color: '#818cf8' }}
          >
            {uploading
              ? <span className="w-3.5 h-3.5 border border-indigo-400 border-t-transparent rounded-full animate-spin" />
              : <Check size={13} />
            }
            {sel ? 'Zuschneiden & speichern' : 'Ganzes Bild speichern'}
          </button>
        </div>
      </div>
    </div>
  );
}

function SubjectCard({
  row,
  onUploaded,
  onDeleted,
  onOpenCrop,
}: {
  row: SubjectRow;
  onUploaded: (key: string) => void;
  onDeleted: (key: string) => void;
  onOpenCrop: (modal: Omit<CropModal, 'sel'>) => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [deleting, setDeleting] = useState(false);
  const { showToast } = useToast();

  const imgUrl = row.hasImage
    ? `/api/admin/subject-images/${encodeURIComponent(row.key)}/preview?token=${encodeURIComponent(adminApi.getToken() ?? '')}`
    : null;

  const handleFile = useCallback((file: File) => {
    if (!file.type.startsWith('image/')) {
      showToast('Nur Bilddateien erlaubt', 'error');
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      const base64 = (reader.result as string).split(',')[1]!;
      const objectUrl = URL.createObjectURL(file);
      const img = new window.Image();
      img.onload = () => {
        onOpenCrop({
          file,
          base64,
          objectUrl,
          naturalWidth: img.naturalWidth,
          naturalHeight: img.naturalHeight,
          subject: row.key,
          longName: row.longName,
        });
      };
      img.src = objectUrl;
    };
    reader.readAsDataURL(file);
  }, [row.key, row.longName, onOpenCrop, showToast]);

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
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold transition-all"
          style={{
            background: 'rgba(99,102,241,0.12)',
            border: '1px solid rgba(99,102,241,0.25)',
            color: '#818cf8',
          }}
          onMouseEnter={e => { (e.currentTarget as HTMLElement).style.background = 'rgba(99,102,241,0.22)'; }}
          onMouseLeave={e => { (e.currentTarget as HTMLElement).style.background = 'rgba(99,102,241,0.12)'; }}
        >
          <ImagePlus size={13} />
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
  const [cropModal, setCropModal] = useState<CropModal | null>(null);
  const [uploading, setUploading] = useState(false);
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

  const handleOpenCrop = useCallback((modal: Omit<CropModal, 'sel'>) => {
    setCropModal({ ...modal, sel: null });
  }, []);

  const handleCropConfirm = useCallback(async (crop: { left: number; top: number; width: number; height: number } | null) => {
    if (!cropModal) return;
    setUploading(true);
    try {
      await adminApi.uploadSubjectImage(cropModal.subject, cropModal.base64, cropModal.file.type, crop ?? undefined);
      showToast(`Bild für "${cropModal.longName}" gespeichert`, 'success');
      handleUploaded(cropModal.subject);
      URL.revokeObjectURL(cropModal.objectUrl);
      setCropModal(null);
    } catch (e) {
      showToast(e instanceof Error ? e.message : 'Upload fehlgeschlagen', 'error');
    } finally {
      setUploading(false);
    }
  }, [cropModal, showToast, handleUploaded]);

  const handleCropCancel = useCallback(() => {
    if (cropModal) URL.revokeObjectURL(cropModal.objectUrl);
    setCropModal(null);
  }, [cropModal]);

  const withImg    = rows.filter(r => r.hasImage);
  const withoutImg = rows.filter(r => !r.hasImage);

  return (
    <div>
      {cropModal && (
        <CropOverlay
          modal={cropModal}
          onConfirm={handleCropConfirm}
          onCancel={handleCropCancel}
          uploading={uploading}
        />
      )}

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
                  <SubjectCard key={r.key} row={r} onUploaded={handleUploaded} onDeleted={handleDeleted} onOpenCrop={handleOpenCrop} />
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
                  <SubjectCard key={r.key} row={r} onUploaded={handleUploaded} onDeleted={handleDeleted} onOpenCrop={handleOpenCrop} />
                ))}
              </div>
            </section>
          )}
        </div>
      )}
    </div>
  );
}
