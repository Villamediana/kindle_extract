# Deploy — Kindle Extract

Playwright headless que autentica via cookies importados, extrai texto do DOM do Kindle Cloud Reader, faz OCR de PDFs.

## Serviço

- **URL pública**: nenhuma (rodar em `localhost:3400`)
- **Porta interna**: `3400` (only `127.0.0.1`)
- **Backend**: `src/server.js`
- **UI local**: `public/` — servido pelo próprio Express
- **Runner**: tmux (não systemd)
- **Consumidor**: MCP source `kindle` faz proxy pra `http://127.0.0.1:3400`

Não tem nginx nem TLS: só usado local ou via MCP.

## Setup em nova VM

Pré-requisitos:
- Node ≥ 20
- Chromium (para Playwright)
- `tesseract-ocr` (com pacote de idioma português)

```bash
sudo apt install -y chromium-browser tesseract-ocr tesseract-ocr-por
```

Clonar e instalar:

```bash
cd ~
git clone https://github.com/Villamediana/kindle_extract.git
cd kindle_extract
npm install
npx playwright install chromium
```

## Rodar

Não usa systemd. Roda numa sessão persistente do tmux (`applocal`):

```bash
tmux new-session -d -s applocal
tmux send-keys -t applocal 'cd ~/kindle_extract && node src/server.js' Enter
```

Ou manualmente:

```bash
cd ~/kindle_extract && node src/server.js
```

## Autenticação Kindle

`cookies.json` já vem no repo — cookies exportados de uma sessão logada no `read.amazon.com.br`. Se caducar:

1. Fazer login no Kindle Cloud Reader no browser
2. Exportar cookies (extensão como "Cookie-Editor") pro formato JSON
3. Substituir `cookies.json`

**Importante**: `cookies.json` dá acesso à conta Amazon. Manter o repo **privado**.

## Dependências e dados

- `output/` — textos extraídos dos livros (`.txt`)
- `pdfs/` — PDFs importados manualmente
- `tessdata/` — modelo Tesseract (`por.traineddata`)
- `screenshots/` — debug de sessões Playwright
- `excluded.json` — lista de livros ignorados no scan
- `config.json` — configuração local do usuário

Todos vêm no repo. `debug/`, `session/`, `tmp_ocr/`, `server.log` são ignorados.

## Integração com MCP

O MCP (`src/sources/kindle/index.js`) espera:

- Este servidor rodando em `http://127.0.0.1:3400`
- Diretório fixo em `/home/miguel/kindle_extract`
- Acesso direto aos `.txt` em `output/`
- `cookies.json` acessível

Se mudar o path, editar `KINDLE_DIR` em `src/sources/kindle/index.js` do MCP.
