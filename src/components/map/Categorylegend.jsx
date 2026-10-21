import React from 'react';
import { CATEGORY_STYLE, normalizeCategory } from '../../config/plotCategories';
import { CANVAS, HAIR, MONO } from '../../theme/tokens';

export default function CategoryLegend({ plots, categories, show }) {
  if (!show) return null;

  const present = new Set(
    plots.map((p) => normalizeCategory(categories && categories[p.name])).filter(Boolean),
  );
  if (!present.size) return null;

  return (
    <div
      style={{
        position: 'absolute', left: 12, bottom: 72, zIndex: 6,
        padding: '8px 12px', background: CANVAS,
        border: `1px solid ${HAIR}`, borderRadius: 10,
        font: `500 12px/1.7 ${MONO}`, color: '#E7E1D5',
        pointerEvents: 'none',
      }}
    >
      {Object.entries(CATEGORY_STYLE)
        .filter(([k]) => present.has(k))
        .map(([k, s]) => (
          <div key={k} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ width: 12, height: 12, borderRadius: 3, background: s.fill }} />
            {s.label}
          </div>
        ))}
    </div>
  );
}