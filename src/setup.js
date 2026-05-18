#!/usr/bin/env node
// Verifica e instala automaticamente tudo que o projeto precisa.
//   - Node >= 18
//   - node_modules (express, playwright)
//   - Chromium do Playwright
//   - tesseract + pacote 'por'
//   - diretórios output/, screenshots/, tmp_ocr/
//   - cookies.json (avisa se faltar)
//   - config.json (avisa se faltar)
//
// Tenta instalar o que falta automaticamente. Quando não consegue (sem sudo,
// sem apt, etc.), imprime instruções claras pro usuário.

const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { resolveTesseractCmd, platform: hostPlatform, playwrightBrowsersDir } = require('./setup-helpers');

const ROOT = path.join(__dirname, '..');
const COOKIES_PATH = path.join(ROOT, 'cookies.json');
const CONFIG_PATH = path.join(ROOT, 'config.json');
const TESSERACT_CMD = resolveTesseractCmd();

// ANSI cores
const C = {
  reset: '\x1b[0m', dim: '\x1b[2m', bold: '\x1b[1m',
  red: '\x1b[31m', green: '\x1b[32m', yellow: '\x1b[33m',
  blue: '\x1b[34m', cyan: '\x1b[36m', magenta: '\x1b[35m'
};

const ok = (m) => console.log(`  ${C.green}✓${C.reset} ${m}`);
const warn = (m) => console.log(`  ${C.yellow}⚠${C.reset} ${m}`);
const fail = (m) => console.log(`  ${C.red}✗${C.reset} ${m}`);
const info = (m) => console.log(`  ${C.cyan}ℹ${C.reset} ${m}`);
const step = (m) => console.log(`\n${C.bold}${C.blue}▶${C.reset} ${C.bold}${m}${C.reset}`);

function sh(cmd, args, opts = {}) {
  return spawnSync(cmd, args, { stdio: 'inherit', encoding: 'utf-8', ...opts });
}
function shq(cmd, args, opts = {}) {
  return spawnSync(cmd, args, { encoding: 'utf-8', ...opts });
}

let failures = 0;
let warnings = 0;

// ---------- 1. Node version ----------
step('Verificando Node.js');
const nodeMajor = parseInt(process.versions.node.split('.')[0], 10);
if (nodeMajor >= 18) {
  ok(`Node ${process.versions.node}`);
} else {
  fail(`Node ${process.versions.node} — precisa de >= 18. Atualize antes de continuar.`);
  failures++;
}

// ---------- 2. npm dependencies ----------
step('Verificando dependências do package.json');
const nodeModulesExists = fs.existsSync(path.join(ROOT, 'node_modules'));
let needsInstall = !nodeModulesExists;
if (!needsInstall) {
  try { require.resolve('express', { paths: [ROOT] }); } catch { needsInstall = true; }
  try { require.resolve('playwright', { paths: [ROOT] }); } catch { needsInstall = true; }
}
if (needsInstall) {
  warn('node_modules/ incompleto — rodando npm install…');
  const r = sh('npm', ['install', '--no-fund', '--no-audit'], { cwd: ROOT });
  if (r.status === 0) ok('npm install concluído');
  else { fail('npm install falhou'); failures++; }
} else {
  ok('node_modules/ presente (express, playwright)');
}

// ---------- 3. Playwright Chromium ----------
step('Verificando Chromium do Playwright');
const cacheDir = playwrightBrowsersDir();
let hasChromium = false;
try {
  if (fs.existsSync(cacheDir)) {
    hasChromium = fs.readdirSync(cacheDir).some(d => d.startsWith('chromium'));
  }
} catch {}
if (hasChromium) {
  ok('Chromium instalado');
} else {
  warn('Chromium não encontrado — instalando…');
  const r = sh('npx', ['playwright', 'install', 'chromium'], { cwd: ROOT });
  if (r.status === 0) ok('Chromium instalado');
  else { fail('falha ao instalar Chromium — tente manualmente: npx playwright install chromium'); failures++; }
}

// ---------- 4. Tesseract ----------
step('Verificando Tesseract OCR');
info(`Binário: ${TESSERACT_CMD}`);
const tessVer = shq(TESSERACT_CMD, ['--version']);
const hasTesseract = tessVer.status === 0;
if (hasTesseract) {
  ok(`Tesseract: ${(tessVer.stdout || tessVer.stderr).split('\n')[0]}`);
} else if (hostPlatform() === 'linux') {
  warn('Tesseract não instalado — tentando instalar via apt…');
  const apt = shq('which', ['apt-get']);
  if (apt.status === 0) {
    const i = sh('sudo', ['apt-get', 'install', '-y', 'tesseract-ocr', 'tesseract-ocr-por']);
    if (i.status === 0) ok('Tesseract + pacote português instalados');
    else {
      fail('apt-get falhou. Instale manualmente:');
      console.log(`     ${C.dim}sudo apt-get install -y tesseract-ocr tesseract-ocr-por${C.reset}`);
      failures++;
    }
  } else {
    fail('apt-get não disponível. Instale Tesseract manualmente para seu OS:');
    console.log(`     ${C.dim}Fedora: sudo dnf install tesseract tesseract-langpack-por${C.reset}`);
    failures++;
  }
} else if (hostPlatform() === 'mac') {
  fail('Tesseract não encontrado. No macOS, instale via Homebrew:');
  console.log(`     ${C.dim}brew install tesseract tesseract-lang${C.reset}`);
  failures++;
} else {
  fail('Tesseract não encontrado. No Windows:');
  console.log(`     ${C.dim}1) Baixe o instalador em https://github.com/UB-Mannheim/tesseract/wiki${C.reset}`);
  console.log(`     ${C.dim}2) Durante a instalação, marque "Additional language data → Portuguese"${C.reset}`);
  console.log(`     ${C.dim}3) Abra o UI (npm run server) e cole o caminho do tesseract.exe na aba de Setup${C.reset}`);
  failures++;
}

// ---------- 5. Tesseract Portuguese ----------
step('Verificando pacote de idioma português do Tesseract');
const tessLangs = shq(TESSERACT_CMD, ['--list-langs']);
if (tessLangs.status === 0) {
  const all = (tessLangs.stdout + tessLangs.stderr).split('\n').map(s => s.trim());
  if (all.includes('por')) {
    ok('Idioma "por" disponível');
  } else {
    warn('Pacote "por" não encontrado — instalando via apt…');
    const apt = shq('which', ['apt-get']);
    if (apt.status === 0) {
      const i = sh('sudo', ['apt-get', 'install', '-y', 'tesseract-ocr-por']);
      if (i.status === 0) ok('Pacote português instalado');
      else { fail('falha ao instalar — rode manualmente: sudo apt-get install tesseract-ocr-por'); failures++; }
    } else {
      fail('Instale manualmente o pacote de idioma português do Tesseract.');
      failures++;
    }
  }
} else {
  // já reportado acima
}

// ---------- 6. Diretórios ----------
step('Criando diretórios de trabalho');
for (const d of ['output', 'screenshots', 'tmp_ocr', 'session']) {
  const fp = path.join(ROOT, d);
  if (fs.existsSync(fp)) ok(`${d}/`);
  else { fs.mkdirSync(fp, { recursive: true }); ok(`${d}/ (criado)`); }
}

// ---------- 7. cookies.json ----------
step('Verificando cookies.json');
if (fs.existsSync(COOKIES_PATH)) {
  try {
    const c = JSON.parse(fs.readFileSync(COOKIES_PATH, 'utf-8'));
    if (Array.isArray(c) && c.length > 0) {
      const sessionCookies = ['at-main','sess-at-main','x-main','ubid-main','session-id'].filter(n => c.some(x => x.name === n));
      if (sessionCookies.length > 0) ok(`${c.length} cookies, sessão Amazon detectada (${sessionCookies.join(', ')})`);
      else { warn('cookies.json existe mas sem cookies de sessão Amazon — refaça pelo UI'); warnings++; }
    } else {
      warn('cookies.json vazio'); warnings++;
    }
  } catch { warn('cookies.json com JSON inválido'); warnings++; }
} else {
  warn('cookies.json não existe. Configure depois pelo UI:');
  console.log(`     ${C.dim}1) Abra http://localhost:3400 → botão "Cookies"${C.reset}`);
  console.log(`     ${C.dim}2) Siga as instruções no modal${C.reset}`);
  warnings++;
}

// ---------- 8. config.json ----------
step('Verificando config.json');
if (fs.existsSync(CONFIG_PATH)) {
  try {
    const cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
    if (Array.isArray(cfg.books) && cfg.books.length > 0) ok(`${cfg.books.length} livros no config`);
    else { warn('config.json sem lista de livros'); warnings++; }
  } catch { warn('config.json com JSON inválido'); warnings++; }
} else {
  warn('config.json não existe. Crie a partir de config.example.json:');
  console.log(`     ${C.dim}cp config.example.json config.json${C.reset}`);
  console.log(`     ${C.dim}…e edite para listar os ASINs dos livros${C.reset}`);
  warnings++;
}

// ---------- resumo ----------
console.log();
console.log('─'.repeat(60));
if (failures === 0 && warnings === 0) {
  console.log(`${C.green}${C.bold}✓ Tudo pronto!${C.reset} Pode rodar:`);
  console.log(`    ${C.cyan}npm run server${C.reset}   ${C.dim}# UI web em http://localhost:3400${C.reset}`);
  console.log(`    ${C.cyan}npm run extract${C.reset}  ${C.dim}# linha de comando${C.reset}`);
} else if (failures === 0) {
  console.log(`${C.yellow}${C.bold}⚠ Setup OK com ${warnings} aviso(s).${C.reset} Você pode iniciar o server:`);
  console.log(`    ${C.cyan}npm run server${C.reset}`);
  console.log(`  Resolva os avisos acima (configurar cookies, config.json) pelo UI.`);
} else {
  console.log(`${C.red}${C.bold}✗ Setup com ${failures} erro(s).${C.reset} Resolva antes de continuar.`);
  process.exit(1);
}
console.log('─'.repeat(60));
