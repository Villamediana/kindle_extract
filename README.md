# Kindle Extract

Extrai texto de livros do **Kindle Cloud Reader** (read.amazon.com) usando seu próprio login (cookies importados). Inclui dashboard web com extração ao vivo e leitor com tipografia agradável.

100% no servidor — não precisa de VNC, X11, nem máquina local rodando nada durante a extração.

## Como funciona

Cada página do Kindle Cloud Reader é renderizada como **imagem** (modo "kr-fullpage-document") e o Amazon bloqueia `fetch`/`XHR` no blob URL, então a única forma de chegar no texto é:

```
abre o livro → vira página → captura PNG via canvas → Tesseract OCR (pt) → escreve no .txt → vira próxima
```

O OCR roda **em paralelo** com a virada da próxima página (pipeline async). Tempo médio: **~5-9s por página**.

## Setup rápido

```bash
git clone <repo> && cd kindle_extract
npm install
npm run setup          # verifica/instala tudo que falta
```

O `npm run setup` checa e instala automaticamente:

- ✓ Node 18+
- ✓ Dependências do `package.json` (npm install)
- ✓ Chromium do Playwright
- ✓ Tesseract OCR + pacote de idioma português (via apt em Debian/Ubuntu)
- ✓ Diretórios de trabalho (`output/`, `tmp_ocr/`, `session/`, etc.)
- ⚠ Avisa se faltar `cookies.json` ou `config.json` (não bloqueia — dá pra configurar pelo UI)

No primeiro `apt-get` o terminal vai pedir sua senha (sudo).

## Configurar cookies (autenticação)

A Amazon não tem login via API, então autenticamos importando os cookies do seu browser:

1. No seu **PC local**, instale a extensão [Cookie-Editor](https://chromewebstore.google.com/detail/cookie-editor/hlkenndednhfkekhgcdicdfddnkalmdm) no Chrome/Brave/Edge.
2. Logue em **read.amazon.com** normalmente.
3. Clique no ícone da extensão → **Export → Export as JSON**.
4. Inicie o server (`npm run server`) e abra `http://SEU_SERVIDOR:3400`.
5. Clique no botão **Cookies** no topo → cole o JSON na textarea → clique **Validar &amp; testar login**.

O sistema valida o JSON, confere se tem os cookies obrigatórios (`at-main`, `sess-at-main`, `x-main`, `ubid-main`, `session-id`), salva em `cookies.json`, e abre o Kindle uma vez pra confirmar que está logado de verdade.

**Sessão expira a cada poucas semanas.** Quando expirar, basta repetir o passo 5.

## Configurar a lista de livros

Edite `config.json` com os ASINs (IDs Amazon) dos livros que você quer extrair:

```json
{
  "books": [
    { "asin": "B0752X3H64", "title": "Cartas de um diabo a seu aprendiz", "author": "Lewis, C. S." },
    { "asin": "B07V8LHWZ5", "title": "Hábitos Atômicos", "author": "Clear, James" }
  ],
  "settings": {
    "pageDelayMs": 1500,
    "headless": true
  }
}
```

Para descobrir os ASINs, abra cada livro em `read.amazon.com` e copie da URL (`?asin=BXXXXXXX`). Tem também o script `npm run list-library` que faz isso automaticamente.

Campos opcionais por livro:
- `maxPages`: limita a quantidade de páginas a extrair (útil pra testes)

## Uso

### UI web (recomendado)

```bash
npm run server                              # foreground (Ctrl+C pra parar)
# ou em background, sobrevive logout:
nohup npm run server > server.log 2>&1 &
```

Abra `http://SEU_SERVIDOR:3400` no navegador. A interface tem:

- **Topo**: contadores (livros, prontos, parciais, cookies OK?), botão de cookies, iniciar/parar
- **Sidebar**: biblioteca com busca, filtros (todos/prontos/parciais/pendentes), pontinhos de status, botão de reset por livro (no hover)
- **Aba "Ao vivo"**: livro atual, página, caracteres extraídos, preview do texto sendo extraído agora, tail do arquivo `.txt` se atualizando
- **Aba "Leitor"**: lê o `.txt` extraído com tipografia serif, fonte ajustável, botão de download e botão de reset
- **Aba "Logs"**: stream colorido de eventos em tempo real

### Linha de comando

```bash
npm run extract             # roda extração de todos os livros do config.json
```

O processo é resiliente: estado de cada livro é salvo a cada página em `output/<titulo>.state.json`. Se parar no meio, na próxima rodada ele retoma da última página extraída.

### Reset (apagar e refazer)

Pelo UI: hover num livro na sidebar → clique no ⟳, ou abra um livro no Leitor → botão ⟳ no canto.

Pela API:

```bash
curl -X POST http://localhost:3400/api/book/B0752X3H64/reset
```

Pela CLI: apague os arquivos manualmente:

```bash
rm output/<titulo>.txt output/<titulo>.state.json
```

## Estrutura

```
kindle_extract/
├── public/              # UI (HTML + CSS + JS estáticos)
│   ├── index.html
│   ├── style.css
│   └── app.js
├── src/
│   ├── server.js        # Express na porta 3400 + SSE
│   ├── setup.js         # verifica/instala dependências
│   ├── extract.js       # extração com Playwright + Tesseract
│   ├── login.js         # validação CLI de cookies
│   ├── list_library.js  # lista a biblioteca do Kindle
│   ├── clean.js         # normalização de texto pós-OCR
│   ├── inspect_reader.js# debug: dumpa HTML/screenshots do reader
│   └── probe_blob.js    # debug: investiga o blob da página
├── output/              # .txt e .state.json de cada livro
├── tmp_ocr/             # PNGs temporários (auto-limpo)
├── session/             # perfil persistente do Chromium
├── cookies.json         # gitignored
├── config.json          # lista de livros + settings
├── server.log           # log do server quando rodando em nohup
└── package.json
```

## API REST

| Método | Rota | Descrição |
|---|---|---|
| GET | `/api/status` | livros + status de cada um, settings, se está rodando |
| GET | `/api/setup-status` | health-check do ambiente (node, playwright, tesseract, etc.) |
| GET | `/api/file/:name` | conteúdo completo do .txt |
| GET | `/api/file/:name/tail` | últimos 4KB do .txt (pra view ao vivo) |
| GET | `/api/logs` | últimos 200 eventos |
| GET | `/api/events` | stream SSE de eventos ao vivo |
| POST | `/api/start` | inicia extração. Body opcional: `{"asins":["B0..."]}` para extrair só alguns |
| POST | `/api/stop` | para a extração atual |
| POST | `/api/cookies` | salva cookies (body = array JSON de cookies) |
| POST | `/api/check-login` | abre Kindle e valida que está logado |
| POST | `/api/book/:asin/reset` | apaga .txt + state do livro |

## Troubleshooting

**"cookies não autenticaram"** — sessão expirou ou exportou do domínio errado. Refaça a exportação de cookies (precisa estar logado na hora) e cole de novo.

**"Tesseract não instalado"** — rode `npm run setup` que tenta instalar via `apt-get`. Em outros OS:
- macOS: `brew install tesseract tesseract-lang`
- Fedora: `sudo dnf install tesseract tesseract-langpack-por`

**OCR lento (>15s/página)** — pode ser que a imagem da página esteja muito grande. Tesseract com `--psm 3 --oem 1 -l por` é o setting mais rápido com qualidade.

**Texto com colunas embaralhadas** — o `--psm 3` (auto layout) já lida com a maioria dos casos. Se ainda assim vier embaralhado, edite `src/extract.js` e teste `--psm 1` (mais lento mas usa OSD).

**Página única só tem chrome do Kindle ("Page X of Y...")** — a página não acabou de renderizar antes da captura. Aumente `pageDelayMs` em `config.json`.

**Quero rodar de novo em livro já completo** — use o reset (UI ou API), porque o sistema pula livros marcados como `completed`.

## Notas

- Tudo roda em headless, sem display gráfico. Ideal pra rodar em VPS.
- O leitor do Kindle Cloud Reader pode mudar a qualquer momento (já mudou de modo "reflowable" pra "fullpage" recentemente). Se quebrar, rode `node src/inspect_reader.js B0XXXXXXX` pra ver a estrutura atual.
- Os PNGs intermediários ficam em `tmp_ocr/<asin>/` durante a extração e são deletados ao final de cada livro.
- A porta 3400 precisa estar liberada no firewall do servidor (ufw/iptables) e também no security group do provedor de cloud, se aplicável.
