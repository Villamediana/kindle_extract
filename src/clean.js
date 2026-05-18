// Detecta linhas com texto que claramente é lixo de OCR. Critérios:
// - case bagunçado dentro da palavra (cMArcaAMst, MooM) — Tesseract confundindo letras
// - sequências longas sem vogal (CCL, MMA) — geralmente fragmentos de ícones/UI
// - excesso de palavras curtas all-caps (SL CCL TT) — também restos de UI
// Tenta NÃO filtrar texto válido com siglas tipo "ABC News" ou títulos em CAPS.
function looksLikeOcrGarbage(line) {
  const trimmed = line.trim();
  if (trimmed.length < 8) return false;
  const words = trimmed.split(/\s+/).filter(Boolean);
  if (words.length < 3) return false;

  let strongGarbage = 0;   // sinais fortes: case bagunçado, sem vogal
  let weakGarbage = 0;     // sinais fracos: curta all caps com vogal (pode ser sigla)
  let normalWords = 0;     // ≥4 chars com vogal e case razoável
  let shortAllUpperCount = 0; // palavras ≤3 chars todo em CAPS

  for (const w of words) {
    const letters = w.replace(/[^a-zA-ZÀ-ÿ]/g, '');
    if (letters.length < 2) continue;

    const hasVowel = /[aeiouáéíóúâêôãõàèìòùAEIOUÁÉÍÓÚÂÊÔÃÕ]/.test(letters);
    const allUpper = /^[A-ZÀ-Þ]+$/.test(letters);

    let switches = 0;
    for (let i = 1; i < letters.length; i++) {
      const a = letters[i - 1], b = letters[i];
      const aLow = /[a-zà-þ]/.test(a), aUp = /[A-ZÀ-Þ]/.test(a);
      const bLow = /[a-zà-þ]/.test(b), bUp = /[A-ZÀ-Þ]/.test(b);
      if ((aLow && bUp) || (aUp && bLow)) switches++;
    }

    if (switches >= 3) strongGarbage++;
    else if (switches >= 2 && letters.length <= 4) strongGarbage++;
    else if (!hasVowel && letters.length >= 2) strongGarbage++;
    else if (allUpper && letters.length <= 4 && hasVowel) {
      weakGarbage++;
      if (letters.length <= 3) shortAllUpperCount++;
    }
    else if (hasVowel && letters.length >= 4) normalWords++;
  }

  // Regra 1: tem ≥1 sinal forte + ≥3 sinais totais + mais sinais que palavras normais
  if (strongGarbage >= 1 &&
      (strongGarbage + weakGarbage) >= 3 &&
      (strongGarbage + weakGarbage) > normalWords) {
    return true;
  }

  // Regra 2: linha 100% de palavras curtas (≤3 chars) + pelo menos 1 all caps + nenhuma normal
  const allWordsShort = words.every(w => w.replace(/[^a-zA-ZÀ-ÿ]/g, '').length <= 3);
  if (words.length >= 4 && allWordsShort && shortAllUpperCount >= 1 && normalWords === 0) {
    return true;
  }

  return false;
}

function cleanText(raw) {
  if (!raw) return '';
  let text = raw
    .replace(/\r\n/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/-\n([a-záéíóúâêôãõç])/gi, '$1')
    .replace(/[ \t]{2,}/g, ' ');

  // Remove linhas que parecem lixo de OCR (Kindle e Google Books)
  text = text.split('\n')
    .filter(line => !looksLikeOcrGarbage(line))
    .join('\n');

  return text.replace(/\n{3,}/g, '\n\n').trim();
}

function dedupePageOverlap(prevTail, current) {
  if (!prevTail) return current;
  const tail = prevTail.slice(-200).trim();
  if (!tail) return current;
  const idx = current.indexOf(tail);
  if (idx >= 0 && idx < 300) {
    return current.slice(idx + tail.length).trimStart();
  }
  return current;
}

module.exports = { cleanText, dedupePageOverlap, looksLikeOcrGarbage };
