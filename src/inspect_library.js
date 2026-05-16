const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');

const ROOT = path.join(__dirname, '..');
const COOKIES_PATH = path.join(ROOT, 'cookies.json');

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
  const cookies = JSON.parse(fs.readFileSync(COOKIES_PATH, 'utf-8')).map(normalizeCookie);
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1400, height: 900 } });
  await context.addCookies(cookies);
  const page = await context.newPage();
  await page.goto('https://read.amazon.com/kindle-library', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(8000);

  // Tenta vários seletores e mostra contagens
  const info = await page.evaluate(() => {
    const result = {};
    const tries = [
      '[data-asin]',
      '[id*="asin"]',
      '[id^="content-"]',
      '.book',
      '[class*="book"]',
      '[class*="library"]',
      '[class*="grid"]',
      '[class*="tile"]',
      'li',
      'img',
      '[role="article"]',
      '[role="link"]',
      '[role="button"]',
      '[role="gridcell"]'
    ];
    for (const sel of tries) {
      try { result[sel] = document.querySelectorAll(sel).length; } catch {}
    }
    // Pega 3 imagens de exemplo
    const imgs = Array.from(document.querySelectorAll('img')).slice(0, 5).map(i => ({ src: i.src, alt: i.alt }));
    // Procura ASINs em qualquer atributo ou texto
    const html = document.documentElement.outerHTML;
    const asinMatches = [...new Set((html.match(/B0[A-Z0-9]{8}/g) || []))].slice(0, 20);
    return { counts: result, imgs, asinMatches, htmlLen: html.length };
  });

  console.log('Contagens por seletor:');
  for (const [k, v] of Object.entries(info.counts)) console.log(`  ${k}: ${v}`);
  console.log('\nPrimeiras imagens:');
  info.imgs.forEach((i, idx) => console.log(`  ${idx}: alt="${i.alt}" src=${i.src.slice(0, 100)}`));
  console.log(`\nASINs encontrados no HTML (max 20): ${info.asinMatches.length}`);
  info.asinMatches.forEach(a => console.log(`  ${a}`));
  console.log(`\nTamanho do HTML: ${info.htmlLen} chars`);

  // Salva HTML pra inspecionar
  const html = await page.content();
  fs.writeFileSync(path.join(ROOT, 'screenshots', 'library.html'), html);
  console.log('HTML salvo em screenshots/library.html');

  await browser.close();
}

main().catch(e => { console.error(e); process.exit(1); });
