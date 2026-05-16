// Testa URL direta com page param &pg=GBS.PT1 + stealth + Xvfb headless=new
const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');
const { spawnSync } = require('child_process');

const COOKIES_PATH = '/tmp/gpb_cookies.json';
const URL = process.argv[2] || 'https://play.google.com/books/reader?id=x9s2EAAAQBAJ&pg=GBS.PT1';
const DEBUG_DIR = path.join(__dirname, '..', 'debug', 'gpb4');
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
  const cookies = JSON.parse(fs.readFileSync(COOKIES_PATH, 'utf-8')).map(normalizeCookie);

  // Tenta channel: 'chrome' (Chrome real, não chromium do Playwright) se disponível
  let browser;
  try {
    browser = await chromium.launch({
      headless: true,
      channel: 'chrome',
      args: ['--disable-blink-features=AutomationControlled', '--no-sandbox']
    });
    console.log('usando channel: chrome');
  } catch (e) {
    browser = await chromium.launch({
      headless: true,
      args: ['--disable-blink-features=AutomationControlled', '--no-sandbox']
    });
    console.log('usando chromium do Playwright (chrome real indisponível: ' + e.message.slice(0,80) + ')');
  }

  const context = await browser.newContext({
    viewport: { width: 1400, height: 900 },
    locale: 'pt-BR',
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    permissions: ['clipboard-read', 'clipboard-write']
  });

  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
    Object.defineProperty(navigator, 'languages', { get: () => ['pt-BR', 'pt', 'en-US', 'en'] });
    window.chrome = { runtime: {} };
  });

  await context.addCookies(cookies);
  const page = await context.newPage();

  // monitora todas as requisições — vamos ver se algo de "page content" chega
  const interesting = [];
  page.on('response', resp => {
    const u = resp.url();
    if (u.includes('content') || u.includes('page') || u.includes('reader') || u.includes('book') || u.includes('image')) {
      const ct = resp.headers()['content-type'] || '';
      interesting.push({ url: u.slice(0, 150), status: resp.status(), type: ct });
    }
  });

  console.log(`abrindo: ${URL}`);
  await page.goto(URL, { waitUntil: 'domcontentloaded' });

  for (let i = 0; i < 40; i++) {
    await page.waitForTimeout(1000);
    const status = await page.evaluate(() => {
      let bodyLen = 0, canv = 0, blob = 0, svgText = 0, imgs = 0, divsBig = 0;
      try {
        for (let i = 0; i < window.frames.length; i++) {
          const d = window.frames[i].document;
          bodyLen += (d.body?.innerText || '').length;
          canv += d.querySelectorAll('canvas').length;
          blob += d.querySelectorAll('img[src^="blob:"]').length;
          imgs += [...d.querySelectorAll('img')].filter(img => img.naturalWidth > 300).length;
          svgText += d.querySelectorAll('svg text, svg tspan').length;
          divsBig += [...d.querySelectorAll('div')].filter(e => (e.innerText||'').length > 500).length;
        }
      } catch {}
      return { bodyLen, canv, blob, imgs, svgText, divsBig };
    });
    if (i % 4 === 0) console.log(`  t${i+1}s body=${status.bodyLen} canv=${status.canv} blob=${status.blob} bigImg=${status.imgs} svgText=${status.svgText} bigDivs=${status.divsBig}`);
    if (status.canv > 0 || status.blob > 0 || status.svgText > 50 || status.divsBig > 0) {
      console.log(`  → conteúdo apareceu em ${i+1}s!`);
      break;
    }
  }

  await page.click('body').catch(() => {});
  await page.waitForTimeout(2000);

  await page.screenshot({ path: path.join(DEBUG_DIR, 'final.png'), fullPage: false });
  console.log('\n--- requests interessantes ---');
  for (const r of interesting.slice(-20)) console.log(`  ${r.status} ${r.type.slice(0, 30)} ${r.url}`);

  // tenta capturar tudo capturável
  console.log('\n--- inspeção final por frame ---');
  for (const f of page.frames()) {
    try {
      const info = await f.evaluate(() => {
        const out = {
          url: location.href,
          bodyLen: (document.body?.innerText || '').length,
          bodyPreview: (document.body?.innerText || '').slice(0, 400),
          canvas: [...document.querySelectorAll('canvas')].map(c => ({ w: c.width, h: c.height })),
          blobImg: [...document.querySelectorAll('img[src^="blob:"]')].map(i => ({ w: i.naturalWidth, h: i.naturalHeight, src: i.src })),
          bigImg: [...document.querySelectorAll('img')].filter(i => i.naturalWidth > 400).map(i => ({ w: i.naturalWidth, h: i.naturalHeight, src: i.src.slice(0,100) })),
          svg: [...document.querySelectorAll('svg')].filter(s => s.getBoundingClientRect().width > 200).map(s => ({
            w: Math.round(s.getBoundingClientRect().width),
            h: Math.round(s.getBoundingClientRect().height),
            text: s.querySelectorAll('text').length,
            tspan: s.querySelectorAll('tspan').length
          }))
        };
        return out;
      });
      console.log(`frame [${info.url.slice(0, 80)}]`);
      console.log(`  body=${info.bodyLen} canvas=${info.canvas.length} blob=${info.blobImg.length} bigImg=${info.bigImg.length} svg=${info.svg.length}`);
      if (info.canvas.length) console.log(`  canvases: ${JSON.stringify(info.canvas)}`);
      if (info.blobImg.length) console.log(`  blobs: ${JSON.stringify(info.blobImg)}`);
      if (info.bigImg.length) console.log(`  imgs: ${JSON.stringify(info.bigImg)}`);
      if (info.svg.length) console.log(`  svgs: ${JSON.stringify(info.svg)}`);
      if (info.bodyLen > 100) console.log(`  preview: "${info.bodyPreview.replace(/\s+/g, ' ').slice(0, 300)}"`);
    } catch (e) { console.log(`  frame err: ${e.message}`); }
  }

  // captura tudo que parecer página de livro e OCR
  console.log('\n--- CAPTURE + OCR ---');
  let captured = 0;
  for (const f of page.frames()) {
    const items = await f.evaluate(() => {
      const r = [];
      for (const c of document.querySelectorAll('canvas')) {
        try { r.push({ kind: 'canvas', w: c.width, h: c.height, b64: c.toDataURL('image/png').split(',')[1] }); }
        catch (e) { r.push({ kind: 'canvas', error: e.message }); }
      }
      for (const img of document.querySelectorAll('img')) {
        if (img.naturalWidth > 400 && img.naturalHeight > 400) {
          try {
            const cv = document.createElement('canvas');
            cv.width = img.naturalWidth; cv.height = img.naturalHeight;
            cv.getContext('2d').drawImage(img, 0, 0);
            r.push({ kind: 'img', w: img.naturalWidth, h: img.naturalHeight, src: img.src.slice(0, 80), b64: cv.toDataURL('image/png').split(',')[1] });
          } catch (e) { r.push({ kind: 'img', error: e.message }); }
        }
      }
      // SVG: serializa e renderiza
      for (const svg of document.querySelectorAll('svg')) {
        const r2 = svg.getBoundingClientRect();
        if (r2.width > 400 && r2.height > 400) {
          try {
            const s = new XMLSerializer().serializeToString(svg);
            r.push({ kind: 'svg', w: r2.width, h: r2.height, text: svg.querySelectorAll('text').length, svgRaw: s.slice(0, 2000) });
          } catch (e) { r.push({ kind: 'svg', error: e.message }); }
        }
      }
      return r;
    });
    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      console.log(`  [${captured}] ${it.kind} ${it.w}x${it.h} ${it.src || ''} ${it.error || ''}`);
      if (it.b64) {
        const png = path.join(DEBUG_DIR, `cap${captured}_${it.kind}.png`);
        fs.writeFileSync(png, Buffer.from(it.b64, 'base64'));
        const base = png.replace(/\.png$/, '');
        const r = spawnSync('tesseract', [png, base, '-l', 'por', '--psm', '3', '--oem', '1'], { encoding: 'utf-8' });
        if (r.status === 0) {
          const txt = fs.readFileSync(base + '.txt', 'utf-8');
          console.log(`      OCR ${txt.length} chars: "${txt.replace(/\s+/g, ' ').slice(0, 200)}"`);
        }
      } else if (it.svgRaw) {
        fs.writeFileSync(path.join(DEBUG_DIR, `cap${captured}.svg.txt`), it.svgRaw);
        console.log(`      svg raw amostra: "${it.svgRaw.slice(0, 200)}"`);
      }
      captured++;
    }
  }

  await browser.close();
}

main().catch(e => { console.error(e); process.exit(1); });
