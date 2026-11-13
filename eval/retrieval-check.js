// Checks that PubMed search finds relevant articles for each case's conditions. Uses PubMed only (no model, no cost).
// Run from the backend folder: node eval/retrieval-check.js
const { articlesFor } = require('../pubmed');
const cases = require('./aipinion-cases.json').cases;

(async () => {
  let hits = 0;
  let total = 0;
  for (const c of cases) {
    for (const name of c.accept.slice(0, 1)) {
      total += 1;
      let articles = [];
      try {
        articles = await articlesFor(name, 3);
      } catch (error) {
        console.log(`${c.id}: PubMed error (${error.message})`);
        continue;
      }
      const titleHits = articles.filter((a) => a.title.toLowerCase().includes(c.keyword)).length;
      const ok = titleHits >= 1;
      if (ok) hits += 1;
      console.log(`${ok ? 'PASS' : 'MISS'} ${c.id} (${name}): ${titleHits} of ${articles.length} titles mention "${c.keyword}"`);
      for (const a of articles) console.log(`    - ${a.year} ${a.title.slice(0, 100)}`);
    }
  }
  console.log(`\nRelevant titles found for ${hits} of ${total} conditions.`);
})();
