// Modo "conecta no meu navegador" via Chrome DevTools Protocol (CDP).
//
// Funciona com qualquer browser Chromium-based (Chrome, Brave, Edge, Opera...).
// Fluxo:
//   1. /launch-chrome  — spawna Chrome com --remote-debugging-port=9222
//      (ou usuário abre Chrome com essa flag manualmente)
//   2. /connect        — server conecta via CDP, lista abas
//   3. Usuário loga no Google, navega até o livro, abre o reader
//   4. /capture-current — pega a aba do reader, roda screenshot+OCR+turn page
//   5. /close-chrome   — fecha tudo
//
// O Chrome roda com user data dir SEPARADO (.gbooks-chrome-debug) pra não
// conflitar com o Chrome principal do usuário, que pode estar aberto.
// Usuário loga uma vez nesse perfil separado — Chrome lembra (persistent).

const { chromium } = require('playwright');
const { spawn } = require('child_process');
const net = require('net');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const sharp = require('sharp');
const { cleanText } = require('./clean');
const { resolveTesseractCmd, findChrome } = require('./setup-helpers');
const TESSERACT_CMD = resolveTesseractCmd();
const ROOT = path.join(__dirname, '..');
const OUTPUT_DIR = path.join(ROOT, 'output');
const TMP_DIR = path.join(ROOT, 'tmp_ocr');
const CHROME_DEBUG_DIR = path.join(ROOT, '.gbooks-chrome-debug');
const DEBUG_PORT = 9222;

let chromeProcess = null;
let browser = null;
let context = null;
let captureActive = false;
let abortRequested = false;

// ---- helpers ----
function safeFileName(s) { return 'gbooks_' + s.replace(/[^a-z0-9_\-]+/gi, '_').slice(0, 80); }
function fmtBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}
function hashB64(b64) { return b64 ? crypto.createHash('sha1').update(b64).digest('hex') : ''; }
function loadStateFile(p) {
  if (!fs.existsSync(p)) return null;
  try { return JSON.parse(fs.readFileSync(p, 'utf-8')); } catch { return null; }
}
function ensureDirs() {
  for (const d of [OUTPUT_DIR, TMP_DIR]) if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
}

function isPortOpen(port) {
  return new Promise(resolve => {
    const s = new net.Socket();
    s.setTimeout(500);
    s.once('connect', () => { s.destroy(); resolve(true); });
    s.once('timeout', () => { s.destroy(); resolve(false); });
    s.once('error', () => { s.destroy(); resolve(false); });
    s.connect(port, '127.0.0.1');
  });
}

async function waitForPort(port, timeoutMs = 8000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await isPortOpen(port)) return true;
    await new Promise(r => setTimeout(r, 300));
  }
  return false;
}

// Upscale 2x lanczos antes do OCR — Tesseract performa muito melhor com input
// equivalente a ~300 DPI; viewports do Chrome são tipicamente ~96 DPI.
async function preprocessForOCR(pngPath) {
  const upscaledPath = pngPath.replace(/\.png$/, '.up.png');
  const meta = await sharp(pngPath).metadata();
  await sharp(pngPath)
    .resize({ width: meta.width * 2, kernel: sharp.kernel.lanczos3 })
    .grayscale()
    .normalise()
    .png({ compressionLevel: 1 })
    .toFile(upscaledPath);
  try { fs.unlinkSync(pngPath); } catch {}
  return upscaledPath;
}

async function ocrPNG(pngPath, lang = 'por', timeoutMs = 45000) {
  let inputPath = pngPath;
  try {
    inputPath = await preprocessForOCR(pngPath);
  } catch (e) {
    // Se sharp falhar, segue com a PNG original.
  }
  return new Promise((resolve) => {
    const base = inputPath.replace(/\.png$/, '');
    const proc = spawn(TESSERACT_CMD, [
      inputPath, base,
      '-l', lang,
      '--psm', '6',
      '--oem', '1',
      '-c', 'user_defined_dpi=300',
      '-c', 'preserve_interword_spaces=1'
    ], { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    proc.stderr.on('data', d => { stderr += d.toString(); });
    const killer = setTimeout(() => { try { proc.kill('SIGKILL'); } catch {} }, timeoutMs);
    proc.on('exit', (code) => {
      clearTimeout(killer);
      const txtPath = base + '.txt';
      let text = '';
      try { text = fs.readFileSync(txtPath, 'utf-8'); } catch {}
      try { fs.unlinkSync(inputPath); } catch {}
      try { fs.unlinkSync(txtPath); } catch {}
      if (code !== 0) return resolve({ ok: false, text: '', error: stderr.slice(0, 200) });
      resolve({ ok: true, text });
    });
    proc.on('error', (e) => { clearTimeout(killer); resolve({ ok: false, text: '', error: e.message }); });
  });
}

async function capturePagePNG(page) {
  // Crop com margens fixas pra recortar header (título do livro), footer
  // (controles tipo "< 4/227 >") e sidebar direita (ícones de zoom/menu).
  // Esses elementos repetem em cada página e poluem o OCR.
  const box = await page.evaluate(() => {
    const W = window.innerWidth;
    const H = window.innerHeight;
    return {
      x: 60,
      y: 80,
      w: W - 60 - 90,   // -90 corta sidebar direita
      h: H - 80 - 70    // -70 corta footer de controles
    };
  });
  const buf = await page.screenshot({
    type: 'png',
    timeout: 60000,
    animations: 'disabled', // pausa animações (cursor piscando, loaders) que travam waitForStability
    caret: 'hide',
    clip: {
      x: Math.max(0, Math.floor(box.x)),
      y: Math.max(0, Math.floor(box.y)),
      width: Math.max(100, Math.floor(box.w)),
      height: Math.max(100, Math.floor(box.h))
    }
  });
  return buf.toString('base64');
}

// Remove lixo de UI do Play Books que o Tesseract pega mesmo após o crop:
// indicadores de página, fragmentos de ícones, linhas de uma letra/símbolo.
function cleanGbooksPage(text) {
  if (!text) return '';
  return text
    .split('\n')
    .map(l => l.trim())
    // remove indicadores de página tipo "< 10/227 >" ou "< 10-11/227 >"
    .filter(l => !/^[<>«»]?\s*\d+(-\d+)?\s*\/\s*\d+\s*[<>«»]?$/.test(l))
    // remove linhas com menos de 4 chars alfanuméricos (provavelmente ícone)
    .filter(l => {
      const alphaNum = (l.match(/[a-zA-ZÀ-ÿ0-9]/g) || []).length;
      return alphaNum >= 4 || l.length === 0;
    })
    // remove linhas que são só "Q", ">", "<", "=", combinações de símbolos
    .filter(l => !/^[\sQ<>=|\\[\](){}.,_\-+*/&%$#@!?:;"'`~^]{1,4}$/.test(l))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// ---- API pública ----

async function launchChrome({ broadcast } = {}) {
  // Se a porta já tá aberta, alguém abriu Chrome com debug — perfeito, só conecta.
  if (await isPortOpen(DEBUG_PORT)) {
    broadcast?.({ t: Date.now(), type: 'gbooks_manual', msg: `Porta ${DEBUG_PORT} já tá ouvindo — pulando spawn` });
    return { ok: true, alreadyListening: true, port: DEBUG_PORT };
  }
  if (chromeProcess && !chromeProcess.killed) {
    return { ok: true, already: true, port: DEBUG_PORT };
  }

  const chromePath = findChrome();
  if (!chromePath) {
    throw new Error('Chrome não encontrado. Instale via Setup ou abra Chrome manualmente com --remote-debugging-port=' + DEBUG_PORT);
  }

  fs.mkdirSync(CHROME_DEBUG_DIR, { recursive: true });
  broadcast?.({ t: Date.now(), type: 'gbooks_manual', msg: `Abrindo Chrome com debug port ${DEBUG_PORT}...` });

  chromeProcess = spawn(chromePath, [
    `--remote-debugging-port=${DEBUG_PORT}`,
    `--user-data-dir=${CHROME_DEBUG_DIR}`,
    '--no-first-run',
    '--no-default-browser-check',
    'https://play.google.com/books'
  ], { detached: false, stdio: 'ignore' });

  chromeProcess.on('exit', (code) => {
    broadcast?.({ t: Date.now(), type: 'gbooks_manual', msg: `Chrome fechou (exit ${code})` });
    chromeProcess = null;
    browser = null;
    context = null;
  });

  const ok = await waitForPort(DEBUG_PORT, 10000);
  if (!ok) throw new Error(`Chrome não abriu a porta ${DEBUG_PORT} em 10s`);

  broadcast?.({ t: Date.now(), type: 'gbooks_manual', msg: `✓ Chrome ouvindo em :${DEBUG_PORT}. Logue e abra o livro.` });
  return { ok: true, chromePath, port: DEBUG_PORT };
}

async function connect({ broadcast } = {}) {
  if (browser) return { ok: true, already: true };
  if (!(await isPortOpen(DEBUG_PORT))) {
    throw new Error(`Porta ${DEBUG_PORT} não tá ouvindo. Abra Chrome em modo debug primeiro.`);
  }
  try {
    browser = await chromium.connectOverCDP(`http://127.0.0.1:${DEBUG_PORT}`);
  } catch (e) {
    browser = null;
    throw new Error(`Falha CDP: ${e.message}`);
  }
  const contexts = browser.contexts();
  if (contexts.length === 0) {
    try { await browser.close(); } catch {}
    browser = null;
    throw new Error('CDP conectou mas sem contextos. Reabra o Chrome.');
  }
  context = contexts[0];
  broadcast?.({ t: Date.now(), type: 'gbooks_manual', msg: `✓ Conectado via CDP (${context.pages().length} aba(s))` });
  return { ok: true };
}

async function status() {
  const portOpen = await isPortOpen(DEBUG_PORT);
  if (!browser) {
    return {
      chromeRunning: !!chromeProcess,
      portOpen,
      connected: false,
      capturing: false
    };
  }
  const pages = context.pages();
  let onReader = false, bookId = null, currentUrl = '';
  for (const p of pages) {
    try {
      const u = p.url();
      if (/play\.google\.com\/books\/reader/.test(u)) {
        currentUrl = u;
        onReader = true;
        const m = u.match(/[?&]id=([^&]+)/);
        if (m) bookId = decodeURIComponent(m[1]);
        break;
      }
      if (!currentUrl) currentUrl = u;
    } catch {}
  }
  return {
    chromeRunning: !!chromeProcess,
    portOpen,
    connected: true,
    capturing: captureActive,
    pageCount: pages.length,
    currentUrl,
    onReader,
    bookId
  };
}

async function captureCurrent({ broadcast, settings = {} }) {
  if (!browser) throw new Error('não conectado — clique em Conectar primeiro');
  if (captureActive) throw new Error('já capturando — espere terminar ou aborte');
  ensureDirs();

  // Acha a aba que está no reader
  let page = null;
  for (const p of context.pages()) {
    try {
      if (/play\.google\.com\/books\/reader/.test(p.url())) { page = p; break; }
    } catch {}
  }
  if (!page) throw new Error('nenhuma aba no reader — abra um livro em play.google.com/books/reader antes');

  const url = page.url();
  const m = url.match(/[?&]id=([^&]+)/);
  if (!m) throw new Error('URL do reader sem id');
  const bookId = decodeURIComponent(m[1]);

  // Título: pega do <title> da página (Google bota "Nome do Livro - Google Play Books")
  let title = bookId;
  try {
    const docTitle = await page.title();
    if (docTitle) title = docTitle.replace(/\s*[-–|]\s*Google Play\s*(Books|Livros)?\s*$/i, '').trim() || bookId;
  } catch {}

  const fileBase = safeFileName(title);
  const outFile = path.join(OUTPUT_DIR, `${fileBase}.txt`);
  const stateFile = path.join(OUTPUT_DIR, `${fileBase}.state.json`);
  const bookTmpDir = path.join(TMP_DIR, fileBase);
  fs.mkdirSync(bookTmpDir, { recursive: true });

  const prevState = loadStateFile(stateFile);
  const isResume = prevState && prevState.lastPage > 0 && !prevState.completed;
  const startedAt = (prevState && prevState.startedAt) || new Date().toISOString();
  const tStart = Date.now();

  captureActive = true;
  abortRequested = false;

  if (isResume) {
    broadcast?.({
      t: Date.now(), type: 'gbooks_manual',
      msg: `⚠ Retomando de pág ${prevState.lastPage} — confirme que o Chrome tá navegado até essa página antes do script começar a virar.`
    });
  }

  broadcast?.({
    t: Date.now(), type: 'book_start', source: 'gbooks',
    id: bookId, asin: bookId, title, idx: 1, total: 1,
    resume: isResume, startFromPage: isResume ? prevState.lastPage : 0,
    file: path.basename(outFile)
  });

  const out = fs.createWriteStream(outFile, { flags: isResume ? 'a' : 'w' });
  const maxPages = settings.maxPages || 10000;
  const END_OF_BOOK_THRESHOLD = 5;

  let currentPage = isResume ? prevState.lastPage : 0;
  let totalChars = (prevState && prevState.totalChars) || 0;
  let prevHash = '';
  let sameHashCount = 0;
  let completed = false;
  let abortReason = null;

  let pendingOCR = null;
  let pendingMeta = null;

  const finalizeOCR = async () => {
    if (!pendingOCR) return;
    const result = await pendingOCR;
    pendingOCR = null;
    const meta = pendingMeta;
    pendingMeta = null;
    if (!result.ok) return;
    const text = cleanText(cleanGbooksPage(result.text));
    out.write(text + '\n\n');
    totalChars += text.length + 2;
    const elapsed = (Date.now() - tStart) / 1000;
    const startPage = isResume ? prevState.lastPage : 0;
    const rate = elapsed > 0 ? (meta.page - startPage) / elapsed : 0;
    broadcast?.({
      t: Date.now(), type: 'page', source: 'gbooks',
      id: bookId, asin: bookId,
      page: meta.page, totalChars, rate, elapsed,
      preview: text.replace(/\s+/g, ' ').slice(0, 280),
      addedChars: text.length
    });
    fs.writeFileSync(stateFile, JSON.stringify({
      id: bookId, title,
      lastPage: meta.page, totalChars,
      completed: false, startedAt,
      updatedAt: new Date().toISOString(),
      lastHash: meta.hash
    }, null, 2));
  };

  try {
    for (let i = currentPage + 1; i <= maxPages; i++) {
      if (abortRequested) { abortReason = 'abortado pelo usuário'; break; }
      await page.waitForTimeout(settings.pageDelayMs || 1500);

      let b64 = null;
      let screenshotError = null;
      for (let attempt = 1; attempt <= 2; attempt++) {
        try { b64 = await capturePagePNG(page); screenshotError = null; break; }
        catch (e) {
          screenshotError = e.message;
          broadcast?.({ t: Date.now(), type: 'gbooks_manual', msg: `screenshot tentativa ${attempt} falhou: ${e.message.slice(0, 100)}`, err: true });
          await page.waitForTimeout(2000);
        }
      }
      if (screenshotError) { abortReason = 'erro screenshot (2 tentativas): ' + screenshotError; break; }

      if (!b64) {
        sameHashCount++;
        if (sameHashCount >= END_OF_BOOK_THRESHOLD) {
          const startPg = isResume ? prevState.lastPage : 0;
          if (currentPage - startPg === 0) {
            completed = false;
            abortReason = 'tela parada — 0 págs extraídas nessa sessão';
          } else {
            completed = true;
            abortReason = `fim do livro (${END_OF_BOOK_THRESHOLD} screenshots vazios)`;
          }
          break;
        }
        await page.keyboard.press('ArrowRight');
        await page.waitForTimeout(800);
        continue;
      }

      const hash = hashB64(b64);
      if (hash === prevHash) {
        sameHashCount++;
        if (sameHashCount >= END_OF_BOOK_THRESHOLD) {
          const startPg = isResume ? prevState.lastPage : 0;
          if (currentPage - startPg === 0) {
            completed = false;
            abortReason = 'tela parada — 0 págs extraídas nessa sessão';
          } else {
            completed = true;
            abortReason = `fim do livro (${END_OF_BOOK_THRESHOLD} imagens iguais)`;
          }
          break;
        }
        await page.keyboard.press('ArrowRight');
        await page.waitForTimeout(800);
        continue;
      }
      sameHashCount = 0;
      prevHash = hash;

      const pngPath = path.join(bookTmpDir, `p${i}.png`);
      fs.writeFileSync(pngPath, Buffer.from(b64, 'base64'));
      const newOCR = ocrPNG(pngPath);
      const newMeta = { page: i, hash };

      await finalizeOCR();

      pendingOCR = newOCR;
      pendingMeta = newMeta;
      currentPage = i;

      await page.keyboard.press('ArrowRight');
    }

    await finalizeOCR();
    if (!completed && !abortReason && currentPage >= maxPages) {
      abortReason = `atingiu maxPages (${maxPages})`;
    }
  } catch (e) {
    abortReason = 'erro: ' + e.message;
    try { await finalizeOCR(); } catch {}
  }

  out.end();

  try {
    for (const f of fs.readdirSync(bookTmpDir)) {
      try { fs.unlinkSync(path.join(bookTmpDir, f)); } catch {}
    }
    fs.rmdirSync(bookTmpDir);
  } catch {}

  fs.writeFileSync(stateFile, JSON.stringify({
    id: bookId, title,
    lastPage: currentPage, totalChars,
    completed, startedAt,
    updatedAt: new Date().toISOString(),
    lastHash: prevHash,
    abortReason: completed ? null : abortReason
  }, null, 2));

  broadcast?.({
    t: Date.now(), type: 'book_end', source: 'gbooks',
    id: bookId, asin: bookId, title, idx: 1, total: 1,
    completed, lastPage: currentPage, totalChars,
    abortReason: completed ? null : abortReason
  });

  captureActive = false;
  return { ok: true, completed, lastPage: currentPage, totalChars, abortReason };
}

async function abortCapture() {
  abortRequested = true;
  return { ok: true };
}

// ----- Modo auto: lista a biblioteca e processa um livro de cada vez -----

async function listLibrary(page, broadcast) {
  broadcast?.({ t: Date.now(), type: 'gbooks_manual', msg: '📚 navegando até biblioteca...' });
  if (!/play\.google\.com\/books(?:\?|$|\/?(?:library|$))/.test(page.url())) {
    await page.goto('https://play.google.com/books', { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(5000);
  }

  broadcast?.({ t: Date.now(), type: 'gbooks_manual', msg: '🔍 listando livros (scroll lento pra Google não bloquear)...' });
  const seen = new Map();
  let stableRounds = 0;
  for (let round = 0; round < 40; round++) {
    const before = seen.size;
    const items = await page.evaluate(() => {
      const out = [];
      document.querySelectorAll('a[href*="/books/reader"]').forEach(a => {
        try {
          const u = new URL(a.href, location.origin);
          const id = u.searchParams.get('id');
          if (!id) return;
          let title = a.getAttribute('aria-label') || a.getAttribute('title') || '';
          if (!title) {
            const img = a.querySelector('img[alt]');
            if (img) title = img.alt || '';
          }
          if (!title) {
            const parent = a.closest('[role="listitem"], li, [class*="card"]');
            if (parent) {
              const t = parent.querySelector('[class*="title"], h3, h4');
              if (t) title = (t.innerText || t.textContent || '').trim();
            }
          }
          out.push({ id, title: title.trim() });
        } catch {}
      });
      return out;
    });
    for (const it of items) {
      if (!seen.has(it.id) || (it.title && !seen.get(it.id).title)) seen.set(it.id, it);
    }
    if (seen.size === before) {
      stableRounds++;
      if (stableRounds >= 4) break;
    } else stableRounds = 0;

    await page.evaluate(() => {
      window.scrollTo(0, document.body.scrollHeight);
      const cs = document.querySelectorAll('[role="main"], main, [class*="library"], [class*="grid"]');
      cs.forEach(c => { c.scrollTop = c.scrollHeight; });
    });
    await page.waitForTimeout(1800);
  }
  const list = [...seen.values()];
  broadcast?.({ t: Date.now(), type: 'gbooks_manual', msg: `📚 ${list.length} livro(s) encontrados na biblioteca` });
  return list;
}

// Espera o reader bootar (texto/canvas/iframe aparece com tamanho real).
async function waitForReaderReady(page, timeoutMs = 45000) {
  try {
    await page.waitForFunction(() => {
      const sels = ['iframe', '[role="main"] canvas', '[role="main"] img', '[class*="page"]'];
      for (const sel of sels) {
        const el = document.querySelector(sel);
        if (el) {
          const r = el.getBoundingClientRect();
          if (r.width > 100 && r.height > 100) return true;
        }
      }
      const main = document.querySelector('[role="main"]');
      return main && main.innerHTML.length > 2000;
    }, { timeout: timeoutMs });
    return true;
  } catch { return false; }
}

// Volta o reader pro início do livro (similar ao kindle: Home + ArrowLeft em loop
// até a página não mudar mais).
async function goToBookStart(page, broadcast) {
  broadcast?.({ t: Date.now(), type: 'gbooks_manual', msg: '⮜ indo pra primeira página...' });
  await page.keyboard.press('Home').catch(() => {});
  await page.waitForTimeout(1500);

  let prevHash = '';
  let stable = 0;
  let i;
  for (i = 0; i < 1500; i++) {
    await page.keyboard.press('ArrowLeft');
    await page.waitForTimeout(180);
    if (i % 12 === 11) {
      await page.waitForTimeout(300);
      const probe = await capturePagePNG(page).catch(() => null);
      const h = probe ? hashB64(probe) : '';
      if (h && h === prevHash) {
        stable++;
        if (stable >= 2) break;
      } else {
        stable = 0;
        prevHash = h;
      }
    }
  }
  await page.waitForTimeout(1500);
  return i + 1;
}

// Loop de captura compartilhado entre captureCurrent (uma aba) e captureAll (todos).
// Recebe a página já posicionada no reader, no início do livro.
async function runCaptureLoop(page, { bookId, title, broadcast, settings = {}, prevState = null, idx = 1, total = 1 }) {
  ensureDirs();
  const fileBase = safeFileName(title);
  const outFile = path.join(OUTPUT_DIR, `${fileBase}.txt`);
  const stateFile = path.join(OUTPUT_DIR, `${fileBase}.state.json`);
  const bookTmpDir = path.join(TMP_DIR, fileBase);
  fs.mkdirSync(bookTmpDir, { recursive: true });

  const isResume = prevState && prevState.lastPage > 0 && !prevState.completed;
  const startedAt = (prevState && prevState.startedAt) || new Date().toISOString();
  const tStart = Date.now();

  if (isResume) {
    broadcast?.({ t: Date.now(), type: 'gbooks_manual', msg: `↻ Retomando "${title}" da pág ${prevState.lastPage}` });
  }

  broadcast?.({
    t: Date.now(), type: 'book_start', source: 'gbooks',
    id: bookId, asin: bookId, title, idx, total,
    resume: isResume, startFromPage: isResume ? prevState.lastPage : 0,
    file: path.basename(outFile)
  });

  const out = fs.createWriteStream(outFile, { flags: isResume ? 'a' : 'w' });
  const maxPages = settings.maxPages || 10000;
  const END_OF_BOOK_THRESHOLD = 5;

  let currentPage = isResume ? prevState.lastPage : 0;
  let totalChars = (prevState && prevState.totalChars) || 0;
  let prevHash = '';
  let sameHashCount = 0;
  let completed = false;
  let abortReason = null;

  let pendingOCR = null;
  let pendingMeta = null;

  const finalizeOCR = async () => {
    if (!pendingOCR) return;
    const result = await pendingOCR;
    pendingOCR = null;
    const meta = pendingMeta;
    pendingMeta = null;
    if (!result.ok) return;
    const text = cleanText(cleanGbooksPage(result.text));
    out.write(text + '\n\n');
    totalChars += text.length + 2;
    const elapsed = (Date.now() - tStart) / 1000;
    const startPage = isResume ? prevState.lastPage : 0;
    const rate = elapsed > 0 ? (meta.page - startPage) / elapsed : 0;
    broadcast?.({
      t: Date.now(), type: 'page', source: 'gbooks',
      id: bookId, asin: bookId,
      page: meta.page, totalChars, rate, elapsed,
      preview: text.replace(/\s+/g, ' ').slice(0, 280),
      addedChars: text.length
    });
    fs.writeFileSync(stateFile, JSON.stringify({
      id: bookId, title,
      lastPage: meta.page, totalChars,
      completed: false, startedAt,
      updatedAt: new Date().toISOString(),
      lastHash: meta.hash
    }, null, 2));
  };

  try {
    for (let i = currentPage + 1; i <= maxPages; i++) {
      if (abortRequested) { abortReason = 'abortado pelo usuário'; break; }
      await page.waitForTimeout(settings.pageDelayMs || 1500);

      let b64 = null;
      let screenshotError = null;
      for (let attempt = 1; attempt <= 2; attempt++) {
        try { b64 = await capturePagePNG(page); screenshotError = null; break; }
        catch (e) {
          screenshotError = e.message;
          broadcast?.({ t: Date.now(), type: 'gbooks_manual', msg: `screenshot tentativa ${attempt} falhou: ${e.message.slice(0, 100)}`, err: true });
          await page.waitForTimeout(2000);
        }
      }
      if (screenshotError) { abortReason = 'erro screenshot (2x): ' + screenshotError; break; }

      if (!b64) {
        sameHashCount++;
        if (sameHashCount >= END_OF_BOOK_THRESHOLD) {
          const startPg = isResume ? prevState.lastPage : 0;
          if (currentPage - startPg === 0) {
            completed = false;
            abortReason = 'tela parada — 0 págs extraídas nessa sessão';
          } else {
            completed = true;
            abortReason = `fim (${END_OF_BOOK_THRESHOLD} screenshots vazios)`;
          }
          break;
        }
        await page.keyboard.press('ArrowRight');
        await page.waitForTimeout(800);
        continue;
      }

      const hash = hashB64(b64);
      if (hash === prevHash) {
        sameHashCount++;
        if (sameHashCount >= END_OF_BOOK_THRESHOLD) {
          const startPg = isResume ? prevState.lastPage : 0;
          if (currentPage - startPg === 0) {
            completed = false;
            abortReason = 'tela parada — 0 págs extraídas nessa sessão';
          } else {
            completed = true;
            abortReason = `fim do livro (${END_OF_BOOK_THRESHOLD} imagens iguais)`;
          }
          break;
        }
        await page.keyboard.press('ArrowRight');
        await page.waitForTimeout(800);
        continue;
      }
      sameHashCount = 0;
      prevHash = hash;

      const pngPath = path.join(bookTmpDir, `p${i}.png`);
      fs.writeFileSync(pngPath, Buffer.from(b64, 'base64'));
      const newOCR = ocrPNG(pngPath);
      const newMeta = { page: i, hash };

      await finalizeOCR();
      pendingOCR = newOCR;
      pendingMeta = newMeta;
      currentPage = i;

      await page.keyboard.press('ArrowRight');
    }
    await finalizeOCR();
    if (!completed && !abortReason && currentPage >= maxPages) {
      abortReason = `atingiu maxPages (${maxPages})`;
    }
  } catch (e) {
    abortReason = 'erro: ' + e.message;
    try { await finalizeOCR(); } catch {}
  }

  out.end();
  try {
    for (const f of fs.readdirSync(bookTmpDir)) { try { fs.unlinkSync(path.join(bookTmpDir, f)); } catch {} }
    fs.rmdirSync(bookTmpDir);
  } catch {}

  fs.writeFileSync(stateFile, JSON.stringify({
    id: bookId, title,
    lastPage: currentPage, totalChars,
    completed, startedAt,
    updatedAt: new Date().toISOString(),
    lastHash: prevHash,
    abortReason: completed ? null : abortReason
  }, null, 2));

  broadcast?.({
    t: Date.now(), type: 'book_end', source: 'gbooks',
    id: bookId, asin: bookId, title, idx, total,
    completed, lastPage: currentPage, totalChars,
    abortReason: completed ? null : abortReason
  });

  return { ok: true, completed, lastPage: currentPage, totalChars, abortReason };
}

async function captureAll({ broadcast, settings = {}, skipCompleted = true } = {}) {
  if (!browser) throw new Error('não conectado — clique em Conectar primeiro');
  if (captureActive) throw new Error('já capturando');

  captureActive = true;
  abortRequested = false;

  try {
    const pages = context.pages();
    let page = pages.find(p => /play\.google\.com\/books/.test(p.url())) || pages[0];
    if (!page) page = await context.newPage();

    const library = await listLibrary(page, broadcast);
    if (library.length === 0) {
      throw new Error('nenhum livro encontrado na biblioteca');
    }

    const extracted = listExtractedBooks();
    const doneIds = new Set(extracted.filter(b => b.state?.completed).map(b => b.id));
    const toProcess = skipCompleted ? library.filter(b => !doneIds.has(b.id)) : library;
    const skipped = library.length - toProcess.length;

    broadcast?.({
      t: Date.now(), type: 'gbooks_manual',
      msg: `▶ Capturar TODOS: ${toProcess.length} livro(s)${skipped > 0 ? ` (${skipped} já completos, pulados)` : ''}`
    });
    broadcast?.({ t: Date.now(), type: 'run_start', source: 'gbooks', total: toProcess.length });

    for (let i = 0; i < toProcess.length; i++) {
      if (abortRequested) {
        broadcast?.({ t: Date.now(), type: 'gbooks_manual', msg: 'abortado pelo usuário entre livros' });
        break;
      }
      const book = toProcess[i];

      try {
        // Garante que tá na biblioteca pra clicar no link do livro
        if (!/play\.google\.com\/books(?:\?|$|\/?(?:library|$))/.test(page.url())) {
          broadcast?.({ t: Date.now(), type: 'gbooks_manual', msg: '↩ voltando pra biblioteca' });
          await page.goto('https://play.google.com/books', { waitUntil: 'domcontentloaded', timeout: 60000 });
          await page.waitForTimeout(4000);
        }

        // Scroll até achar o link e clica nele (mais "natural" que goto pro reader)
        const clicked = await page.evaluate((id) => {
          const link = document.querySelector(`a[href*="reader?id=${id}"]`) ||
                       document.querySelector(`a[href*="id=${id}"]`);
          if (!link) return false;
          link.scrollIntoView({ block: 'center' });
          link.click();
          return true;
        }, book.id);

        if (!clicked) {
          broadcast?.({ t: Date.now(), type: 'gbooks_manual', msg: `⚠ link do livro ${book.id} não achado, indo direto pelo URL`, err: true });
          await page.goto(`https://play.google.com/books/reader?id=${encodeURIComponent(book.id)}&hl=pt-BR`, { waitUntil: 'domcontentloaded', timeout: 60000 });
        }

        broadcast?.({ t: Date.now(), type: 'gbooks_manual', msg: `[${i+1}/${toProcess.length}] ⏳ abrindo "${book.title || book.id}"` });
        const ready = await waitForReaderReady(page, 60000);
        if (!ready) {
          throw new Error('reader não bootou em 60s (página em branco?)');
        }
        await page.waitForTimeout(4000);

        await goToBookStart(page, broadcast);

        const fileBase = safeFileName(book.title || book.id);
        const stateFile = path.join(OUTPUT_DIR, `${fileBase}.state.json`);
        const prevState = loadStateFile(stateFile);

        // Se é retomada (livro parcial), avança até onde paramos antes de
        // iniciar a captura — goToBookStart deixou na pág 1.
        if (prevState && prevState.lastPage > 0 && !prevState.completed) {
          broadcast?.({
            t: Date.now(), type: 'gbooks_manual',
            msg: `↻ avançando ${prevState.lastPage} págs (retomada)...`
          });
          for (let j = 0; j < prevState.lastPage; j++) {
            if (abortRequested) break;
            await page.keyboard.press('ArrowRight');
            await page.waitForTimeout(220);
          }
          await page.waitForTimeout(2500);
        }

        await runCaptureLoop(page, {
          bookId: book.id,
          title: book.title || book.id,
          broadcast, settings, prevState,
          idx: i + 1, total: toProcess.length
        });

        // Pequena pausa entre livros (parecer mais humano)
        await page.waitForTimeout(3000);
      } catch (e) {
        broadcast?.({
          t: Date.now(), type: 'book_error', source: 'gbooks',
          id: book.id, title: book.title, error: e.message
        });
        broadcast?.({ t: Date.now(), type: 'gbooks_manual', msg: `⚠ ${book.title || book.id}: ${e.message} — pulando`, err: true });
      }
    }

    broadcast?.({ t: Date.now(), type: 'run_end', source: 'gbooks' });
    return { ok: true, total: toProcess.length, skipped };
  } finally {
    captureActive = false;
  }
}

async function disconnect() {
  if (browser) { try { await browser.close(); } catch {} } // CDP close apenas desconecta
  browser = null;
  context = null;
  return { ok: true };
}

async function closeChrome() {
  await disconnect();
  if (chromeProcess && !chromeProcess.killed) {
    try { chromeProcess.kill('SIGTERM'); } catch {}
    setTimeout(() => { if (chromeProcess) try { chromeProcess.kill('SIGKILL'); } catch {} }, 2000);
  }
  chromeProcess = null;
  return { ok: true };
}

// Lista livros do Google Books extraídos (baseado em output/gbooks_*.state.json).
// Não precisa mais de gbooks-config.json — biblioteca é descoberta dinamicamente.
function listExtractedBooks() {
  if (!fs.existsSync(OUTPUT_DIR)) return [];
  const out = [];
  for (const f of fs.readdirSync(OUTPUT_DIR)) {
    if (!f.startsWith('gbooks_') || !f.endsWith('.state.json')) continue;
    try {
      const state = JSON.parse(fs.readFileSync(path.join(OUTPUT_DIR, f), 'utf-8'));
      const fileBase = f.replace(/\.state\.json$/, '');
      out.push({
        source: 'gbooks',
        key: state.id || fileBase,
        id: state.id || fileBase,
        title: state.title || fileBase,
        author: state.author || '',
        fileBase,
        fileName: fileBase + '.txt',
        hasFile: fs.existsSync(path.join(OUTPUT_DIR, fileBase + '.txt')),
        txtSize: fs.existsSync(path.join(OUTPUT_DIR, fileBase + '.txt')) ? fs.statSync(path.join(OUTPUT_DIR, fileBase + '.txt')).size : 0,
        state
      });
    } catch {}
  }
  return out;
}

module.exports = {
  launchChrome, connect, status, captureCurrent, captureAll, abortCapture, disconnect, closeChrome,
  listExtractedBooks
};
