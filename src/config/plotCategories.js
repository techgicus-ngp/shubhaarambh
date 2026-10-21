export const CATEGORY_STYLE = {
  residential:    { label: 'Residential',     fill: '#4E9A57' },
  commercial:     { label: 'Commercial',      fill: '#C2AE2A' },
  semicommercial: { label: 'Semi-commercial', fill: '#5AA79B' },
  corner:         { label: 'Corner',          fill: '#9B59B6' },
};

export const normalizeCategory = (v) => {
  if (!v) return null;
  const k = String(v).toLowerCase().replace(/[^a-z]/g, '');
  if (CATEGORY_STYLE[k]) return k;
  // tolerate "Residential Plot", "semi-commercial", "Corner plot", etc.
  if (k.includes('semi')) return 'semicommercial';
  if (k.includes('corner')) return 'corner';
  if (k.includes('commercial')) return 'commercial';
  if (k.includes('resid')) return 'residential';
  return null;
};

export const categoryFill = (categories, plotName) => {
  const k = normalizeCategory(categories && categories[plotName]);
  return k ? CATEGORY_STYLE[k].fill : null;
};

// field names (letters only, lowercase) that may hold the category
const CATEGORY_KEYS = [
  'category', 'plotcategory', 'plottype', 'landuse', 'use', 'zone', 'type',
];

export const readCategory = (p) => {
  if (!p) return null;
  const sources = [p, p.doc, p.properties, p.props, p.data, p.raw];
  for (const src of sources) {
    if (!src || typeof src !== 'object') continue;
    for (const key of Object.keys(src)) {
      const nk = key.toLowerCase().replace(/[^a-z]/g, '');
      if (CATEGORY_KEYS.includes(nk) && normalizeCategory(src[key])) {
        return src[key];
      }
    }
  }
  return null;
};