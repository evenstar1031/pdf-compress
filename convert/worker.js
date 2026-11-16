// PDF가 아닌 파일 → PDF (압축하기 전에 한 번)
//  · 한글(HWP·HWPX): rhwp로 쪽마다 그린 뒤 MuPDF로 PDF를 만든다. 글자는 검색·복사되는 진짜 글자로.
//  · 사진(JPG·PNG·HEIC·WEBP·GIF·BMP·TIFF): 한 장 = 한 쪽. 사진 비율 그대로, 긴 변을 A4 긴 변(297mm)에 맞춘다.
// 무거운 엔진은 이 워커 하나에만 올린다(압축 워커는 Ghostscript만).
import { loadRhwp, hwpSvgs, svgsToPdf } from './hwp-pdf.js';
import { NewFontSet } from './fontset.js';
import { classifyFont, pickSlot } from './classify.js';
import { initSubsetter, subsetFont } from './subset.js';

let mupdf = null;
async function getMupdf() {
  if (!mupdf) mupdf = await import('./vendor/mupdf/mupdf.js');
  return mupdf;
}

// 글꼴: 고딕 = Noto Sans KR, 바탕 = 나눔명조 (둘 다 OFL). 필요한 것만 받는다.
const FONT_FILES = {
  gR: 'NotoSansKR-Regular.ttf', gB: 'NotoSansKR-Bold.ttf',
  bR: 'NanumMyeongjo-Regular.ttf', bB: 'NanumMyeongjo-Bold.ttf',
};
const FALLBACK_FILES = ['NotoSansSymbols2-Regular.ttf', 'NotoSansMath-Regular.ttf'];
const fontCache = new Map();
async function loadFont(file) {
  if (fontCache.has(file)) return fontCache.get(file);
  const p = (async () => {
    const res = await fetch(new URL('./fonts/' + file, import.meta.url));
    if (!res.ok) throw new Error(`글꼴을 받지 못했어요 (${file})`);
    const bytes = new Uint8Array(await res.arrayBuffer());
    return { bytes, psname: file.replace(/\.[^.]+$/, '').replace(/[^A-Za-z0-9-]/g, ''), font: new mupdf.Font(file.replace(/\.[^.]+$/, ''), bytes) };
  })();
  fontCache.set(file, p);
  p.catch(() => fontCache.delete(file));
  return p;
}

let subsetReady = null;
function ensureSubsetter() {
  if (!subsetReady) {
    subsetReady = initSubsetter(new URL('./vendor/hb/harfbuzz-subset.wasm', import.meta.url).href);
    subsetReady.catch(() => { subsetReady = null; });
  }
  return subsetReady;
}

function slotOf(face, bold) {
  const cls = classifyFont(face, { bold });
  cls.bold = cls.bold || bold;
  const s = pickSlot(cls, { mode: 'keep', keepMono: false });
  return s || (cls.family === 'batang' ? (cls.bold ? 'bB' : 'bR') : (cls.bold ? 'gB' : 'gR'));
}

// SVG를 훑어 실제로 쓰일 글꼴 칸만 고른다(안 쓰는 글꼴은 받지 않으려고)
function neededSlots(svgs) {
  const need = new Set();
  const seen = new Set();
  const re = /<text\b[^>]*?font-family="([^"]*)"[^>]*>/g;
  for (const s of svgs) {
    let m;
    re.lastIndex = 0;
    while ((m = re.exec(s))) {
      const tag = m[0];
      const fam = m[1].replace(/&apos;|&quot;/g, "'").split(',')[0].replace(/^\s*'?|'?\s*$/g, '');
      const w = (/font-weight="([^"]*)"/.exec(tag) || [])[1] || '';
      const bold = w === 'bold' || +w >= 600;
      const k = fam + (bold ? '|b' : '');
      if (seen.has(k)) continue;
      seen.add(k);
      need.add(slotOf(fam, bold));
    }
  }
  if (!need.size) need.add('bR');
  return need;
}

async function decodeWithBrowser(bytes, mime, preferPng) {
  if (typeof createImageBitmap !== 'function' || typeof OffscreenCanvas === 'undefined') return null;
  let bmp;
  try { bmp = await createImageBitmap(new Blob([bytes], { type: mime || '' }), { imageOrientation: 'from-image' }); }
  catch (e) { bmp = await createImageBitmap(new Blob([bytes], { type: mime || '' })); }
  const c = new OffscreenCanvas(bmp.width, bmp.height);
  const g = c.getContext('2d');
  if (!preferPng) { g.fillStyle = '#fff'; g.fillRect(0, 0, bmp.width, bmp.height); }
  g.drawImage(bmp, 0, 0);
  if (bmp.close) bmp.close();
  const blob = await c.convertToBlob(preferPng ? { type: 'image/png' } : { type: 'image/jpeg', quality: 0.92 });
  return new Uint8Array(await blob.arrayBuffer());
}

async function hwpToPdfBytes(id, bytes) {
  const progress = (done, total) => postMessage({ type: 'progress', id, done, total });
  progress(0, 0);
  await getMupdf();
  const [rhwp] = await Promise.all([loadRhwp(new URL('./vendor/rhwp/', import.meta.url)), ensureSubsetter()]);
  const svgs = hwpSvgs(rhwp, bytes);
  const n = svgs.length;
  progress(0, n);
  const need = neededSlots(svgs);
  const fonts = {};
  await Promise.all([...need].map(async (k) => { fonts[k] = await loadFont(FONT_FILES[k]); }));
  const fallbacks = [];
  for (const f of FALLBACK_FILES) { try { fallbacks.push(await loadFont(f)); } catch (e) { /* 없으면 없는 대로 */ } }
  let nf = null;
  const r = await svgsToPdf(mupdf, svgs, {
    fonts: (pdf) => (nf = new NewFontSet(mupdf, pdf, fonts)),
    pick(face, bold) {
      const s = slotOf(face, bold);
      return nf.resolveKey(s) || s;
    },
    fallbacks,
    subset: subsetFont,
    decodeImage: (b, mime) => decodeWithBrowser(b, mime, true),
    progress: (i) => progress(i, n),
  });
  nf.finalize(subsetFont);
  const out = r.pdf.saveToBuffer('garbage=compact,compress').asUint8Array().slice();
  r.pdf.destroy && r.pdf.destroy();
  return { pdf: out, pages: n };
}

// A4 긴 변 = 842pt. 사진 긴 변을 여기에 맞추고 비율은 그대로.
async function imageToPdfBytes(id, bytes, mime, name) {
  postMessage({ type: 'progress', id, done: 0, total: 1 });
  await getMupdf();
  const isPng = /png/i.test(mime) || /\.png$/i.test(name);
  const isJpeg = /jpe?g/i.test(mime) || /\.jpe?g$/i.test(name);
  let img = null;
  // 1) 브라우저로 풀기 (사진의 회전 정보 반영, HEIC도 됨) → 2) 안 되면 MuPDF로 직접
  try {
    const re = await decodeWithBrowser(bytes, mime, isPng);
    if (re) img = new mupdf.Image(re);
  } catch (e) { img = null; }
  if (!img && (isPng || isJpeg || /gif|bmp|tiff?/i.test(mime + name))) {
    try { img = new mupdf.Image(bytes); img.getWidth(); } catch (e) { img = null; }
  }
  if (!img) throw new Error('이 사진 형식은 이 브라우저에서 열 수 없어요. JPG나 PNG로 바꿔서 넣어 주세요.');
  const w = img.getWidth(), h = img.getHeight();
  const s = 842 / Math.max(w, h);
  const pw = Math.max(1, w * s), ph = Math.max(1, h * s);
  const pdf = new mupdf.PDFDocument();
  const ref = pdf.addImage(img);
  const res = pdf.newDictionary();
  const xo = pdf.newDictionary();
  xo.put('Im0', ref);
  res.put('XObject', xo);
  const content = new TextEncoder().encode(`q ${pw.toFixed(3)} 0 0 ${ph.toFixed(3)} 0 0 cm /Im0 Do Q`);
  pdf.insertPage(-1, pdf.addPage([0, 0, pw, ph], 0, res, content));
  const out = pdf.saveToBuffer('garbage=compact,compress').asUint8Array().slice();
  postMessage({ type: 'progress', id, done: 1, total: 1 });
  return { pdf: out, pages: 1 };
}

self.onmessage = async (e) => {
  const m = e.data;
  if (m.type !== 'convert') return;
  try {
    const bytes = new Uint8Array(await m.file.arrayBuffer());
    const r = m.kind === 'hwp' ? await hwpToPdfBytes(m.id, bytes) : await imageToPdfBytes(m.id, bytes, m.file.type || '', m.file.name || '');
    postMessage({ type: 'done', id: m.id, buf: r.pdf.buffer, pages: r.pages }, [r.pdf.buffer]);
  } catch (err) {
    const msg = String((err && err.message) || err);
    postMessage({
      type: 'error', id: m.id,
      message: err instanceof RangeError || /memory/i.test(msg) ? '메모리가 부족해요. 다른 앱/탭을 닫고 다시 해 보세요.' : msg,
    });
  }
};
