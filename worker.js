// PDF 압축 워커 — Ghostscript(WASM)로 파일 하나씩 압축합니다.
// 파일마다 새 Ghostscript 인스턴스를 만들어서, 끝나면 메모리를 통째로 돌려받습니다.
import loadGS from './engine/gs.js';

const WASM_URL = new URL('./engine/gs.wasm', import.meta.url);

// iLovePDF의 3단계와 같은 개념 (Ghostscript 기본 프리셋)
//  extreme     : 이미지 72dpi  — 가장 작게, 화질 낮음
//  recommended : 이미지 150dpi — 화면으로 보기엔 충분
//  low         : 이미지 300dpi — 인쇄용, 덜 줄어듦
const PRESET_ARGS = {
  extreme: ['-dPDFSETTINGS=/screen'],
  recommended: ['-dPDFSETTINGS=/ebook'],
  low: ['-dPDFSETTINGS=/printer'],
};

// 프리셋(-dPDFSETTINGS)을 먼저 주고, 그 뒤에 세부 옵션을 덧씌웁니다.
const COMMON_ARGS = [
  '-dCompatibilityLevel=1.5',
  '-dNOPAUSE', '-dBATCH', '-dSAFER',
  '-dAutoRotatePages=/None',          // 페이지 방향을 멋대로 돌리지 않게
  '-dDetectDuplicateImages=true',     // 같은 이미지가 반복되면 한 번만 저장
  '-dCompressFonts=true', '-dSubsetFonts=true',
  '-dColorImageDownsampleType=/Bicubic',
  '-dGrayImageDownsampleType=/Bicubic',
];

let compiled = null;
function getEngine() {
  if (!compiled) {
    compiled = (async () => {
      try {
        return await WebAssembly.compileStreaming(fetch(WASM_URL));
      } catch {
        // 서버가 .wasm MIME 타입을 안 줄 때를 위한 대체 경로
        const res = await fetch(WASM_URL);
        if (!res.ok) throw new Error(`압축 엔진을 불러오지 못했어요 (HTTP ${res.status})`);
        return WebAssembly.compile(await res.arrayBuffer());
      }
    })();
    compiled.catch(() => { compiled = null; });
  }
  return compiled;
}

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(bytes) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}

async function compress({ id, file, preset }) {
  const log = [];
  let total = 0;
  const onLine = (line) => {
    log.push(line);
    if (log.length > 500) log.shift();
    let m = /^Processing pages \d+ through (\d+)/.exec(line);
    if (m) { total = +m[1]; postMessage({ type: 'progress', id, page: 0, total }); return; }
    m = /^Page (\d+)$/.exec(line);
    if (m) postMessage({ type: 'progress', id, page: +m[1], total });
  };

  const engine = await getEngine();
  const gs = await new Promise((resolve, reject) => {
    loadGS({
      instantiateWasm(imports, done) {
        WebAssembly.instantiate(engine, imports).then((inst) => done(inst, engine), reject);
        return {};
      },
      print: onLine,
      printErr: onLine,
      onAbort: (what) => reject(new Error('엔진이 중단됐어요: ' + what)),
    }).then(resolve, reject);
  });

  const input = new Uint8Array(await file.arrayBuffer());
  const inSize = input.byteLength;
  gs.FS.writeFile('/in.pdf', input, { canOwn: true });

  let rc;
  try {
    rc = gs.callMain(['-sDEVICE=pdfwrite', ...(PRESET_ARGS[preset] || PRESET_ARGS.recommended), ...COMMON_ARGS,
      '-sOutputFile=/out.pdf', '/in.pdf']);
  } catch (err) {
    rc = err && typeof err.status === 'number' ? err.status : -1;
    log.push(String((err && err.message) || err));
  }

  let out = null;
  try { out = gs.FS.readFile('/out.pdf'); } catch { /* 출력 없음 */ }
  try { gs.FS.unlink('/in.pdf'); } catch { /* */ }
  try { gs.FS.unlink('/out.pdf'); } catch { /* */ }

  const text = log.join('\n');
  const looksLikePdf = out && out.byteLength > 100 && out[0] === 0x25 && out[1] === 0x50 && out[2] === 0x44 && out[3] === 0x46;
  // 암호 PDF는 Ghostscript가 "성공"하면서 빈 PDF를 내놓기 때문에 로그로 따로 걸러냄
  if (/requires a password|password did not work/i.test(text)) {
    throw new Error('암호가 걸린 PDF라서 압축할 수 없어요. 암호를 푼 뒤 다시 넣어 주세요.');
  }
  if (rc !== 0 || !looksLikePdf || /No pages will be processed|Couldn't initialise file/i.test(text)) {
    if (/not a PDF|Couldn't find trailer|Unrecoverable/i.test(text)) throw new Error('PDF 파일이 아니거나 심하게 손상된 파일이에요.');
    throw new Error('이 PDF는 처리하지 못했어요. 손상됐거나 특수한 형식일 수 있어요.');
  }

  const warn = /Output may be incorrect|\*\*\*\* Error/i.test(text);

  // 압축해도 1% 미만으로만 줄면(또는 커지면) 원본을 그대로 둡니다.
  if (out.byteLength >= inSize * 0.99) {
    postMessage({ type: 'done', id, kept: true, size: inSize, crc: crc32(input), warn: false });
    return;
  }
  if (out.byteOffset !== 0 || out.buffer.byteLength !== out.byteLength) out = out.slice();
  postMessage({ type: 'done', id, kept: false, size: out.byteLength, crc: crc32(out), buf: out.buffer, warn }, [out.buffer]);
}

self.onmessage = async (e) => {
  const msg = e.data;
  if (msg.type === 'warmup') {
    try { await getEngine(); postMessage({ type: 'ready' }); }
    catch (err) { postMessage({ type: 'engine-error', message: String((err && err.message) || err) }); }
    return;
  }
  if (msg.type === 'job') {
    try {
      await compress(msg);
    } catch (err) {
      const message = err instanceof RangeError || /memory/i.test(String(err))
        ? '메모리가 부족해요. 다른 앱/탭을 닫거나 이 파일만 따로 압축해 보세요. (아주 큰 파일은 윈도우용 스크립트 추천)'
        : String((err && err.message) || err);
      postMessage({ type: 'error', id: msg.id, message });
    }
  }
};
