// Probe Google Play Books:
// 1) loga via cookies em play.google.com/books
// 2) lista livros da biblioteca
// 3) abre o primeiro e inspeciona a estrutura do reader
// 4) testa Ctrl+A/Ctrl+C, canvas capture, OCR

const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');
const { spawnSync } = require('child_process');

const COOKIES_PATH = process.argv[2] || '/tmp/gpb_cookies.json';
const DEBUG_DIR = path.join(__dirname, '..', 'debug', 'gpb');
fs.mkdirSync(DEBUG_DIR, { recursive: true });

function normalizeCookie(c) {
  const out = { name: c.name, value: c.value, domain: c.domain, path: c.path || '/', httpOnly: !!c.httpOnly, secure: !!c.secure };
  if (c.expirationDate) out.expires = Math.floor(Number(c.expirationDate));
  let ss = (c.sameSite || '').toString().toLowerCase();
  if (ss === 'no_restriction' || ss === 'none' || ss === 'unspecified' || ss === 'null') ss = 'None';
  else if (ss === 'lax') ss = 'Lax';
  else if (ss === 'strict') ss = 'Strict';
  else ss = 'Lax';
  out.sameSite = ss;
  return out;
}

async function main() {
  const raw = JSON.parse(fs.readFileSync(COOKIES_PATH, 'utf-8'));
  const cookies = raw.map(normalizeCookie);

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: 1400, height: 900 },
    locale: 'pt-BR',
    permissions: ['clipboard-read', 'clipboard-write']
  });
  await context.addCookies(cookies);

  const page = await context.newPage();

  // === 1. login check ===
  console.log('--- LOGIN ---');
  await page.goto('https://play.google.com/books', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(5000);
  const url = page.url();
  const title = await page.title().catch(() => '');
  console.log('url final:', url);
  console.log('title:', title);

  await page.screenshot({ path: path.join(DEBUG_DIR, '01_library.png'), fullPage: false });

  // === 2. lista a biblioteca ===
  console.log('\n--- LISTANDO LIVROS (em /books) ---');
  // já estamos em /books (que funciona); só espera mais o JS carregar
  await page.waitForTimeout(5000);
  // tenta scrollar pra carregar tudo
  await page.evaluate(() => window.scrollTo(0, 2000));
  await page.waitForTimeout(2000);
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForTimeout(1500);
  await page.screenshot({ path: path.join(DEBUG_DIR, '02_library_page.png'), fullPage: true });

  const libUrl = page.url();
  console.log('library url:', libUrl);

  // Procura cards de livros — várias estratégias
  const books = await page.evaluate(() => {
    const seen = new Set();
    const add = (id, title, href) => {
      if (!id || seen.has(id)) return;
      seen.add(id);
      return { id, title: (title || '').trim().slice(0, 200), href: href || '' };
    };
    const out = [];

    // 1. anchors com href contendo id
    for (const a of document.querySelectorAll('a[href]')) {
      const m = a.href.match(/[?&]id=([A-Za-z0-9_-]+)/);
      if (m && /(reader|details|ebooks|store\/books)/i.test(a.href)) {
        const r = add(m[1], a.textContent || a.getAttribute('aria-label') || '', a.href);
        if (r) out.push(r);
      }
    }

    // 2. data attributes
    for (const el of document.querySelectorAll('[data-id], [data-book-id], [data-item-id]')) {
      const id = el.getAttribute('data-id') || el.getAttribute('data-book-id') || el.getAttribute('data-item-id');
      if (id && id.length >= 8 && id.length <= 20) {
        const title = el.getAttribute('aria-label') || el.textContent || '';
        const r = add(id, title, '');
        if (r) out.push(r);
      }
    }

    // 3. busca por padrões no HTML inteiro: id de livro Google é tipicamente 12 chars (ex "WkVxCgAAQBAJ")
    const html = document.documentElement.outerHTML;
    const idsMatch = html.match(/\b[A-Za-z0-9_-]{12}\b/g) || [];
    const seenIds = {};
    for (const id of idsMatch) {
      seenIds[id] = (seenIds[id] || 0) + 1;
    }
    // pega IDs que aparecem >= 2x
    const candidates = Object.entries(seenIds).filter(([_, n]) => n >= 2).map(([id]) => id);
    return { detected: out, htmlSize: html.length, idCandidates: candidates.slice(0, 30) };
  });
  console.log('detectados via DOM:', books.detected.length);
  for (const b of books.detected.slice(0, 8)) {
    console.log(`  ${b.id}: "${b.title.slice(0, 80)}"`);
  }
  console.log('id candidates (regex no HTML, top 30):', books.idCandidates);
  console.log('html size:', books.htmlSize);

  // dump HTML pra inspeção
  const libHtml = await page.content();
  fs.writeFileSync(path.join(DEBUG_DIR, '02_library.html'), libHtml);

  const target = books.detected[0] || (books.idCandidates[0] ? { id: books.idCandidates[0], title: '?' } : null);
  if (!target) {
    console.log('\n[!] Sem candidato de livro. Veja debug/gpb/02_library.html');
    await browser.close();
    return;
  }
  console.log(`\n--- ABRINDO LIVRO ${target.id} ---`);
  await page.goto(`https://play.google.com/books/reader?id=${target.id}`, { waitUntil: 'domcontentloaded' });

  // espera carregar de verdade — pode levar 20-30s
  console.log('aguardando reader carregar (até 35s)...');
  for (let i = 0; i < 35; i++) {
    await page.waitForTimeout(1000);
    const hasContent = await page.evaluate(() => {
      let signs = 0;
      signs += document.querySelectorAll('canvas, img[src^="blob:"], img[src^="data:image"]').length;
      signs += (document.body?.innerText || '').length > 500 ? 1 : 0;
      try {
        for (let f = 0; f < window.frames.length; f++) {
          const d = window.frames[f].document;
          signs += d.querySelectorAll('canvas, img').length;
          signs += (d.body?.innerText || '').length > 500 ? 1 : 0;
        }
      } catch {}
      return signs;
    });
    if (hasContent > 0) { console.log(`  conteúdo detectado em ${i+1}s (sinais=${hasContent})`); break; }
  }

  await page.click('body').catch(() => {});
  await page.waitForTimeout(2000);
  // tenta avançar 1 página pra sair da capa
  await page.keyboard.press('ArrowRight').catch(() => {});
  await page.waitForTimeout(4000);

  await page.screenshot({ path: path.join(DEBUG_DIR, '03_reader_initial.png'), fullPage: false });

  // inspeciona TODOS os frames
  console.log('\n--- TODOS OS FRAMES ---');
  for (const f of page.frames()) {
    try {
      const info = await f.evaluate(() => ({
        url: location.href,
        bodyTextLen: (document.body?.innerText || '').length,
        bodyTextPreview: (document.body?.innerText || '').slice(0, 300),
        canvases: document.querySelectorAll('canvas').length,
        canvasSizes: [...document.querySelectorAll('canvas')].map(c => `${c.width}x${c.height}`),
        imgs: document.querySelectorAll('img').length,
        blobImgs: document.querySelectorAll('img[src^="blob:"]').length,
        svgs: document.querySelectorAll('svg').length,
        bigSvgs: [...document.querySelectorAll('svg')].filter(s => s.getBoundingClientRect().width > 200).length,
        svgTextNodes: document.querySelectorAll('svg text').length,
        divsWithText: [...document.querySelectorAll('div, p, span')].filter(e => (e.innerText||'').trim().length > 100).length
      }));
      console.log(`  frame ${info.url.slice(0,80)}`);
      console.log(`    body=${info.bodyTextLen}ch canvas=${info.canvases}${info.canvases ? ' ('+info.canvasSizes.join(',')+')' : ''} img=${info.imgs} blob=${info.blobImgs} svg=${info.svgs} svgBig=${info.bigSvgs} svgText=${info.svgTextNodes} bigDivs=${info.divsWithText}`);
      if (info.bodyTextLen > 0) console.log(`    preview: "${info.bodyTextPreview.replace(/\s+/g,' ').slice(0,200)}"`);
    } catch (e) {
      console.log(`  frame [erro: ${e.message}]`);
    }
  }

  // === 4. inspeciona estrutura ===
  console.log('\n--- INSPEÇÃO DOM ---');
  const dom = await page.evaluate(() => {
    const out = {
      url: location.href,
      title: document.title,
      bodyText: (document.body?.innerText || '').slice(0, 300),
      bodyTextLen: (document.body?.innerText || '').length,
      frames: window.frames.length,
      iframes: document.querySelectorAll('iframe').length,
      canvases: document.querySelectorAll('canvas').length,
      imgs: 0,
      imgsBlob: 0,
      imgsData: 0,
      sample: {}
    };
    const imgs = document.querySelectorAll('img');
    out.imgs = imgs.length;
    for (const img of imgs) {
      if (img.src && img.src.startsWith('blob:')) out.imgsBlob++;
      if (img.src && img.src.startsWith('data:')) out.imgsData++;
    }
    // procura por elementos com IDs/classes suspeitos
    const sels = ['.gb-page-content', '.text-content', '#viewport', '.book-page', '.flow-content', '[data-page-index]', '#book-content', 'main', '[role="main"]'];
    for (const sel of sels) {
      const e = document.querySelectorAll(sel);
      if (e.length) {
        out.sample[sel] = {
          count: e.length,
          firstText: (e[0].innerText || '').slice(0, 100),
          firstTextLen: (e[0].innerText || '').length
        };
      }
    }
    return out;
  });
  console.log(JSON.stringify(dom, null, 2));

  // dump HTML do reader
  const html = await page.content();
  fs.writeFileSync(path.join(DEBUG_DIR, '03_reader.html'), html);
  console.log('html dump:', html.length, 'chars');

  // === 5. testa Ctrl+A + Ctrl+C ===
  console.log('\n--- TESTE Ctrl+A + Ctrl+C ---');
  await page.keyboard.press('Control+A');
  await page.waitForTimeout(400);
  await page.keyboard.press('Control+C');
  await page.waitForTimeout(400);
  try {
    const clip = await page.evaluate(() => navigator.clipboard.readText().catch(e => '__ERR__' + e.message));
    console.log('clipboard:', clip.length > 0 ? `${clip.length} chars` : '(vazio)');
    if (clip && !clip.startsWith('__ERR__')) {
      console.log('preview:', clip.slice(0, 300));
      fs.writeFileSync(path.join(DEBUG_DIR, '04_clipboard.txt'), clip);
    } else {
      console.log('erro:', clip);
    }
  } catch (e) { console.log('clipboard fail:', e.message); }

  const sel = await page.evaluate(() => window.getSelection()?.toString() || '');
  console.log('getSelection:', sel.length, 'chars');
  if (sel.length > 100) fs.writeFileSync(path.join(DEBUG_DIR, '04_selection.txt'), sel);

  // === 6. canvas capture ===
  console.log('\n--- CANVAS CAPTURE ---');
  // procura elementos candidatos (canvas ou img)
  const captured = await page.evaluate(() => {
    const results = [];
    // canvas
    for (const c of document.querySelectorAll('canvas')) {
      try {
        const dataUrl = c.toDataURL('image/png');
        if (dataUrl.length > 100) {
          results.push({ kind: 'canvas', w: c.width, h: c.height, dataUrlLen: dataUrl.length, b64: dataUrl.split(',')[1] });
        }
      } catch (e) { results.push({ kind: 'canvas', error: e.message }); }
    }
    // imgs grandes (provavelmente página)
    for (const img of document.querySelectorAll('img')) {
      if (img.naturalWidth > 300 && img.naturalHeight > 300) {
        try {
          const c = document.createElement('canvas');
          c.width = img.naturalWidth; c.height = img.naturalHeight;
          c.getContext('2d').drawImage(img, 0, 0);
          const dataUrl = c.toDataURL('image/png');
          results.push({ kind: 'img', w: img.naturalWidth, h: img.naturalHeight, src: img.src.slice(0, 60), dataUrlLen: dataUrl.length, b64: dataUrl.split(',')[1] });
        } catch (e) { results.push({ kind: 'img', error: e.message }); }
      }
    }
    return results;
  });
  console.log('candidatos capturados:', captured.length);
  for (let i = 0; i < captured.length; i++) {
    const c = captured[i];
    console.log(`  [${i}] ${c.kind} ${c.w}x${c.h} ${c.src || ''} ${c.error ? 'ERR: ' + c.error : 'ok'}`);
    if (c.b64) {
      const pngPath = path.join(DEBUG_DIR, `05_cap${i}_${c.kind}.png`);
      fs.writeFileSync(pngPath, Buffer.from(c.b64, 'base64'));
      // OCR
      const base = pngPath.replace(/\.png$/, '');
      const r = spawnSync('tesseract', [pngPath, base, '-l', 'por', '--psm', '3', '--oem', '1'], { encoding: 'utf-8' });
      if (r.status === 0) {
        const txt = fs.readFileSync(base + '.txt', 'utf-8');
        console.log(`     OCR: ${txt.length} chars — "${txt.replace(/\s+/g,' ').slice(0, 200)}"`);
      } else {
        console.log(`     OCR fail`);
      }
    }
  }

  await browser.close();
  console.log(`\n→ resultados em ${DEBUG_DIR}`);
}

main().catch(e => { console.error('erro:', e); process.exit(1); });
