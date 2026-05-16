// Probe com stealth — tenta esconder sinais de headless pra ver se Google libera o reader
const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');

const COOKIES_PATH = process.argv[2] || '/tmp/gpb_cookies.json';
const BOOK_ID = process.argv[3] || 'x9s2EAAAQBAJ';
const DEBUG_DIR = path.join(__dirname, '..', 'debug', 'gpb3');
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

  const browser = await chromium.launch({
    headless: true,
    args: [
      '--disable-blink-features=AutomationControlled',
      '--disable-features=IsolateOrigins,site-per-process',
      '--no-sandbox',
      '--disable-web-security'
    ]
  });

  const context = await browser.newContext({
    viewport: { width: 1400, height: 900 },
    locale: 'pt-BR',
    userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    permissions: ['clipboard-read', 'clipboard-write']
  });

  // stealth patches
  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
    Object.defineProperty(navigator, 'languages', { get: () => ['pt-BR', 'pt', 'en-US', 'en'] });
    window.chrome = { runtime: {} };
    const originalQuery = window.navigator.permissions.query;
    window.navigator.permissions.query = (parameters) =>
      parameters.name === 'notifications'
        ? Promise.resolve({ state: Notification.permission })
        : originalQuery(parameters);
  });

  await context.addCookies(cookies);

  const page = await context.newPage();
  console.log(`abrindo ${BOOK_ID} (com stealth)...`);
  await page.goto(`https://play.google.com/books/reader?id=${BOOK_ID}`, { waitUntil: 'domcontentloaded' });

  // monitora carregamento até 50s
  for (let i = 0; i < 50; i++) {
    await page.waitForTimeout(1000);
    const status = await page.evaluate(() => {
      const f = window.frames[0];
      let bodyLen = 0, canv = 0, imgs = 0, svgs = 0, blob = 0;
      try {
        if (f) {
          bodyLen = (f.document.body?.innerText || '').length;
          canv = f.document.querySelectorAll('canvas').length;
          imgs = f.document.querySelectorAll('img').length;
          svgs = f.document.querySelectorAll('svg').length;
          blob = f.document.querySelectorAll('img[src^="blob:"]').length;
        }
      } catch {}
      return { bodyLen, canv, imgs, svgs, blob };
    });
    if (i % 5 === 0 || status.canv > 0 || status.blob > 0 || status.bodyLen > 500) {
      console.log(`  t${i+1}s body=${status.bodyLen} canv=${status.canv} img=${status.imgs} blob=${status.blob} svg=${status.svgs}`);
    }
    if (status.canv > 0 || status.blob > 0 || status.bodyLen > 500) break;
  }

  // tenta arrow right
  await page.click('body').catch(() => {});
  await page.waitForTimeout(1500);
  await page.keyboard.press('ArrowRight').catch(() => {});
  await page.waitForTimeout(5000);

  await page.screenshot({ path: path.join(DEBUG_DIR, 'after.png') });

  // dump tudo
  for (const f of page.frames()) {
    try {
      const data = await f.evaluate(() => ({
        url: location.href,
        bodyText: (document.body?.innerText || '').slice(0, 500),
        bodyLen: (document.body?.innerText || '').length,
        canv: document.querySelectorAll('canvas').length,
        imgs: [...document.querySelectorAll('img')].filter(i => i.naturalWidth > 200).map(i => `${i.naturalWidth}x${i.naturalHeight} ${i.src.slice(0,50)}`),
        svgsWithText: document.querySelectorAll('svg text, svg tspan').length
      }));
      console.log(`\nframe ${data.url.slice(0,80)}`);
      console.log(`  body=${data.bodyLen} canv=${data.canv} svgText=${data.svgsWithText}`);
      console.log(`  imgs grandes: ${JSON.stringify(data.imgs)}`);
      console.log(`  body preview: "${data.bodyText.replace(/\s+/g, ' ')}"`);
    } catch (e) { console.log(`  frame err: ${e.message}`); }
  }

  await browser.close();
}

main().catch(e => { console.error(e); process.exit(1); });
