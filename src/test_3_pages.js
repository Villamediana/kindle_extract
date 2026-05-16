// Compara dois métodos em 3 páginas:
//  A) Ctrl+A + Ctrl+C (seleção/clipboard)
//  B) Canvas → PNG → Tesseract OCR
//
// Salva ambos resultados em debug/test3/ pra comparação

const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const SESSION_DIR = path.join(ROOT, 'session');
const COOKIES_PATH = path.join(ROOT, 'cookies.json');
const OUT_DIR = path.join(ROOT, 'debug', 'test3');

const ASIN = process.argv[2] || 'B0752X3H64';

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

async function capturePageImage(page) {
  // Extrai PNG da página via canvas (mesma técnica do probe_blob.js)
  return await page.evaluate(async () => {
    const img = document.querySelector('.kg-full-page-img img') || document.querySelector('img[src^="blob:"]');
    if (!img) return null;
    const c = document.createElement('canvas');
    c.width = img.naturalWidth || 1120;
    c.height = img.naturalHeight || 750;
    c.getContext('2d').drawImage(img, 0, 0);
    const dataUrl = c.toDataURL('image/png');
    return dataUrl.split(',')[1]; // base64
  });
}

async function trySelectAndCopy(page, context) {
  // método 1: Ctrl+A + Ctrl+C
  await page.keyboard.press('Control+A');
  await page.waitForTimeout(400);
  await page.keyboard.press('Control+C');
  await page.waitForTimeout(400);

  // tenta ler clipboard
  try {
    const clip = await page.evaluate(async () => {
      try { return await navigator.clipboard.readText(); }
      catch (e) { return '__ERR__: ' + e.message; }
    });
    if (clip && !clip.startsWith('__ERR__')) return { ok: true, text: clip, method: 'clipboard' };
  } catch {}

  // método 2: window.getSelection() depois de Ctrl+A
  const sel = await page.evaluate(() => {
    const s = window.getSelection();
    return s ? s.toString() : '';
  });
  if (sel && sel.length > 20) return { ok: true, text: sel, method: 'getSelection' };

  // método 3: tenta nos iframes
  for (const f of page.frames()) {
    try {
      const t = await f.evaluate(() => {
        const s = window.getSelection();
        return s ? s.toString() : '';
      });
      if (t && t.length > 20) return { ok: true, text: t, method: 'frame-getSelection' };
    } catch {}
  }

  return { ok: false, text: '', method: 'none' };
}

function runOCR(pngPath, lang = 'por') {
  const t0 = Date.now();
  const base = pngPath.replace(/\.png$/, '');
  const r = spawnSync('tesseract', [pngPath, base, '-l', lang, '--psm', '6'], { encoding: 'utf-8' });
  const dt = Date.now() - t0;
  if (r.status !== 0) return { ok: false, error: r.stderr, ms: dt };
  const txt = fs.readFileSync(base + '.txt', 'utf-8');
  return { ok: true, text: txt, ms: dt };
}

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });

  // permissão clipboard
  let context, browser;
  if (fs.existsSync(SESSION_DIR) && fs.readdirSync(SESSION_DIR).length > 0) {
    context = await chromium.launchPersistentContext(SESSION_DIR, {
      headless: true,
      viewport: { width: 1400, height: 900 },
      permissions: ['clipboard-read', 'clipboard-write']
    });
  } else {
    browser = await chromium.launch({ headless: true });
    context = await browser.newContext({
      viewport: { width: 1400, height: 900 },
      permissions: ['clipboard-read', 'clipboard-write']
    });
    const cookies = JSON.parse(fs.readFileSync(COOKIES_PATH, 'utf-8')).map(normalizeCookie);
    await context.addCookies(cookies);
  }
  try { await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: 'https://read.amazon.com' }); } catch {}

  const page = await context.newPage();
  console.log(`abrindo ${ASIN}…`);
  await page.goto(`https://read.amazon.com/?asin=${ASIN}`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(8000);
  await page.click('body').catch(() => {});
  await page.waitForTimeout(2000);

  // avança umas páginas iniciais pra entrar em conteúdo real
  for (let i = 0; i < 5; i++) {
    await page.keyboard.press('ArrowRight');
    await page.waitForTimeout(1500);
  }

  for (let p = 1; p <= 3; p++) {
    console.log(`\n=== PÁGINA ${p} ===`);
    await page.waitForTimeout(1500);

    // método A: ctrl+c
    const sel = await trySelectAndCopy(page, context);
    console.log(`  [Ctrl+C] ok=${sel.ok}, método=${sel.method}, chars=${sel.text.length}`);
    fs.writeFileSync(path.join(OUT_DIR, `p${p}_clipboard.txt`),
      `[método: ${sel.method}, ok: ${sel.ok}]\n\n` + sel.text);

    // método B: canvas + ocr
    const b64 = await capturePageImage(page);
    if (b64) {
      const pngPath = path.join(OUT_DIR, `p${p}.png`);
      fs.writeFileSync(pngPath, Buffer.from(b64, 'base64'));
      const stat = fs.statSync(pngPath);
      const ocr = runOCR(pngPath);
      console.log(`  [OCR] png=${stat.size}b, ocr=${ocr.ok ? 'OK' : 'FAIL'}, chars=${ocr.text?.length || 0}, tempo=${ocr.ms}ms`);
      if (ocr.ok) fs.writeFileSync(path.join(OUT_DIR, `p${p}_ocr.txt`), ocr.text);
    } else {
      console.log(`  [OCR] nenhuma imagem encontrada`);
    }

    // limpa seleção e vira página
    await page.keyboard.press('ArrowRight');
    await page.waitForTimeout(1500);
  }

  await context.close();
  if (browser) await browser.close();
  console.log(`\n→ resultados em ${OUT_DIR}`);
}

main().catch(e => { console.error(e); process.exit(1); });
