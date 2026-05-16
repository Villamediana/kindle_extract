// Roda Chromium em modo HEADED dentro de display virtual (Xvfb)
// Invocar com: xvfb-run -a -s "-screen 0 1440x900x24" node src/probe_gpb_xvfb.js [url]
const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');
const { spawnSync } = require('child_process');

const COOKIES_PATH = '/tmp/gpb_cookies.json';
const URL = process.argv[2] || 'https://play.google.com/books/reader?id=x9s2EAAAQBAJ&pg=GBS.PT1';
const DEBUG_DIR = path.join(__dirname, '..', 'debug', 'gpb_xvfb');
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
  console.log('DISPLAY:', process.env.DISPLAY || '(none)');
  const cookies = JSON.parse(fs.readFileSync(COOKIES_PATH, 'utf-8')).map(normalizeCookie);

  // HEADED (não headless) dentro do Xvfb
  const browser = await chromium.launch({
    headless: false,
    args: ['--no-sandbox', '--disable-blink-features=AutomationControlled', '--disable-dev-shm-usage']
  });

  const context = await browser.newContext({
    viewport: { width: 1400, height: 900 },
    locale: 'pt-BR',
    permissions: ['clipboard-read', 'clipboard-write']
  });

  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
  });

  await context.addCookies(cookies);
  const page = await context.newPage();

  console.log('abrindo:', URL);
  await page.goto(URL, { waitUntil: 'domcontentloaded' });

  // espera carregar
  let foundAt = 0;
  for (let i = 0; i < 50; i++) {
    await page.waitForTimeout(1000);
    const s = await page.evaluate(() => {
      let bodyLen = 0, canv = 0, blob = 0, bigImg = 0, svgT = 0;
      try {
        for (let f = 0; f < window.frames.length; f++) {
          const d = window.frames[f].document;
          bodyLen += (d.body?.innerText || '').length;
          canv += d.querySelectorAll('canvas').length;
          blob += d.querySelectorAll('img[src^="blob:"]').length;
          bigImg += [...d.querySelectorAll('img')].filter(i => i.naturalWidth > 400).length;
          svgT += d.querySelectorAll('svg text, svg tspan').length;
        }
      } catch {}
      return { bodyLen, canv, blob, bigImg, svgT };
    });
    if (i % 3 === 0) console.log(`  t${i+1}s body=${s.bodyLen} canv=${s.canv} blob=${s.blob} bigImg=${s.bigImg} svgT=${s.svgT}`);
    if (s.canv > 0 || s.blob > 0 || s.bigImg > 1 || s.svgT > 30) { foundAt = i+1; break; }
  }

  if (foundAt) console.log(`\n✓ conteúdo apareceu em ${foundAt}s!`);
  else console.log(`\n✗ timeout — nada apareceu em 50s`);

  await page.waitForTimeout(3000);
  await page.screenshot({ path: path.join(DEBUG_DIR, 'final.png'), fullPage: false });

  // inspeção final
  console.log('\n--- frames ---');
  for (const f of page.frames()) {
    try {
      const info = await f.evaluate(() => ({
        url: location.href,
        bodyLen: (document.body?.innerText || '').length,
        bodyPreview: (document.body?.innerText || '').slice(0, 300),
        canvas: [...document.querySelectorAll('canvas')].map(c => ({ w: c.width, h: c.height })),
        blobImg: [...document.querySelectorAll('img[src^="blob:"]')].map(i => ({ w: i.naturalWidth, h: i.naturalHeight })),
        bigImg: [...document.querySelectorAll('img')].filter(i => i.naturalWidth > 400).map(i => ({ w: i.naturalWidth, h: i.naturalHeight, src: i.src.slice(0, 100) })),
        svgWithText: [...document.querySelectorAll('svg')].filter(s => s.querySelectorAll('text, tspan').length > 5).map(s => {
          const r = s.getBoundingClientRect();
          return { w: Math.round(r.width), h: Math.round(r.height), text: s.querySelectorAll('text').length, tspan: s.querySelectorAll('tspan').length };
        })
      }));
      console.log(`${info.url.slice(0,80)}`);
      console.log(`  body=${info.bodyLen} canvas=${info.canvas.length} blob=${info.blobImg.length} bigImg=${info.bigImg.length} svgT=${info.svgWithText.length}`);
      if (info.canvas.length) console.log(`  canvas: ${JSON.stringify(info.canvas)}`);
      if (info.blobImg.length) console.log(`  blob: ${JSON.stringify(info.blobImg)}`);
      if (info.bigImg.length) console.log(`  img grande: ${JSON.stringify(info.bigImg)}`);
      if (info.svgWithText.length) console.log(`  svg c/texto: ${JSON.stringify(info.svgWithText)}`);
      if (info.bodyLen > 200) console.log(`  body: "${info.bodyPreview.replace(/\s+/g,' ').slice(0,200)}"`);
    } catch (e) { console.log(`  err: ${e.message}`); }
  }

  // captura + OCR
  console.log('\n--- CAPTURE + OCR ---');
  let n = 0;
  for (const f of page.frames()) {
    const items = await f.evaluate(() => {
      const r = [];
      for (const c of document.querySelectorAll('canvas')) {
        try { r.push({ kind: 'canvas', w: c.width, h: c.height, b64: c.toDataURL('image/png').split(',')[1] }); } catch (e) { r.push({ kind: 'canvas', err: e.message }); }
      }
      for (const img of document.querySelectorAll('img')) {
        if (img.naturalWidth > 400 && img.naturalHeight > 400) {
          try {
            const cv = document.createElement('canvas');
            cv.width = img.naturalWidth; cv.height = img.naturalHeight;
            cv.getContext('2d').drawImage(img, 0, 0);
            r.push({ kind: 'img', w: img.naturalWidth, h: img.naturalHeight, src: img.src.slice(0, 80), b64: cv.toDataURL('image/png').split(',')[1] });
          } catch (e) { r.push({ kind: 'img', err: e.message }); }
        }
      }
      // SVG large + has text — serialize them
      for (const svg of document.querySelectorAll('svg')) {
        const rect = svg.getBoundingClientRect();
        if (rect.width > 400 && rect.height > 400 && svg.querySelectorAll('text, tspan').length > 5) {
          r.push({ kind: 'svg-text', w: rect.width, h: rect.height, text: [...svg.querySelectorAll('text, tspan')].map(t => t.textContent).join('\n').slice(0, 5000) });
        }
      }
      return r;
    });
    for (const it of items) {
      console.log(`  [${n}] ${it.kind} ${it.w}x${it.h} ${it.src||''} ${it.err||''}`);
      if (it.b64) {
        const png = path.join(DEBUG_DIR, `cap${n}.png`);
        fs.writeFileSync(png, Buffer.from(it.b64, 'base64'));
        const base = png.replace(/\.png$/, '');
        const r = spawnSync('tesseract', [png, base, '-l', 'por', '--psm', '3', '--oem', '1'], { encoding: 'utf-8' });
        if (r.status === 0) {
          const txt = fs.readFileSync(base + '.txt', 'utf-8');
          console.log(`     OCR ${txt.length} chars: "${txt.replace(/\s+/g, ' ').slice(0, 250)}"`);
        }
      } else if (it.text) {
        console.log(`     SVG text: "${it.text.replace(/\s+/g, ' ').slice(0, 250)}"`);
        fs.writeFileSync(path.join(DEBUG_DIR, `cap${n}_svg.txt`), it.text);
      }
      n++;
    }
  }

  await browser.close();
}

main().catch(e => { console.error(e); process.exit(1); });
