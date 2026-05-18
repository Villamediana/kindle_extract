const { chromium } = require('playwright');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { cleanText } = require('./clean');
const { resolveTesseractCmd } = require('./setup-helpers');

const TESSERACT_CMD = resolveTesseractCmd();

const ROOT = path.join(__dirname, '..');
const SESSION_DIR = path.join(ROOT, 'session');
const OUTPUT_DIR = path.join(ROOT, 'output');
const SHOTS_DIR = path.join(ROOT, 'screenshots');
const TMP_DIR = path.join(ROOT, 'tmp_ocr');
const CONFIG_PATH = process.env.CONFIG_PATH || path.join(ROOT, 'config.json');
const COOKIES_PATH = path.join(ROOT, 'cookies.json');

function loadConfig() {
  if (!fs.existsSync(CONFIG_PATH)) {
    console.error('Falta config.json.');
    process.exit(1);
  }
  return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
}

function ensureDirs() {
  for (const d of [OUTPUT_DIR, SHOTS_DIR, TMP_DIR]) {
    if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
  }
}

function normalizeCookie(c) {
  const out = { name: c.name, value: c.value, domain: c.domain, path: c.path || '/', httpOnly: !!c.httpOnly, secure: !!c.secure };
  if (c.expirationDate) out.expires = Math.floor(Number(c.expirationDate));
  let ss = (c.sameSite || '').toString().toLowerCase();
  if (ss === 'no_restriction' || ss === 'none' || ss === 'unspecified') ss = 'None';
  else if (ss === 'lax') ss = 'Lax';
  else if (ss === 'strict') ss = 'Strict';
  else ss = 'Lax';
  out.sameSite = ss;
  return out;
}

function safeFileName(s) {
  return s.replace(/[^a-z0-9_\-]+/gi, '_').slice(0, 80);
}

function fmtBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}

const JSON_EVENTS = process.env.JSON_EVENTS === '1';

function emit(type, data) {
  if (!JSON_EVENTS) return;
  process.stdout.write(JSON.stringify({ t: Date.now(), type, ...data }) + '\n');
}

function log(...args) {
  if (JSON_EVENTS) emit('log', { msg: args.join(' ') });
  else console.log(...args);
}

function progressLine(s) {
  if (JSON_EVENTS) return;
  const cols = process.stdout.columns || 100;
  const trimmed = s.length > cols - 1 ? s.slice(0, cols - 4) + '...' : s.padEnd(cols - 1);
  process.stdout.write('\r' + trimmed);
}

async function turnPage(page) {
  await page.keyboard.press('ArrowRight');
}

async function turnPageBack(page) {
  await page.keyboard.press('ArrowLeft');
}

// Kindle Cloud Reader abre o livro na última posição lida pelo usuário, não na pág 1.
// Esta função força o reader a voltar até o início (detectado quando o hash da imagem
// para de mudar — i.e., ArrowLeft em loop não muda mais a página).
async function goToStart(page) {
  // Tenta atalho Home primeiro (alguns clients aceitam)
  await page.keyboard.press('Home').catch(() => {});
  await page.waitForTimeout(1500);

  let prevHash = '';
  let stable = 0;
  let i;
  for (i = 0; i < 2000; i++) {
    await turnPageBack(page);
    await page.waitForTimeout(180);

    if (i % 15 === 14) {
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

function loadState(stateFile) {
  if (!fs.existsSync(stateFile)) return null;
  try { return JSON.parse(fs.readFileSync(stateFile, 'utf-8')); }
  catch { return null; }
}

function saveState(stateFile, state) {
  fs.writeFileSync(stateFile, JSON.stringify(state, null, 2));
}

// --- Página: espera blob image carregar e captura PNG via canvas ---

async function waitPageImageReady(page, timeoutMs = 8000) {
  try {
    await page.waitForFunction(() => {
      const img = document.querySelector('.kg-full-page-img img[src^="blob:"]') ||
                  document.querySelector('img[src^="blob:"]');
      return img && img.complete && img.naturalWidth > 100 && img.naturalHeight > 100;
    }, { timeout: timeoutMs });
    return true;
  } catch {
    return false;
  }
}

async function capturePagePNG(page) {
  return await page.evaluate(async () => {
    const img = document.querySelector('.kg-full-page-img img[src^="blob:"]') ||
                document.querySelector('img[src^="blob:"]');
    if (!img || !img.complete || img.naturalWidth < 100) return null;
    const c = document.createElement('canvas');
    c.width = img.naturalWidth;
    c.height = img.naturalHeight;
    c.getContext('2d').drawImage(img, 0, 0);
    return c.toDataURL('image/png').split(',')[1];
  });
}

// --- OCR ---

function ocrPNG(pngPath, lang = 'por', timeoutMs = 45000) {
  return new Promise((resolve) => {
    const base = pngPath.replace(/\.png$/, '');
    const proc = spawn(TESSERACT_CMD, [pngPath, base, '-l', lang, '--psm', '3', '--oem', '1'],
      { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    proc.stderr.on('data', d => { stderr += d.toString(); });

    const killer = setTimeout(() => { try { proc.kill('SIGKILL'); } catch {} }, timeoutMs);

    proc.on('exit', (code) => {
      clearTimeout(killer);
      const txtPath = base + '.txt';
      let text = '';
      try { text = fs.readFileSync(txtPath, 'utf-8'); } catch {}
      try { fs.unlinkSync(pngPath); } catch {}
      try { fs.unlinkSync(txtPath); } catch {}
      if (code !== 0) return resolve({ ok: false, text: '', error: stderr.slice(0, 200) });
      resolve({ ok: true, text });
    });
    proc.on('error', (e) => {
      clearTimeout(killer);
      resolve({ ok: false, text: '', error: e.message });
    });
  });
}

function hashB64(b64) {
  if (!b64) return '';
  // SHA1 do conteúdo — não precisa criptografia, só identificar imagens iguais
  return crypto.createHash('sha1').update(b64).digest('hex');
}

// --- Extração de um livro com pipeline OCR ---

async function extractBook(context, book, settings, idx, total) {
  const fileBase = safeFileName(book.title || book.asin);
  const outFile = path.join(OUTPUT_DIR, `${fileBase}.txt`);
  const stateFile = path.join(OUTPUT_DIR, `${fileBase}.state.json`);
  const bookTmpDir = path.join(TMP_DIR, fileBase);
  fs.mkdirSync(bookTmpDir, { recursive: true });

  const header = `[${idx}/${total}] ${book.title || book.asin}`;
  if (!JSON_EVENTS) {
    console.log('\n' + '═'.repeat(Math.min(header.length, 80)));
    console.log(header);
    console.log('═'.repeat(Math.min(header.length, 80)));
  }

  let state = loadState(stateFile);
  if (state && state.completed) {
    emit('book_skip', { asin: book.asin, title: book.title, idx, total, lastPage: state.lastPage, totalChars: state.totalChars || 0 });
    log(`  ✓ já concluído (${state.lastPage} págs, ${fmtBytes(state.totalChars || 0)}). Pulando.`);
    return;
  }

  const isResume = state && state.lastPage > 0;
  const startFromPage = isResume ? state.lastPage : 0;

  emit('book_start', {
    asin: book.asin, title: book.title, idx, total,
    resume: isResume, startFromPage, file: path.basename(outFile)
  });

  if (isResume) log(`  ↻ retomando da página ${startFromPage} (${fmtBytes(state.totalChars || 0)} extraídos)`);

  const page = await context.newPage();
  const url = `https://read.amazon.com/?asin=${book.asin}`;
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(7000);
  await page.click('body').catch(() => {});

  // O Kindle abre o livro na última posição lida pelo usuário — força o início.
  if (!JSON_EVENTS) process.stdout.write(`  ⮜ voltando ao início... `);
  const backTurns = await goToStart(page);
  if (!JSON_EVENTS) process.stdout.write(`ok (${backTurns} viradas)\n`);
  emit('book_rewind', { asin: book.asin, backTurns });

  if (isResume && startFromPage > 0) {
    if (!JSON_EVENTS) process.stdout.write(`  avançando ${startFromPage} págs... `);
    // Avanço mais lento — Kindle perde eventos com delays muito curtos em loops longos.
    // Usa delay maior e verifica progresso periodicamente.
    let lastCheckHash = '';
    let stallCount = 0;
    for (let i = 0; i < startFromPage; i++) {
      await turnPage(page);
      await page.waitForTimeout(400);

      // a cada 25 viradas, confere se a página de fato mudou
      if ((i + 1) % 25 === 0 || i === startFromPage - 1) {
        await waitPageImageReady(page, 3000);
        const probe = await capturePagePNG(page).catch(() => null);
        const probeHash = probe ? hashB64(probe) : '';
        if (probeHash && probeHash === lastCheckHash) {
          stallCount++;
          // página travou — espera mais um pouco antes de continuar
          await page.waitForTimeout(1500);
          if (stallCount >= 2) {
            log(`  ⚠ avanço pode ter travado na pág ~${i + 1} — continuando mesmo assim`);
          }
        } else {
          stallCount = 0;
        }
        lastCheckHash = probeHash;
      }
    }
    if (!JSON_EVENTS) process.stdout.write('ok\n');
    await page.waitForTimeout(2500);

    // Sanidade: confere se a página atual bate com o lastHash do state.
    // Se bater, é sinal de que o avanço não pulou nada e estamos vendo a última pág extraída.
    const savedHash = (state && state.lastHash) || '';
    if (savedHash) {
      const probe = await capturePagePNG(page).catch(() => null);
      if (probe) {
        const probeHash = hashB64(probe);
        if (probeHash === savedHash) {
          log(`  ⚠ avanço pode não ter progredido — primeira captura idêntica ao último hash salvo`);
          for (let k = 0; k < 3; k++) {
            await turnPage(page);
            await page.waitForTimeout(800);
          }
        }
      }
    }
  }

  const out = fs.createWriteStream(outFile, { flags: isResume ? 'a' : 'w' });

  const maxPages = book.maxPages || 10000;
  // Threshold de fim de livro: precisa de N capturas com mesmo hash pra considerar fim.
  // Valor alto reduz falsos positivos (ex: render hiccup, página intermediária travada).
  const END_OF_BOOK_THRESHOLD = 5;
  let currentPage = startFromPage;
  let totalChars = (state && state.totalChars) || 0;
  // Não herda o lastHash do state ao retomar — evita falso positivo se a primeira
  // captura pós-avanço bater com a última extraída antes.
  let prevHash = '';
  let sameHashCount = 0;
  const startedAt = (state && state.startedAt) || new Date().toISOString();
  const tStart = Date.now();

  let completed = false;
  let abortReason = null;

  // Pipeline: OCR roda em paralelo com a virada de página.
  let pendingOCR = null;
  let pendingMeta = null;

  const finalizeOCR = async () => {
    if (!pendingOCR) return;
    const result = await pendingOCR;
    pendingOCR = null;
    const meta = pendingMeta;
    pendingMeta = null;
    if (!result.ok) return null;
    const text = cleanText(result.text);
    out.write(text + '\n\n');
    totalChars += text.length + 2;
    const elapsed = (Date.now() - tStart) / 1000;
    const rate = elapsed > 0 ? (meta.page - startFromPage) / elapsed : 0;
    progressLine(`  pág ${meta.page} | ${fmtBytes(totalChars)} | ${rate.toFixed(2)} pg/s | "${text.replace(/\s+/g,' ').slice(0,40)}"`);
    emit('page', {
      asin: book.asin,
      page: meta.page,
      totalChars,
      rate,
      elapsed,
      preview: text.replace(/\s+/g, ' ').slice(0, 280),
      addedChars: text.length
    });
    saveState(stateFile, {
      asin: book.asin, title: book.title,
      lastPage: meta.page, totalChars,
      completed: false, startedAt,
      updatedAt: new Date().toISOString(),
      lastHash: meta.hash
    });
    return text;
  };

  try {
    for (let i = currentPage + 1; i <= maxPages; i++) {
      // espera a imagem da página atual carregar
      await page.waitForTimeout(settings.pageDelayMs || 1200);
      const ready = await waitPageImageReady(page, 8000);
      if (!ready) {
        // tenta clicar pra dispensar overlay e continuar
        await page.click('body').catch(() => {});
        await page.waitForTimeout(1500);
      }

      const b64 = await capturePagePNG(page);
      if (!b64) {
        sameHashCount++;
        if (sameHashCount >= END_OF_BOOK_THRESHOLD) {
          completed = true;
          abortReason = `fim do livro (sem imagem em ${END_OF_BOOK_THRESHOLD} tentativas)`;
          break;
        }
        await turnPage(page);
        await page.waitForTimeout(800);
        continue;
      }

      const hash = hashB64(b64);
      if (hash === prevHash) {
        sameHashCount++;
        if (sameHashCount >= END_OF_BOOK_THRESHOLD) {
          completed = true;
          abortReason = `fim do livro (${END_OF_BOOK_THRESHOLD} imagens iguais)`;
          break;
        }
        await turnPage(page);
        await page.waitForTimeout(800);
        continue;
      }
      sameHashCount = 0;
      prevHash = hash;

      // dispara OCR async
      const pngPath = path.join(bookTmpDir, `p${i}.png`);
      fs.writeFileSync(pngPath, Buffer.from(b64, 'base64'));
      const newOCR = ocrPNG(pngPath);
      const newMeta = { page: i, hash };

      // antes de virar a página, escreve resultado do OCR anterior (se houver)
      await finalizeOCR();

      pendingOCR = newOCR;
      pendingMeta = newMeta;
      currentPage = i;

      // virar página: o OCR continua rodando em paralelo
      await turnPage(page);
    }

    // drena OCR pendente do último loop
    await finalizeOCR();

    if (!completed && currentPage >= maxPages) {
      abortReason = `atingiu maxPages (${maxPages})`;
    }
  } catch (e) {
    abortReason = `erro: ${e.message}`;
    // tenta drenar o que tiver
    try { await finalizeOCR(); } catch {}
  }

  out.end();
  if (!JSON_EVENTS) process.stdout.write('\n');

  // limpa temp dir do livro
  try {
    for (const f of fs.readdirSync(bookTmpDir)) {
      try { fs.unlinkSync(path.join(bookTmpDir, f)); } catch {}
    }
    fs.rmdirSync(bookTmpDir);
  } catch {}

  saveState(stateFile, {
    asin: book.asin, title: book.title,
    lastPage: currentPage, totalChars,
    completed, startedAt,
    updatedAt: new Date().toISOString(),
    lastHash: prevHash,
    abortReason: completed ? null : abortReason
  });

  emit('book_end', {
    asin: book.asin, title: book.title, idx, total,
    completed, lastPage: currentPage, totalChars,
    abortReason: completed ? null : abortReason
  });

  if (completed) log(`  ✓ concluído: ${currentPage} págs, ${fmtBytes(totalChars)}`);
  else log(`  ⚠ parado: ${abortReason || 'desconhecido'} (pág ${currentPage})`);

  await page.close();
}

async function main() {
  ensureDirs();
  const config = loadConfig();

  let context, browser;
  if (fs.existsSync(SESSION_DIR) && fs.readdirSync(SESSION_DIR).length > 0) {
    context = await chromium.launchPersistentContext(SESSION_DIR, {
      headless: !!config.settings.headless,
      viewport: { width: 1400, height: 900 },
      locale: 'pt-BR'
    });
  } else if (fs.existsSync(COOKIES_PATH)) {
    browser = await chromium.launch({ headless: !!config.settings.headless });
    context = await browser.newContext({ viewport: { width: 1400, height: 900 }, locale: 'pt-BR' });
    const cookies = JSON.parse(fs.readFileSync(COOKIES_PATH, 'utf-8')).map(normalizeCookie);
    await context.addCookies(cookies);
  } else {
    console.error('Sem sessão e sem cookies.json. Rode primeiro: npm run import-cookies');
    process.exit(1);
  }

  const total = config.books.length;
  emit('run_start', { total });
  log(`Total de livros no config: ${total}`);

  for (let i = 0; i < total; i++) {
    try {
      await extractBook(context, config.books[i], config.settings, i + 1, total);
    } catch (e) {
      emit('book_error', { asin: config.books[i].asin, error: e.message });
      if (!JSON_EVENTS) console.error(`\nErro no livro ${config.books[i].asin}:`, e.message);
    }
  }

  await context.close();
  if (browser) await browser.close();
  emit('run_end', {});
  log('Finalizado.');
}

main().catch(err => {
  console.error('Erro fatal:', err);
  process.exit(1);
});
