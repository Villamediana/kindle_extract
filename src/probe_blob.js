const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');

const ROOT = path.join(__dirname, '..');
const SESSION_DIR = path.join(ROOT, 'session');
const COOKIES_PATH = path.join(ROOT, 'cookies.json');
const DEBUG_DIR = path.join(ROOT, 'debug');

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

async function main() {
  fs.mkdirSync(DEBUG_DIR, { recursive: true });
  let context, browser;
  if (fs.existsSync(SESSION_DIR) && fs.readdirSync(SESSION_DIR).length > 0) {
    context = await chromium.launchPersistentContext(SESSION_DIR, { headless: true, viewport: { width: 1400, height: 900 } });
  } else {
    browser = await chromium.launch({ headless: true });
    context = await browser.newContext({ viewport: { width: 1400, height: 900 } });
    const cookies = JSON.parse(fs.readFileSync(COOKIES_PATH, 'utf-8')).map(normalizeCookie);
    await context.addCookies(cookies);
  }

  const page = await context.newPage();
  console.log(`abrindo ${ASIN}...`);
  await page.goto(`https://read.amazon.com/?asin=${ASIN}`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(8000);
  await page.click('body').catch(() => {});
  await page.waitForTimeout(2000);

  // Vira algumas páginas pra sair da capa
  for (let i = 0; i < 3; i++) {
    await page.keyboard.press('ArrowRight');
    await page.waitForTimeout(2500);
  }

  // Descobre tipo e tamanho do blob via XHR (fetch é bloqueado) + tenta canvas
  const info = await page.evaluate(async () => {
    const imgs = document.querySelectorAll('img[src^="blob:"]');
    const results = [];
    for (const img of imgs) {
      const r = { src: img.src, natural: { w: img.naturalWidth, h: img.naturalHeight } };

      // tenta XHR
      try {
        const blob = await new Promise((resolve, reject) => {
          const x = new XMLHttpRequest();
          x.open('GET', img.src);
          x.responseType = 'blob';
          x.onload = () => x.status === 200 ? resolve(x.response) : reject(new Error('status ' + x.status));
          x.onerror = () => reject(new Error('xhr error'));
          x.send();
        });
        r.xhr = { mime: blob.type, size: blob.size };
        const buf = await blob.arrayBuffer();
        const head = new Uint8Array(buf.slice(0, 16));
        r.xhr.hex = Array.from(head).map(b => b.toString(16).padStart(2, '0')).join('');
      } catch (e) {
        r.xhrError = e.message;
      }

      // tenta canvas (extrai pixels — caminho OCR)
      try {
        const c = document.createElement('canvas');
        c.width = img.naturalWidth || 1120;
        c.height = img.naturalHeight || 750;
        const ctx = c.getContext('2d');
        ctx.drawImage(img, 0, 0);
        const dataUrl = c.toDataURL('image/png');
        r.canvas = { ok: true, dataUrlLen: dataUrl.length, sample: dataUrl.slice(0, 60) };
      } catch (e) {
        r.canvasError = e.message;
      }

      results.push(r);
    }
    return results;
  });

  console.log('\n=== BLOBS encontrados ===');
  console.log(JSON.stringify(info, null, 2));

  // Salva via XHR ou via canvas (PNG)
  if (info.length > 0 && info[0].src) {
    try {
      const result = await page.evaluate(async (src) => {
        // tenta XHR
        try {
          const blob = await new Promise((resolve, reject) => {
            const x = new XMLHttpRequest();
            x.open('GET', src);
            x.responseType = 'blob';
            x.onload = () => x.status === 200 ? resolve(x.response) : reject(new Error('status ' + x.status));
            x.onerror = () => reject(new Error('xhr error'));
            x.send();
          });
          const buf = await blob.arrayBuffer();
          return { via: 'xhr', mime: blob.type, bytes: Array.from(new Uint8Array(buf)) };
        } catch (e) {
          // fallback canvas
          const img = document.querySelector('img[src="' + src + '"]');
          const c = document.createElement('canvas');
          c.width = img.naturalWidth; c.height = img.naturalHeight;
          c.getContext('2d').drawImage(img, 0, 0);
          const dataUrl = c.toDataURL('image/png');
          const b64 = dataUrl.split(',')[1];
          const bin = atob(b64);
          const bytes = new Uint8Array(bin.length);
          for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
          return { via: 'canvas', mime: 'image/png', bytes: Array.from(bytes) };
        }
      }, info[0].src);

      const buf = Buffer.from(result.bytes);
      const ext = result.mime.includes('pdf') ? 'pdf'
                : result.mime.includes('png') ? 'png'
                : result.mime.includes('jpeg') ? 'jpg'
                : 'bin';
      const fp = path.join(DEBUG_DIR, `blob_sample.${ext}`);
      fs.writeFileSync(fp, buf);
      console.log(`\n→ salvo em ${fp} via ${result.via} (${buf.length} bytes, mime=${result.mime})`);
    } catch (e) {
      console.log('falha ao baixar:', e.message);
    }
  }

  await context.close();
  if (browser) await browser.close();
}

main().catch(e => { console.error(e); process.exit(1); });
