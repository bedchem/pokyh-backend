import { useMemo } from 'react';
import { useTheme } from '../../theme';
import { frameFor } from './countries';
import { WorldMap, type MapValue } from './WorldMap';

// The visitor map on the Analytics page itself: the same map as in the
// inspector, framed on its own. A click on a country opens the visitors
// narrowed to it; a click on the sea opens them all.
export default function VisitorMapPreview({ byCountry, onOpen }: {
  byCountry: Array<{ country: string; views: number; visitors: number }>;
  onOpen: (country: string | null) => void;
}) {
  const theme = useTheme();
  const values = useMemo(() => new Map<string, MapValue>(byCountry.map((c) => [c.country, { views: c.views, visitors: c.visitors }])), [byCountry]);
  return (
    <WorldMap
      values={values}
      frame={frameFor(byCountry)}
      selected={null}
      onSelect={onOpen}
      theme={theme}
      idleText={values.size > 0 ? 'Land wählen für seine Besucher' : 'Noch keine Besucher mit bekanntem Land'}
    />
  );
}
