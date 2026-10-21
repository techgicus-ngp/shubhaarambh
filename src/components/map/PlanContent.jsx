import React from 'react';
import { pathWithHoles } from '../../lib/geometry';
import { fittedNumberSize } from '../../lib/labels';
import { STATUS, statusKeyOf } from '../../theme/status';
import {
  DIM_EDGE, DIM_FILL, DIM_INK,
  KIND, MAPFONT, MONO, SANS, PLOT_STROKE, SEL_STROKE, SOCKET_FILL,
} from '../../theme/tokens';
import { categoryFill, readCategory } from '../../config/plotCategories';

/* EVERY plot on the layout, off-white. This replaces toneOf's per-block
   master-plan tones outright — one plot reads the same as the next, so
   the only colour anywhere on the plan is a sale or category colour, and
   a coloured plot means something rather than being one more shade among
   twelve.

   Roads, open spaces and amenities are untouched: their colours come
   from KIND, not from here.

   Change this one constant to recolour the whole layout. */
const PLAIN_FILL = '#F1ECE2';

/* Ground colour behind the whole layout, drawn ONLY inside the project's
   layoutBoundary. Change this one constant to recolour it. */
const LAYOUT_BG = '#3b3b3b';

const ROAD_FONT_BOOST = 2;

/* ── PLOT NUMBER ORIENTATION ─────────────────────────────────────────
   Orientation of a plot, in degrees, for SVG rotate().
   Sweeps the polygon through 0–89° and keeps the angle where its
   bounding box is tightest, which is the plot's own "grain". Rounded
   corners don't confuse it, unlike a longest-edge approach. The text
   runs along the plot's longer side and is folded into (-90, 90] so
   a number is never upside-down. */
function plotAngle(pts) {
  if (!pts || pts.length < 3) return 0;
  let best = 0, bestArea = Infinity, bestW = 0, bestH = 0;
  for (let a = 0; a < 90; a += 1) {
    const r = (a * Math.PI) / 180, c = Math.cos(r), s = Math.sin(r);
    let minU = Infinity, maxU = -Infinity, minV = Infinity, maxV = -Infinity;
    for (const [x, y] of pts) {
      const u = x * c + y * s;
      const v = -x * s + y * c;
      if (u < minU) minU = u;
      if (u > maxU) maxU = u;
      if (v < minV) minV = v;
      if (v > maxV) maxV = v;
    }
    const w = maxU - minU, h = maxV - minV;
    if (w * h < bestArea) { bestArea = w * h; best = a; bestW = w; bestH = h; }
  }
  // Text runs along the longer side. Change `>=` to `<` to run across the short side.
  let ang = bestW >= bestH ? best : best + 90;
  while (ang > 90) ang -= 180;
  while (ang <= -90) ang += 180;
  return ang;
}

export default function PlanContent({
  layout, selected, matches, status, showNumbers, showStatus, hover, setHover, onPick,
  categories, showCategory,                                   // NEW
}) {
  /* One reading of a plot's status, shared by the shape and its number:
     they have to agree, or a plot ends up with dark ink on a red fill.

     `status` is undefined for the first frames, before the Firestore
     read lands, so it is guarded here rather than indexed raw. */
  const stateOf = (name) => STATUS[statusKeyOf((status || {})[name])];

  /* The plot's category colour, only while the Category switch is on.
     null when the plot has no (known) category, so it falls through to
     the status colour or the plain drawing tone. */
  const catOf = (f) => {
    if (!showCategory) return null;
    /* `categories` is { plotName: 'residential' | ... } from PlanMap.
       Falling back to the plot's own field covers a parent that sends
       nothing. */
    return categoryFill(categories, f.name)
      || categoryFill({ [f.name]: readCategory(f) }, f.name);
  };

  /* ── THE LAYOUT BOUNDARY ───────────────────────────────────────────
     The outer edge of the whole site, already a ring of [x, y] points
     in drawing-space metres. The background is drawn from this ring
     ONLY; a project with no layoutBoundary gets no background. Drawn
     first, so it sits under the whole layout. */
  const layoutBoundary = layout.layoutBoundary;

  const groundPath = React.useMemo(() => (
    layoutBoundary && layoutBoundary.length > 2
      ? pathWithHoles(layoutBoundary)
      : null
  ), [layoutBoundary]);

  /* Each plot's angle, worked out once per layout rather than on every
     hover/selection re-render. Keyed by f.i, the same key the plots use. */
  const plotAngles = React.useMemo(() => {
    const m = new Map();
    (layout.plots || []).forEach((f) => m.set(f.i, plotAngle(f.pts)));
    return m;
  }, [layout.plots]);

  return (
    <g>
      {groundPath && (
        <path
          d={groundPath}
          fill={KIND.road.fill}
          fillOpacity={1}
          fillRule="evenodd"
          stroke="none"
          style={{ pointerEvents: 'none' }}
        />
      )}

      {layout.sorted.map((f) => {
        const k = KIND[f.kind];
        const isPlot = f.kind === 'plot';
        const isSel = isPlot && selected === f.name;
        const dim = isPlot && matches && !matches.has(f.name);

        let fill = k.fill;
        if (isPlot) {
          /* Priority: category colour (switch on) → sale colour (switch
             on) → off-white drawing tone. */
          const st = stateOf(f.name);
          fill = catOf(f) || (showStatus && st.fill) || PLAIN_FILL;
        }
        if (isSel) fill = SOCKET_FILL;   // the raised copy carries the real colour

        return (
          <path
            key={f.i}
            data-plot={isPlot ? f.name : undefined}
            d={pathWithHoles(f.pts, f.holes)}
            fill={fill}
            fillRule="evenodd"
            stroke={isSel ? '#E9C6F2' : k.stroke}
            strokeWidth={isSel ? SEL_STROKE : PLOT_STROKE}
            fillOpacity={dim ? DIM_FILL : 0.92}
            strokeOpacity={dim ? DIM_EDGE : 1}
            opacity={hover === f.name && isPlot ? 0.85 : 1}
            onMouseEnter={() => isPlot && setHover(f.name)}
            onClick={() => isPlot && onPick(f.name)}
            style={{ cursor: isPlot ? 'pointer' : 'default' }}
          />
        );
      })}

      {showNumbers && layout.plots.map((f) => {
        if (f.name === selected) return null;
        const dim = matches && !matches.has(f.name);
        const size = fittedNumberSize(f, 3.2);
        if (size < 0.85) return null;   // smaller than this is a smudge, not a number
        /* Dark ink vanishes on the red and blue fills, so the number
           takes whatever the status says is legible on it. A category
           colour is light enough for dark ink, so it wins over status
           here, matching the fill above. */
        const st = !catOf(f) && showStatus ? stateOf(f.name) : null;
        const ink = (st && st.fill && st.ink) || '#1A1208';
        const [x, y] = f.lp;
        const ang = plotAngles.get(f.i) || 0;   // number runs along the plot line
        return (
          <text
            key={`n${f.i}`} x={x} y={y} textAnchor="middle" dy="0.35em"
            transform={`rotate(${ang} ${x} ${y})`}
            fontFamily={MAPFONT} fontSize={size} fontWeight="600" fill={ink}
            fillOpacity={dim ? DIM_INK : 1}
            style={{ pointerEvents: 'none' }}
          >
            {f.name}
          </text>
        );
      })}

      {/* Roads, open spaces, amenities and utilities name themselves. A
          road polygon is long and thin, so its longest edge is the
          direction the name should run. */}
      {layout.features.map((f) => {
        if (f.kind === 'plot') return null;
        const label = (f.title || f.name || '').trim();
        if (!label) return null;

        const isRoad = f.kind === 'road';
        const baseSize = Math.min(Math.max(f.ir * (isRoad ? 0.55 : 0.9), 1.2), isRoad ? 2.8 : 3.8);
        const size = isRoad ? baseSize + ROAD_FONT_BOOST : baseSize;
        if (size < 1.2) return null;

        const ink = KIND[f.kind].ink;
        const [x, y] = f.lp;

        return (
          <g
            key={`l${f.i}`} style={{ pointerEvents: 'none' }} paintOrder="stroke"
            stroke="rgba(0,0,0,0.45)" strokeWidth={size * 0.028}
            transform={`rotate(${f.angle} ${x} ${y})`}
          >
            <text
              x={x} y={isRoad ? y : y - size * 0.4} textAnchor="middle" dy="0.35em"
              fontFamily={isRoad ? MAPFONT : SANS} fontSize={size}
              letterSpacing={isRoad ? 0 : 0.5} fill={ink} fontWeight="600"
            >
              {label}
            </text>
            {!isRoad && f.area > 200 && (
              <text
                x={x} y={y + size * 0.85} textAnchor="middle" dy="0.35em"
                fontFamily={MONO} fontSize={size * 0.62} fill={ink} opacity="0.85"
              >
                {Math.round(f.area).toLocaleString('en-IN')} m²
              </text>
            )}
          </g>
        );
      })}
    </g>
  );
}