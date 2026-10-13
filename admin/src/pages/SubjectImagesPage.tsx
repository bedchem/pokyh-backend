import { useState, useEffect, useCallback, useRef } from 'react';
import { Image, ImageOff, ImagePlus, Trash2, RefreshCw, Check, X, Crop } from 'lucide-react';
import { adminApi } from '../api';
import { useToast } from '../components/Toast';
import { useLive } from '../live';
import { AuthedImage, Empty, Figures, IconButton, MarkLoader, PageHeader, Section } from '../components/kit';
import { SplitBar } from '../components/charts';

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
}

const ASPECT = 3;
const HANDLE = 12;
type DragMode = 'move' | 'tl' | 'tr' | 'bl' | 'br';

function CropOverlay({
  modal,
  onConfirm,
  onCancel,
  uploading,
}: {
  modal: CropModal;
  onConfirm: (crop: { left: number; top: number; width: number; height: number }) => void;
  onCancel: () => void;
  uploading: boolean;
}) {
  const imgRef = useRef<HTMLImageElement>(null);
  const [box, setBox] = useState<{ x: number; y: number; w: number; h: number } | null>(null);
  const dragRef = useRef<{ mode: DragMode; mx0: number; my0: number; b0: { x: number; y: number; w: number; h: number } } | null>(null);

  const initBox = useCallback(() => {
    const img = imgRef.current;
    if (!img) return;
    const iw = img.offsetWidth;
    const ih = img.offsetHeight;
    const w = Math.min(iw * 0.85, ih * ASPECT);
    const h = w / ASPECT;
    setBox({ x: (iw - w) / 2, y: (ih - h) / 2, w, h });
  }, []);

  useEffect(() => {
    if (imgRef.current?.complete) initBox();
  }, [initBox]);

  const clamp = useCallback((b: { x: number; y: number; w: number; h: number }) => {
    const img = imgRef.current;
    if (!img) return b;
    const iw = img.offsetWidth;
    const ih = img.offsetHeight;
    let { x, y, w, h } = b;
    w = Math.max(40, w);
    h = w / ASPECT;
    if (h > ih) { h = ih; w = h * ASPECT; }
    if (w > iw) { w = iw; h = w / ASPECT; }
    x = Math.max(0, Math.min(iw - w, x));
    y = Math.max(0, Math.min(ih - h, y));
    return { x, y, w, h };
  }, []);

  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      if (!dragRef.current) return;
      const { mode, mx0, my0, b0 } = dragRef.current;
      const dx = e.clientX - mx0;
      const dy = e.clientY - my0;
      let nb = { ...b0 };
      if (mode === 'move') {
        nb = { ...b0, x: b0.x + dx, y: b0.y + dy };
      } else if (mode === 'br') {
        const w = Math.max(40, b0.w + dx); nb = { ...b0, w, h: w / ASPECT };
      } else if (mode === 'bl') {
        const w = Math.max(40, b0.w - dx); nb = { x: b0.x + b0.w - w, y: b0.y, w, h: w / ASPECT };
      } else if (mode === 'tr') {
        const w = Math.max(40, b0.w + dx); const h = w / ASPECT;
        nb = { x: b0.x, y: b0.y + b0.h - h, w, h };
      } else if (mode === 'tl') {
        const w = Math.max(40, b0.w - dx); const h = w / ASPECT;
        nb = { x: b0.x + b0.w - w, y: b0.y + b0.h - h, w, h };
      }
      setBox(clamp(nb));
    };
    const onUp = () => { dragRef.current = null; };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
    return () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    };
  }, [clamp]);

  const startDrag = (mode: DragMode, e: React.MouseEvent) => {
    e.stopPropagation();
    e.preventDefault();
    if (!box) return;
    dragRef.current = { mode, mx0: e.clientX, my0: e.clientY, b0: { ...box } };
  };

  const handleConfirm = () => {
    if (!box || !imgRef.current) return;
    const img = imgRef.current;
    const scaleX = modal.naturalWidth / img.offsetWidth;
    const scaleY = modal.naturalHeight / img.offsetHeight;
    onConfirm({
      left:   Math.round(box.x * scaleX),
      top:    Math.round(box.y * scaleY),
      width:  Math.round(box.w * scaleX),
      height: Math.round(box.h * scaleY),
    });
  };

  const corners: Array<{ id: DragMode; s: React.CSSProperties }> = [
    { id: 'tl', s: { top: -HANDLE / 2, left: -HANDLE / 2, cursor: 'nwse-resize' } },
    { id: 'tr', s: { top: -HANDLE / 2, right: -HANDLE / 2, cursor: 'nesw-resize' } },
    { id: 'bl', s: { bottom: -HANDLE / 2, left: -HANDLE / 2, cursor: 'nesw-resize' } },
    { id: 'br', s: { bottom: -HANDLE / 2, right: -HANDLE / 2, cursor: 'nwse-resize' } },
  ];

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      style={{ background: 'var(--scrim)' }}
      onClick={e => { if (e.target === e.currentTarget) onCancel(); }}
    >
      <div
        className="flex flex-col rounded-[22px] overflow-hidden max-w-2xl w-full"
        style={{ background: '#1a1a2e', border: '1px solid transparent', maxHeight: '90vh' }}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4" style={{ borderBottom: '1px solid rgb(var(--ink-rgb) / calc(0.087 * var(--veil)))' }}>
          <div className="flex items-center gap-2">
            <Crop size={16} style={{ color: 'var(--sky-deep)' }} />
            <span className="font-semibold text-sm" style={{ color: 'var(--ink)' }}>Bild zuschneiden</span>
            <span className="text-xs px-2 py-0.5 rounded-full" style={{ background: 'rgba(60,135,215,0.15)', color: 'var(--sky-deep)' }}>{modal.longName}</span>
          </div>
          <button onClick={onCancel} style={{ color: 'rgb(var(--ink-rgb) / 0.5)' }} className="hover:text-ink transition-colors">
            <X size={18} />
          </button>
        </div>

        {/* Image + crop box */}
        <div className="overflow-auto p-4 flex-1">
          <p className="text-xs mb-3" style={{ color: 'rgb(var(--ink-rgb) / 0.5)' }}>
            Box verschieben oder an den Ecken ziehen — Seitenverhältnis bleibt 3:1.
          </p>
          <div className="relative inline-block" style={{ userSelect: 'none' }}>
            <img
              ref={imgRef}
              src={modal.objectUrl}
              alt="crop"
              style={{ display: 'block', maxWidth: '100%', maxHeight: '55vh', borderRadius: 8 }}
              draggable={false}
              onLoad={initBox}
            />
            {box && (
              <>
                {/* Dim overlay — 4 pieces */}
                <div style={{ position: 'absolute', left: 0, top: 0, right: 0, height: box.y, background: 'var(--scrim)', pointerEvents: 'none' }} />
                <div style={{ position: 'absolute', left: 0, top: box.y + box.h, right: 0, bottom: 0, background: 'var(--scrim)', pointerEvents: 'none' }} />
                <div style={{ position: 'absolute', left: 0, top: box.y, width: box.x, height: box.h, background: 'var(--scrim)', pointerEvents: 'none' }} />
                <div style={{ position: 'absolute', left: box.x + box.w, top: box.y, right: 0, height: box.h, background: 'var(--scrim)', pointerEvents: 'none' }} />

                {/* Crop box */}
                <div
                  style={{
                    position: 'absolute', left: box.x, top: box.y, width: box.w, height: box.h,
                    border: '2px solid var(--sky-deep)', cursor: 'move', boxSizing: 'border-box',
                  }}
                  onMouseDown={e => startDrag('move', e)}
                >
                  {/* Rule-of-thirds grid */}
                  <div style={{ position: 'absolute', left: '33.33%', top: 0, bottom: 0, width: 1, background: 'rgb(var(--ink-rgb) / calc(0.16 * var(--veil)))', pointerEvents: 'none' }} />
                  <div style={{ position: 'absolute', left: '66.66%', top: 0, bottom: 0, width: 1, background: 'rgb(var(--ink-rgb) / calc(0.16 * var(--veil)))', pointerEvents: 'none' }} />
                  <div style={{ position: 'absolute', top: '33.33%', left: 0, right: 0, height: 1, background: 'rgb(var(--ink-rgb) / calc(0.16 * var(--veil)))', pointerEvents: 'none' }} />
                  <div style={{ position: 'absolute', top: '66.66%', left: 0, right: 0, height: 1, background: 'rgb(var(--ink-rgb) / calc(0.16 * var(--veil)))', pointerEvents: 'none' }} />

                  {/* Corner handles */}
                  {corners.map(({ id, s }) => (
                    <div
                      key={id}
                      onMouseDown={e => startDrag(id, e)}
                      style={{ position: 'absolute', width: HANDLE, height: HANDLE, background: 'var(--sky-solid)', borderRadius: 3, ...s }}
                    />
                  ))}
                </div>
              </>
            )}
          </div>
        </div>

        {/* Footer */}
        <div className="flex gap-3 px-5 py-4 justify-end" style={{ borderTop: '1px solid rgb(var(--ink-rgb) / calc(0.087 * var(--veil)))' }}>
          <button
            onClick={onCancel}
            disabled={uploading}
            className="text-xs px-3 py-2 rounded-full transition-all disabled:opacity-50"
            style={{ background: 'rgba(225,70,75,0.1)', border: '1px solid transparent', color: 'var(--rose-deep)' }}
          >
            Abbrechen
          </button>
          <button
            onClick={handleConfirm}
            disabled={uploading || !box}
            className="flex items-center gap-1.5 text-xs px-4 py-2 rounded-full font-semibold transition-all disabled:opacity-50"
            style={{ background: 'rgba(60,135,215,0.2)', border: '1px solid transparent', color: 'var(--sky-deep)' }}
          >
            {uploading
              ? <span className="w-3.5 h-3.5 border border-sky-deep border-t-transparent rounded-full animate-spin" />
              : <Check size={13} />
            }
            Zuschneiden & speichern
          </button>
        </div>
      </div>
    </div>
  );
}

function SubjectCard({
  row,
  onDeleted,
  onOpenCrop,
}: {
  row: SubjectRow;
  onDeleted: (key: string) => void;
  onOpenCrop: (modal: CropModal) => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [deleting, setDeleting] = useState(false);
  const { showToast } = useToast();

  const imgUrl = row.hasImage
    ? `/api/admin/subject-images/${encodeURIComponent(row.key)}/preview?t=${encodeURIComponent(row.updatedAt ?? '0')}`
    : null;

  const handleFile = useCallback((file: File) => {
    if (!file.type.startsWith('image/')) { showToast('Nur Bilddateien erlaubt', 'error'); return; }
    const reader = new FileReader();
    reader.onload = () => {
      const base64 = (reader.result as string).split(',')[1]!;
      const objectUrl = URL.createObjectURL(file);
      const img = new window.Image();
      img.onload = () => {
        onOpenCrop({ file, base64, objectUrl, naturalWidth: img.naturalWidth, naturalHeight: img.naturalHeight, subject: row.key, longName: row.longName });
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
      className="spot flex items-center gap-4 py-4"
      onDragOver={e => e.preventDefault()}
      onDrop={e => { e.preventDefault(); const f = e.dataTransfer.files[0]; if (f) handleFile(f); }}
    >
      <div className="flex h-14 w-14 flex-shrink-0 items-center justify-center overflow-hidden rounded-[16px] bg-well text-ink-4">
        {imgUrl
          ? <AuthedImage src={imgUrl} token={adminApi.getToken()} alt={row.longName} className="h-full w-full object-cover" fallback={<Image size={20} strokeWidth={1.5} />} />
          : <Image size={20} strokeWidth={1.5} />}
      </div>

      <div className="min-w-0 flex-1">
        <p className="truncate text-[14.5px] font-medium">{row.longName}</p>
        {row.shortName && row.shortName !== row.longName && (
          <p className="mt-0.5 text-[13px] text-ink-3">{row.shortName}</p>
        )}
      </div>

      <div className="flex flex-shrink-0 items-center gap-2">
        <button type="button" onClick={() => inputRef.current?.click()} className="btn btn-sm btn-quiet">
          <ImagePlus size={14} strokeWidth={1.7} />
          {row.hasImage ? 'Ersetzen' : 'Bild hinzufügen'}
        </button>

        {row.hasImage && (
          <IconButton icon={Trash2} tone="rose" label="Bild löschen" busy={deleting} onClick={() => void handleDelete()} />
        )}
      </div>

      <input ref={inputRef} type="file" accept="image/*" style={{ display: 'none' }}
        onChange={e => { const f = e.target.files?.[0]; if (f) handleFile(f); e.target.value = ''; }} />
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
  useLive(['subject-images'], () => { void load(); });

  const handleUploaded = useCallback((key: string) => {
    setRows(prev => prev.map(r => r.key === key ? { ...r, hasImage: true, updatedAt: new Date().toISOString() } : r));
  }, []);

  const handleDeleted = useCallback((key: string) => {
    setRows(prev => prev.map(r => r.key === key ? { ...r, hasImage: false, mimeType: null, updatedAt: null } : r));
  }, []);

  const handleCropConfirm = useCallback(async (crop: { left: number; top: number; width: number; height: number }) => {
    if (!cropModal) return;
    setUploading(true);
    try {
      await adminApi.uploadSubjectImage(cropModal.subject, cropModal.base64, cropModal.file.type, crop);
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
        <CropOverlay modal={cropModal} onConfirm={handleCropConfirm} onCancel={handleCropCancel} uploading={uploading} />
      )}

      <PageHeader title="Fachbilder" subtitle="Bilder für Unterrichtsfächer — sichtbar für alle User im Stundenplan-Popup.">
        <IconButton icon={RefreshCw} label="Aktualisieren" size={42} busy={loading} onClick={() => void load()} />
      </PageHeader>

      <Figures
        className="mt-10"
        items={[
          { label: 'Fächer', value: rows.length, icon: Image },
          { label: 'Mit Bild', value: withImg.length, icon: ImagePlus },
          { label: 'Ohne Bild', value: withoutImg.length, icon: ImageOff },
        ]}
      />

      {loading && rows.length === 0 ? (
        <div className="flex justify-center py-20"><MarkLoader /></div>
      ) : rows.length === 0 ? (
        <Empty icon={Image}>Noch keine Fächer bekannt. Stundenplan im Frontend aufrufen, dann erscheinen sie hier.</Empty>
      ) : (
        <>
          <Section className="mt-[46px]" title="Abdeckung">
            <div className="mt-8 max-w-[720px]">
              <SplitBar
                ariaLabel="Fächer mit und ohne Bild"
                parts={[
                  { label: 'Mit Bild',  value: withImg.length,    color: '#4f96dc' },
                  { label: 'Ohne Bild', value: withoutImg.length, color: 'var(--ink-4)' },
                ]}
              />
            </div>
          </Section>

          {withoutImg.length > 0 && (
            <Section className="mt-[50px]" title="Kein Bild" meta={`${withoutImg.length} Fächer`}>
              <div className="stack mt-2">
                {withoutImg.map(r => <SubjectCard key={r.key} row={r} onDeleted={handleDeleted} onOpenCrop={setCropModal} />)}
              </div>
            </Section>
          )}
          {withImg.length > 0 && (
            <Section className="mt-[50px]" title="Bild hinzugefügt" meta={`${withImg.length} Fächer`}>
              <div className="stack mt-2">
                {withImg.map(r => <SubjectCard key={r.key} row={r} onDeleted={handleDeleted} onOpenCrop={setCropModal} />)}
              </div>
            </Section>
          )}
        </>
      )}
    </div>
  );
}
