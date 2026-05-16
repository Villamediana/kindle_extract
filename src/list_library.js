const { scanLibrary, mergeIntoConfig } = require('./library');

async function main() {
  console.log('Abrindo biblioteca...');
  const books = await scanLibrary({
    onProgress: (p) => {
      if (p.phase === 'scrolling') {
        console.log(`  rodada ${p.round}: ${p.count} livros (delta ${p.delta})`);
      } else if (p.phase === 'collecting') {
        console.log('Coletando livros (scroll incremental)...');
      }
    }
  });

  if (books.length === 0) {
    console.error('Nenhum livro encontrado.');
    process.exit(3);
  }

  const { total, added } = mergeIntoConfig(books);
  console.log(`\nGravados ${total} livros no config.json (${added} novos desta varredura).`);
  console.log('\nPrimeiros 10:');
  books.slice(0, 10).forEach((b, i) =>
    console.log(`  ${i + 1}. [${b.asin}] ${b.title}${b.author ? ' — ' + b.author : ''}`)
  );
}

main().catch(err => {
  console.error('Erro:', err.message);
  process.exit(1);
});
