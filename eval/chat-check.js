// Runs each case through the real AI-pinion routes and checks the top three.
// COSTS MONEY: every case makes several model calls. Needs ANTHROPIC_API_KEY. Run only when agreed:
//   AI_PINION_ENABLED=true ANTHROPIC_API_KEY=... node eval/chat-check.js
// Answers each question with its first option (or "Not sure"), so the chat is repeatable.
const express = require('express');
const Anthropic = require('@anthropic-ai/sdk');
const { mountAiPinionRoutes } = require('../aipinion');
const cases = require('./aipinion-cases.json').cases;

process.env.AI_PINION_ENABLED = 'true';
const MAX_TURNS = 10;

(async () => {
  const app = express();
  app.use(express.json());
  mountAiPinionRoutes(app, new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY }));
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = async (path, body) => {
    const r = await fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    return r.json();
  };

  let passed = 0;
  for (const c of cases) {
    const messages = [{ role: 'user', content: c.story }];
    let names = null;
    let turns = 0;
    while (turns < MAX_TURNS && !names) {
      turns += 1;
      const turn = await post('/api/ai-pinion/turn', { messages });
      if (turn.type === 'question') {
        messages.push({ role: 'assistant', content: turn.text });
        messages.push({ role: 'user', content: turn.options?.[0] || 'Not sure' });
      } else if (turn.type === 'candidates') {
        names = turn.candidates.map((x) => x.name);
      } else {
        console.log(`${c.id}: stopped with ${turn.type}`);
        break;
      }
    }
    if (!names) {
      console.log(`MISS ${c.id}: no possibilities after ${turns} turns`);
      continue;
    }
    const ok = names.some((n) => c.expect_any_of.some((e) => n.toLowerCase() === e.toLowerCase()));
    if (ok) passed += 1;
    console.log(`${ok ? 'PASS' : 'MISS'} ${c.id}: ${names.join(' | ')} (${turns} turns)`);
  }
  console.log(`\nExpected condition in the top three for ${passed} of ${cases.length} cases.`);
  server.close();
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
