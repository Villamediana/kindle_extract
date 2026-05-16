function cleanText(raw) {
  if (!raw) return '';
  return raw
    .replace(/\r\n/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/-\n([a-záéíóúâêôãõç])/gi, '$1')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
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

module.exports = { cleanText, dedupePageOverlap };
