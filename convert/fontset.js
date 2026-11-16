// 새 글꼴 묶음(고딕 보통/굵게, 바탕 보통/굵게): 글자 → 글리프, 쓴 글자 기록, 마지막에 줄여서(subset) 넣기
// lectrue-font-swap 저장소의 engine/pdf-swap.js 에 있는 NewFontSet과 같은 코드
// 새 글꼴에 없는 글자를 비슷한 글자로
const SUBST = new Map([
  [0x2010, [0x2d]], [0x2011, [0x2d]], [0x00ad, [0x2d]], [0x00a0, [0x20]], [0x202f, [0x20]], [0x2007, [0x20]], [0x2009, [0x20]],
  [0x200a, [0x20]], [0x2002, [0x20]], [0x2003, [0x20]], [0x00b7, [0x2219, 0x22c5, 0x30fb, 0x2027]], [0x2219, [0x00b7, 0x22c5]],
  [0x2027, [0x00b7]], [0x2212, [0x2013, 0x2d]], [0xfeff, [0x20]],
]);

function isPUA(cp) { return (cp >= 0xe000 && cp <= 0xf8ff) || cp >= 0xf0000; }

export class NewFontSet {
  /** @param fonts {gR,gB,bR,bB} → {font: mupdf.Font, label} */
  constructor(mupdf, doc, fonts) {
    this.mupdf = mupdf;
    this.doc = doc;
    this.fonts = fonts;
    this.refs = {};
    this.cache = { gR: new Map(), gB: new Map(), bR: new Map(), bB: new Map() };
    this.adv = { gR: new Map(), gB: new Map(), bR: new Map(), bB: new Map() };
  }
  has(key) { return !!this.fonts[key]; }
  resolveKey(key) {
    // 슬롯 글꼴이 없으면 같은 계열 다른 굵기 → 다른 계열
    if (this.fonts[key]) return key;
    const alt = [key[0] + (key[1] === 'B' ? 'R' : 'B'), (key[0] === 'g' ? 'b' : 'g') + key[1], (key[0] === 'g' ? 'b' : 'g') + (key[1] === 'B' ? 'R' : 'B')];
    return alt.find((k) => this.fonts[k]) || null;
  }
  gid(key, cp) {
    const c = this.cache[key];
    let g = c.get(cp);
    if (g === undefined) {
      g = this.fonts[key].font.encodeCharacter(cp) || 0;
      c.set(cp, g);
    }
    return g;
  }
  advance(key, gid) {
    const c = this.adv[key];
    let a = c.get(gid);
    if (a === undefined) { a = this.fonts[key].font.advanceGlyph(gid, 0); c.set(gid, a); }
    return a;
  }
  // 자원 사전에는 자리표시 객체를 넣어 두고, 마지막에 줄인(subset) 글꼴로 채운다.
  ref(key) {
    if (!this.refs[key]) this.refs[key] = this.doc.addObject(this.doc.newDictionary());
    return this.refs[key];
  }
  note(key, cps, gids) {
    if (!this.used) this.used = {};
    const u = this.used[key] || (this.used[key] = { cps: new Set(), gids: new Set() });
    for (const c of cps) u.cps.add(c);
    for (const g of gids) u.gids.add(g);
  }
  /** subsetFn(bytes, unicodes, gids) → Uint8Array|null */
  finalize(subsetFn) {
    const sizes = {};
    for (const key of Object.keys(this.refs)) {
      const f = this.fonts[key];
      const u = (this.used && this.used[key]) || { cps: new Set(), gids: new Set() };
      let font = f.font;
      let bytes = null;
      if (subsetFn && f.bytes) {
        try { bytes = subsetFn(f.bytes, u.cps, u.gids); } catch (e) { bytes = null; }
        if (bytes) {
          try {
            const sf = new this.mupdf.Font(f.psname || 'Font', bytes);
            // 줄인 글꼴에서도 같은 글리프 번호인지 확인
            let ok = true;
            for (const cp of [...u.cps].slice(0, 50)) if (sf.encodeCharacter(cp) !== font.encodeCharacter(cp)) { ok = false; break; }
            if (ok) font = sf; else bytes = null;
          } catch (e) { bytes = null; }
        }
      }
      const real = this.doc.addFont(font);
      this.refs[key].writeObject(real.resolve());
      sizes[key] = bytes ? bytes.length : f.bytes ? f.bytes.length : 0;
    }
    return sizes;
  }
  /** 문자열 u를 슬롯 key 글꼴 글리프로. 없으면 다른 계열로, 그래도 없으면 null */
  map(u, key) {
    if (!u) return null;
    const cps = Array.from(u, (ch) => ch.codePointAt(0));
    for (const cp of cps) if (cp < 0x20 || isPUA(cp) || cp === 0xfffd) return null;
    const order = [key, (key[0] === 'g' ? 'b' : 'g') + key[1]].filter((k) => this.fonts[k]);
    for (const k of order) {
      const gids = [];
      let ok = true;
      for (const cp of cps) {
        let g = this.gid(k, cp);
        if (!g && SUBST.has(cp)) for (const s of SUBST.get(cp)) { g = this.gid(k, s); if (g) break; }
        if (!g) { ok = false; break; }
        gids.push(g);
      }
      if (ok) {
        let adv = 0;
        for (const g of gids) adv += this.advance(k, g);
        this.note(k, cps, gids);
        return { key: k, gids, adv };
      }
    }
    return null;
  }
}
