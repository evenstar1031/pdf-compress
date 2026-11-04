// PDF 압축 — 화면 쪽 로직 (파일 목록, 워커 관리, 다운로드/ZIP/공유)

const $ = (s) => document.querySelector(s);
const drop = $('#drop'), picker = $('#picker'), list = $('#list');
const startBtn = $('#start'), stopBtn = $('#stop'), clearBtn = $('#clear');
const statusEl = $('#status'), summary = $('#summary'), sumText = $('#sumText');
const zipBtn = $('#zipAll'), shareAllBtn = $('#shareAll'), keepName = $('#keepName');

const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) ||
  (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
// 아이패드는 메모리를 아끼려고 한 번에 1개씩, 컴퓨터는 최대 3개 동시에
const MAX_WORKERS = isIOS || (navigator.deviceMemory && navigator.deviceMemory <= 4)
  ? 1
  : Math.min(3, Math.max(1, Math.floor((navigator.hardwareConcurrency || 2) / 2)));

const canShareFiles = (() => {
  try { return isIOS && !!navigator.canShare && navigator.canShare({ files: [new File(['x'], 'x.pdf', { type: 'application/pdf' })] }); }
  catch { return false; }
})();

/** @type {{id:number,file:File,name:string,size:number,status:string,page:number,total:number,out:Blob|null,outSize:number,crc:number,warn:boolean,error:string,preset:string,el:HTMLElement}[]} */
let items = [];
let nextId = 1;
let running = false;
let pool = [];          // { w: Worker, job: item|null }
let wakeLock = null;

// ---------- 유틸 ----------
function fmt(bytes) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 ** 2) return (bytes / 1024).toFixed(0) + ' KB';
  if (bytes < 1024 ** 3) return (bytes / 1024 ** 2).toFixed(bytes < 10 * 1024 ** 2 ? 2 : 1) + ' MB';
  return (bytes / 1024 ** 3).toFixed(2) + ' GB';
}
const nfc = (s) => (s.normalize ? s.normalize('NFC') : s); // 아이패드/맥의 분리된 한글(NFD) → 윈도우에서 안 깨지게
const isPdf = (f) => f.type === 'application/pdf' || /\.pdf$/i.test(f.name);
const presetLabel = { extreme: '강하게', recommended: '권장', low: '약하게' };

function outName(item) {
  const base = nfc(item.name).replace(/\.pdf$/i, '');
  return keepName.checked ? `${base}.pdf` : `${base}_압축.pdf`;
}
function setStatus(text, isErr = false) {
  statusEl.textContent = text || '';
  statusEl.classList.toggle('err', !!isErr);
}
function selectedPreset() {
  return document.querySelector('input[name="level"]:checked').value;
}

// ---------- 파일 추가 ----------
function addFiles(files) {
  let skipped = 0, added = 0;
  for (const f of files) {
    if (!isPdf(f)) { skipped++; continue; }
    if (items.some((it) => it.file.name === f.name && it.size === f.size && it.file.lastModified === f.lastModified)) continue;
    const item = { id: nextId++, file: f, name: nfc(f.name), size: f.size, status: 'pending', page: 0, total: 0,
      out: null, outSize: 0, crc: 0, warn: false, error: '', preset: '', el: null };
    item.el = renderRow(item);
    list.appendChild(item.el);
    items.push(item);
    added++;
  }
  if (skipped) setStatus(`PDF가 아닌 파일 ${skipped}개는 뺐어요.`);
  else if (added) setStatus('');
  if (added) warmup();
  refresh();
}

// 폴더를 끌어다 놓은 경우(컴퓨터) 안의 PDF까지 모두 찾기
async function filesFromDrop(dt) {
  const entries = [...(dt.items || [])].map((i) => i.webkitGetAsEntry && i.webkitGetAsEntry()).filter(Boolean);
  if (!entries.length) return [...dt.files];
  const out = [];
  const walk = async (entry) => {
    if (entry.isFile) {
      out.push(await new Promise((res, rej) => entry.file(res, rej)));
    } else if (entry.isDirectory) {
      const reader = entry.createReader();
      let batch;
      do {
        batch = await new Promise((res, rej) => reader.readEntries(res, rej));
        for (const e of batch) await walk(e);
      } while (batch.length);
    }
  };
  for (const e of entries) await walk(e);
  return out.sort((a, b) => a.name.localeCompare(b.name, 'ko', { numeric: true }));
}

drop.addEventListener('click', () => picker.click());
drop.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); picker.click(); } });
picker.addEventListener('change', () => { addFiles([...picker.files]); picker.value = ''; });
['dragenter', 'dragover'].forEach((t) => drop.addEventListener(t, (e) => { e.preventDefault(); drop.classList.add('over'); }));
['dragleave', 'dragend'].forEach((t) => drop.addEventListener(t, () => drop.classList.remove('over')));
drop.addEventListener('drop', async (e) => {
  e.preventDefault(); drop.classList.remove('over');
  try { addFiles(await filesFromDrop(e.dataTransfer)); }
  catch { addFiles([...e.dataTransfer.files]); }
});
// 페이지 아무 데나 떨어뜨려도 브라우저가 PDF를 열어버리지 않게
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', (e) => { if (!drop.contains(e.target)) { e.preventDefault(); } });

// ---------- 목록 표시 ----------
function renderRow(item) {
  const li = document.createElement('li');
  li.className = 'item';
  li.innerHTML = `
    <div class="row">
      <div class="name"></div>
      <div class="acts"></div>
      <button class="x" title="목록에서 빼기" aria-label="목록에서 빼기">×</button>
    </div>
    <div class="meta"></div>
    <div class="track"><i></i></div>`;
  li.querySelector('.name').textContent = item.name;
  li.querySelector('.name').title = item.name;
  li.querySelector('.x').addEventListener('click', () => removeItem(item));
  return li;
}

function updateRow(item) {
  const li = item.el;
  li.className = 'item ' + item.status;
  const meta = li.querySelector('.meta');
  const acts = li.querySelector('.acts');
  const bar = li.querySelector('.track i');
  li.querySelector('.x').hidden = item.status === 'running';

  let html = fmt(item.size);
  if (item.status === 'pending') html += ' · 대기 중';
  if (item.status === 'running') {
    if (item.total) {
      html += ` · 압축 중 ${item.page}/${item.total}쪽`;
      bar.classList.remove('indet'); bar.style.width = (100 * item.page / item.total).toFixed(1) + '%';
    } else {
      html += ' · 여는 중…';
      bar.classList.add('indet'); bar.style.width = '';
    }
  }
  if (item.status === 'done') {
    const pct = Math.round(100 * (1 - item.outSize / item.size));
    html += ` → <b>${fmt(item.outSize)}</b> <span class="gain">−${pct}%</span> · ${presetLabel[item.preset]}`;
    if (item.warn) html += ' · <span class="warn">원본에 오류가 있어 일부 페이지가 다르게 보일 수 있어요. 확인해 주세요.</span>';
  }
  if (item.status === 'kept') html += ' · 이미 최적화돼 있어 더 줄일 수 없어요 (원본 그대로)';
  if (item.status === 'error') html += ` · <span class="err">${escapeHtml(item.error)}</span>`;
  meta.innerHTML = html;

  acts.textContent = '';
  if (item.status === 'done' || item.status === 'kept') {
    const dl = document.createElement('button');
    dl.textContent = '받기';
    dl.addEventListener('click', () => download(resultBlob(item), outName(item)));
    acts.appendChild(dl);
    if (canShareFiles) {
      const sh = document.createElement('button');
      sh.textContent = '공유';
      sh.addEventListener('click', () => shareItems([item]));
      acts.appendChild(sh);
    }
  }
}
function escapeHtml(s) { return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }

function removeItem(item) {
  if (item.status === 'running') return;
  items = items.filter((it) => it !== item);
  item.el.remove();
  refresh();
}

function refresh() {
  const waiting = items.filter((i) => i.status === 'pending').length;
  const failed = items.filter((i) => i.status === 'error').length;
  const finished = items.filter((i) => i.status === 'done' || i.status === 'kept');
  startBtn.disabled = running || !items.length;
  startBtn.textContent = running ? '압축 중…'
    : waiting ? `압축 시작 (${waiting + failed}개)`
    : failed ? `실패한 파일 다시 시도 (${failed}개)`
    : items.length ? `선택한 수준으로 다시 압축 (${items.length}개)` : '압축 시작';
  stopBtn.hidden = !running;
  clearBtn.hidden = running || !items.length;

  if (finished.length) {
    const before = finished.reduce((s, i) => s + i.size, 0);
    const after = finished.reduce((s, i) => s + (i.status === 'done' ? i.outSize : i.size), 0);
    const pct = before ? Math.round(100 * (1 - after / before)) : 0;
    sumText.textContent = `${finished.length}개 완료 · ${fmt(before)} → ${fmt(after)} (−${pct}%)`;
    summary.classList.add('show');
    zipBtn.disabled = running;
    shareAllBtn.hidden = !canShareFiles;
    shareAllBtn.disabled = running;
  } else {
    summary.classList.remove('show');
  }
}

// ---------- 워커 ----------
function makeWorker() {
  const w = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
  const slot = { w, job: null };
  w.onmessage = (e) => onWorkerMessage(slot, e.data);
  w.onerror = (e) => {
    e.preventDefault();
    const job = slot.job;
    slot.job = null;
    try { slot.w.terminate(); } catch { /* */ }
    pool = pool.filter((s) => s !== slot);   // 고장난 워커는 버리고 새로 만듦
    if (!pool.length) warmed = false;
    if (job) {
      job.status = 'error';
      job.error = '압축 엔진이 멈췄어요. 메모리가 부족했을 수 있어요.';
      updateRow(job);
    } else {
      setStatus('압축 엔진을 시작하지 못했어요. 브라우저를 최신으로 업데이트해 주세요.', true);
    }
    if (running) schedule();
  };
  return slot;
}

let warmed = false;
function warmup() {
  if (warmed) return;
  warmed = true;
  if (!pool.length) pool.push(makeWorker());
  pool[0].w.postMessage({ type: 'warmup' });
}

function onWorkerMessage(slot, msg) {
  if (msg.type === 'engine-error') { warmed = false; setStatus(msg.message, true); return; }
  if (msg.type === 'ready') return;
  const item = slot.job;
  if (!item || item.id !== msg.id) return;
  if (msg.type === 'progress') {
    item.page = msg.page; item.total = msg.total;
    updateRow(item);
    return;
  }
  finishJob(slot, msg);
}

function finishJob(slot, msg) {
  const item = slot.job;
  slot.job = null;
  if (msg.type === 'done') {
    item.status = msg.kept ? 'kept' : 'done';
    item.crc = msg.crc;
    item.warn = !!msg.warn;
    item.outSize = msg.size;
    item.out = msg.kept ? null : new Blob([msg.buf], { type: 'application/pdf' });
  } else {
    item.status = 'error';
    item.error = msg.message || '알 수 없는 오류';
  }
  updateRow(item);
  schedule();
}

function schedule() {
  if (!running) return;
  const queue = items.filter((i) => i.status === 'pending');
  while (queue.length) {
    let slot = pool.find((s) => !s.job);
    if (!slot && pool.length < MAX_WORKERS) {
      slot = makeWorker(); pool.push(slot);
    }
    if (!slot) break;
    const item = queue.shift();
    item.status = 'running'; item.page = 0; item.total = 0;
    slot.job = item;
    updateRow(item);
    slot.w.postMessage({ type: 'job', id: item.id, file: item.file, preset: item.preset });
  }
  const busy = pool.filter((s) => s.job).length;
  if (!busy) { done(); return; }
  const left = items.filter((i) => i.status === 'pending' || i.status === 'running').length;
  setStatus(`${items.length - left}/${items.length}개 끝남 · 한 번에 ${busy}개씩 처리 중`);
  refresh();
}

async function start() {
  if (running || !items.length) return;
  let targets = items.filter((i) => i.status === 'pending' || i.status === 'error');
  if (!targets.length) { // 전부 끝난 상태에서 다시 누르면 = 지금 고른 수준으로 다시
    targets = items;
  }
  const preset = selectedPreset();
  for (const it of targets) {
    it.status = 'pending'; it.preset = preset; it.out = null; it.outSize = 0; it.error = ''; it.warn = false;
    updateRow(it);
  }
  running = true;
  if (!warmed) setStatus('압축 엔진 불러오는 중… (처음 한 번만 약 15MB)');
  await keepAwake(true);
  schedule();
}

function stop() {
  for (const slot of pool) {
    try { slot.w.terminate(); } catch { /* */ }
    if (slot.job) { slot.job.status = 'pending'; updateRow(slot.job); }
  }
  pool = []; warmed = false; running = false;
  keepAwake(false);
  setStatus('중지했어요. 다시 누르면 남은 파일부터 이어서 압축해요.');
  refresh();
}

function done() {
  running = false;
  keepAwake(false);
  const errs = items.filter((i) => i.status === 'error').length;
  setStatus(errs ? `끝났어요. ${errs}개는 실패했어요 (이유는 각 파일 아래에).` : '모두 끝났어요!', !!errs);
  refresh();
}

// 아이패드가 처리 중에 잠들면 브라우저가 작업을 멈추므로 화면을 켜둡니다
async function keepAwake(on) {
  try {
    if (on && 'wakeLock' in navigator && !wakeLock) {
      wakeLock = await navigator.wakeLock.request('screen');
      wakeLock.addEventListener('release', () => { wakeLock = null; });
    } else if (!on && wakeLock) {
      await wakeLock.release(); wakeLock = null;
    }
  } catch { /* 지원 안 하면 그냥 넘어감 */ }
}
document.addEventListener('visibilitychange', () => { if (running && document.visibilityState === 'visible') keepAwake(true); });
window.addEventListener('beforeunload', (e) => { if (running) { e.preventDefault(); e.returnValue = ''; } });

startBtn.addEventListener('click', start);
stopBtn.addEventListener('click', stop);
clearBtn.addEventListener('click', () => { items = []; list.textContent = ''; setStatus(''); refresh(); });

// ---------- 받기 / ZIP / 공유 ----------
const resultBlob = (item) => (item.status === 'done' ? item.out : item.file);

function download(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = name; a.rel = 'noopener';
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 120000);
}

async function shareItems(its) {
  const files = its.map((it) => new File([resultBlob(it)], outName(it), { type: 'application/pdf' }));
  try { await navigator.share({ files }); }
  catch (err) { if (err && err.name !== 'AbortError') setStatus('공유하지 못했어요. 파일이 너무 크면 “받기”나 ZIP을 써 주세요.', true); }
}
shareAllBtn.addEventListener('click', () => shareItems(items.filter((i) => i.status === 'done' || i.status === 'kept')));

// 압축 없이 묶기만 하는(STORE) ZIP — PDF는 이미 압축돼 있어서 이게 제일 빠르고 메모리도 적게 씀
function makeZip(entries) {
  const enc = new TextEncoder();
  const now = new Date();
  const dosTime = (now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1);
  const dosDate = ((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();
  const parts = [], central = [];
  let offset = 0;
  const used = new Set();
  for (const e of entries) {
    let name = e.name, n = 2;
    while (used.has(name.toLowerCase())) name = e.name.replace(/(\.pdf)?$/i, ` (${n++})$1`);
    used.add(name.toLowerCase());
    const nb = enc.encode(name);
    const lh = new DataView(new ArrayBuffer(30));
    lh.setUint32(0, 0x04034b50, true); lh.setUint16(4, 20, true); lh.setUint16(6, 0x0800, true); // UTF-8 이름
    lh.setUint16(8, 0, true); lh.setUint16(10, dosTime, true); lh.setUint16(12, dosDate, true);
    lh.setUint32(14, e.crc, true); lh.setUint32(18, e.size, true); lh.setUint32(22, e.size, true);
    lh.setUint16(26, nb.length, true); lh.setUint16(28, 0, true);
    parts.push(lh.buffer, nb, e.blob);
    const ch = new DataView(new ArrayBuffer(46));
    ch.setUint32(0, 0x02014b50, true); ch.setUint16(4, 20, true); ch.setUint16(6, 20, true); ch.setUint16(8, 0x0800, true);
    ch.setUint16(10, 0, true); ch.setUint16(12, dosTime, true); ch.setUint16(14, dosDate, true);
    ch.setUint32(16, e.crc, true); ch.setUint32(20, e.size, true); ch.setUint32(24, e.size, true);
    ch.setUint16(28, nb.length, true); ch.setUint32(42, offset, true);
    central.push(ch.buffer, nb);
    offset += 30 + nb.length + e.size;
  }
  const cdSize = central.reduce((s, p) => s + p.byteLength, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true); end.setUint16(8, entries.length, true); end.setUint16(10, entries.length, true);
  end.setUint32(12, cdSize, true); end.setUint32(16, offset, true);
  return new Blob([...parts, ...central, end.buffer], { type: 'application/zip' });
}

zipBtn.addEventListener('click', () => {
  const fin = items.filter((i) => i.status === 'done' || i.status === 'kept');
  const entries = fin.map((it) => ({ name: outName(it), blob: resultBlob(it), size: it.status === 'done' ? it.outSize : it.size, crc: it.crc }));
  const total = entries.reduce((s, e) => s + e.size, 0);
  if (total >= 0xFFFFFFFF - 1e6) { setStatus('합쳐서 4GB가 넘어서 ZIP으로는 못 묶어요. 파일별로 “받기”를 눌러 주세요.', true); return; }
  const d = new Date();
  const stamp = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}-${String(d.getHours()).padStart(2, '0')}${String(d.getMinutes()).padStart(2, '0')}`;
  download(makeZip(entries), `압축된PDF_${stamp}.zip`);
});

keepName.addEventListener('change', () => items.forEach(updateRow));

// 구형 브라우저 안내
if (!('Worker' in window) || !('WebAssembly' in window)) {
  setStatus('이 브라우저는 지원하지 않아요. 최신 Safari / Chrome / Edge로 열어 주세요.', true);
}
refresh();
