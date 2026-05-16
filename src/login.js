const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');

const ROOT = path.join(__dirname, '..');
const SESSION_DIR = path.join(ROOT, 'session');
const COOKIES_PATH = path.join(ROOT, 'cookies.json');

function normalizeCookie(c) {
  // Aceita formato da extensão "Cookie-Editor" (exportação JSON).
  // Playwright exige sameSite em {Strict, Lax, None} e expires em segundos epoch.
  const out = {
    name: c.name,
    value: c.value,
    domain: c.domain,
    path: c.path || '/',
    httpOnly: !!c.httpOnly,
    secure: !!c.secure
  };

  if (c.expirationDate) {
    out.expires = Math.floor(Number(c.expirationDate));
  } else if (c.expires && typeof c.expires === 'number') {
    out.expires = Math.floor(c.expires);
  }

  let ss = (c.sameSite || '').toString().toLowerCase();
  if (ss === 'no_restriction' || ss === 'none' || ss === 'unspecified') ss = 'None';
  else if (ss === 'lax') ss = 'Lax';
  else if (ss === 'strict') ss = 'Strict';
  else ss = 'Lax';
  out.sameSite = ss;

  return out;
}

async function main() {
  if (!fs.existsSync(COOKIES_PATH)) {
    console.error(`Falta o arquivo ${COOKIES_PATH}`);
    console.error('Exporte os cookies do seu browser logado em read.amazon.com (extensão "Cookie-Editor" → Export → JSON) e cole aqui.');
    process.exit(1);
  }

  const raw = JSON.parse(fs.readFileSync(COOKIES_PATH, 'utf-8'));
  const cookies = Array.isArray(raw) ? raw.map(normalizeCookie) : [];
  if (!cookies.length) {
    console.error('Nenhum cookie encontrado em cookies.json');
    process.exit(1);
  }

  if (!fs.existsSync(SESSION_DIR)) fs.mkdirSync(SESSION_DIR, { recursive: true });

  console.log(`Importando ${cookies.length} cookies para a sessão...`);

  const context = await chromium.launchPersistentContext(SESSION_DIR, {
    headless: true,
    viewport: { width: 1400, height: 900 },
    locale: 'pt-BR'
  });

  await context.addCookies(cookies);

  // Verifica se está logado abrindo a biblioteca
  const page = await context.newPage();
  console.log('Verificando login em read.amazon.com...');
  await page.goto('https://read.amazon.com', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(4000);

  const url = page.url();
  const title = await page.title().catch(() => '');
  const isLogin = /signin|ap\/signin|login/i.test(url);

  console.log(`URL atual: ${url}`);
  console.log(`Título: ${title}`);

  if (isLogin) {
    console.error('\n[FALHA] A Amazon redirecionou pro login — os cookies não autenticaram.');
    console.error('Verifique se você exportou os cookies do domínio correto (.amazon.com.br ou .amazon.com)');
    console.error('e se incluiu os cookies de sessão (at-main, sess-at-main, ubid-main, x-main, session-id, etc).');
  } else {
    console.log('\n[OK] Sessão autenticada. Pode rodar: npm run extract');
  }

  await context.close();
}

main().catch(err => {
  console.error('Erro:', err);
  process.exit(1);
});
