// Probe focado: abre 1 livro do Play Books, espera MUITO,
// dumpa screenshot + HTML do iframe interno em 3 momentos.

const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');
const { spawnSync } = require('child_process');

const COOKIES_PATH = process.argv[2] || '/tmp/gpb_cookies.json';
const BOOK_ID = process.argv[3] || 'x9s2EAAAQBAJ'; // "O Homem Mais Feliz"
const DEBUG_DIR = path.join(__dirname, '..', 'debug', 'gpb2');
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

async function snapshot(page, label) {
  console.log(`\n=== ${label} ===`);
  await page.screenshot({ path: path.join(DEBUG_DIR, `${label}.png`), fullPage: false });

  for (const f of page.frames()) {
    try {
      const info = await f.evaluate(() => {
        const data = {
          url: location.href,
          bodyTextLen: (document.body?.innerText || '').length,
          bodyTextPreview: (document.body?.innerText || '').slice(0, 400),
          canvases: [...document.querySelectorAll('canvas')].map(c => ({ w: c.width, h: c.height })),
          imgs: [...document.querySelectorAll('img')].filter(i => i.naturalWidth > 100).map(i => ({ w: i.naturalWidth, h: i.naturalHeight, src: i.src.slice(0, 60) })),
          svgs: [...document.querySelectorAll('svg')].filter(s => {
            const r = s.getBoundingClientRect();
            return r.width > 100 && r.height > 100;
          }).map(s => ({ w: Math.round(s.getBoundingClientRect().width), h: Math.round(s.getBoundingClientRect().height), textNodes: s.querySelectorAll('text').length, tspanNodes: s.querySelectorAll('tspan').length })),
          divsLarge: [...document.querySelectorAll('div')].filter(d => {
            const t = (d.innerText || '').trim();
            return t.length > 200 && t.length < 5000;
          }).slice(0, 5).map(d => ({ id: d.id, cls: d.className.toString().slice(0, 50), len: d.innerText.length, sample: d.innerText.slice(0, 200) })),
          iframes: document.querySelectorAll('iframe').length
        };
        return data;
      });
      console.log(`  frame [${info.url.slice(0, 90)}]`);
      console.log(`    body=${info.bodyTextLen} canvases=${info.canvases.length} imgs=${info.imgs.length} svgs=${info.svgs.length} iframes=${info.iframes}`);
      if (info.canvases.length) console.log(`    canvas sizes: ${info.canvases.map(c => c.w+'x'+c.h).join(', ')}`);
      if (info.imgs.length) console.log(`    imgs grandes: ${info.imgs.map(i => i.w+'x'+i.h+' ['+i.src+']').join(' | ')}`);
      if (info.svgs.length) console.log(`    svgs grandes: ${info.svgs.map(s => `${s.w}x${s.h} text=${s.textNodes} tspan=${s.tspanNodes}`).join(' | ')}`);
      if (info.bodyTextLen > 50) console.log(`    preview: "${info.bodyTextPreview.replace(/\s+/g, ' ').slice(0, 250)}"`);
      for (const d of info.divsLarge) {
        console.log(`    div ${d.len}ch <#${d.id} .${d.cls}>: "${d.sample.replace(/\s+/g, ' ')}"`);
      }

      // dump HTML do iframe interno
      if (info.url.includes('googleusercontent') || info.svgs.length > 0 || info.canvases.length > 0 || info.bodyTextLen > 500) {
        try {
          const html = await f.evaluate(() => document.documentElement.outerHTML);
          const safe = info.url.replace(/[^a-z0-9]/gi, '_').slice(0, 50);
          fs.writeFileSync(path.join(DEBUG_DIR, `${label}_${safe}.html`), html);
        } catch {}
      }
    } catch (e) {
      console.log(`  frame [ERRO: ${e.message}]`);
    }
  }
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
  console.log(`abrindo livro ${BOOK_ID}...`);
  await page.goto(`https://play.google.com/books/reader?id=${BOOK_ID}`, { waitUntil: 'domcontentloaded' });

  await page.waitForTimeout(8000);
  await snapshot(page, 't08');

  await page.waitForTimeout(10000);
  await snapshot(page, 't18');

  // tenta interagir: click + arrow
  await page.click('body').catch(() => {});
  await page.waitForTimeout(1500);
  await page.keyboard.press('ArrowRight').catch(() => {});
  await page.waitForTimeout(5000);
  await snapshot(page, 'after_arrow');

  // mais 1 página
  await page.keyboard.press('ArrowRight').catch(() => {});
  await page.waitForTimeout(5000);
  await snapshot(page, 'after_arrow2');

  // tenta Ctrl+A no iframe interno
  const innerFrame = page.frames().find(f => f.url().includes('googleusercontent'));
  if (innerFrame) {
    console.log('\n=== Ctrl+A no iframe interno ===');
    await innerFrame.click('body').catch(() => {});
    await page.keyboard.press('Control+A');
    await page.waitForTimeout(500);
    await page.keyboard.press('Control+C');
    await page.waitForTimeout(500);
    try {
      const clip = await page.evaluate(() => navigator.clipboard.readText().catch(e => '__ERR__' + e.message));
      console.log(`clipboard: ${clip.length} chars`);
      if (clip.length > 100 && !clip.startsWith('__ERR__')) {
        console.log('preview:', clip.slice(0, 300));
        fs.writeFileSync(path.join(DEBUG_DIR, 'clipboard.txt'), clip);
      }
    } catch (e) { console.log('clipboard fail:', e.message); }

    const sel = await innerFrame.evaluate(() => window.getSelection()?.toString() || '');
    console.log(`getSelection: ${sel.length} chars`);
    if (sel.length > 50) {
      console.log('preview:', sel.slice(0, 300));
      fs.writeFileSync(path.join(DEBUG_DIR, 'selection.txt'), sel);
    }
  }

  // captura canvas/img+OCR no inner frame
  console.log('\n=== CAPTURE no iframe ===');
  for (const f of page.frames()) {
    if (!f.url().includes('googleusercontent')) continue;
    const captures = await f.evaluate(() => {
      const results = [];
      for (const c of document.querySelectorAll('canvas')) {
        try {
          const dataUrl = c.toDataURL('image/png');
          results.push({ kind: 'canvas', w: c.width, h: c.height, b64: dataUrl.split(',')[1] });
        } catch (e) { results.push({ kind: 'canvas', error: e.message }); }
      }
      for (const img of document.querySelectorAll('img')) {
        if (img.naturalWidth > 300 && img.naturalHeight > 300) {
          try {
            const cv = document.createElement('canvas');
            cv.width = img.naturalWidth; cv.height = img.naturalHeight;
            cv.getContext('2d').drawImage(img, 0, 0);
            const dataUrl = cv.toDataURL('image/png');
            results.push({ kind: 'img', w: img.naturalWidth, h: img.naturalHeight, b64: dataUrl.split(',')[1] });
          } catch (e) { results.push({ kind: 'img', error: e.message }); }
        }
      }
      return results;
    });
    console.log(`  candidatos: ${captures.length}`);
    for (let i = 0; i < captures.length; i++) {
      const c = captures[i];
      console.log(`    [${i}] ${c.kind} ${c.w}x${c.h} ${c.error || ''}`);
      if (c.b64) {
        const png = path.join(DEBUG_DIR, `cap${i}_${c.kind}.png`);
        fs.writeFileSync(png, Buffer.from(c.b64, 'base64'));
        const base = png.replace(/\.png$/, '');
        const r = spawnSync('tesseract', [png, base, '-l', 'por', '--psm', '3', '--oem', '1'], { encoding: 'utf-8' });
        if (r.status === 0) {
          const txt = fs.readFileSync(base + '.txt', 'utf-8');
          console.log(`      OCR ${txt.length} chars: "${txt.replace(/\s+/g, ' ').slice(0, 200)}"`);
        } else console.log(`      OCR fail`);
      }
    }
  }

  await browser.close();
}

main().catch(e => { console.error('erro:', e); process.exit(1); });
