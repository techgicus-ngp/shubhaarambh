import React, {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";

import PlanContent from "./PlanContent";
import DimensionOverlay from "./DimensionOverlay";
import FilterPanel from "./FilterPanel";
import StatusLegend from "./Statuslegend";
import MapToggles from "./Maptoggles";
import CategoryLegend from "./Categorylegend"; // NEW
import { readCategory, normalizeCategory } from '../../config/plotCategories';
import { useGoogleMaps } from "../../hooks/useGoogleMaps";
import { usePlanCamera } from "../../hooks/usePlanCamera";
import { usePlanOverlay } from "../../hooks/usePlanOverlay";

import { GOOGLE_MAP_STYLE_ID, PAD, MAX_SHEET } from "../../config/site";
import { clamp } from "../../lib/units";
import { quadMatrix } from "../../lib/matrix";
import { pathWithHoles } from "../../lib/geometry";
import { EMPTY_FILTERS } from "../../lib/filters";
import {
  ACCENT,
  CANVAS,
  HAIR,
  LIFT_H,
  MAX_TILT,
  MONO,
  SEL_STROKE,
  SELECTED_FILL,
  WALL_EDGE,
  WALL_FILL,
} from "../../theme/tokens";

import "../../styles/home.css";

export const DOWN_MS = 190; // the old plot sinking
export const UP_MS = 430; // the new one rising
export const FLY_MS = 900; // the camera closing in on a pick
export const REAIM_MS = 320; // the same pick re-aimed once a panel opens
export const REFIT_MS = 260; // the frame settling after a tilt
export const easeOut = (t) => 1 - (1 - t) ** 3;

/* Slow at both ends. Used by the opening move, which has to start and
   finish from a standstill. */
export const easeInOut = (t) =>
  t < 0.5 ? 4 * t ** 3 : 1 - (-2 * t + 2) ** 3 / 2;

/* ── THE COLOUR BEHIND THE MAP ───────────────────────────────────────
   Shown before the tiles land, in the gaps a turned camera opens at the
   corners, and under the oversized container. The three must agree or a
   seam appears at the edge of the frame. Black so the satellite imagery
   has no visible frame; everything else stays on CANVAS because panels
   and labels sit OVER imagery. */
const MAP_BG = "#2d2d2ddb";

const SVG_NS = "http://www.w3.org/2000/svg";

/* ── ONE PLACE FRAMES THE MAP ────────────────────────────────────────
   This file. fitPlan for the whole layout, flyTo for a pick, and
   nothing else may call fitBounds or setZoom on this map. Space taken
   by chrome is DECLARED via `reserve` ({ left, right, top, bottom }). */

/* ── TWO CAMERAS, ONE AT A TIME ──────────────────────────────────────
   A PICKED PLOT: the map CONTAINER is CSS-transformed by camRef.
   THE UNPICKED MAP: Google's own camera turns (real heading and tilt).
   They must never both be off square at once. flyTo unwinds the native
   camera to north and flat across the flight in.

   THE NATIVE HALF NEEDS A VECTOR MAP: GOOGLE_MAP_STYLE_ID must be a Map
   ID whose style is Vector, with Tilt and Rotation ticked. On raster,
   heading and tilt are accepted and ignored. */

const RAD = Math.PI / 180;
const NATIVE_MAX_TILT_DEG = Math.min(MAX_TILT / RAD, 67.5); // vector cap
const NATIVE_SPIN_DEG_PER_S = 10; // a lap in 36s
const NATIVE_IDLE_MS = 2500;
const NATIVE_SPIN_PER_PX = 0.4; // degrees of heading per px of drag
const NATIVE_TILT_PER_PX = 0.3;

/* ── THE OPENING ─────────────────────────────────────────────────────
   IT OPENS FLAT AND NORTH-UP and stays that way until a hand moves it.
   THE OPENING MOVE IS OFF:
     INTRO_LEAN   true: camera eases to INTRO_TILT_DEG after the fit.
     INTRO_LAPS   0 = hands only · 1 = one lap · Infinity = keeps turning.
   INTRO_PULL backs the camera off (zoom levels) while it leans.
   SPIN_TAU_MS is how quickly a lap gets up to speed / gives way.
   Abandoned the moment anyone touches the map; skipped for reduced
   motion. */
const INTRO_LEAN = false;
const INTRO_LAPS = 0;

/* Prints the renderer and whether a test turn took. Off for customers. */
const CAMERA_DEBUG = false;
const INTRO_WAIT_MS = 700; // let the fit and the imagery land first
const INTRO_TILT_DEG = 45;
const INTRO_PULL = 0.35;
const INTRO_MS = 1600;
const SPIN_TAU_MS = 900;

/* The last stretch of a counted lap, in degrees, over which speed is
   taken off. */
const SPIN_TAPER_DEG = 60;

/* The close-up.

   GUTTER: clear ground around the plot for the dimension figures, in
   METRES. Tied to SCALE in DimensionOverlay (`off + txt` ~1.5 m at
   SCALE 1.35, hence 1.6). Raise SCALE without raising this and the
   figures are framed off the edge of the screen.

   LIFT_RESERVE: fraction of the raised block's screen reach the fit sets
   aside, at the CURRENT tilt.

   CLOSE_BOOST pushes in past the fit (1.0 = plot plus gutter exactly
   fills the frame). The knob to turn if a pick is not close enough.

   SLACK keeps the drawing off the glass. LIFT_BIAS sits the plot low so
   the RAISED block finishes centred.

   FLY_MIN_Z is a floor. FLY_MAX_Z must not exceed MAP_MAX_Z. Past ~21
   the satellite imagery is upscaled; the overlay stays sharp. */
const GUTTER = 1.6;
const LIFT_RESERVE = 0.4;
const CLOSE_BOOST = 1.4; // desktop
const CLOSE_BOOST_TABLET = 1.65;
const CLOSE_BOOST_PHONE = 1.9;
const SLACK = 1.02;
const LIFT_BIAS = 0.5;
const FLY_MIN_Z = 17;
const FLY_MAX_Z = 24;
const MAP_MAX_Z = 24;

/* The vertical budget is squashed by cos(tilt). Floored. */
const MIN_CT = 0.35;

/* How far a pinch travels. 1.0 is one-to-one with the fingers. */
const PINCH_GAIN = 2.5;

/* One press of the on-screen zoom, in zoom levels, and how long it takes. */
const ZOOM_STEP = 0.75;
const ZOOM_STEP_MS = 220;

/* Double-tap: two taps closer than this, on the same spot. */
const DOUBLE_TAP_MS = 300;
const DOUBLE_TAP_PX = 24;

/* ── THE DIMENSION FIGURES (screen-space alternative) ────────────────
   OFF BY DEFAULT. DimensionOverlay draws figures on the ground plane
   (foreshortened when tilted). Turning this on draws them upright at a
   fixed pixel size instead, but throws away DimensionOverlay's fillet
   runs, extension lines and name/area. When on, the DimensionOverlay in
   the lift layer is skipped automatically. */
const SCREEN_DIMS = false;
const DIM_FONT = 12; // px on screen, whatever the camera is doing
const DIM_OFFSET = 24; // px clear of the edge it belongs to
const DIM_MIN_EDGE = 34; // px; shorter edges on screen get no figure
const DIM_PAD = 120; // px of room the label box needs past the walls

/* How far the CSS camera must be off square before the container counts
   as turned. */
const TURNED_EPS = 0.001;

/* The same question for the native camera, in degrees. */
const NATIVE_EPS_DEG = 0.5;

/* Clear ground kept around the whole layout when framing it, in screen
   px. Top and bottom account for the logo header (.mh, --mh-block) and
   the Filters button (bottom: 50px on tablet and phone). Measure your
   own header and bar and match these. */
const FIT_PAD = { top: 92, right: 4, bottom: 24, left: 4 };
const FIT_PAD_TABLET = { top: 78, right: 3, bottom: 44, left: 3 };
const FIT_PAD_NARROW = { top: 62, right: 2, bottom: 58, left: 2 };
const NARROW_PX = 600; // phone
const TABLET_PX = 1024; // tablet, and a narrow desktop window

/* Resize bursts (address bar, keyboard, sheets, rotation) are collapsed
   into one call. */
const RESIZE_SETTLE_MS = 120;

/* Reduced motion gets the destination, not the journey. Read per call. */
const reducedMotion = () => {
  if (typeof window === "undefined" || !window.matchMedia) return false;
  try {
    return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  } catch (err) {
    return false;
  }
};

/* env() fallback has to be inside the calc for older WebKit. */
const safeArea = (side, base) =>
  `calc(${base}px + env(safe-area-inset-${side}, 0px))`;

/* ── IS THIS A SHARED LINK? (kept for reference) ─────────────────────
   app    https://…/maps/:id
   share  https://…/share/maps/:id
   Currently the status view is shown on every route (see canStatus),
   so these are unused, but kept so the share route can be re-enabled. */
const SHARE_PATH = /(^|[/#?&])share([/#?&=]|$)/;

// eslint-disable-next-line no-unused-vars
const isShareUrl = () => {
  if (typeof window === "undefined") return false;
  try {
    const l = window.location;
    return SHARE_PATH.test(`${l.pathname}${l.search}${l.hash}`);
  } catch (err) {
    return false;
  }
};

/* A pick opens FLAT — straight down on the plot, north up. The overview
   is left exactly as the user left it. Set false to keep the heading and
   tilt the user arrived with. */
const TOP_VIEW_ON_PICK = true;

const wrapDeg = (d) => ((d % 360) + 360) % 360;

/* radians, folded to the short way round */
const wrapRad = (r) => {
  const two = Math.PI * 2;
  return ((((r + Math.PI) % two) + two) % two) - Math.PI;
};

/* The plan is the most expensive subtree on the page and does not care
   about the camera, so it is held still while the view turns. Its props
   must stay referentially stable — `categories` too, so pass a memoised
   object from the parent. */
const PlanContentMemo = React.memo(PlanContent);

/* ── THE COMPASS ─────────────────────────────────────────────────────
   Reads whichever camera is live and writes the needle's rotation
   STRAIGHT TO THE DOM on a rAF. Never setState. Always on screen. */
function Compass({ mapRef, camRef, selectedRef, onReset }) {
  const gRef = useRef(null);
  const lastRef = useRef(null);

  useEffect(() => {
    let raf = 0;
    const tick = () => {
      const g = gRef.current;
      if (g) {
        /* Flip either sign if the needle turns against the map. */
        const deg = selectedRef.current
          ? camRef.current.spin / RAD
          : -(mapRef.current?.getHeading?.() || 0);
        const r = Math.round(deg * 10) / 10;
        if (r !== lastRef.current) {
          lastRef.current = r;
          g.style.transform = `rotate(${r}deg)`;
        }
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [mapRef, camRef, selectedRef]);

  return (
    <button
      type="button"
      title="Face north"
      aria-label="Face north"
      /* the native turn listens on the document in the capture phase,
         so without this a tap here also starts a camera drag */
      onPointerDown={(e) => e.stopPropagation()}
      onClick={onReset}
      style={{
        position: "absolute",
        zIndex: 6,
        right: safeArea("right", 12),
        top: FIT_PAD.top + 4,
        width: 44,
        height: 44,
        display: "grid",
        placeItems: "center",
        padding: 0,
        background: CANVAS,
        border: `1px solid ${HAIR}`,
        borderRadius: 22,
        cursor: "pointer",
        touchAction: "manipulation",
        WebkitTapHighlightColor: "transparent",
        WebkitAppearance: "none",
        appearance: "none",
      }}
    >
      <svg
        width="26"
        height="26"
        viewBox="-13 -13 26 26"
        style={{ display: "block" }}
      >
        <g
          ref={gRef}
          style={{ transformOrigin: "50% 50%", willChange: "transform" }}
        >
          <path d="M0 -9 L4.5 1.5 L0 -0.8 Z" fill={ACCENT} />
          <path
            d="M0 -9 L-4.5 1.5 L0 -0.8 Z"
            fill={ACCENT}
            fillOpacity="0.55"
          />
          <path d="M0 9 L4.5 -1.5 L0 0.8 Z" fill={HAIR} />
          <path d="M0 9 L-4.5 -1.5 L0 0.8 Z" fill={HAIR} fillOpacity="0.55" />
        </g>
        {/* outside the rotating group on purpose: it labels the top of
            the dial, so it stays upright and readable */}
        <text
          x="0"
          y="-9.5"
          textAnchor="middle"
          fill="#E7E1D5"
          fontFamily={MONO}
          fontSize="7"
          fontWeight="700"
        >
          N
        </text>
      </svg>
    </button>
  );
}

/**
 * Map + plan. The map owns pan and zoom; the plan is one div riding an
 * OverlayView, warped onto the ground each frame.
 *
 * CATEGORY (new): `categories` is { plotName: 'residential' | 'commercial' |
 * 'semicommercial' | 'corner' }. When the Category switch is on, plots are
 * filled by category (see config/categories.js) and sale-status colours step
 * aside, since both colour the same plots.
 *
 * SELECTED is what the user has chosen; SHOWN is what is currently
 * standing up. NOTHING IN THE HOT PATH CALLS setState: a turn, a rise
 * and a flight all run through overlayRef.draw() and direct DOM writes.
 */
export default function PlanMap({
  layout,
  selected,
  onSelect,
  matches,
  status,
  mapRef,
  fitRef,
  onReady,
  showNumbers,
  setShowNumbers,
  showStatus,
  setShowStatus,
  reserve,
  share = false,
  categories,
  showCategory,
  setShowCategory, // NEW
}) {
  const viewRef = useRef(null);
  const hostRef = useRef(null);
  const selRef = useRef(null);
  const shownRef = useRef(null);
  const riseRef = useRef(0);
  const drawRef = useRef(() => {});
  const dragRef = useRef(null);
  const pinchRef = useRef(new Map());
  const pinchStartRef = useRef(null);
  const wheelRef = useRef(0);
  const flyRef = useRef(0);
  const winRef = useRef(null);

  /* the wall and dimension SVGs, written to directly */
  const wallSvgRef = useRef(null);
  const dimSvgRef = useRef(null);

  /* true only while a flight is in the air */
  const flyingRef = useRef(false);

  /* True while the NATIVE camera is being moved (turn, drag, lap). Tells
     the draw callback to leave the drawing window alone. */
  const turningRef = useRef(false);
  const settleWinRef = useRef(0);

  /* which plot the camera has already flown to, so a late `reserve`
     re-aims instead of starting the whole flight again */
  const flownRef = useRef(null);

  /* The CSS tilt the current frame was computed for. */
  const framedTiltRef = useRef(0);

  /* Set the moment the user pinches or wheels; no automatic re-fit may
     take a zoom they chose. Cleared on the next pick. */
  const manualZoomRef = useRef(false);

  /* the last tap that landed on the orbit surface, for double-tap */
  const tapRef = useRef(null);

  /* the CSS camera levelling itself out on a pick */
  const levelRef = useRef(0);

  /* TOP VIEW, HELD: set on every new pick, cleared when the user turns
     the view by hand. While set, the CSS camera is FORCED square on
     every frame in the draw callback, so usePlanCamera cannot slide it
     into a three-quarter view. */
  const topLockRef = useRef(false);

  /* the native camera's own drag, two-finger gesture and auto-spin */
  const nativeDragRef = useRef(null);
  const nativeRafRef = useRef(0);
  const nativeTouchRef = useRef(0);
  const natPtrs = useRef(new Map());
  const natGesture = useRef(null);

  /* The lap's speed, as a fraction of NATIVE_SPIN_DEG_PER_S. */
  const spinVelRef = useRef(0);

  /* Degrees turned so far, and how many are allowed. */
  const spunRef = useRef(0);
  const lapBudgetRef = useRef(Infinity);

  /* The opening runs once per mount. */
  const introDoneRef = useRef(false);
  const introTiltRef = useRef(0);

  const [pad, setPad] = useState({ x: 0, y: 0 });
  const [hover, setHover] = useState(null);
  /* Hover is a PROP of the plan, so every change re-renders all of it.
     Refused for the length of a gesture. */
  const setHoverSafe = useCallback((v) => {
    if (turningRef.current) return;
    setHover((h) => (h === v ? h : v));
  }, []);
  const [map, setMap] = useState(null);
  const [shown, setShown] = useState(null);
  const [win, setWin] = useState(() => ({ ...layout.bounds, s: 1 }));

  const [showFilters, setShowFilters] = useState(false);
  const [draft, setDraft] = useState(EMPTY_FILTERS);
  const [filterHits, setFilterHits] = useState(null);

  /* True once the CSS camera is off square. Drives container oversizing. */
  const [turned, setTurned] = useState(false);

  /* The same for the native camera. Kept apart from `turned`: this one
     must NOT inflate the container. */
  const [nativeTurned, setNativeTurned] = useState(false);
  const [nativeSpin, setNativeSpin] = useState(false);

  /* ── THE STATUS VIEW ─────────────────────────────────────────────
     Status view is shown on every route: app and shared link alike.
     Only a DELIBERATE false from the parent turns it off
     (`showStatus !== false`), so an undefined prop stays ON.
     NOTE: `status` itself is NOT in this test, or the colours would
     blink off while the status map loads from Firestore. */
  const canStatus = true;

  const [ownNumbers, setOwnNumbers] = useState(showNumbers !== false);
  const [ownStatus, setOwnStatus] = useState(true);

  const numbersOn = setShowNumbers ? showNumbers : ownNumbers;
  const statusOn =
    canStatus && (setShowStatus ? showStatus !== false : ownStatus);
  const toggleNumbers = setShowNumbers || setOwnNumbers;
  const toggleStatus = setShowStatus || setOwnStatus;

  /* ── CATEGORY: colour plots by category. OFF until switched on. ─────
     Only a DELIBERATE true from the parent turns it on. The switch is
     always offered; with no category data it simply colours nothing. */
  const [ownCategory, setOwnCategory] = useState(false);
  const categoryOn = setShowCategory ? showCategory === true : ownCategory;
  const toggleCategory = setShowCategory || setOwnCategory;

  const { maps, error } = useGoogleMaps();
  const { overlayRef, divs } = usePlanOverlay(maps, map, drawRef);
  const { camRef, touched, spin, setSpin, faceNorth, bump } = usePlanCamera({
    selectedRef: selRef,
    hostRef,
    overlayRef,
  });

  const { toLL, toDraw, bounds } = layout;

  const plots = useMemo(() => [...layout.byName.values()], [layout]);

  /* Category per plot. Uses the `categories` prop when the parent sends one,
     otherwise reads it off the plot itself. CHANGE the field names below
     to whatever your plot data really uses. Memoised, so PlanContentMemo
     still holds. */
     
const categoryMap = useMemo(() => {
  const z = {};
  plots.forEach((p) => {
    // 1. default: everything is residential
    z[p.name] = 'residential';

    // 2. a category stored on the plot itself overrides the default
    const own = normalizeCategory(readCategory(p));
    if (own) z[p.name] = own;
  });

  // 3. categories passed from the parent (Firebase) override both
  if (categories) {
    Object.entries(categories).forEach(([name, c]) => {
      const k = normalizeCategory(c);
      if (k) z[name] = k;
    });
  }
  return z;
}, [categories, plots]);
useEffect(() => {
  console.log('sample plot', plots[0]);
  console.log('categoryMap size', Object.keys(categoryMap).length, categoryMap);
}, [plots, categoryMap]);
  /* Screen edges that are spoken for. Broken apart and re-assembled
     because an inline `reserve` object is new on every render. */
  const {
    left: rl = 0,
    right: rr = 0,
    top: rt = 0,
    bottom: rb = 0,
  } = reserve || {};
  const inset = useMemo(
    () => ({
      left: rl,
      right: rr,
      top: rt,
      bottom: rb,
    }),
    [rl, rr, rt, rb],
  );

  /* Search and filter both narrow, so they intersect. */
  const shownMatches = useMemo(() => {
    if (matches && filterHits) {
      return new Set([...matches].filter((n) => filterHits.has(n)));
    }
    return matches || filterHits;
  }, [matches, filterHits]);

  const onApplyFilters = useCallback(
    (hits, next) => {
      setFilterHits(hits);
      setDraft(next);
      setShowFilters(false);
      /* a raised plot that no longer matches would stand lit inside a
       dimmed layout, so put it back down */
      if (hits && selRef.current && !hits.has(selRef.current)) onSelect(null);
    },
    [onSelect],
  );

  /* Called after any CSS camera change, at the END of a gesture. */
  const syncTurned = useCallback(() => {
    const c = camRef.current;
    const off = Math.abs(c.spin) > TURNED_EPS || c.tilt > TURNED_EPS;
    setTurned((v) => (v === off ? v : off));
  }, [camRef]);

  /* The native camera is also moved by Google's built-in gestures, so
     this is read off the map rather than any local copy. */
  const syncNative = useCallback(() => {
    const m = mapRef.current;
    if (!m) return;
    const h = wrapDeg(m.getHeading() || 0);
    const off =
      Math.min(h, 360 - h) > NATIVE_EPS_DEG ||
      (m.getTilt() || 0) > NATIVE_EPS_DEG;
    setNativeTurned((v) => (v === off ? v : off));
  }, [mapRef]);

  /* The raised block's walls, painted by hand: one SVG node created
     once, its paths mutated in place. */
  const paintWalls = useCallback((box, faces) => {
    const svg = wallSvgRef.current;
    if (!svg) return;

    if (!box || !faces || !faces.length) {
      svg.style.display = "none";
      return;
    }

    svg.style.display = "block";
    svg.style.left = `${box.x}px`;
    svg.style.top = `${box.y}px`;
    svg.setAttribute("width", box.w);
    svg.setAttribute("height", box.h);
    svg.setAttribute("viewBox", `${box.x} ${box.y} ${box.w} ${box.h}`);

    while (svg.childNodes.length > faces.length) {
      svg.removeChild(svg.lastChild);
    }
    for (let i = 0; i < faces.length; i += 1) {
      let p = svg.childNodes[i];
      if (!p) {
        p = document.createElementNS(SVG_NS, "path");
        p.setAttribute("fill", WALL_FILL);
        p.setAttribute("stroke", WALL_EDGE);
        p.setAttribute("stroke-width", "1");
        svg.appendChild(p);
      }
      p.setAttribute("d", faces[i].d);
    }
  }, []);

  /* The screen-space figures (only used when SCREEN_DIMS is on). Each
     label carries its own counter-transform against the camera. */
  const paintDims = useCallback((box, items) => {
    const svg = dimSvgRef.current;
    if (!svg) return;

    if (!box || !items || !items.length) {
      svg.style.display = "none";
      return;
    }

    svg.style.display = "block";
    svg.style.left = `${box.x}px`;
    svg.style.top = `${box.y}px`;
    svg.setAttribute("width", box.w);
    svg.setAttribute("height", box.h);
    svg.setAttribute("viewBox", `${box.x} ${box.y} ${box.w} ${box.h}`);

    while (svg.childNodes.length > items.length) {
      svg.removeChild(svg.lastChild);
    }
    for (let i = 0; i < items.length; i += 1) {
      const it = items[i];
      let g = svg.childNodes[i];
      if (!g) {
        g = document.createElementNS(SVG_NS, "g");
        const r = document.createElementNS(SVG_NS, "rect");
        r.setAttribute("rx", "7");
        r.setAttribute("fill", CANVAS);
        r.setAttribute("fill-opacity", "0.92");
        r.setAttribute("stroke", HAIR);
        r.setAttribute("stroke-width", "1");
        const t = document.createElementNS(SVG_NS, "text");
        t.setAttribute("text-anchor", "middle");
        /* dy, not dominant-baseline: WebKit and Blink disagree */
        t.setAttribute("dy", "0.35em");
        t.setAttribute("fill", "#E7E1D5");
        t.setAttribute("font-family", MONO);
        t.setAttribute("font-size", String(DIM_FONT));
        t.setAttribute("font-weight", "600");
        g.appendChild(r);
        g.appendChild(t);
        svg.appendChild(g);
      }
      const r = g.childNodes[0];
      const t = g.childNodes[1];

      g.setAttribute(
        "transform",
        `translate(${it.x} ${it.y}) rotate(${it.rot}) scale(1 ${it.sy})`,
      );
      if (t.textContent !== it.label) t.textContent = it.label;

      /* MONO, so the box is sized without measuring (no forced layout) */
      const w = it.label.length * DIM_FONT * 0.62 + 14;
      const h = DIM_FONT + 10;
      r.setAttribute("x", String(-w / 2));
      r.setAttribute("y", String(-h / 2));
      r.setAttribute("width", String(w));
      r.setAttribute("height", String(h));
    }
  }, []);

  /* ---------------------------------------------------------------
     Framing the layout. The opening view, and what the toolbar's fit
     button returns to. Fits the PLOTS, not layout.bounds. Heading and
     tilt are levelled for the fit, then PUT BACK unless keepCamera is
     false.
  --------------------------------------------------------------- */
  const fitPlan = useCallback(
    (target, keepCamera = true) => {
      const m = target || mapRef.current;
      const el = viewRef.current;
      if (!m || !el || !maps) return;

      const b = new maps.LatLngBounds();
      let n = 0;
      plots.forEach((p) => {
        (p.pts || []).forEach(([x, y]) => {
          const ll = toLL(x, y);
          b.extend(new maps.LatLng(ll.lat, ll.lng));
          n += 1;
        });
      });

      /* No plots parsed yet — fall back to the sheet. */
      if (n === 0) {
        [
          [bounds.x0, bounds.y0],
          [bounds.x1, bounds.y0],
          [bounds.x1, bounds.y1],
          [bounds.x0, bounds.y1],
        ].forEach(([x, y]) => {
          const ll = toLL(x, y);
          b.extend(new maps.LatLng(ll.lat, ll.lng));
        });
      }

      const h0 = wrapDeg(m.getHeading() || 0);
      const t0 = m.getTilt() || 0;
      if (typeof m.moveCamera === "function")
        m.moveCamera({ heading: 0, tilt: 0 });
      const w = el.clientWidth;
      let padding = FIT_PAD;
      if (w < NARROW_PX) padding = FIT_PAD_NARROW;
      else if (w < TABLET_PX) padding = FIT_PAD_TABLET;
      m.fitBounds(b, padding);
      if (keepCamera && (h0 || t0) && typeof m.moveCamera === "function") {
        m.moveCamera({ heading: h0, tilt: t0 });
      }
    },
    [maps, mapRef, plots, bounds, toLL],
  );

  /* Handed back to the parent so the toolbar's fit button calls THIS.
     Wrapped so an onClick event is never taken for a map, and because
     this is the one fit that SHOULD level the camera. */
  useEffect(() => {
    if (!fitRef) return undefined;
    fitRef.current = () => fitPlan(undefined, false);
    return () => {
      fitRef.current = null;
    };
  }, [fitRef, fitPlan]);

  /* ---------------------------------------------------------------
     Framing a pick — the close-up.

     pickFrame returns the zoom that fits the plot and the centre that
     puts it in the middle of what is actually VISIBLE, AT THE CAMERA'S
     CURRENT TILT. Used by flyTo, the re-aim when a panel opens, the
     re-fit after a tilt, and every pinch / wheel notch.

     `zForce` asks "where should the centre sit IF the zoom were this".
  --------------------------------------------------------------- */
  const pickFrame = useCallback(
    (name, zForce, flat) => {
      const m = mapRef.current;
      const el = viewRef.current;
      const plot = name && layout.byName.get(name);
      if (!m || !el || !plot || !plot.pts.length) return null;

      const xs = plot.pts.map((p) => p[0]);
      const ys = plot.pts.map((p) => p[1]);
      const x0 = Math.min(...xs);
      const x1 = Math.max(...xs);
      const y0 = Math.min(...ys);
      const y1 = Math.max(...ys);
      const to = toLL((x0 + x1) / 2, (y0 + y1) / 2);
      const world = 156543.03392 * Math.cos((to.lat * Math.PI) / 180);

      const w = el.clientWidth;
      let boost = CLOSE_BOOST;
      if (w < NARROW_PX) boost = CLOSE_BOOST_PHONE;
      else if (w < TABLET_PX) boost = CLOSE_BOOST_TABLET;

      /* The tilt the camera is AT, read every time. */
      const tiltNow = flat ? 0 : camRef.current.tilt;
      const ct = Math.max(Math.cos(tiltNow), MIN_CT);
      const lift = LIFT_H * Math.sin(tiltNow); // the block's reach, in ground metres

      const needW = (x1 - x0 + GUTTER * 2) * SLACK;
      const needH = (y1 - y0 + GUTTER * 2) * SLACK + lift * LIFT_RESERVE;

      /* The reserve is honoured, but never allowed to starve the fit. */
      const availW = Math.max(
        el.clientWidth -
          Math.min(inset.left + inset.right, el.clientWidth * 0.5),
        160,
      );
      const availH = Math.max(
        (el.clientHeight -
          Math.min(inset.top + inset.bottom, el.clientHeight * 0.5)) *
          ct,
        160,
      );

      /* metres per pixel wanted, divided down to push in (CLOSE_BOOST) */
      const mpp = Math.max(needW / availW, needH / availH) / boost;
      const fit = clamp(Math.log2(world / mpp), FLY_MIN_Z, FLY_MAX_Z);
      const z = zForce == null ? fit : clamp(zForce, FLY_MIN_Z, MAP_MAX_Z);

      /* Aim at the middle of what is VISIBLE and sit low by half the
       reserved lift. Offsets are run back through the container's
       rotation and squash, then divided by the scale. */
      let aim = to;
      const proj = m.getProjection();
      if (proj) {
        const scale = 2 ** z;
        const risePx = (lift * LIFT_RESERVE * scale) / world;
        const sx = (inset.right - inset.left) / 2;
        const sy = (inset.bottom - inset.top) / 2 - risePx * LIFT_BIAS;
        const s = flat ? 0 : camRef.current.spin;
        const cx = sx * Math.cos(s) + (sy / ct) * Math.sin(s);
        const cy = (sy / ct) * Math.cos(s) - sx * Math.sin(s);
        const p = proj.fromLatLngToPoint(new maps.LatLng(to.lat, to.lng));
        const q = proj.fromPointToLatLng(
          new maps.Point(p.x + cx / scale, p.y + cy / scale),
        );
        if (q) aim = { lat: q.lat(), lng: q.lng() };
      }

      return { z, fit, aim, tilt: tiltNow };
    },
    [layout, toLL, mapRef, maps, camRef, inset],
  );

  /* ---------------------------------------------------------------
     Flying in on a pick. Everything about WHERE is pickFrame's; this is
     the glide and the unwinding of the native camera. `ms` is short for
     a re-aim. The flight is skipped when the camera is already there
     (`still`).
  --------------------------------------------------------------- */
  const flyTo = useCallback(
    (name, msIn = FLY_MS, flat = false) => {
      const ms = reducedMotion() ? 1 : msIn;
      const m = mapRef.current;
      const f = pickFrame(name, undefined, flat);
      if (!m || !f) return;

      const z1 = f.z;
      const { aim } = f;

      const c0 = m.getCenter();
      if (!c0) return;
      const a = { lat: c0.lat(), lng: c0.lng() };
      const z0 = m.getZoom();

      /* where the native camera has to be unwound from */
      const h0 = wrapDeg(m.getHeading() || 0);
      const hDelta = h0 > 180 ? 360 - h0 : -h0; // the short way back to north
      const nt0 = m.getTilt() || 0;

      /* the tilt this frame was computed for — refitPick compares */
      framedTiltRef.current = f.tilt;

      const still =
        Math.abs(a.lat - aim.lat) < 1e-7 &&
        Math.abs(a.lng - aim.lng) < 1e-7 &&
        Math.abs(z1 - z0) < 0.05 &&
        Math.abs(hDelta) < 0.5 &&
        nt0 < 0.5;
      if (still) return;

      /* Raster hybrid rounds the zoom unless fractional zoom is on, and
       maxZoom must cover the fit or small plots refuse to get closer. */
      m.setOptions({ isFractionalZoomEnabled: true, maxZoom: MAP_MAX_Z });

      cancelAnimationFrame(flyRef.current);
      flyingRef.current = true;
      const t0 = performance.now();
      const step = (now) => {
        const t = easeOut(Math.min(1, (now - t0) / ms));
        const center = {
          lat: a.lat + (aim.lat - a.lat) * t,
          lng: a.lng + (aim.lng - a.lng) * t,
        };
        const z = z0 + (z1 - z0) * t;
        if (typeof m.moveCamera === "function") {
          m.moveCamera({
            center,
            zoom: z,
            heading: wrapDeg(h0 + hDelta * t),
            tilt: nt0 * (1 - t),
          });
        } else {
          m.setZoom(z);
          m.setCenter(center);
        }
        if (t < 1) {
          flyRef.current = requestAnimationFrame(step);
        } else {
          /* Let the drawing window settle at the zoom it landed on. */
          flyingRef.current = false;
          if (overlayRef.current) overlayRef.current.draw();
        }
      };
      flyRef.current = requestAnimationFrame(step);
    },
    [mapRef, pickFrame, overlayRef],
  );

  /* ── THE GESTURE FLAG ───────────────────────────────────────────
     One pair of calls around every native camera movement. While up,
     the drawing window is frozen and hover is ignored. The end is
     DELAYED 180 ms past the last pointer event to skip stray frames. */
  const beginTurn = useCallback(() => {
    clearTimeout(settleWinRef.current);
    turningRef.current = true;
  }, []);

  const endTurn = useCallback(() => {
    clearTimeout(settleWinRef.current);
    settleWinRef.current = setTimeout(() => {
      turningRef.current = false;
      if (overlayRef.current) overlayRef.current.draw();
    }, 180);
  }, [overlayRef]);

  useEffect(() => () => clearTimeout(settleWinRef.current), []);

  /* the flight is the user's the moment they touch anything */
  const stopFly = useCallback(() => {
    cancelAnimationFrame(flyRef.current);
    flyingRef.current = false;
  }, []);

  /* ---------------------------------------------------------------
     Zooming ABOUT THE PLOT. moveCamera({ zoom }) holds the map CENTRE
     still, and the centre is not the plot, so re-aim on every step. The
     ONLY thing that should change zoom while a plot is raised: pinch,
     wheel and refit all come through here.
  --------------------------------------------------------------- */
  const zoomAtPlot = useCallback(
    (z) => {
      const m = mapRef.current;
      if (!m) return;
      const f = pickFrame(selRef.current, z);
      if (!f) {
        if (typeof m.moveCamera === "function")
          m.moveCamera({ zoom: clamp(z, FLY_MIN_Z, MAP_MAX_Z) });
        else m.setZoom(clamp(z, FLY_MIN_Z, MAP_MAX_Z));
        return;
      }
      if (typeof m.moveCamera === "function")
        m.moveCamera({ zoom: f.z, center: f.aim });
      else {
        m.setZoom(f.z);
        m.setCenter(f.aim);
      }
    },
    [mapRef, pickFrame],
  );

  /* ---------------------------------------------------------------
     Re-fitting after a tilt. When a turn ENDS, re-fit to the tilt they
     finished on. Short and eased. Skipped once they have pinched.
  --------------------------------------------------------------- */
  const refitPick = useCallback(
    (msIn = REFIT_MS, force = false) => {
      const ms = reducedMotion() ? 1 : msIn;
      const m = mapRef.current;
      if (!m || !selRef.current) return;
      if (!force && manualZoomRef.current) return;

      const f = pickFrame(selRef.current);
      if (!f) return;

      /* nothing meaningful has changed since this frame was set */
      if (!force && Math.abs(f.tilt - framedTiltRef.current) < 0.02) return;
      framedTiltRef.current = f.tilt;

      const c0 = m.getCenter();
      const z0 = m.getZoom();
      if (!c0) return;
      const a = { lat: c0.lat(), lng: c0.lng() };
      if (!force && Math.abs(f.z - z0) < 0.04) return;

      cancelAnimationFrame(flyRef.current);
      flyingRef.current = true;
      const t0 = performance.now();
      const step = (now) => {
        const t = easeOut(Math.min(1, (now - t0) / ms));
        const center = {
          lat: a.lat + (f.aim.lat - a.lat) * t,
          lng: a.lng + (f.aim.lng - a.lng) * t,
        };
        const z = z0 + (f.z - z0) * t;
        if (typeof m.moveCamera === "function")
          m.moveCamera({ center, zoom: z });
        else {
          m.setZoom(z);
          m.setCenter(center);
        }
        if (t < 1) {
          flyRef.current = requestAnimationFrame(step);
        } else {
          flyingRef.current = false;
          if (overlayRef.current) overlayRef.current.draw();
        }
      };
      flyRef.current = requestAnimationFrame(step);
    },
    [mapRef, pickFrame, overlayRef],
  );

  /* ---------------------------------------------------------------
     Back to square — the CSS camera only. Eased over the same span as
     the flight; the heading takes the short way round. Also what the
     compass calls while a plot is raised.
  --------------------------------------------------------------- */
  const levelCam = useCallback(
    (msIn = FLY_MS) => {
      const ms = reducedMotion() ? 1 : msIn;
      const c = camRef.current;
      setSpin(false);
      cancelAnimationFrame(levelRef.current);

      /* fold the accumulated heading to its short equivalent first */
      const s0 = wrapRad(c.spin);
      const t0 = c.tilt;
      c.spin = s0;

      if (Math.abs(s0) < TURNED_EPS && t0 < TURNED_EPS) {
        framedTiltRef.current = 0;
        return;
      }

      const start = performance.now();
      const step = (now) => {
        const e = easeOut(Math.min(1, (now - start) / ms));
        c.spin = s0 * (1 - e);
        c.tilt = t0 * (1 - e);
        if (overlayRef.current) overlayRef.current.draw();
        if (e < 1) {
          levelRef.current = requestAnimationFrame(step);
        } else {
          c.spin = 0;
          c.tilt = 0;
          framedTiltRef.current = 0;
          if (overlayRef.current) overlayRef.current.draw();
          syncTurned();
          bump((n) => n + 1);
        }
      };
      levelRef.current = requestAnimationFrame(step);
    },
    [camRef, overlayRef, setSpin, syncTurned, bump],
  );

  useEffect(() => () => cancelAnimationFrame(levelRef.current), []);

  /* One press of + or −, or one double-tap. Eased, via zoomAtPlot so
     the plot does not drift. */
  const nudgeZoom = useCallback(
    (d) => {
      const m = mapRef.current;
      if (!m || !selRef.current) return;
      stopFly();
      manualZoomRef.current = true;
      const z0 = m.getZoom() || 18;
      const z1 = clamp(z0 + d, FLY_MIN_Z, MAP_MAX_Z);
      if (Math.abs(z1 - z0) < 0.01) return;

      const ms = reducedMotion() ? 1 : ZOOM_STEP_MS;
      flyingRef.current = true;
      const t0 = performance.now();
      const step = (now) => {
        const t = easeOut(Math.min(1, (now - t0) / ms));
        zoomAtPlot(z0 + (z1 - z0) * t);
        if (t < 1) {
          flyRef.current = requestAnimationFrame(step);
        } else {
          flyingRef.current = false;
          if (overlayRef.current) overlayRef.current.draw();
        }
      };
      flyRef.current = requestAnimationFrame(step);
    },
    [mapRef, stopFly, zoomAtPlot, overlayRef],
  );

  /* Back to the frame the pick was given. Hands the frame back to the
     code, so tilting starts re-fitting again. */
  const fitPick = useCallback(() => {
    stopFly();
    manualZoomRef.current = false;
    refitPick(REFIT_MS, true);
  }, [stopFly, refitPick]);

  /* ---------------------------------------------------------------
     The pinch, listened for on the DOCUMENT in the capture phase, so a
     two-finger pinch ANYWHERE zooms the raised plot while one-finger
     taps inside the sheet keep working. `touchmove` is cancelled
     non-passive, plus Safari's gesturestart/gesturechange, or the
     browser zooms the page instead. Only bound while a plot is raised.
  --------------------------------------------------------------- */
  useEffect(() => {
    if (!selected) return undefined;

    const pts = new Map();
    let start = null;

    const onDown = (e) => {
      if (e.pointerType !== "touch") return;
      pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (pts.size === 2) {
        const [p, q] = [...pts.values()];
        start = {
          dist: Math.max(1, Math.hypot(q.x - p.x, q.y - p.y)),
          zoom: mapRef.current?.getZoom?.() || 18,
        };
        stopFly();
      }
    };

    const onMove = (e) => {
      if (!pts.has(e.pointerId)) return;
      pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (pts.size < 2 || !start) return;
      const [p, q] = [...pts.values()];
      const dist = Math.max(1, Math.hypot(q.x - p.x, q.y - p.y));
      manualZoomRef.current = true;
      zoomAtPlot(start.zoom + Math.log2(dist / start.dist) * PINCH_GAIN);
      touched.current = Date.now();
    };

    const onUp = (e) => {
      pts.delete(e.pointerId);
      if (pts.size < 2) start = null;
    };

    const onTouchMove = (e) => {
      if (e.touches && e.touches.length >= 2 && e.cancelable)
        e.preventDefault();
    };

    const onGesture = (e) => {
      if (e.cancelable) e.preventDefault();
    };

    const cap = { capture: true };
    document.addEventListener("pointerdown", onDown, cap);
    document.addEventListener("pointermove", onMove, cap);
    document.addEventListener("pointerup", onUp, cap);
    document.addEventListener("pointercancel", onUp, cap);
    document.addEventListener("touchmove", onTouchMove, {
      capture: true,
      passive: false,
    });
    document.addEventListener("gesturestart", onGesture, {
      capture: true,
      passive: false,
    });
    document.addEventListener("gesturechange", onGesture, {
      capture: true,
      passive: false,
    });

    return () => {
      document.removeEventListener("pointerdown", onDown, cap);
      document.removeEventListener("pointermove", onMove, cap);
      document.removeEventListener("pointerup", onUp, cap);
      document.removeEventListener("pointercancel", onUp, cap);
      document.removeEventListener("touchmove", onTouchMove, { capture: true });
      document.removeEventListener("gesturestart", onGesture, {
        capture: true,
      });
      document.removeEventListener("gesturechange", onGesture, {
        capture: true,
      });
    };
  }, [selected, mapRef, zoomAtPlot, stopFly, touched]);

  useEffect(() => {
    selRef.current = selected;
  }, [selected]);
  useEffect(() => {
    if (!selected) setSpin(false);
  }, [selected, setSpin]);

  /* usePlanCamera starts its own idle orbit; refuse it while the top
     view holds, since zeroing per frame would fight it to a standstill. */
  useEffect(() => {
    if (spin && topLockRef.current) setSpin(false);
  }, [spin, setSpin]);
  useEffect(() => () => cancelAnimationFrame(flyRef.current), []);

  /* A pick flies once. `reserve` usually arrives a beat later, which
     changes flyTo's identity; same plot, second run: re-aim briefly. */
  useEffect(() => {
    if (!selected) {
      flownRef.current = null;
      manualZoomRef.current = false;
      topLockRef.current = false;
      return;
    }
    const reaim = flownRef.current === selected;
    /* a NEW plot gets a fresh frame */
    if (!reaim) manualZoomRef.current = false;
    flownRef.current = selected;

    /* Level and close in together. A re-aim is not a new pick: do not
       level again and fight whatever tilt the user has since chosen. */
    if (!reaim && TOP_VIEW_ON_PICK) {
      topLockRef.current = true;
      levelCam(FLY_MS);
    }
    flyTo(selected, reaim ? REAIM_MS : FLY_MS, !reaim && TOP_VIEW_ON_PICK);
  }, [selected, flyTo, levelCam]);

  /* Both camera flags are re-read on each pick edge. */
  useEffect(() => {
    syncTurned();
    if (selected) setNativeSpin(false);
    const id = setTimeout(syncNative, FLY_MS + 60);
    return () => clearTimeout(id);
  }, [selected, syncTurned, syncNative]);

  /* ── The 360, with nothing raised ────────────────────────────────
     Heading climbs and wraps. Speed is EASED, not switched, and waits
     out NATIVE_IDLE_MS after the last touch before taking the view
     back. */
  useEffect(() => {
    if (!nativeSpin || selected) {
      cancelAnimationFrame(nativeRafRef.current);
      spinVelRef.current = 0;
      return undefined;
    }
    spunRef.current = 0;
    turningRef.current = true;
    let last = performance.now();
    const step = (now) => {
      /* A backgrounded tab hands back one enormous dt on return. */
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      const m = mapRef.current;
      if (m && typeof m.moveCamera === "function") {
        /* Date.now(), NOT the rAF timestamp: nativeTouchRef is stamped
           with Date.now() (epoch ms) while `now` is performance.now();
           mixing them made idle false forever. */
        const idle =
          !nativeTouchRef.current ||
          Date.now() - nativeTouchRef.current > NATIVE_IDLE_MS;

        const left =
          lapBudgetRef.current === Infinity
            ? Infinity
            : lapBudgetRef.current - spunRef.current;
        if (left <= 0.2) {
          setNativeSpin(false);
          return;
        }
        const taper =
          left === Infinity ? 1 : clamp(left / SPIN_TAPER_DEG, 0, 1);

        const k = 1 - Math.exp(-(dt * 1000) / SPIN_TAU_MS);
        spinVelRef.current += ((idle ? taper : 0) - spinVelRef.current) * k;
        if (spinVelRef.current > 0.001) {
          const deg = Math.min(
            NATIVE_SPIN_DEG_PER_S * spinVelRef.current * dt,
            left,
          );
          spunRef.current += deg;
          m.moveCamera({ heading: wrapDeg((m.getHeading() || 0) + deg) });
        }
      }
      nativeRafRef.current = requestAnimationFrame(step);
    };
    nativeRafRef.current = requestAnimationFrame(step);
    return () => {
      cancelAnimationFrame(nativeRafRef.current);
      endTurn();
    };
  }, [nativeSpin, selected, mapRef, endTurn]);

  useEffect(() => () => cancelAnimationFrame(nativeRafRef.current), []);

  /* ── The opening: lean, pull back, then lap ──────────────────────
     Armed once the map exists. Given up the instant anyone touches the
     map or picks a plot. Reduced motion gets the fit and nothing else. */
  useEffect(() => {
    if (!INTRO_LEAN || !map || selected || introDoneRef.current)
      return undefined;
    if (typeof map.moveCamera !== "function") return undefined;
    if (reducedMotion()) {
      introDoneRef.current = true;
      return undefined;
    }

    let raf = 0;
    let timer = 0;

    const lean = () => {
      if (selRef.current) return;

      /* A tap while the tiles were still landing is not a decision to
         take the camera: wait until they have been still and retry. */
      if (
        nativeTouchRef.current &&
        Date.now() - nativeTouchRef.current < NATIVE_IDLE_MS
      ) {
        timer = setTimeout(lean, 400);
        return;
      }

      introDoneRef.current = true;
      const mark = Date.now();

      const tilt = Math.min(INTRO_TILT_DEG, NATIVE_MAX_TILT_DEG);
      introTiltRef.current = tilt;
      const z0 = map.getZoom() || 18;
      const t0 = performance.now();

      const step = (now) => {
        /* theirs now — leave the camera exactly where they put it */
        if (selRef.current || nativeTouchRef.current > mark) return;
        const e = easeInOut(Math.min(1, (now - t0) / INTRO_MS));
        map.moveCamera({ tilt: tilt * e, zoom: z0 - INTRO_PULL * e });
        if (e < 1) {
          raf = requestAnimationFrame(step);
        } else {
          syncNative();
          if (INTRO_LAPS > 0) {
            lapBudgetRef.current = 360 * INTRO_LAPS;
            setNativeSpin(true);
          }
        }
      };
      raf = requestAnimationFrame(step);
    };

    timer = setTimeout(lean, INTRO_WAIT_MS);

    return () => {
      clearTimeout(timer);
      cancelAnimationFrame(raf);
    };
  }, [map, selected, syncNative]);

  /* Back to north and flat, the short way round. The compass calls this
     while nothing is picked; levelCam is its opposite number. */
  const nativeFaceNorth = useCallback(() => {
    const m = mapRef.current;
    if (!m || typeof m.moveCamera !== "function") return;
    setNativeSpin(false);
    const h0 = wrapDeg(m.getHeading() || 0);
    const t0 = m.getTilt() || 0;
    const d = h0 > 180 ? 360 - h0 : -h0;
    const start = performance.now();
    const step = (now) => {
      const k = Math.min(1, (now - start) / 500);
      const e = easeOut(k);
      m.moveCamera({ heading: wrapDeg(h0 + d * e), tilt: t0 * (1 - e) });
      if (k < 1) requestAnimationFrame(step);
      else syncNative();
    };
    requestAnimationFrame(step);
  }, [mapRef, syncNative]);

  /* Whichever camera is live, back to north. */
  const resetHeading = useCallback(() => {
    if (selRef.current) levelCam(500);
    else nativeFaceNorth();
  }, [levelCam, nativeFaceNorth]);

  /* Back out to the whole layout when a plot is dismissed. The lean and
     heading survive it, since fitPlan puts them back. */
  useEffect(() => {
    if (selected || !map) return;
    if (shownRef.current === null) return; // nothing was ever up
    fitPlan();
    if (INTRO_LAPS === Infinity && !reducedMotion()) {
      lapBudgetRef.current = Infinity;
      setNativeSpin(true);
    }
  }, [selected, map, fitPlan]);

  /* ---------------------------------------------------------------
     Watching the element, not the window: ResizeObserver plus
     visualViewport (address bar, keyboard), all collapsed into one
     debounced call. Only while nothing is picked.
  --------------------------------------------------------------- */
  useEffect(() => {
    const el = viewRef.current;
    if (!el) return undefined;

    let timer = 0;
    const settle = () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        if (selRef.current) return;
        fitPlan();
      }, RESIZE_SETTLE_MS);
    };

    let ro = null;
    if (typeof ResizeObserver !== "undefined") {
      ro = new ResizeObserver(settle);
      ro.observe(el);
    }
    window.addEventListener("resize", settle);
    window.addEventListener("orientationchange", settle);
    const vv = window.visualViewport;
    if (vv) vv.addEventListener("resize", settle);

    return () => {
      clearTimeout(timer);
      if (ro) ro.disconnect();
      window.removeEventListener("resize", settle);
      window.removeEventListener("orientationchange", settle);
      if (vv) vv.removeEventListener("resize", settle);
    };
  }, [fitPlan, mapRef]);

  /* Sink whatever is up, swap the drawn plot, raise the new one. Height
     lives in a ref because the draw callback runs per frame. */
  useEffect(() => {
    if (selected === shownRef.current) return undefined;
    let raf = 0;

    const ramp = (from, to, ms, then) => {
      const t0 = performance.now();
      const step = (now) => {
        const t = Math.min(1, (now - t0) / ms);
        riseRef.current = from + (to - from) * easeOut(t);
        if (overlayRef.current) overlayRef.current.draw();
        if (t < 1) raf = requestAnimationFrame(step);
        else {
          bump((n) => n + 1);
          if (then) then();
        }
      };
      raf = requestAnimationFrame(step);
    };

    const raise = () => {
      shownRef.current = selected;
      setShown(selected);
      if (selected) ramp(0, 1, UP_MS);
      else {
        riseRef.current = 0;
        paintWalls(null);
      }
    };

    if (shownRef.current) ramp(riseRef.current, 0, DOWN_MS, raise);
    else raise();

    return () => cancelAnimationFrame(raf);
  }, [selected, overlayRef, bump, paintWalls]);

  /* How much bigger than the viewport the map has to be so that turning
     the CONTAINER never exposes a corner. Keyed to the CSS camera only;
     stays {0,0} until a plot is picked. */
  useEffect(() => {
    const fit = () => {
      const el = viewRef.current;
      if (!el) return;
      if (!turned && !selRef.current) {
        setPad({ x: 0, y: 0 });
        return;
      }
      const W = el.clientWidth;
      const H = el.clientHeight;
      const half = Math.hypot(W / 2, H / (2 * Math.cos(MAX_TILT)));
      setPad({ x: Math.ceil(half - W / 2), y: Math.ceil(half - H / 2) });
    };
    fit();

    let ro = null;
    const el = viewRef.current;
    if (el && typeof ResizeObserver !== "undefined") {
      ro = new ResizeObserver(fit);
      ro.observe(el);
    }
    window.addEventListener("resize", fit);
    window.addEventListener("orientationchange", fit);
    return () => {
      if (ro) ro.disconnect();
      window.removeEventListener("resize", fit);
      window.removeEventListener("orientationchange", fit);
    };
  }, [turned, selected]);

  /* the map itself */
  useEffect(() => {
    if (!maps || !hostRef.current) return;
    if (mapRef.current) {
      setMap(mapRef.current);
      return;
    }
    const centre = toLL(
      (bounds.x0 + bounds.x1) / 2,
      (bounds.y0 + bounds.y1) / 2,
    );
    const m = new maps.Map(hostRef.current, {
      center: centre,
      /* A starting value only — fitPlan overrides it below. */
      zoom: 18,
      mapTypeId: "hybrid",
      /* Without a Map ID set to Vector there is no native camera. */
      ...(GOOGLE_MAP_STYLE_ID ? { mapId: GOOGLE_MAP_STYLE_ID } : {}),

      /* THE THREE LINES THE 360 LIVES OR DIES BY: renderingType
         overrides the Map ID's cloud config, and the two interaction
         flags turn tilt and heading on. */
      renderingType: maps.RenderingType.VECTOR,
      tiltInteractionEnabled: true,
      headingInteractionEnabled: true,
      tilt: 0,
      heading: 0,
      streetViewControl: false,
      fullscreenControl: false,
      /* The compass replaces Google's rotate control. */
      rotateControl: false,
      mapTypeControl: false,
      zoomControlOptions: { position: maps.ControlPosition.RIGHT_BOTTOM },
      /* 'greedy' also hands Google's built-in rotate and tilt gestures
         to the map, on top of the drag handled below. */
      gestureHandling: "greedy",
      /* Must be at least FLY_MAX_Z; the lower cap wins. */
      maxZoom: MAP_MAX_Z,
      isFractionalZoomEnabled: true,
      /* READ ONCE, AT CONSTRUCTION. Changing MAP_BG needs a full reload. */
      backgroundColor: MAP_BG,
    });
    mapRef.current = m;
    setMap(m);

    /* Passed explicitly: mapRef.current was assigned this same tick.
       Fitted twice on purpose: once now, once on first idle against the
       real container size (skipped if a plot has been picked). */
    fitPlan(m);
    maps.event.addListenerOnce(m, "idle", () => {
      if (!selRef.current) fitPlan(m);
    });

    /* Turn on before debugging rotation: logs the renderer and whether
       the camera accepted a turn. */
    if (CAMERA_DEBUG) {
      maps.event.addListenerOnce(m, "tilesloaded", () => {
        // eslint-disable-next-line no-console
        console.log("rendering:", m.getRenderingType());
        m.moveCamera({ heading: 45, tilt: 45 });
        setTimeout(() => {
          // eslint-disable-next-line no-console
          console.log("after moveCamera:", m.getHeading(), m.getTilt());
          m.moveCamera({ heading: 0, tilt: 0 });
        }, 400);
      });
    }

    onReady();
  }, [maps, mapRef, toLL, bounds, onReady, fitPlan]);

  /* Google's own gestures move the native camera without going through
     this file, so keep the flag in step by listening to the map. */
  useEffect(() => {
    if (!map || !maps) return undefined;
    const ls = ["heading_changed", "tilt_changed"].map((ev) =>
      maps.event.addListener(map, ev, syncNative),
    );
    syncNative();
    return () => ls.forEach((l) => maps.event.removeListener(l));
  }, [map, maps, syncNative]);

  useLayoutEffect(() => {
    winRef.current = win;
    if (overlayRef.current) overlayRef.current.draw();
  }, [win, overlayRef]);

  /* ---------------------------------------------------------------
     Only ever draw the part of the plan you can actually see, at the
     size it appears on screen. The window follows the viewport, its
     pixel size follows the zoom, so the transform's scale stays 1.0.
     Handles a natively rotated map: the four window corners are
     projected one by one and quadMatrix takes the quadrilateral.
  --------------------------------------------------------------- */
  useEffect(() => {
    drawRef.current = (proj, dPlan, dScrim, dWall, dLift) => {
      if (!proj || !hostRef.current || !winRef.current) return;

      const px = ([x, y]) => {
        const ll = toLL(x, y);
        const q = proj.fromLatLngToDivPixel(new maps.LatLng(ll.lat, ll.lng));
        return { x: q.x, y: q.y };
      };
      const ref = px([0, 0]);
      const refX = px([100, 0]);
      const pxPerM = Math.hypot(refX.x - ref.x, refX.y - ref.y) / 100;
      if (!(pxPerM > 0)) return;

      /* WHAT THE VIEWPORT COVERS, MADE HEADING-PROOF: a SQUARE about the
         view centre, so the window is the same at 0° and 217° and a
         turn re-renders nothing. The radius is capped at the screen
         diagonal in ground metres so a steep tilt cannot swallow the
         whole drawing. */
      const W = hostRef.current.clientWidth;
      const H = hostRef.current.clientHeight;
      const mid = proj.fromContainerPixelToLatLng(new maps.Point(W / 2, H / 2));
      if (!mid) return;
      const cd = toDraw(mid.lat(), mid.lng());
      const cap = Math.hypot(W, H) / pxPerM;
      let r = 0;
      [
        [0, 0],
        [W, 0],
        [0, H],
        [W, H],
      ].forEach(([cx, cy]) => {
        const ll = proj.fromContainerPixelToLatLng(new maps.Point(cx, cy));
        if (!ll) return;
        const q = toDraw(ll.lat(), ll.lng());
        r = Math.max(r, Math.hypot(q[0] - cd[0], q[1] - cd[1]));
      });
      r = Math.min(r || cap * 0.5, cap) * 1.35; // 1.35 = room to pan into
      const nw = {
        x0: clamp(cd[0] - r, bounds.x0 - PAD, bounds.x1 + PAD),
        y0: clamp(cd[1] - r, bounds.y0 - PAD, bounds.y1 + PAD),
        x1: clamp(cd[0] + r, bounds.x0 - PAD, bounds.x1 + PAD),
        y1: clamp(cd[1] + r, bounds.y0 - PAD, bounds.y1 + PAD),
        s: pxPerM,
      };
      const cur = winRef.current;

      /* Re-render only when the view has genuinely left the window or
         the zoom moved enough. NOTHING re-renders mid-flight or
         mid-turn; the window is settled once afterwards. */
      const outside =
        nw.x0 < cur.x0 - 0.01 ||
        nw.y0 < cur.y0 - 0.01 ||
        nw.x1 > cur.x1 + 0.01 ||
        nw.y1 > cur.y1 + 0.01;
      const rescaled = pxPerM / cur.s > 1.6 || pxPerM / cur.s < 0.45;
      if ((outside || rescaled) && !flyingRef.current && !turningRef.current) {
        setWin(nw);
        return;
      }

      /* the window's own pixel size, held to a sane texture budget */
      const spanX = cur.x1 - cur.x0;
      const spanY = cur.y1 - cur.y0;
      const s = Math.min(cur.s, MAX_SHEET / Math.max(spanX, spanY));
      const wpx = spanX * s;
      const hpx = spanY * s;

      const q1 = px([cur.x0, cur.y0]);
      const q2 = px([cur.x1, cur.y0]);
      const q3 = px([cur.x0, cur.y1]);
      const q4 = px([cur.x1, cur.y1]);
      const m = `matrix3d(${quadMatrix(wpx, hpx, q1, q2, q3, q4).join(",")})`;

      /* the scrim follows the SELECTION so it doesn't blink mid-swap;
         the block follows what is actually drawn */
      const sel = shownRef.current && layout.byName.get(shownRef.current);
      dScrim.style.opacity = selRef.current ? "1" : "0";
      dPlan.style.transform = m;

      if (!sel) {
        dLift.style.transform = m;
        paintWalls(null);
        paintDims(null);
        return;
      }

      /* The container is what turns, so the lift is expressed in
         container coordinates. */
      const cam = camRef.current;

      /* held flat until the user turns it themselves — see topLockRef */
      if (topLockRef.current) {
        cam.spin = 0;
        cam.tilt = 0;
      }

      const ct = Math.cos(cam.tilt);
      const rise = LIFT_H * pxPerM * Math.sin(cam.tilt) * riseRef.current;
      if (rise < 0.5) {
        dLift.style.transform = m;
        paintWalls(null);
        paintDims(null);
        return;
      }
      const up = {
        x: (-rise / ct) * Math.sin(cam.spin),
        y: (-rise / ct) * Math.cos(cam.spin),
      };
      dLift.style.transform = `translate(${up.x}px, ${up.y}px) ${m}`;

      /* Walls live in screen pixels, in a box sized exactly to them. */
      const ring = sel.pts.map(px);
      const all = ring.concat(
        ring.map((q) => ({ x: q.x + up.x, y: q.y + up.y })),
      );
      const bx0 = Math.floor(Math.min(...all.map((q) => q.x))) - 2;
      const by0 = Math.floor(Math.min(...all.map((q) => q.y))) - 2;
      const bx1 = Math.ceil(Math.max(...all.map((q) => q.x))) + 2;
      const by1 = Math.ceil(Math.max(...all.map((q) => q.y))) + 2;

      const faces = ring
        .map((_, i) => {
          const u = ring[i];
          const v = ring[(i + 1) % ring.length];
          return {
            i,
            // nearness after the turn: project the edge onto the screen-down axis
            depth:
              (u.y + v.y) * Math.cos(cam.spin) -
              (u.x + v.x) * Math.sin(cam.spin),
            d:
              `M${u.x} ${u.y}L${v.x} ${v.y}` +
              `L${v.x + up.x} ${v.y + up.y}L${u.x + up.x} ${u.y + up.y}Z`,
          };
        })
        .sort((u, v) => u.depth - v.depth);

      paintWalls({ x: bx0, y: by0, w: bx1 - bx0, h: by1 - by0 }, faces);

      /* ── the screen-space figures (SCREEN_DIMS only) ───────────── */
      if (!SCREEN_DIMS) {
        paintDims(null);
        return;
      }

      const cs = Math.cos(cam.spin);
      const ss = Math.sin(cam.spin);
      const gx = ring.reduce((s2, p) => s2 + p.x, 0) / ring.length;
      const gy = ring.reduce((s2, p) => s2 + p.y, 0) / ring.length;
      const items = [];

      for (let i = 0; i < ring.length; i += 1) {
        const u = ring[i];
        const v = ring[(i + 1) % ring.length];
        const a = sel.pts[i];
        const b = sel.pts[(i + 1) % sel.pts.length];

        /* the edge as the screen sees it */
        const dxc = v.x - u.x;
        const dyc = v.y - u.y;
        const ex = dxc * cs - dyc * ss;
        const ey = (dxc * ss + dyc * cs) * ct;
        if (Math.hypot(ex, ey) < DIM_MIN_EDGE) continue;

        /* outward, normalised in SCREEN px, mapped back to container */
        const mx = (u.x + v.x) / 2;
        const my = (u.y + v.y) / 2;
        const ox = mx - gx;
        const oy = my - gy;
        const osx = ox * cs - oy * ss;
        const osy = (ox * ss + oy * cs) * ct;
        const n = Math.hypot(osx, osy) || 1;
        const fx = (osx / n) * DIM_OFFSET;
        const fy = (osy / n) * DIM_OFFSET;
        const kx = fx * cs + (fy / ct) * ss;
        const ky = (fy / ct) * cs - fx * ss;

        const metres = Math.hypot(b[0] - a[0], b[1] - a[1]);
        items.push({
          x: mx + up.x + kx,
          y: my + up.y + ky,
          rot: -cam.spin / RAD,
          sy: 1 / ct,
          label: `${metres >= 10 ? metres.toFixed(1) : metres.toFixed(2)} m`,
        });
      }

      paintDims(
        {
          x: bx0 - DIM_PAD,
          y: by0 - DIM_PAD,
          w: bx1 - bx0 + DIM_PAD * 2,
          h: by1 - by0 + DIM_PAD * 2,
        },
        items,
      );
    };
    if (overlayRef.current) overlayRef.current.draw();
  }, [
    maps,
    map,
    layout,
    toLL,
    toDraw,
    bounds,
    selected,
    shown,
    win,
    camRef,
    overlayRef,
    paintWalls,
    paintDims,
  ]);

  /* ── Turning the view, plot raised ───────────────────────────────
     The CSS camera. Apply a delta measured from wherever the grab
     started, then redraw. Draw only: no bump, no syncTurned per frame. */
  const applyTurn = useCallback(
    (dSpin, dTilt, from) => {
      /* A deliberate turn, not finger jitter: the top-view hold is done. */
      if (Math.abs(dSpin) > 0.01 || Math.abs(dTilt) > 0.01) {
        topLockRef.current = false;
      }
      camRef.current.spin = from.spin + dSpin;
      camRef.current.tilt = clamp(from.tilt + dTilt, 0, MAX_TILT);
      if (overlayRef.current) overlayRef.current.draw();
      touched.current = Date.now();
    },
    [camRef, overlayRef, touched],
  );

  /* With a plot raised the whole surface orbits on a plain drag. */
  const startOrbit = (e) => {
    stopFly();
    touched.current = Date.now();
    if (!selRef.current) return;

    e.stopPropagation();
    e.currentTarget.setPointerCapture(e.pointerId);

    pinchRef.current.set(e.pointerId, { x: e.clientX, y: e.clientY });

    if (pinchRef.current.size === 2) {
      const points = [...pinchRef.current.values()];
      const dx = points[1].x - points[0].x;
      const dy = points[1].y - points[0].y;
      pinchStartRef.current = {
        distance: Math.hypot(dx, dy),
        zoom: mapRef.current?.getZoom?.() || 18,
      };
      dragRef.current = null;
      return;
    }

    dragRef.current = {
      x: e.clientX,
      y: e.clientY,
      spin: camRef.current.spin,
      tilt: camRef.current.tilt,
      moved: false,
    };
  };

  const onPointerMove = (e) => {
    if (pinchRef.current.has(e.pointerId)) {
      pinchRef.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    }

    if (pinchRef.current.size >= 2) {
      const start = pinchStartRef.current;
      const points = [...pinchRef.current.values()];
      if (!start || points.length < 2) return;

      const dx = points[1].x - points[0].x;
      const dy = points[1].y - points[0].y;
      const distance = Math.max(1, Math.hypot(dx, dy));
      const zoomDelta = Math.log2(distance / Math.max(1, start.distance));
      const nextZoom = clamp(
        start.zoom + zoomDelta * PINCH_GAIN,
        FLY_MIN_Z,
        MAP_MAX_Z,
      );

      /* the plot stays under the fingers; no refit will take this zoom */
      manualZoomRef.current = true;
      zoomAtPlot(nextZoom);
      touched.current = Date.now();
      return;
    }

    const g = dragRef.current;
    if (!g) return;
    const dx = e.clientX - g.x;
    const dy = e.clientY - g.y;
    if (Math.abs(dx) > 3 || Math.abs(dy) > 3) g.moved = true;
    applyTurn(dx * 0.008, -dy * 0.006, g);
  };

  const endDrag = (e) => {
    pinchRef.current.delete(e?.pointerId);

    if (pinchRef.current.size < 2) {
      pinchStartRef.current = null;
    }

    touched.current = Date.now();

    // Do not interpret the end of a pinch as a tap.
    if (pinchRef.current.size > 0 || pinchStartRef.current) {
      dragRef.current = null;
      if (pinchRef.current.size === 0) pinchStartRef.current = null;
      syncTurned();
      bump((n) => n + 1);
      return;
    }

    dragRef.current = null;
    syncTurned();
    bump((n) => n + 1);
    refitPick();
  };

  /* ── TURNING THE MAP, FROM ANYWHERE, ON ANY DEVICE ───────────────
     The turn, tilt and zoom of the UNPICKED map, listened for on the
     DOCUMENT in the capture phase (touch and mouse), so a two-finger
     gesture ANYWHERE turns the map even if it starts on the header,
     filter button, legend or toggles. Twist = heading, sliding up/down
     = tilt, spreading = zoom. One finger still pans. MOUSE: a plain
     left drag turns and tilts; drags that start on something
     interactive are left alone (INTERACTIVE keeps the compass and the
     toggles clickable). NONE OF IT WORKS ON A RASTER MAP. */
  const INTERACTIVE =
    'button, a, input, select, textarea, label, [role="button"], [role="switch"]';
  useEffect(() => {
    if (selected) return undefined;

    const onDown = (e) => {
      const m = mapRef.current;
      if (!m || typeof m.moveCamera !== "function") return;

      if (e.pointerType !== "touch") {
        if (e.button !== 0) return;
        if (e.target && e.target.closest && e.target.closest(INTERACTIVE))
          return;
        stopFly();
        beginTurn();
        nativeTouchRef.current = Date.now();
        nativeDragRef.current = {
          x: e.clientX,
          y: e.clientY,
          heading: m.getHeading() || 0,
          tilt: m.getTilt() || 0,
        };
        m.setOptions({ draggable: false });
        return;
      }

      natPtrs.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
      nativeTouchRef.current = Date.now();
      if (natPtrs.current.size === 2) {
        const [p, q] = [...natPtrs.current.values()];
        natGesture.current = {
          angle: Math.atan2(q.y - p.y, q.x - p.x),
          dist: Math.max(1, Math.hypot(q.x - p.x, q.y - p.y)),
          midY: (p.y + q.y) / 2,
          heading: m.getHeading() || 0,
          tilt: m.getTilt() || 0,
          zoom: m.getZoom() || 18,
        };
        stopFly();
        beginTurn();
        /* take the gesture over completely, or Google acts on the same
           two fingers and the view turns twice as far as the hand */
        m.setOptions({ gestureHandling: "none", draggable: false });
      }
    };

    const onMove = (e) => {
      /* mouse: heading off the horizontal, tilt off the vertical */
      const d = nativeDragRef.current;
      if (d && e.pointerType !== "touch") {
        const m2 = mapRef.current;
        if (!m2) return;
        nativeTouchRef.current = Date.now();
        m2.moveCamera({
          heading: wrapDeg(d.heading + (e.clientX - d.x) * NATIVE_SPIN_PER_PX),
          tilt: clamp(
            d.tilt - (e.clientY - d.y) * NATIVE_TILT_PER_PX,
            0,
            NATIVE_MAX_TILT_DEG,
          ),
        });
        return;
      }

      if (!natPtrs.current.has(e.pointerId)) return;
      natPtrs.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
      const g = natGesture.current;
      const m = mapRef.current;
      if (!g || !m || natPtrs.current.size < 2) return;

      const [p, q] = [...natPtrs.current.values()];
      let dA = (Math.atan2(q.y - p.y, q.x - p.x) - g.angle) / RAD;
      if (dA > 180) dA -= 360;
      if (dA < -180) dA += 360;

      const dist = Math.max(1, Math.hypot(q.x - p.x, q.y - p.y));
      const midY = (p.y + q.y) / 2;

      m.moveCamera({
        /* flip this sign if the map turns against the fingers */
        heading: wrapDeg(g.heading - dA),
        tilt: clamp(
          g.tilt + (g.midY - midY) * NATIVE_TILT_PER_PX,
          0,
          NATIVE_MAX_TILT_DEG,
        ),
        zoom: clamp(g.zoom + Math.log2(dist / g.dist), FLY_MIN_Z, MAP_MAX_Z),
      });
      nativeTouchRef.current = Date.now();
    };

    const onUp = (e) => {
      if (nativeDragRef.current) {
        nativeDragRef.current = null;
        const m2 = mapRef.current;
        if (m2 && !selRef.current) m2.setOptions({ draggable: true });
      }
      natPtrs.current.delete(e.pointerId);
      if (natGesture.current && natPtrs.current.size < 2) {
        natGesture.current = null;
        const m = mapRef.current;
        if (m && !selRef.current) {
          m.setOptions({ gestureHandling: "greedy", draggable: true });
        }
      }
      nativeTouchRef.current = Date.now();
      if (!natGesture.current && !nativeDragRef.current) endTurn();
      syncNative();
    };

    const onTouchMove = (e) => {
      if (natGesture.current && e.cancelable) e.preventDefault();
    };
    const onGesture = (e) => {
      if (e.cancelable) e.preventDefault();
    };

    const cap = { capture: true };
    document.addEventListener("pointerdown", onDown, cap);
    document.addEventListener("pointermove", onMove, cap);
    document.addEventListener("pointerup", onUp, cap);
    document.addEventListener("pointercancel", onUp, cap);
    document.addEventListener("touchmove", onTouchMove, {
      capture: true,
      passive: false,
    });
    document.addEventListener("gesturestart", onGesture, {
      capture: true,
      passive: false,
    });
    document.addEventListener("gesturechange", onGesture, {
      capture: true,
      passive: false,
    });

    return () => {
      document.removeEventListener("pointerdown", onDown, cap);
      document.removeEventListener("pointermove", onMove, cap);
      document.removeEventListener("pointerup", onUp, cap);
      document.removeEventListener("pointercancel", onUp, cap);
      document.removeEventListener("touchmove", onTouchMove, { capture: true });
      document.removeEventListener("gesturestart", onGesture, {
        capture: true,
      });
      document.removeEventListener("gesturechange", onGesture, {
        capture: true,
      });
      natPtrs.current.clear();
      natGesture.current = null;
      nativeDragRef.current = null;
    };
  }, [selected, mapRef, stopFly, syncNative, beginTurn, endTurn]);

  /* Any touch of the map hands the auto-spin back to the user. */
  const noteNativeTouch = () => {
    nativeTouchRef.current = Date.now();
  };

  /* A tap on the orbit surface that never became a drag is meant for
     whatever sits under it: blind the surface for one call and hit-test
     the real DOM (the browser applies the container transform). */
  const pickThrough = (e) => {
    const surface = e.currentTarget;
    const prev = surface.style.pointerEvents;
    surface.style.pointerEvents = "none";
    const el = document.elementFromPoint(e.clientX, e.clientY);
    surface.style.pointerEvents = prev;
    const hit = el && el.closest && el.closest("[data-plot]");
    return hit ? hit.getAttribute("data-plot") : null;
  };

  const endOrbit = (e) => {
    const g = dragRef.current;

    pinchRef.current.delete(e.pointerId);

    // A pinch must never become a plot click when the second finger lifts.
    if (pinchStartRef.current) {
      if (pinchRef.current.size < 2) pinchStartRef.current = null;
      dragRef.current = null;
      touched.current = Date.now();
      syncTurned();
      bump((n) => n + 1);
      return;
    }

    touched.current = Date.now();
    dragRef.current = null;
    syncTurned();
    bump((n) => n + 1);

    if (g && g.moved) {
      refitPick();
      return;
    }

    /* A second tap in the same place, quickly, means closer. */
    const now = Date.now();
    const last = tapRef.current;
    tapRef.current = { x: e.clientX, y: e.clientY, t: now };
    if (
      last &&
      now - last.t < DOUBLE_TAP_MS &&
      Math.hypot(e.clientX - last.x, e.clientY - last.y) < DOUBLE_TAP_PX
    ) {
      tapRef.current = null;
      nudgeZoom(ZOOM_STEP);
      return;
    }

    const name = pickThrough(e);
    if (name && name !== selRef.current) onSelect(name);
  };

  /* Google positions its drag and wheel handling from raw client
     coordinates, which the container transform invalidates, so take
     both over while a plot is up. */
  useEffect(() => {
    const m = mapRef.current;
    if (!m) return;
    if (selected) {
      natPtrs.current.clear();
      natGesture.current = null;
      nativeDragRef.current = null;
    }
    m.setOptions({
      draggable: !selected,
      scrollwheel: !selected,
      gestureHandling: "greedy",
    });
  }, [selected, mapRef, map]);

  /* Wheel zoom while a plot is up. The flight leaves zoom on a
     fraction, so each notch steps from the current value. */
  const onWheel = useCallback(
    (e) => {
      const m = mapRef.current;
      if (!selected || !m) return;
      e.preventDefault();
      stopFly();
      wheelRef.current += e.deltaY;
      if (Math.abs(wheelRef.current) < 12) return;

      const currentZoom = m.getZoom() || 18;
      const direction = wheelRef.current > 0 ? -1 : 1;
      const step = Math.min(
        0.6,
        Math.max(0.18, Math.abs(wheelRef.current) / 120),
      );
      const nextZoom = clamp(
        currentZoom + direction * step,
        FLY_MIN_Z,
        MAP_MAX_Z,
      );

      manualZoomRef.current = true;
      zoomAtPlot(nextZoom);

      wheelRef.current = 0;
    },
    [selected, mapRef, stopFly, zoomAtPlot],
  );

  /* React registers its root `wheel` listener as PASSIVE, so bind it on
     the element ourselves, non-passive. macOS trackpad pinch arrives
     here as ctrl+wheel, covered by the same cancel. */
  useEffect(() => {
    const el = viewRef.current;
    if (!el) return undefined;
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [onWheel]);

  const shownPlot = shown ? layout.byName.get(shown) : null;

  /* the window, in the units each layer needs */
  const spanX = win.x1 - win.x0;
  const spanY = win.y1 - win.y0;
  const sheetS = Math.min(win.s, MAX_SHEET / Math.max(spanX, spanY));
  const viewBox = `${win.x0} ${win.y0} ${spanX} ${spanY}`;
  const sheetW = spanX * sheetS;
  const sheetH = spanY * sheetS;

  /* Stable, so PlanContentMemo can actually hold. */
  const onPickPlot = useCallback(
    (name) => {
      if (dragRef.current && dragRef.current.moved) return;
      onSelect(name);
    },
    [onSelect],
  );

  const planLayer =
    divs &&
    createPortal(
      <svg
        viewBox={viewBox}
        width={sheetW}
        height={sheetH}
        style={{
          overflow: "hidden",
          display: "block",
          cursor: selected ? "grab" : "pointer",
          touchAction: selected ? "none" : "auto",
        }}
        onPointerDown={startOrbit}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onMouseLeave={() => setHoverSafe(null)}
      >
        <PlanContentMemo
          layout={layout}
          selected={shown}
          matches={shownMatches}
          status={status}
          showNumbers={numbersOn}
          /* Category win while on: both colour the same plots. */
          showStatus={statusOn && !categoryOn}
          categories={categoryMap}
          showCategory={categoryOn}
          hover={hover}
          setHover={setHoverSafe}
          onPick={onPickPlot}
        />
      </svg>,
      divs.plan,
    );

  /* Two nodes, mounted once, written to by paintWalls and paintDims. */
  const wallLayer =
    divs &&
    createPortal(
      <>
        <svg
          ref={wallSvgRef}
          style={{
            position: "absolute",
            left: 0,
            top: 0,
            display: "none",
            pointerEvents: "none",
          }}
        />
        <svg
          ref={dimSvgRef}
          style={{
            position: "absolute",
            left: 0,
            top: 0,
            display: "none",
            pointerEvents: "none",
            overflow: "visible",
          }}
        />
      </>,
      divs.wall,
    );

  const liftLayer =
    divs &&
    shownPlot &&
    createPortal(
      <svg
        viewBox={viewBox}
        width={sheetW}
        height={sheetH}
        style={{ overflow: "hidden", display: "block" }}
      >
        <path
          d={pathWithHoles(shownPlot.pts)}
          fill={SELECTED_FILL}
          stroke="#E9C6F2"
          strokeWidth={SEL_STROKE}
        />
        {/* Figures moved to the screen-space layer when SCREEN_DIMS is on;
          leaving this too would print every measurement twice. */}
        {!SCREEN_DIMS && <DimensionOverlay plot={shownPlot} />}
      </svg>,
      divs.lift,
    );

  return (
    <>
      {/* The window you see through. With a plot raised the map inside
          is deliberately larger, because the container turns. MAP_BG on
          this, the host below and the map's backgroundColor: any two
          disagreeing is a visible seam. */}
      <div
        ref={viewRef}
        onTouchStart={noteNativeTouch}
        onPointerDown={noteNativeTouch}
        onContextMenu={(e) => e.preventDefault()}
        className="plan-map-viewport"
        style={{
          position: "absolute",
          inset: 0,
          overflow: "hidden",
          background: MAP_BG,
        }}
      >
        <div
          ref={hostRef}
          style={{
            position: "absolute",
            left: -pad.x,
            top: -pad.y,
            right: -pad.x,
            bottom: -pad.y,
            background: MAP_BG,
            transformOrigin: "50% 50%",
            willChange: "transform",
            cursor: selected ? "grab" : "default",
          }}
        />
      </div>

      {/* orbit surface: covers the map while a plot is up. */}
      {selected && (
        <div
          onPointerDown={startOrbit}
          onPointerMove={onPointerMove}
          onPointerUp={endOrbit}
          onPointerCancel={endOrbit}
          style={{
            position: "absolute",
            inset: 0,
            zIndex: 5,
            touchAction: "none",
            cursor: "grab",
          }}
        />
      )}

      {planLayer}
      {wallLayer}
      {liftLayer}

      {/* North, and the way back to it. */}
      <Compass
        mapRef={mapRef}
        camRef={camRef}
        selectedRef={selRef}
        onReset={resetHeading}
      />

      {/* Zoom, on screen, while a plot is raised. The only zoom that is
          guaranteed reachable (pinch can be swallowed, wheel needs a
          mouse). zIndex 6 puts it over the orbit surface. 44 px is the
          smallest reliable finger target; 16px+ font avoids iOS zoom. */}
      {selected && (
        <div
          style={{
            position: "absolute",
            zIndex: 6,
            right: safeArea("right", 12),
            bottom: safeArea("bottom", (inset.bottom || 0) + 16),
            display: "grid",
            gap: 8,
            justifyItems: "center",
          }}
        >
          {[
            {
              k: "in",
              label: "+",
              title: "Zoom in",
              act: () => nudgeZoom(ZOOM_STEP),
            },
            {
              k: "out",
              label: "−",
              title: "Zoom out",
              act: () => nudgeZoom(-ZOOM_STEP),
            },
            { k: "fit", label: "⌂", title: "Fit plot", act: fitPick },
          ].map((b) => (
            <button
              key={b.k}
              type="button"
              title={b.title}
              aria-label={b.title}
              onPointerDown={(e) => e.stopPropagation()}
              onClick={b.act}
              style={{
                width: 44,
                height: 44,
                font: `500 18px/1 ${MONO}`,
                WebkitTapHighlightColor: "transparent",
                WebkitAppearance: "none",
                appearance: "none",
                color: "#E7E1D5",
                background: CANVAS,
                border: `1px solid ${HAIR}`,
                borderRadius: 12,
                cursor: "pointer",
                display: "grid",
                placeItems: "center",
                touchAction: "manipulation",
              }}
            >
              {b.label}
            </button>
          ))}
        </div>
      )}

      {/* Filters. Above the orbit surface (zIndex 5) so it stays usable
          while a plot is raised. */}
      {!showFilters && (
        <button
          type="button"
          onClick={() => setShowFilters(true)}
          className="filter-toggle-btn"
          style={{
            font: `500 13px/1 ${MONO}`,
            color: filterHits ? CANVAS : "#E7E1D5",
            background: filterHits ? ACCENT : CANVAS,
            border: `1px solid ${filterHits ? ACCENT : HAIR}`,
            borderRadius: 10,
            padding: "11px 10px",
            cursor: "pointer",
          }}
        >
          Filters{filterHits ? ` · ${filterHits.size}` : ""}
        </button>
      )}

      {showFilters && (
        <FilterPanel
          plots={plots}
          filters={draft}
          onApply={onApplyFilters}
          onClose={() => setShowFilters(false)}
        />
      )}

      {/* MapToggles draws only the switches it has a handler for. */}
      <MapToggles
        showNumbers={numbersOn}
        setShowNumbers={toggleNumbers}
        showStatus={statusOn}
        setShowStatus={canStatus ? toggleStatus : null}
        showCategory={categoryOn}
        setShowCategory={toggleCategory}
      />

      {/* One legend at a time: sale colours, or category colours. */}
      {canStatus && !categoryOn && (
        <StatusLegend plots={plots} status={status} show={statusOn} />
      )}

      <CategoryLegend
        plots={plots}
        categories={categoryMap}
        show={categoryOn}
      />

      {error && (
        <div
          style={{
            position: "absolute",
            inset: 0,
            display: "grid",
            placeItems: "center",
            padding: 24,
            background: CANVAS,
            color: "#E68A72",
            fontFamily: MONO,
            fontSize: 13,
            textAlign: "center",
            lineHeight: 1.6,
          }}
        >
          {error}
        </div>
      )}
    </>
  );
}
