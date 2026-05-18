// Helpers de setup: detecção de OS, resolução do tesseract, instruções por plataforma.
// Usado tanto pelo server.js (UI) quanto pelo extract.js (pipeline).

const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const SETUP_LOCAL_PATH = path.join(ROOT, 'setup.local.json');

function platform() {
  const p = process.platform;
  if (p === 'win32') return 'windows';
  if (p === 'darwin') return 'mac';
  return 'linux';
}

function loadSetupLocal() {
  if (!fs.existsSync(SETUP_LOCAL_PATH)) return {};
  try { return JSON.parse(fs.readFileSync(SETUP_LOCAL_PATH, 'utf-8')); }
  catch { return {}; }
}

function saveSetupLocal(obj) {
  const current = loadSetupLocal();
  const merged = { ...current, ...obj };
  fs.writeFileSync(SETUP_LOCAL_PATH, JSON.stringify(merged, null, 2));
  return merged;
}

// Resolve o binário do tesseract:
//  1) caminho explícito em setup.local.json
//  2) env TESSERACT_CMD
//  3) caminhos padrão do Windows
//  4) "tesseract" (resolve via PATH)
function resolveTesseractCmd() {
  const local = loadSetupLocal();
  if (local.tesseractPath && fs.existsSync(local.tesseractPath)) {
    return local.tesseractPath;
  }
  if (process.env.TESSERACT_CMD && fs.existsSync(process.env.TESSERACT_CMD)) {
    return process.env.TESSERACT_CMD;
  }
  if (platform() === 'windows') {
    const candidates = [
      'C:\\Program Files\\Tesseract-OCR\\tesseract.exe',
      'C:\\Program Files (x86)\\Tesseract-OCR\\tesseract.exe',
      path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Tesseract-OCR', 'tesseract.exe'),
      path.join(process.env.USERPROFILE || '', 'AppData', 'Local', 'Programs', 'Tesseract-OCR', 'tesseract.exe')
    ];
    for (const c of candidates) {
      if (c && fs.existsSync(c)) return c;
    }
  }
  return 'tesseract';
}

// Tenta rodar `<cmd> --version` e retorna { ok, version, error }.
function probeTesseract(cmd) {
  const c = cmd || resolveTesseractCmd();
  try {
    const r = spawnSync(c, ['--version'], { encoding: 'utf-8', timeout: 4000 });
    if (r.error) return { ok: false, error: r.error.message, cmd: c };
    if (r.status !== 0) return { ok: false, error: (r.stderr || r.stdout || '').slice(0, 200), cmd: c };
    const first = (r.stdout || r.stderr || '').split('\n')[0].trim();
    return { ok: true, version: first, cmd: c };
  } catch (e) {
    return { ok: false, error: e.message, cmd: c };
  }
}

function probeTesseractLangs(cmd) {
  const c = cmd || resolveTesseractCmd();
  try {
    const r = spawnSync(c, ['--list-langs'], { encoding: 'utf-8', timeout: 4000 });
    if (r.status !== 0) return { ok: false, langs: [] };
    const langs = (r.stdout + r.stderr).split('\n').map(s => s.trim()).filter(s => s && !s.includes(':'));
    return { ok: true, langs };
  } catch {
    return { ok: false, langs: [] };
  }
}

function playwrightBrowsersDir() {
  if (process.env.PLAYWRIGHT_BROWSERS_PATH) return process.env.PLAYWRIGHT_BROWSERS_PATH;
  if (process.platform === 'win32') {
    const local = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
    return path.join(local, 'ms-playwright');
  }
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Caches', 'ms-playwright');
  }
  return path.join(os.homedir(), '.cache', 'ms-playwright');
}

function hasChromium() {
  const cacheDir = playwrightBrowsersDir();
  try {
    if (!fs.existsSync(cacheDir)) return false;
    return fs.readdirSync(cacheDir).some(d => d.startsWith('chromium'));
  } catch { return false; }
}

function hasPlaywright() {
  try { require.resolve('playwright'); return true; } catch { return false; }
}

// Instruções de instalação por plataforma + item. Frontend renderiza isto.
function instructionsFor(item, plat = platform()) {
  const TABLE = {
    tesseract: {
      linux: {
        title: 'Instalar Tesseract OCR + pacote português',
        autoInstall: { endpoint: '/api/setup/install-tesseract', label: 'Instalar via apt-get' },
        commands: ['sudo apt-get install -y tesseract-ocr tesseract-ocr-por'],
        note: 'Requer sudo. Se a senha for pedida, rode no terminal: npm run setup'
      },
      mac: {
        title: 'Instalar Tesseract OCR no macOS',
        commands: ['brew install tesseract tesseract-lang'],
        note: 'Precisa do Homebrew (https://brew.sh). O pacote tesseract-lang inclui português.'
      },
      windows: {
        title: 'Instalar Tesseract OCR no Windows',
        download: 'https://github.com/UB-Mannheim/tesseract/wiki',
        steps: [
          'Baixe o instalador "tesseract-ocr-w64-setup-*.exe" no link acima',
          'Durante a instalação, marque "Additional language data → Portuguese" (idioma "por")',
          'Conclua a instalação (caminho padrão: C:\\Program Files\\Tesseract-OCR\\)',
          'Cole o caminho do tesseract.exe no campo abaixo (ou clique em "Detectar automaticamente")'
        ],
        showPathInput: true
      }
    },
    tesseractPor: {
      linux: {
        title: 'Instalar pacote de idioma português',
        autoInstall: { endpoint: '/api/setup/install-tesseract-por', label: 'Instalar via apt-get' },
        commands: ['sudo apt-get install -y tesseract-ocr-por']
      },
      mac: {
        title: 'Instalar pacote de idiomas',
        commands: ['brew install tesseract-lang'],
        note: 'tesseract-lang inclui todos os idiomas, incluindo "por".'
      },
      windows: {
        title: 'Adicionar idioma português ao Tesseract',
        steps: [
          'Re-execute o instalador do Tesseract',
          'Em "Additional language data", marque "Portuguese"',
          'Concluir — o arquivo por.traineddata será adicionado ao tessdata/',
          'Alternativa: baixar https://github.com/tesseract-ocr/tessdata_best/raw/main/por.traineddata e colocar em C:\\Program Files\\Tesseract-OCR\\tessdata\\'
        ]
      }
    },
    chromium: {
      _all: {
        title: 'Baixar Chromium do Playwright',
        autoInstall: { endpoint: '/api/setup/install-chromium', label: 'Baixar agora' },
        commands: ['npx playwright install chromium'],
        note: 'Download de ~170 MB. Demora 30-90s dependendo da conexão.'
      }
    },
    playwright: {
      _all: {
        title: 'Instalar dependências do npm',
        autoInstall: { endpoint: '/api/setup/install-deps', label: 'Rodar npm install' },
        commands: ['npm install']
      }
    },
    node: {
      _all: {
        title: 'Atualizar Node.js',
        note: 'Precisa de Node 18 ou superior. Atualize via nvm (Linux/Mac) ou nodejs.org (Windows).',
        download: 'https://nodejs.org/'
      }
    },
    cookies: {
      _all: {
        title: 'Importar cookies do Kindle',
        openCookiesModal: true,
        note: 'Clique no botão "Cookies" no topo da página pra colar o JSON exportado da extensão Cookie-Editor.'
      }
    },
    config: {
      _all: {
        title: 'Importar lista de livros',
        note: 'Gerado automaticamente após validar os cookies. Se quiser editar manualmente, use config.example.json como base.'
      }
    }
  };

  const t = TABLE[item];
  if (!t) return null;
  return t[plat] || t._all || null;
}

// Garante que tessdata/por.traineddata (modelo "best", melhor pra itálicos)
// está presente em <projeto>/tessdata. Chamado tanto pelo setup.js quanto pelo
// server.js no startup. Usa curl síncrono (Linux/Mac/Win10+) com fallback
// PowerShell. Retorna { state: 'present'|'downloaded'|'failed', error?, sizeMB? }.
const TESSDATA_BEST_URL = 'https://github.com/tesseract-ocr/tessdata_best/raw/main/por.traineddata';
const TESSDATA_BEST_MIN_BYTES = 5 * 1024 * 1024; // arquivo real ~7.8 MB
const TESSDATA_LOCAL_DIR = path.join(ROOT, 'tessdata');
const TESSDATA_LOCAL_PATH = path.join(TESSDATA_LOCAL_DIR, 'por.traineddata');

function ensureTessdataBest({ quiet = false } = {}) {
  if (fs.existsSync(TESSDATA_LOCAL_PATH) && fs.statSync(TESSDATA_LOCAL_PATH).size >= TESSDATA_BEST_MIN_BYTES) {
    return { state: 'present', sizeMB: (fs.statSync(TESSDATA_LOCAL_PATH).size / 1024 / 1024).toFixed(1) };
  }
  fs.mkdirSync(TESSDATA_LOCAL_DIR, { recursive: true });
  const tmp = TESSDATA_LOCAL_PATH + '.part';
  try { fs.unlinkSync(tmp); } catch {}

  const stdio = quiet ? 'ignore' : 'inherit';
  let r = spawnSync('curl', ['-fsSL', '-o', tmp, TESSDATA_BEST_URL], { stdio });
  if (r.status !== 0 && platform() === 'windows') {
    const ps = `Invoke-WebRequest -Uri "${TESSDATA_BEST_URL}" -OutFile "${tmp}" -UseBasicParsing`;
    r = spawnSync('powershell', ['-NoProfile', '-Command', ps], { stdio });
  }

  if (r.status === 0 && fs.existsSync(tmp) && fs.statSync(tmp).size >= TESSDATA_BEST_MIN_BYTES) {
    fs.renameSync(tmp, TESSDATA_LOCAL_PATH);
    return { state: 'downloaded', sizeMB: (fs.statSync(TESSDATA_LOCAL_PATH).size / 1024 / 1024).toFixed(1) };
  }
  try { fs.unlinkSync(tmp); } catch {}
  return { state: 'failed', error: 'curl falhou (e PowerShell, se Windows)' };
}

module.exports = {
  ROOT,
  SETUP_LOCAL_PATH,
  TESSDATA_LOCAL_DIR,
  TESSDATA_LOCAL_PATH,
  TESSDATA_BEST_URL,
  platform,
  loadSetupLocal,
  saveSetupLocal,
  resolveTesseractCmd,
  probeTesseract,
  probeTesseractLangs,
  playwrightBrowsersDir,
  hasChromium,
  hasPlaywright,
  instructionsFor,
  ensureTessdataBest
};
