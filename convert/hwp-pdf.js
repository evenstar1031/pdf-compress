// 한글(HWP·HWPX) → PDF
// rhwp(WebAssembly)가 쪽마다 그려 주는 SVG를 MuPDF PDF 쪽으로 옮겨 쓴다.
// 글자는 진짜 글자(검색·복사 가능)로, 선·도형은 벡터로, 그림은 그대로 넣는다.
// 글꼴은 호출하는 쪽이 준 글꼴 묶음(NewFontSet 모양: resolveKey, map, ref, advance)으로 쓴다.
//
// 이 파일은 lectrue-font-swap 과 pdf-compress 두 저장소에 똑같이 들어 있다.

let rhwpP = null;

/** rhwp 엔진 불러오기 (한 번만). baseUrl: rhwp.js 와 rhwp_bg.wasm 이 있는 폴더 */
export function loadRhwp(baseUrl) {
  if (rhwpP) return rhwpP;
  rhwpP = (async () => {
    if (typeof globalThis.measureTextWidth !== 'function') {
      // rhwp는 대부분 자체 글꼴 폭 표를 쓰지만, 모르는 글꼴은 이 함수로 잰다.
      let ctx = null, last = '';
      globalThis.measureTextWidth = (font, text) => {
        try {
          if (!ctx && typeof OffscreenCanvas !== 'undefined') ctx = new OffscreenCanvas(8, 8).getContext('2d');
          if (!ctx && typeof document !== 'undefined') ctx = document.createElement('canvas').getContext('2d');
        } catch (e) { ctx = null; }
        if (ctx) { if (font !== last) { ctx.font = font; last = font; } return ctx.measureText(text).width; }
        const m = /([\d.]+)px/.exec(font);
        const s = m ? +m[1] : 16;
        let w = 0;
        for (const ch of text) w += ch.codePointAt(0) >= 0x1100 ? s : s * 0.55;
        return w;
      };
    }
    const mod = await import(new URL('rhwp.js', baseUrl).href);
    await mod.default({ module_or_path: new URL('rhwp_bg.wasm', baseUrl).href });
    return mod;
  })();
  rhwpP.catch(() => { rhwpP = null; });
  return rhwpP;
}

export function isHwpName(name) { return /\.(hwp|hwpx)$/i.test(name || ''); }

/** 한글 파일 열기 → { doc, pages } (doc은 다 쓰면 free) */
export function openHwp(rhwp, bytes) {
  let doc;
  try {
    doc = new rhwp.HwpDocument(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes));
  } catch (e) {
    const msg = String((e && e.message) || e);
    if (/password|암호|encrypt|distribut|배포/i.test(msg)) throw new Error('암호가 걸렸거나 배포용으로 잠긴 한글 문서예요. 한글에서 잠금을 푼 뒤 넣어 주세요.');
    throw new Error('한글 문서를 열 수 없어요 (' + msg.slice(0, 120) + ')');
  }
  return { doc, pages: doc.pageCount() };
}

export function renderHwpSvg(hdoc, i) {
  try { return hdoc.renderPageSvgWithProfile(i, 'print'); } catch (e) { return hdoc.renderPageSvg(i); }
}

// ------------------------------------------------------------------ 작은 XML 해석기
const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
function unescapeXml(s) {
  if (s.indexOf('&') < 0) return s;
  return s.replace(/&(#x[0-9a-fA-F]+|#\d+|[a-zA-Z]+);/g, (m, e) => {
    if (e[0] === '#') { const n = e[1] === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10); try { return String.fromCodePoint(n); } catch (er) { return ''; } }
    return ENT[e] != null ? ENT[e] : m;
  });
}
export function parseXml(src) {
  const root = { name: '#root', attrs: {}, kids: [], text: '' };
  const stack = [root];
  const re = /<!--[\s\S]*?-->|<!\[CDATA\[([\s\S]*?)\]\]>|<\?[\s\S]*?\?>|<!(?:DOCTYPE|doctype)(?:[^>[]|\[[^\]]*\])*>|<(\/?)([A-Za-z_][\w:.-]*)((?:\s+[^\s=/>]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+))?)*)\s*(\/?)>|([^<]+)/g;
  const attrRe = /([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g;
  let m;
  while ((m = re.exec(src))) {
    const top = stack[stack.length - 1];
    if (m[1] != null) { top.kids.push({ name: '#text', text: m[1] }); continue; }
    if (m[6] != null) { if (m[6].trim() || top.name === 'text' || top.name === 'tspan') top.kids.push({ name: '#text', text: unescapeXml(m[6]) }); continue; }
    if (!m[3]) continue;
    if (m[2] === '/') {
      for (let i = stack.length - 1; i > 0; i--) if (stack[i].name === m[3]) { stack.length = i; break; }
      continue;
    }
    const el = { name: m[3].replace(/^svg:/, ''), attrs: {}, kids: [] };
    let a;
    attrRe.lastIndex = 0;
    const as = m[4] || '';
    while ((a = attrRe.exec(as))) el.attrs[a[1]] = unescapeXml(a[2] != null ? a[2] : a[3] != null ? a[3] : a[4] != null ? a[4] : '');
    top.kids.push(el);
    if (!m[5]) stack.push(el);
  }
  return root.kids.find((k) => k.name === 'svg') || null;
}

// ------------------------------------------------------------------ 수학
const I = [1, 0, 0, 1, 0, 0];
const mul = (a, b) => [
  a[0] * b[0] + a[1] * b[2], a[0] * b[1] + a[1] * b[3],
  a[2] * b[0] + a[3] * b[2], a[2] * b[1] + a[3] * b[3],
  a[4] * b[0] + a[5] * b[2] + b[4], a[4] * b[1] + a[5] * b[3] + b[5],
];
const apply = (m, x, y) => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
function fmt(x) {
  if (!isFinite(x)) return '0';
  const r = Math.round(x * 10000) / 10000;
  if (r === 0) return '0';
  let s = r.toFixed(4).replace(/0+$/, '').replace(/\.$/, '');
  if (s.startsWith('0.')) s = s.slice(1); else if (s.startsWith('-0.')) s = '-' + s.slice(2);
  return s;
}
const fm = (m) => m.map(fmt).join(' ');
function nums(s) { return (String(s || '').match(/[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?/g) || []).map(Number); }
function len(v, rel = 0) {
  if (v == null || v === '') return null;
  const s = String(v).trim();
  const n = parseFloat(s);
  if (!isFinite(n)) return null;
  if (s.endsWith('%')) return (n / 100) * rel;
  if (s.endsWith('pt')) return n * (96 / 72);
  if (s.endsWith('mm')) return n * (96 / 25.4);
  if (s.endsWith('cm')) return n * (96 / 2.54);
  if (s.endsWith('in')) return n * 96;
  return n;
}
export function parseTransform(s) {
  let m = I;
  if (!s) return m;
  const re = /(matrix|translate|scale|rotate|skewX|skewY)\s*\(([^)]*)\)/g;
  let t;
  while ((t = re.exec(s))) {
    const v = nums(t[2]);
    let k = I;
    switch (t[1]) {
      case 'matrix': if (v.length >= 6) k = v.slice(0, 6); break;
      case 'translate': k = [1, 0, 0, 1, v[0] || 0, v[1] || 0]; break;
      case 'scale': k = [v[0] == null ? 1 : v[0], 0, 0, v[1] == null ? (v[0] == null ? 1 : v[0]) : v[1], 0, 0]; break;
      case 'rotate': {
        const a = ((v[0] || 0) * Math.PI) / 180, c = Math.cos(a), sn = Math.sin(a);
        k = [c, sn, -sn, c, 0, 0];
        if (v.length >= 3) k = mul(mul([1, 0, 0, 1, -v[1], -v[2]], k), [1, 0, 0, 1, v[1], v[2]]);
        break;
      }
      case 'skewX': k = [1, 0, Math.tan(((v[0] || 0) * Math.PI) / 180), 1, 0, 0]; break;
      case 'skewY': k = [1, Math.tan(((v[0] || 0) * Math.PI) / 180), 0, 1, 0, 0]; break;
      default: break;
    }
    m = mul(k, m);
  }
  return m;
}

// ------------------------------------------------------------------ 색
const NAMED = {
  black: '000000', white: 'ffffff', red: 'ff0000', green: '008000', blue: '0000ff', yellow: 'ffff00', gray: '808080', grey: '808080',
  silver: 'c0c0c0', maroon: '800000', purple: '800080', fuchsia: 'ff00ff', lime: '00ff00', olive: '808000', navy: '000080', teal: '008080',
  aqua: '00ffff', orange: 'ffa500', lightgray: 'd3d3d3', lightgrey: 'd3d3d3', darkgray: 'a9a9a9', darkgrey: 'a9a9a9',
};
function parseColor(v, cur) {
  if (v == null) return undefined;
  let s = String(v).trim().toLowerCase();
  if (!s || s === 'none' || s === 'transparent') return null;
  if (s === 'currentcolor') return cur || [0, 0, 0];
  if (s.startsWith('url(')) return { url: (/#([^)'"\s]+)/.exec(s) || [])[1], fallback: parseColor(s.replace(/^url\([^)]*\)\s*/, '') || 'none') };
  if (NAMED[s]) s = '#' + NAMED[s];
  let m = /^#([0-9a-f]{3,8})$/.exec(s);
  if (m) {
    let h = m[1];
    if (h.length === 3 || h.length === 4) h = h.split('').map((c) => c + c).join('');
    return [parseInt(h.slice(0, 2), 16) / 255, parseInt(h.slice(2, 4), 16) / 255, parseInt(h.slice(4, 6), 16) / 255];
  }
  m = /^rgba?\(([^)]*)\)$/.exec(s);
  if (m) {
    const p = m[1].split(/[\s,/]+/).filter(Boolean);
    return [0, 1, 2].map((i) => { const x = p[i] || '0'; return Math.max(0, Math.min(1, x.endsWith('%') ? parseFloat(x) / 100 : parseFloat(x) / 255)); });
  }
  return [0, 0, 0];
}
const colorOp = (c, stroke) => `${fmt(c[0])} ${fmt(c[1])} ${fmt(c[2])} ${stroke ? 'RG' : 'rg'}`;

// ------------------------------------------------------------------ 경로
function arcToBeziers(x1, y1, rx, ry, phi, fa, fs, x2, y2) {
  const out = [];
  if (!rx || !ry) { out.push(['L', x2, y2]); return out; }
  rx = Math.abs(rx); ry = Math.abs(ry);
  const sp = Math.sin((phi * Math.PI) / 180), cp = Math.cos((phi * Math.PI) / 180);
  const dx = (x1 - x2) / 2, dy = (y1 - y2) / 2;
  const x1p = cp * dx + sp * dy, y1p = -sp * dx + cp * dy;
  let lam = (x1p * x1p) / (rx * rx) + (y1p * y1p) / (ry * ry);
  if (lam > 1) { rx *= Math.sqrt(lam); ry *= Math.sqrt(lam); }
  const num = rx * rx * ry * ry - rx * rx * y1p * y1p - ry * ry * x1p * x1p;
  const den = rx * rx * y1p * y1p + ry * ry * x1p * x1p;
  let co = Math.sqrt(Math.max(0, num / den));
  if (fa === fs) co = -co;
  const cxp = (co * rx * y1p) / ry, cyp = (-co * ry * x1p) / rx;
  const cx = cp * cxp - sp * cyp + (x1 + x2) / 2, cy = sp * cxp + cp * cyp + (y1 + y2) / 2;
  const ang = (ux, uy, vx, vy) => { const a = Math.atan2(ux * vy - uy * vx, ux * vx + uy * vy); return a; };
  const t1 = ang(1, 0, (x1p - cxp) / rx, (y1p - cyp) / ry);
  let dt = ang((x1p - cxp) / rx, (y1p - cyp) / ry, (-x1p - cxp) / rx, (-y1p - cyp) / ry);
  if (!fs && dt > 0) dt -= 2 * Math.PI; else if (fs && dt < 0) dt += 2 * Math.PI;
  const segs = Math.ceil(Math.abs(dt) / (Math.PI / 2));
  const d = dt / segs;
  const k = (4 / 3) * Math.tan(d / 4);
  let t = t1;
  const pt = (a) => { const x = rx * Math.cos(a), y = ry * Math.sin(a); return [cp * x - sp * y + cx, sp * x + cp * y + cy]; };
  const dv = (a) => { const x = -rx * Math.sin(a), y = ry * Math.cos(a); return [cp * x - sp * y, sp * x + cp * y]; };
  for (let i = 0; i < segs; i++) {
    const a1 = t, a2 = t + d;
    const p1 = pt(a1), p2 = pt(a2), d1 = dv(a1), d2 = dv(a2);
    out.push(['C', p1[0] + k * d1[0], p1[1] + k * d1[1], p2[0] - k * d2[0], p2[1] - k * d2[1], p2[0], p2[1]]);
    t = a2;
  }
  return out;
}

/** SVG 경로 → 절대 좌표 명령 [['M',x,y],['L',x,y],['C',..6],['Z']] */
export function parsePath(d) {
  const toks = String(d || '').match(/[MmLlHhVvCcSsQqTtAaZz]|[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?/g) || [];
  const out = [];
  let i = 0, cmd = '', x = 0, y = 0, sx = 0, sy = 0, lc = null, lq = null;
  const isCmd = (t) => /^[A-Za-z]$/.test(t);
  const n = () => +toks[i++];
  const flag = () => {
    // 호(arc)의 플래그는 붙어 쓰일 수 있다 ("011")
    const t = toks[i];
    if (t && /^[01]{2,}/.test(t)) { toks[i] = t.slice(1); return +t[0]; }
    return +toks[i++];
  };
  while (i < toks.length) {
    if (isCmd(toks[i])) cmd = toks[i++];
    else if (!cmd) { i++; continue; }
    const rel = cmd === cmd.toLowerCase();
    const C = cmd.toUpperCase();
    const ox = rel ? x : 0, oy = rel ? y : 0;
    switch (C) {
      case 'M': x = ox + n(); y = oy + n(); out.push(['M', x, y]); sx = x; sy = y; cmd = rel ? 'l' : 'L'; lc = lq = null; break;
      case 'L': x = ox + n(); y = oy + n(); out.push(['L', x, y]); lc = lq = null; break;
      case 'H': x = (rel ? x : 0) + n(); out.push(['L', x, y]); lc = lq = null; break;
      case 'V': y = (rel ? y : 0) + n(); out.push(['L', x, y]); lc = lq = null; break;
      case 'C': { const a = ox + n(), b = oy + n(), c = ox + n(), e = oy + n(); x = ox + n(); y = oy + n(); out.push(['C', a, b, c, e, x, y]); lc = [c, e]; lq = null; break; }
      case 'S': { const a = lc ? 2 * x - lc[0] : x, b = lc ? 2 * y - lc[1] : y; const c = ox + n(), e = oy + n(); x = ox + n(); y = oy + n(); out.push(['C', a, b, c, e, x, y]); lc = [c, e]; lq = null; break; }
      case 'Q': { const qx = ox + n(), qy = oy + n(); const nx = ox + n(), ny = oy + n(); out.push(['C', x + (2 / 3) * (qx - x), y + (2 / 3) * (qy - y), nx + (2 / 3) * (qx - nx), ny + (2 / 3) * (qy - ny), nx, ny]); x = nx; y = ny; lq = [qx, qy]; lc = null; break; }
      case 'T': { const qx = lq ? 2 * x - lq[0] : x, qy = lq ? 2 * y - lq[1] : y; const nx = ox + n(), ny = oy + n(); out.push(['C', x + (2 / 3) * (qx - x), y + (2 / 3) * (qy - y), nx + (2 / 3) * (qx - nx), ny + (2 / 3) * (qy - ny), nx, ny]); x = nx; y = ny; lq = [qx, qy]; lc = null; break; }
      case 'A': { const rx = n(), ry = n(), ph = n(), fa = flag(), fs = flag(); const nx = ox + n(), ny = oy + n(); for (const s of arcToBeziers(x, y, rx, ry, ph, fa, fs, nx, ny)) out.push(s); x = nx; y = ny; lc = lq = null; break; }
      case 'Z': out.push(['Z']); x = sx; y = sy; lc = lq = null; break;
      default: i++; break;
    }
    if (out.length && out[out.length - 1].some((v) => typeof v === 'number' && !isFinite(v))) { out.pop(); break; }
  }
  return out;
}
function pathOps(segs) {
  const o = [];
  for (const s of segs) {
    if (s[0] === 'M') o.push(`${fmt(s[1])} ${fmt(s[2])} m`);
    else if (s[0] === 'L') o.push(`${fmt(s[1])} ${fmt(s[2])} l`);
    else if (s[0] === 'C') o.push(`${fmt(s[1])} ${fmt(s[2])} ${fmt(s[3])} ${fmt(s[4])} ${fmt(s[5])} ${fmt(s[6])} c`);
    else if (s[0] === 'Z') o.push('h');
  }
  return o.join(' ');
}
function segBBox(segs) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const s of segs) for (let k = 1; k + 1 < s.length; k += 2) { x0 = Math.min(x0, s[k]); x1 = Math.max(x1, s[k]); y0 = Math.min(y0, s[k + 1]); y1 = Math.max(y1, s[k + 1]); }
  return isFinite(x0) ? [x0, y0, x1, y1] : [0, 0, 0, 0];
}
const KAPPA = 0.5522847498;
function ellipseSegs(cx, cy, rx, ry) {
  const kx = rx * KAPPA, ky = ry * KAPPA;
  return [['M', cx + rx, cy], ['C', cx + rx, cy + ky, cx + kx, cy + ry, cx, cy + ry], ['C', cx - kx, cy + ry, cx - rx, cy + ky, cx - rx, cy],
    ['C', cx - rx, cy - ky, cx - kx, cy - ry, cx, cy - ry], ['C', cx + kx, cy - ry, cx + rx, cy - ky, cx + rx, cy], ['Z']];
}
function rectSegs(x, y, w, h, rx, ry) {
  if (!(w > 0 && h > 0)) return [];
  if (rx == null && ry != null) rx = ry;
  if (ry == null && rx != null) ry = rx;
  rx = Math.min(Math.max(0, rx || 0), w / 2); ry = Math.min(Math.max(0, ry || 0), h / 2);
  if (!rx || !ry) return [['M', x, y], ['L', x + w, y], ['L', x + w, y + h], ['L', x, y + h], ['Z']];
  const kx = rx * KAPPA, ky = ry * KAPPA;
  return [['M', x + rx, y], ['L', x + w - rx, y], ['C', x + w - rx + kx, y, x + w, y + ry - ky, x + w, y + ry], ['L', x + w, y + h - ry],
    ['C', x + w, y + h - ry + ky, x + w - rx + kx, y + h, x + w - rx, y + h], ['L', x + rx, y + h], ['C', x + rx - kx, y + h, x, y + h - ry + ky, x, y + h - ry],
    ['L', x, y + ry], ['C', x, y + ry - ky, x + rx - kx, y, x + rx, y], ['Z']];
}
function shapeSegs(el) {
  const a = el.attrs;
  switch (el.name) {
    case 'rect': return rectSegs(len(a.x) || 0, len(a.y) || 0, len(a.width) || 0, len(a.height) || 0, len(a.rx), len(a.ry));
    case 'circle': { const r = len(a.r) || 0; return r > 0 ? ellipseSegs(len(a.cx) || 0, len(a.cy) || 0, r, r) : []; }
    case 'ellipse': { const rx = len(a.rx) || 0, ry = len(a.ry) || 0; return rx > 0 && ry > 0 ? ellipseSegs(len(a.cx) || 0, len(a.cy) || 0, rx, ry) : []; }
    case 'line': return [['M', len(a.x1) || 0, len(a.y1) || 0], ['L', len(a.x2) || 0, len(a.y2) || 0]];
    case 'polyline': case 'polygon': {
      const v = nums(a.points);
      const s = [];
      for (let i = 0; i + 1 < v.length; i += 2) s.push([i ? 'L' : 'M', v[i], v[i + 1]]);
      if (el.name === 'polygon' && s.length) s.push(['Z']);
      return s;
    }
    case 'path': return parsePath(a.d);
    default: return [];
  }
}

// ------------------------------------------------------------------ 모양(스타일)
const INHERIT = ['fill', 'fill-opacity', 'fill-rule', 'stroke', 'stroke-width', 'stroke-opacity', 'stroke-dasharray', 'stroke-dashoffset',
  'stroke-linecap', 'stroke-linejoin', 'stroke-miterlimit', 'font-family', 'font-size', 'font-weight', 'font-style', 'text-anchor',
  'dominant-baseline', 'visibility', 'letter-spacing', 'clip-rule'];
function styleOf(el, parent) {
  const st = Object.create(parent);
  const a = el.attrs;
  const put = (k, v) => { if (v != null && v !== '' && v !== 'inherit') st[k] = String(v).trim(); };
  for (const k of INHERIT) put(k, a[k]);
  if (a.style) for (const decl of a.style.split(';')) { const i = decl.indexOf(':'); if (i > 0) { const k = decl.slice(0, i).trim(); if (INHERIT.includes(k) || k === 'opacity' || k === 'display') put(k, decl.slice(i + 1)); } }
  return st;
}
const ROOT_STYLE = { fill: '#000000', stroke: 'none', 'stroke-width': '1', 'font-size': '16', 'font-family': 'serif', 'fill-rule': 'nonzero' };

// ------------------------------------------------------------------ 그리기
class Painter {
  constructor(mupdf, doc, opt) {
    this.mupdf = mupdf;
    this.doc = doc;
    this.opt = opt;
    this.nf = opt.fonts;
    this.imageCache = opt.imageCache || new Map();
    this.stats = opt.stats;
    this.fb = opt.fallbackSet || null;
  }

  async page(svgText, pageNo) {
    const root = parseXml(svgText);
    if (!root) throw new Error(`${pageNo + 1}쪽을 그리지 못했어요`);
    const W = len(root.attrs.width) || 793.7, H = len(root.attrs.height) || 1122.5;
    const vb = nums(root.attrs.viewBox);
    this.out = [];
    this.res = { Font: {}, XObject: {}, ExtGState: {}, Shading: {} };
    this.ids = new Map();
    this.text = null;
    this.pageStat = { page: pageNo, replaced: 0, kept: 0, invisible: 0 };
    this.collectIds(root);
    const ptW = W * 0.75, ptH = H * 0.75;
    let base = [0.75, 0, 0, -0.75, 0, ptH];
    if (vb.length === 4 && vb[2] > 0 && vb[3] > 0) base = mul(this.viewBoxMatrix(vb, W, H, root.attrs.preserveAspectRatio), base);
    this.out.push(`${fm(base)} cm`);
    this.out.push('0 J 0 j 1 w 10 M');
    await this.children(root, styleOf(root, ROOT_STYLE), 0);
    this.flushText();
    const resources = this.makeResources();
    const contents = new TextEncoder().encode(this.out.join('\n'));
    this.out = null;
    const pageObj = this.doc.addPage([0, 0, ptW, ptH], 0, resources, contents);
    this.doc.insertPage(-1, pageObj);
    return this.pageStat;
  }

  viewBoxMatrix(vb, w, h, par) {
    const sx = w / vb[2], sy = h / vb[3];
    const p = String(par || 'xMidYMid meet').trim();
    if (p.startsWith('none')) return [sx, 0, 0, sy, -vb[0] * sx, -vb[1] * sy];
    const slice = /slice/.test(p);
    const s = slice ? Math.max(sx, sy) : Math.min(sx, sy);
    const ax = /xMin/.test(p) ? 0 : /xMax/.test(p) ? 1 : 0.5;
    const ay = /YMin/.test(p) ? 0 : /YMax/.test(p) ? 1 : 0.5;
    return [s, 0, 0, s, -vb[0] * s + (w - vb[2] * s) * ax, -vb[1] * s + (h - vb[3] * s) * ay];
  }

  collectIds(el) {
    if (el.attrs && el.attrs.id) this.ids.set(el.attrs.id, el);
    if (el.kids) for (const k of el.kids) if (k.name !== '#text') this.collectIds(k);
  }

  makeResources() {
    const d = this.doc.newDictionary();
    for (const [k, v] of Object.entries(this.res)) {
      const names = Object.keys(v);
      if (!names.length) continue;
      const sub = this.doc.newDictionary();
      for (const n of names) sub.put(n, v[n]);
      d.put(k, sub);
    }
    return d;
  }

  async children(el, st, depth) {
    for (const k of el.kids || []) if (k.name !== '#text') await this.node(k, st, depth + 1);
  }

  async node(el, pst, depth) {
    if (depth > 60) return;
    const n = el.name;
    if (n === 'defs' || n === 'clipPath' || n === 'mask' || n === 'linearGradient' || n === 'radialGradient' || n === 'pattern' || n === 'symbol'
      || n === 'style' || n === 'title' || n === 'desc' || n === 'metadata' || n === 'marker' || n === 'filter') return;
    const a = el.attrs;
    const st = styleOf(el, pst);
    const disp = a.display || (a.style && /display\s*:\s*none/.test(a.style) ? 'none' : '');
    if (disp === 'none') return;
    let op = a.opacity != null ? parseFloat(a.opacity) : a.style && /(?:^|;)\s*opacity\s*:\s*([\d.]+)/.test(a.style) ? parseFloat(RegExp.$1) : 1;
    if (!isFinite(op)) op = 1;
    if (op <= 0.001) return;
    const clip = a['clip-path'] && /#([^)'"\s]+)/.exec(a['clip-path']);
    // 글자의 transform은 글자 행렬(Tm)에 직접 넣는다 → 여러 글자를 한 BT로 이어 쓸 수 있다
    const textSelf = n === 'text' && !clip && op >= 0.999;
    const tf = a.transform && !textSelf ? parseTransform(a.transform) : null;
    const wrap = !!(tf || clip || op < 0.999);
    // 글자 묶음은 같은 좌표계에서만 이어 쓴다
    if (wrap || n !== 'text') this.flushText();
    if (wrap) {
      this.out.push('q');
      if (tf) this.out.push(`${fm(tf)} cm`);
      if (clip) this.applyClip(clip[1], el);
      if (op < 0.999) this.out.push(`/${this.gs(op, op)} gs`);
    }
    try {
      switch (n) {
        case 'g': case 'a': case 'switch': await this.children(el, st, depth); break;
        case 'svg': await this.nestedSvg(el, st, depth); break;
        case 'use': await this.use(el, st, depth); break;
        case 'text': this.textEl(el, st, textSelf); break;
        case 'image': this.flushText(); await this.image(el, st, depth); break;
        case 'rect': case 'circle': case 'ellipse': case 'line': case 'polyline': case 'polygon': case 'path': this.shape(el, st); break;
        default: break;
      }
    } finally {
      if (wrap) { this.flushText(); this.out.push('Q'); }
    }
  }

  gs(ca, CA) {
    const name = `GSa${Math.round(ca * 100)}_${Math.round(CA * 100)}`;
    if (!this.res.ExtGState[name]) this.res.ExtGState[name] = this.doc.addObject({ Type: 'ExtGState', ca: Math.max(0, Math.min(1, ca)), CA: Math.max(0, Math.min(1, CA)) });
    return name;
  }

  applyClip(id, user) {
    const cp = this.ids.get(id);
    if (!cp) return;
    const ctf = cp.attrs.transform ? parseTransform(cp.attrs.transform) : null;
    const parts = [];
    const bbox = cp.attrs.clipPathUnits === 'objectBoundingBox' ? segBBox(shapeSegs(user)) : null;
    const walk = (e, m) => {
      for (const k of e.kids || []) {
        if (k.name === '#text') continue;
        let km = m;
        if (k.attrs.transform) km = mul(parseTransform(k.attrs.transform), m);
        if (k.name === 'g') { walk(k, km); continue; }
        if (k.name === 'use') { const ref = this.ids.get(((k.attrs.href || k.attrs['xlink:href'] || '').match(/#(.+)$/) || [])[1]); if (ref) walk({ kids: [ref] }, mul([1, 0, 0, 1, len(k.attrs.x) || 0, len(k.attrs.y) || 0], km)); continue; }
        const segs = shapeSegs(k);
        if (!segs.length) continue;
        parts.push(pathOps(segs.map((s) => (s[0] === 'Z' ? s : [s[0], ...pairs(s.slice(1), km)]))));
      }
    };
    let m0 = ctf || I;
    if (bbox) m0 = mul(m0, [bbox[2] - bbox[0], 0, 0, bbox[3] - bbox[1], bbox[0], bbox[1]]);
    walk(cp, m0);
    if (!parts.length) { this.out.push('0 0 m h W n'); return; }
    const eo = (cp.attrs['clip-rule'] || (cp.kids[0] && cp.kids[0].attrs && cp.kids[0].attrs['clip-rule'])) === 'evenodd';
    this.out.push(`${parts.join(' ')} ${eo ? 'W*' : 'W'} n`);
  }

  async nestedSvg(el, st, depth) {
    const a = el.attrs;
    const x = len(a.x) || 0, y = len(a.y) || 0;
    const w = len(a.width), h = len(a.height);
    const vb = nums(a.viewBox);
    this.out.push('q');
    if (w && h) this.out.push(`${fmt(x)} ${fmt(y)} ${fmt(w)} ${fmt(h)} re W n`);
    let m = [1, 0, 0, 1, x, y];
    if (vb.length === 4 && vb[2] > 0 && vb[3] > 0 && w && h) m = mul(this.viewBoxMatrix(vb, w, h, a.preserveAspectRatio), m);
    this.out.push(`${fm(m)} cm`);
    this.collectIds(el);
    await this.children(el, st, depth);
    this.flushText();
    this.out.push('Q');
  }

  async use(el, st, depth) {
    const id = ((el.attrs.href || el.attrs['xlink:href'] || '').match(/#(.+)$/) || [])[1];
    const ref = id && this.ids.get(id);
    if (!ref || depth > 30) return;
    const x = len(el.attrs.x) || 0, y = len(el.attrs.y) || 0;
    this.out.push(`q 1 0 0 1 ${fmt(x)} ${fmt(y)} cm`);
    if (ref.name === 'symbol') await this.children(ref, styleOf(ref, st), depth);
    else await this.node(ref, st, depth + 1);
    this.flushText();
    this.out.push('Q');
  }

  // ---- 도형
  shape(el, st) {
    const segs = shapeSegs(el);
    if (!segs.length) return;
    if (st.visibility === 'hidden' || st.visibility === 'collapse') return;
    const fillC = el.name === 'line' ? null : parseColor(st.fill);
    const strokeC = parseColor(st.stroke);
    const sw = len(st['stroke-width']);
    const doStroke = strokeC && sw !== 0 && sw !== null;
    if (!fillC && !doStroke) return;
    const ops = pathOps(segs);
    const fo = Math.max(0, Math.min(1, parseFloat(st['fill-opacity'] != null ? st['fill-opacity'] : 1)));
    const so = Math.max(0, Math.min(1, parseFloat(st['stroke-opacity'] != null ? st['stroke-opacity'] : 1)));
    const eo = st['fill-rule'] === 'evenodd';
    const out = this.out;
    out.push('q');
    if (fo < 0.999 || so < 0.999) out.push(`/${this.gs(isFinite(fo) ? fo : 1, isFinite(so) ? so : 1)} gs`);
    let filled = false;
    if (fillC && fillC.url) {
      const g = this.ids.get(fillC.url);
      if (g && /Gradient$/.test(g.name)) {
        const sh = this.shading(g, segBBox(segs));
        if (sh) { out.push(`q ${ops} ${eo ? 'W*' : 'W'} n ${sh}`); out.push('Q'); filled = true; }
      }
      if (!filled) {
        const fb = (g && this.gradientFallback(g)) || fillC.fallback;
        if (fb) { out.push(`${colorOp(fb, false)} ${ops} ${eo ? 'f*' : 'f'}`); filled = true; }
      }
    }
    const fc = fillC && !fillC.url ? fillC : null;
    let sc = strokeC && !strokeC.url ? strokeC : null;
    if (strokeC && strokeC.url) { const g = this.ids.get(strokeC.url); sc = (g && this.gradientFallback(g)) || strokeC.fallback || null; }
    if (doStroke && sc) {
      out.push(`${fmt(sw == null ? 1 : sw)} w`);
      const cap = { butt: 0, round: 1, square: 2 }[st['stroke-linecap']] || 0;
      const join = { miter: 0, round: 1, bevel: 2 }[st['stroke-linejoin']] || 0;
      out.push(`${cap} J ${join} j`);
      if (st['stroke-miterlimit']) out.push(`${fmt(Math.max(1, parseFloat(st['stroke-miterlimit']) || 4))} M`);
      const da = st['stroke-dasharray'] && st['stroke-dasharray'] !== 'none' ? nums(st['stroke-dasharray']).filter((v) => v >= 0) : [];
      if (da.length && da.some((v) => v > 0)) out.push(`[${(da.length % 2 ? da.concat(da) : da).map(fmt).join(' ')}] ${fmt(len(st['stroke-dashoffset']) || 0)} d`);
      out.push(colorOp(sc, true));
    }
    if (fc) out.push(colorOp(fc, false));
    if (fc && doStroke && sc) out.push(`${ops} ${eo ? 'B*' : 'B'}`);
    else if (fc) out.push(`${ops} ${eo ? 'f*' : 'f'}`);
    else if (doStroke && sc) out.push(`${ops} S`);
    out.push('Q');
  }

  gradientStops(g) {
    let cur = g;
    for (let i = 0; i < 8 && cur; i++) {
      const stops = (cur.kids || []).filter((k) => k.name === 'stop');
      if (stops.length) {
        return stops.map((s) => {
          const ss = styleOf(s, {});
          let off = s.attrs.offset || '0';
          off = off.endsWith('%') ? parseFloat(off) / 100 : parseFloat(off);
          const col = s.attrs['stop-color'] || (s.attrs.style && (/stop-color\s*:\s*([^;]+)/.exec(s.attrs.style) || [])[1]) || ss.fill || '#000';
          return { off: Math.max(0, Math.min(1, isFinite(off) ? off : 0)), c: parseColor(col) || [1, 1, 1] };
        });
      }
      const href = ((cur.attrs.href || cur.attrs['xlink:href'] || '').match(/#(.+)$/) || [])[1];
      cur = href ? this.ids.get(href) : null;
    }
    return [];
  }
  gradientFallback(g) {
    const s = this.gradientStops(g);
    if (!s.length) return null;
    const c = [0, 0, 0];
    for (const x of s) for (let i = 0; i < 3; i++) c[i] += x.c[i] / s.length;
    return c;
  }
  shading(g, bbox) {
    const stops = this.gradientStops(g);
    if (!stops.length) return null;
    stops.sort((a, b) => a.off - b.off);
    const N = 256;
    const samples = new Uint8Array(N * 3);
    for (let i = 0; i < N; i++) {
      const t = i / (N - 1);
      let j = 0;
      while (j < stops.length - 1 && stops[j + 1].off < t) j++;
      const s0 = stops[j], s1 = stops[Math.min(j + 1, stops.length - 1)];
      const u = s1.off > s0.off ? Math.max(0, Math.min(1, (t - s0.off) / (s1.off - s0.off))) : t <= s0.off ? 0 : 1;
      const c = t <= stops[0].off ? stops[0].c : t >= stops[stops.length - 1].off ? stops[stops.length - 1].c : s0.c.map((v, k) => v + (s1.c[k] - v) * u);
      for (let k = 0; k < 3; k++) samples[i * 3 + k] = Math.round(c[k] * 255);
    }
    const fn = this.doc.addStream(samples, { FunctionType: 0, Domain: [0, 1], Range: [0, 1, 0, 1, 0, 1], Size: [N], BitsPerSample: 8 });
    const a = g.attrs;
    const user = a.gradientUnits === 'userSpaceOnUse';
    const rel = (v, def, ref) => { if (v == null) return def; const s = String(v).trim(); return s.endsWith('%') ? (parseFloat(s) / 100) * (user ? ref : 1) : parseFloat(s); };
    let dict;
    if (g.name === 'linearGradient') {
      const W = bbox[2] - bbox[0] || 1, H = bbox[3] - bbox[1] || 1;
      dict = { ShadingType: 2, ColorSpace: 'DeviceRGB', Coords: [rel(a.x1, 0, W), rel(a.y1, 0, H), rel(a.x2, user ? W : 1, W), rel(a.y2, 0, H)], Function: fn, Extend: [true, true] };
    } else {
      const W = bbox[2] - bbox[0] || 1;
      const cx = rel(a.cx, user ? 0 : 0.5, W), cy = rel(a.cy, user ? 0 : 0.5, W), r = rel(a.r, user ? 0 : 0.5, W);
      dict = { ShadingType: 3, ColorSpace: 'DeviceRGB', Coords: [rel(a.fx, cx, W), rel(a.fy, cy, W), 0, cx, cy, r], Function: fn, Extend: [true, true] };
    }
    const name = 'Sh' + Object.keys(this.res.Shading).length;
    this.res.Shading[name] = this.doc.addObject(dict);
    let m = a.gradientTransform ? parseTransform(a.gradientTransform) : I;
    if (!user) m = mul(m, [bbox[2] - bbox[0] || 1, 0, 0, bbox[3] - bbox[1] || 1, bbox[0], bbox[1]]);
    return `${fm(m)} cm /${name} sh`;
  }

  // ---- 그림
  async image(el, st) {
    const a = el.attrs;
    const href = a.href || a['xlink:href'] || '';
    const w = len(a.width), h = len(a.height);
    if (!href || !(w > 0) || !(h > 0)) return;
    const x = len(a.x) || 0, y = len(a.y) || 0;
    const m = /^data:([^;,]+)?(;base64)?,(.*)$/s.exec(href);
    if (!m) return; // 바깥 주소 그림은 넣지 않는다
    const mime = (m[1] || '').toLowerCase();
    const raw = m[2] ? b64(m[3]) : new TextEncoder().encode(decodeURIComponent(m[3]));
    if (mime === 'image/svg+xml') {
      const sub = parseXml(new TextDecoder().decode(raw));
      if (!sub) return;
      const vb = nums(sub.attrs.viewBox);
      const sw = len(sub.attrs.width) || (vb[2] || w), sh = len(sub.attrs.height) || (vb[3] || h);
      const box = vb.length === 4 && vb[2] > 0 && vb[3] > 0 ? vb : [0, 0, sw, sh];
      this.out.push(`q ${fmt(x)} ${fmt(y)} ${fmt(w)} ${fmt(h)} re W n`);
      this.out.push(`${fm(mul(this.viewBoxMatrix(box, w, h, a.preserveAspectRatio), [1, 0, 0, 1, x, y]))} cm`);
      this.collectIds(sub);
      await this.children(sub, styleOf(sub, ROOT_STYLE), 1);
      this.flushText();
      this.out.push('Q');
      return;
    }
    const key = href.length > 200 ? href.length + ':' + href.slice(0, 80) + href.slice(-120) : href;
    let ent = this.imageCache.get(key);
    if (ent === undefined) {
      ent = null;
      let img = null;
      try { img = new this.mupdf.Image(raw); img.getWidth(); } catch (e) { img = null; }
      if (!img && this.opt.decodeImage) {
        try { const png = await this.opt.decodeImage(raw, mime); if (png) img = new this.mupdf.Image(png); } catch (e) { img = null; }
      }
      if (img) ent = { ref: this.doc.addImage(img), w: img.getWidth(), h: img.getHeight() };
      this.imageCache.set(key, ent);
    }
    if (!ent) return;
    const name = 'Im' + Object.keys(this.res.XObject).length;
    this.res.XObject[name] = ent.ref;
    let bx = x, by = y, bw = w, bh = h;
    const par = String(a.preserveAspectRatio || 'xMidYMid meet');
    const clipNeeded = /slice/.test(par);
    if (!par.startsWith('none') && ent.w && ent.h) {
      const vm = this.viewBoxMatrix([0, 0, ent.w, ent.h], w, h, par);
      bw = ent.w * vm[0]; bh = ent.h * vm[3]; bx = x + vm[4]; by = y + vm[5];
    }
    this.out.push(`q ${clipNeeded ? `${fmt(x)} ${fmt(y)} ${fmt(w)} ${fmt(h)} re W n ` : ''}${fmt(bw)} 0 0 ${fmt(-bh)} ${fmt(bx)} ${fmt(by + bh)} cm /${name} Do Q`);
  }

  // ---- 글자
  textEl(el, st, ownTransform) {
    const a = el.attrs;
    this.textTf = ownTransform && a.transform ? parseTransform(a.transform) : I;
    if (st.visibility === 'hidden' || st.visibility === 'collapse') return;
    // tspan이 위치를 따로 가지면 조각으로 나눈다
    const runs = [];
    const base = { x: len(a.x) || 0, y: len(a.y) || 0 };
    const walk = (e, est) => {
      for (const k of e.kids || []) {
        if (k.name === '#text') { runs.push({ text: k.text, st: est, x: null, y: null }); continue; }
        if (k.name === 'tspan' || k.name === 'a') {
          const kst = styleOf(k, est);
          const kx = len(k.attrs.x), ky = len(k.attrs.y);
          const start = runs.length;
          walk(k, kst);
          if (runs[start] && (kx != null || ky != null)) { runs[start].x = kx; runs[start].y = ky; }
        }
      }
    };
    walk(el, st);
    if (!runs.length) return;
    let cx = base.x, cy = base.y;
    const multi = runs.length > 1;
    for (const r of runs) {
      if (r.x != null) cx = r.x;
      if (r.y != null) cy = r.y;
      const txt = multi ? r.text : r.text;
      const t = txt.replace(/[\r\n\t]/g, ' ');
      if (!t) continue;
      const adv = this.drawText(t, r.st, cx, cy, multi ? null : a);
      cx += adv;
    }
  }

  pickKey(st) {
    const fam = String(st['font-family'] || '').split(',')[0].replace(/^\s*['"]?|['"]?\s*$/g, '').trim() || 'serif';
    const fw = String(st['font-weight'] || 'normal');
    const bold = fw === 'bold' || fw === 'bolder' || (+fw >= 600);
    const italic = /italic|oblique/.test(st['font-style'] || '');
    const size = len(st['font-size']) || 16;
    return { face: fam, key: this.opt.pick(fam, bold, italic, size), bold, italic, size };
  }

  drawText(text, st, x, y, attrs) {
    const f = this.pickKey(st);
    const stat = this.stats.font(f.face, f.bold, f.italic);
    const fill = parseColor(st.fill);
    const stroke = parseColor(st.stroke);
    const fo = parseFloat(st['fill-opacity'] != null ? st['fill-opacity'] : 1);
    const sw = len(st['stroke-width']);
    const useStroke = stroke && !stroke.url && sw > 0;
    const fillC = fill && !fill.url ? fill : fill && fill.url ? (this.gradientFallback(this.ids.get(fill.url) || { kids: [] }) || fill.fallback) : null;
    let mode = fillC && fo > 0.001 ? (useStroke ? 2 : 0) : (useStroke ? 1 : 3);
    // 글자 하나하나 글꼴 글리프로
    const glyphs = [];
    let total = 0;
    for (const ch of text) {
      const cp = ch.codePointAt(0);
      if (ch === ' ' || ch === ' ' || ch === '　') {
        const sp = this.nf.map(' ', f.key);
        const adv = (cp === 0x3000 ? 1 : (sp ? sp.adv : 0.25));
        glyphs.push({ space: true, key: sp && sp.key, gids: sp ? sp.gids : [], adv, ch });
        total += adv;
        continue;
      }
      let m = cp >= 0x20 ? this.nf.map(ch, f.key) : null;
      if (!m && cp >= 0x20 && this.fb) { m = this.fb.map(ch); if (m) this.fb.note(m); }
      stat.glyphs++;
      if (!m) { stat.kept++; this.pageStat.kept++; glyphs.push({ missing: true, adv: cp >= 0x1100 ? 1 : 0.5, ch }); total += cp >= 0x1100 ? 1 : 0.5; continue; }
      stat.replaced++; this.pageStat.replaced++;
      if (!m.key.startsWith('fb')) stat.slots[m.key] = (stat.slots[m.key] || 0) + 1;
      glyphs.push({ key: m.key, gids: m.gids, adv: m.adv, ch });
      total += m.adv;
    }
    if (!glyphs.length) return 0;
    const size = f.size;
    // 장평·자간: textLength(spacingAndGlyphs)면 그 폭에 맞춘다
    let hs = 1;
    const tl = attrs ? len(attrs.textLength) : null;
    if (tl && total > 0 && (!attrs.lengthAdjust || attrs.lengthAdjust === 'spacingAndGlyphs')) hs = tl / (total * size);
    const ls = len(st['letter-spacing']) || 0;
    const width = total * size * hs + ls * glyphs.length;
    const anchor = st['text-anchor'];
    if (anchor === 'middle') x -= width / 2; else if (anchor === 'end') x -= width;
    const db = st['dominant-baseline'] || (attrs && attrs['alignment-baseline']);
    if (db === 'central' || db === 'middle') y += size * 0.35;
    else if (db === 'hanging' || db === 'text-before-edge' || db === 'text-top') y += size * 0.8;
    const skew = /oblique\s+([-\d.]+)deg/.exec(st['font-style'] || '');
    let tan = skew ? Math.tan((parseFloat(skew[1]) * Math.PI) / 180) : /italic|oblique/.test(st['font-style'] || '') ? Math.tan((12 * Math.PI) / 180) : 0;
    if (this.opt.italic === false) tan = 0;
    const etf = this.textTf || I;
    const T = this.beginText();
    // 같은 줄에서 앞 글자와 띄어져 있으면 띄어쓰기 글자를 넣는다(검색·복사용)
    const origin = apply(etf, x, y);
    const scaleX = Math.hypot(etf[0], etf[1]) || 1;
    if (T.prev && T.prev.key && Math.abs(T.prev.y - origin[1]) < size * 0.25 * Math.hypot(etf[2], etf[3])) {
      const gap = origin[0] - T.prev.x1;
      const em = size * scaleX;
      if (gap > em * 0.22 && gap < em * 8 && !T.prev.space && T.prev.spaceGids) {
        T.ops.push(`3 Tr ${T.prev.m.map(fmt).slice(0, 4).join(' ')} ${fmt(T.prev.x1)} ${fmt(T.prev.y)} Tm ${hexGids(T.prev.spaceGids)} Tj`);
        T.tr = 3;
      }
    }
    let gx = x;
    let lastKey = null;
    for (const g of glyphs) {
      const step = g.adv * size * hs + ls;
      if (g.missing || (g.space && !g.gids.length)) { gx += step; continue; }
      const m = mul([size * hs, 0, size * tan, -size, gx, y], etf);
      if (T.font !== g.key) { T.ops.push(`/${this.fontRes(g.key)} 1 Tf`); T.font = g.key; }
      const wantTr = g.space ? (mode === 3 ? 3 : mode) : mode;
      if (T.tr !== wantTr) { T.ops.push(`${wantTr} Tr`); T.tr = wantTr; }
      if (fillC && (wantTr === 0 || wantTr === 2)) { const c = colorOp(fillC, false); if (T.fill !== c) { T.ops.push(c); T.fill = c; } }
      if (useStroke && (wantTr === 1 || wantTr === 2)) {
        const c = colorOp(stroke, true); if (T.stroke !== c) { T.ops.push(c); T.stroke = c; }
        const w = fmt(sw); // 글자 테두리 굵기는 사용자 공간(px) 단위
        if (T.lw !== w) { T.ops.push(`${w} w`); T.lw = w; }
      }
      T.ops.push(`${fm(m)} Tm ${hexGids(g.gids)} Tj`);
      lastKey = g.key;
      gx += step;
    }
    if (mode === 3) this.pageStat.invisible += glyphs.length;
    const end = apply(etf, gx, y);
    const sp = lastKey ? this.nf.map(' ', lastKey) : null;
    T.prev = { key: lastKey, x1: end[0], y: origin[1], m: [size * scaleX * hs, 0, 0, -size * Math.hypot(etf[2], etf[3]), 0, 0], space: glyphs[glyphs.length - 1].space, spaceGids: sp && sp.key === lastKey ? sp.gids : null };
    return gx - x;
  }

  fontRes(key) {
    const name = 'FSW' + key;
    if (!this.res.Font[name]) this.res.Font[name] = key.startsWith('fb') ? this.fb.ref(key) : this.nf.ref(key);
    return name;
  }

  beginText() {
    if (!this.text) this.text = { ops: [], font: null, tr: 0, fill: null, stroke: null, lw: null, prev: null };
    return this.text;
  }
  flushText() {
    const T = this.text;
    this.text = null;
    if (!T || !T.ops.length) return;
    this.out.push('q BT');
    this.out.push(T.ops.join('\n'));
    this.out.push('ET Q');
  }
}

function pairs(arr, m) {
  const o = [];
  for (let i = 0; i + 1 < arr.length; i += 2) { const p = apply(m, arr[i], arr[i + 1]); o.push(p[0], p[1]); }
  return o;
}
function hexGids(gids) {
  let s = '<';
  for (const g of gids) s += (g >> 8 & 255).toString(16).padStart(2, '0') + (g & 255).toString(16).padStart(2, '0');
  return s + '>';
}
function b64(s) {
  const clean = s.replace(/[^A-Za-z0-9+/=]/g, '');
  if (typeof atob === 'function') { const bin = atob(clean); const u = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i); return u; }
  return new Uint8Array(Buffer.from(clean, 'base64'));
}

// 기본 글꼴에 없는 기호(✔, ❐, 수학 기호 등)를 위한 예비 글꼴
class FallbackFonts {
  constructor(mupdf, doc, list) {
    this.mupdf = mupdf; this.doc = doc;
    this.list = (list || []).filter((f) => f && f.font);
    this.refs = {}; this.used = {}; this.cache = new Map();
  }
  map(ch) {
    const cp = ch.codePointAt(0);
    let hit = this.cache.get(cp);
    if (hit !== undefined) return hit;
    hit = null;
    for (let i = 0; i < this.list.length; i++) {
      const f = this.list[i].font;
      let g = 0;
      try { g = f.encodeCharacter(cp); } catch (e) { g = 0; }
      if (g) { hit = { key: 'fb' + i, gids: [g], adv: f.advanceGlyph(g, 0), cp }; break; }
    }
    this.cache.set(cp, hit);
    return hit;
  }
  note(m) { const u = this.used[m.key] || (this.used[m.key] = { cps: new Set(), gids: new Set() }); u.cps.add(m.cp); for (const g of m.gids) u.gids.add(g); }
  ref(key) { if (!this.refs[key]) this.refs[key] = this.doc.addObject(this.doc.newDictionary()); return this.refs[key]; }
  finalize(subsetFn) {
    for (const key of Object.keys(this.refs)) {
      const f = this.list[+key.slice(2)];
      let font = f.font;
      if (subsetFn && f.bytes) {
        try {
          const u = this.used[key];
          const b = subsetFn(f.bytes, u.cps, u.gids);
          if (b) { const sf = new this.mupdf.Font('Fallback', b); if ([...u.cps].every((c) => sf.encodeCharacter(c) === f.font.encodeCharacter(c))) font = sf; }
        } catch (e) { /* 통째로 넣기 */ }
      }
      this.refs[key].writeObject(this.doc.addFont(font).resolve());
    }
  }
}

class FontStats {
  constructor(classify) { this.map = new Map(); this.classify = classify; }
  font(face, bold, italic) {
    const k = face + (bold ? '|b' : '') + (italic ? '|i' : '');
    let s = this.map.get(k);
    if (!s) {
      const c = this.classify ? this.classify(face, { bold, italic }) : { family: 'unknown', bold, italic };
      s = { name: face, family: c.family, bold: !!(bold || c.bold), italic: !!(italic || c.italic), ok: true, glyphs: 0, replaced: 0, kept: 0, slots: {} };
      this.map.set(k, s);
    }
    return s;
  }
  list() {
    // 굵기만 다른 같은 이름은 합쳐서 보여 준다(바꾸기 설정은 이름 단위)
    const by = new Map();
    for (const s of this.map.values()) {
      const t = by.get(s.name);
      if (!t) { by.set(s.name, { ...s, slots: { ...s.slots } }); continue; }
      t.glyphs += s.glyphs; t.replaced += s.replaced; t.kept += s.kept; t.bold = t.bold || s.bold;
      for (const [k, v] of Object.entries(s.slots)) t.slots[k] = (t.slots[k] || 0) + v;
    }
    return [...by.values()];
  }
}

/** 문서 전체에서 가장 많이 쓴 글자 크기(본문 크기) */
export function bodyFontSize(svgs) {
  const hist = new Map();
  for (const s of svgs) for (const m of s.matchAll(/<text\b[^>]*?\sfont-size="([\d.]+)"[^>]*>([^<]*)</g)) {
    const k = Math.round(parseFloat(m[1]) * 2) / 2;
    hist.set(k, (hist.get(k) || 0) + m[2].length);
  }
  let best = 0, n = 0;
  for (const [k, v] of hist) if (v > n) { n = v; best = k; }
  return best;
}

/**
 * 한글 문서 → MuPDF PDFDocument
 * opt: {
 *   fonts: NewFontSet 모양 객체, 또는 (pdf) => 그 객체,
 *   pick(face, bold, italic, sizePx) → 'gR'|'gB'|'bR'|'bB',
 *   classify(face, hint) → {family,bold,italic}  (보고용, 선택)
 *   fallbacks: [{font: mupdf.Font, bytes}]  기본 글꼴에 없는 기호용 (선택)
 *   subset(bytes, unicodes, gids) → Uint8Array|null  예비 글꼴 줄이기 (선택)
 *   decodeImage(bytes, mime) → Promise<Uint8Array PNG|null>  (MuPDF가 못 읽는 그림, 선택)
 *   italic: false 이면 기울임 글씨를 똑바로
 *   progress(done, total)
 * }
 */
export async function hwpToPdf(mupdf, rhwp, bytes, opt) {
  const { doc: hdoc, pages } = openHwp(rhwp, bytes);
  try {
    if (!pages) throw new Error('쪽이 없는 한글 문서예요.');
    const pdf = new mupdf.PDFDocument();
    const fonts = typeof opt.fonts === 'function' ? opt.fonts(pdf) : opt.fonts;
    const stats = new FontStats(opt.classify);
    const fallbackSet = new FallbackFonts(mupdf, pdf, opt.fallbacks);
    const painter = new Painter(mupdf, pdf, { ...opt, fonts, stats, fallbackSet, imageCache: new Map() });
    const pageStats = [];
    for (let i = 0; i < pages; i++) {
      let svg;
      try { svg = renderHwpSvg(hdoc, i); } catch (e) { throw new Error(`${i + 1}쪽을 그리지 못했어요 (${String((e && e.message) || e).slice(0, 80)})`); }
      pageStats.push(await painter.page(svg, i));
      svg = null;
      opt.progress && opt.progress(i + 1, pages);
    }
    fallbackSet.finalize(opt.subset);
    return { pdf, fontSet: fonts, pages: pageStats, fonts: stats.list() };
  } finally {
    try { hdoc.free(); } catch (e) { /* */ }
  }
}

/** 두 단계 변환용: 먼저 SVG를 모두 받아 두기 (본문 크기 계산 등) */
export function hwpSvgs(rhwp, bytes, progress) {
  const { doc: hdoc, pages } = openHwp(rhwp, bytes);
  try {
    const out = [];
    for (let i = 0; i < pages; i++) { out.push(renderHwpSvg(hdoc, i)); progress && progress(i + 1, pages); }
    return out;
  } finally {
    try { hdoc.free(); } catch (e) { /* */ }
  }
}

/** 미리 받아 둔 SVG들로 PDF 만들기 */
export async function svgsToPdf(mupdf, svgs, opt) {
  const pdf = new mupdf.PDFDocument();
  const fonts = typeof opt.fonts === 'function' ? opt.fonts(pdf) : opt.fonts;
  const stats = new FontStats(opt.classify);
  const fallbackSet = new FallbackFonts(mupdf, pdf, opt.fallbacks);
  const painter = new Painter(mupdf, pdf, { ...opt, fonts, stats, fallbackSet, imageCache: new Map() });
  const pageStats = [];
  for (let i = 0; i < svgs.length; i++) {
    pageStats.push(await painter.page(svgs[i], i));
    svgs[i] = null; // 메모리 아끼기
    opt.progress && opt.progress(i + 1, svgs.length);
  }
  fallbackSet.finalize(opt.subset);
  return { pdf, fontSet: fonts, pages: pageStats, fonts: stats.list() };
}
