import { useEffect, useMemo, useState } from 'react';
import { geoMercator, geoPath } from 'd3-geo';
import type { FeatureCollection, Geometry, MultiPoint } from 'geojson';
import type { Theme } from '../../theme';
import { Spinner } from '../kit';
import { countryName } from './countries';
import { loadCountryShapes, type CountryShape } from './geo';

// A choropleth of where the website's visitors come from: one hue from little
// to much, land without visitors in the well's own grey. Pointing at a country
// names its figures in the corner; a click selects it (and the address list
// beside the map follows). Feedback is colour only — nothing moves or grows.

export type MapFrame = 'world' | 'europe';

export interface MapValue {
  views: number;
  visitors: number;
}

const WIDTH = 960;
const HEIGHT = 600;

// The panel's sky blue as sequential steps (the analytics charts' #4f96dc in
// the middle): light → dark on paper, dim → bright on the dark sheet. The
// last entry is the hover step past the strongest.
const RAMP: Record<Theme, string[]> = {
  light: ['#cfe3f8', '#a9cff3', '#7db4ea', '#4f96dc', '#2a78cc', '#1d5ea6'],
  dark: ['#1e2c3c', '#25415f', '#2f5c88', '#4a86c8', '#7db8f2', '#a9d1f7'],
};

// Europe as the map frames it, around the Alps: Iberia to Ukraine, Sicily to
// southern Scandinavia. The frame's height sets the zoom; the width follows.
const EUROPE_FRAME: MultiPoint = { type: 'MultiPoint', coordinates: [[-8, 37], [28, 37], [28, 60], [-8, 60]] };

function stepOf(value: number, peak: number): number {
  if (value <= 0 || peak <= 0) return -1;
  // Logarithmic: one country with most of the visits must not wash every
  // other one out to the first step.
  const share = Math.log1p(value) / Math.log1p(peak);
  return Math.min(4, Math.max(0, Math.ceil(share * 5) - 1));
}

function compact(value: number): string {
  return value.toLocaleString('de-AT');
}

interface WorldMapProps {
  values: Map<string, MapValue>;
  frame: MapFrame;
  selected: string | null;
  onSelect: (code: string | null) => void;
  theme: Theme;
  // Shown in the corner while nothing is pointed at or selected.
  idleText: string;
}

export function WorldMap({ values, frame, selected, onSelect, theme, idleText }: WorldMapProps) {
  const [shapes, setShapes] = useState<CountryShape[] | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [hovered, setHovered] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    loadCountryShapes()
      .then((next) => { if (alive) setShapes(next); })
      .catch((err: unknown) => { if (alive) setFailed(err instanceof Error ? err.message : 'Karte nicht geladen'); });
    return () => { alive = false; };
  }, []);

  const paths = useMemo(() => {
    if (!shapes) return [];
    const projection = geoMercator();
    if (frame === 'world') {
      const all: FeatureCollection<Geometry> = { type: 'FeatureCollection', features: shapes.map((s) => s.feature) };
      projection.fitExtent([[6, 6], [WIDTH - 6, HEIGHT - 6]], all);
    } else {
      projection.fitExtent([[0, 0], [WIDTH, HEIGHT]], EUROPE_FRAME);
      projection.clipExtent([[0, 0], [WIDTH, HEIGHT]]);
    }
    const path = geoPath(projection);
    return shapes
      .map((shape, i) => ({ key: `${shape.code || 'x'}-${i}`, code: shape.code, d: path(shape.feature) ?? '' }))
      .filter((shape) => shape.d !== '');
  }, [shapes, frame]);

  const peak = useMemo(() => Math.max(0, ...[...values.values()].map((v) => v.views)), [values]);
  const ramp = RAMP[theme];

  const focus = hovered ?? selected;
  const focusValue = focus ? values.get(focus) : undefined;
  const selectedPath = selected ? paths.filter((p) => p.code === selected) : [];

  if (failed) {
    return <div className="map-frame flex items-center justify-center text-[13.5px] text-ink-3">{failed}</div>;
  }

  return (
    <div className="map-frame" onPointerLeave={() => setHovered(null)}>
      {!shapes ? (
        <div className="absolute inset-0 flex items-center justify-center text-ink-3"><Spinner size={20} /></div>
      ) : (
        <svg
          viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
          className="block h-full w-full"
          role="img"
          aria-label={`Weltkarte der Website-Besucher nach Land${selected ? `, gewählt: ${countryName(selected)}` : ''}`}
        >
          {/* The sea: a click on it clears the selection. */}
          <rect width={WIDTH} height={HEIGHT} fill="transparent" onClick={() => onSelect(null)} />
          <g aria-hidden="true">
            {paths.map(({ key, code, d }) => {
              const value = code ? values.get(code) : undefined;
              const step = value ? stepOf(value.views, peak) : -1;
              const on = code !== '' && code === hovered;
              const fill = step >= 0 ? ramp[on ? step + 1 : step] : on ? 'var(--map-land-hover)' : 'var(--map-land)';
              return (
                <path
                  key={key}
                  d={d}
                  className="map-country"
                  style={{ fill }}
                  onPointerEnter={code ? () => setHovered(code) : undefined}
                  onClick={code ? () => onSelect(code === selected ? null : code) : undefined}
                />
              );
            })}
            {selectedPath.map(({ key, d }) => <path key={`sel-${key}`} d={d} className="map-selected" />)}
          </g>
        </svg>
      )}

      <div className="map-info" aria-live="polite">
        {focus ? (
          <>
            <span className="font-medium text-ink">{countryName(focus)}</span>
            <span className="tabular text-ink-3">
              {focusValue ? `${compact(focusValue.views)} Aufrufe · ${compact(focusValue.visitors)} Besucher` : 'keine Besuche'}
            </span>
          </>
        ) : (
          <span className="text-ink-3">{idleText}</span>
        )}
      </div>

      <div className="map-legend" aria-hidden="true">
        <span>Weniger</span>
        {ramp.slice(0, 5).map((color) => <i key={color} style={{ background: color }} />)}
        <span>Mehr</span>
      </div>
    </div>
  );
}
