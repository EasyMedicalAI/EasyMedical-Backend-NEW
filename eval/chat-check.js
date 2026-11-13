// Runs each case through the real AI-pinion routes and checks the top three.
// COSTS MONEY: every case makes several model calls. Needs ANTHROPIC_API_KEY. Run only when agreed:
//   AI_PINION_ENABLED=true ANTHROPIC_API_KEY=... node eval/chat-check.js
// Answers each question with its first option (or "Not sure"), so the chat is repeatable.
const express = require('express');
const Anthropic = require('@anthropic-ai/sdk');
// The hourly cap is for the live server. Test runs make many calls, so raise it here.
process.env.AI_PINION_HOURLY_LIMIT = process.env.AI_PINION_HOURLY_LIMIT || '100000';
const { mountAiPinionRoutes } = require('../aipinion');
const { emergencyReason } = require('../triage');
// ONLY=id1,id2 runs just those cases (useful for a first test)
const cases = require('./aipinion-cases.json').cases.filter((c) => !process.env.ONLY || process.env.ONLY.split(',').includes(c.id));

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
        // Answers 'Not sure' when offered. Otherwise the first option that is not a warning sign (those stop the chat).
        const options = turn.options || [];
        const pick = options.find((o) => /not sure/i.test(o)) || options.find((o) => !emergencyReason(o)) || options[0] || 'Not sure';
        messages.push({ role: 'user', content: pick });
      } else if (turn.type === 'candidates') {
        names = turn.candidates.map((x) => x.name);
      } else {
        console.log(`${c.id}: stopped with ${turn.type}: ${JSON.stringify(turn).slice(0, 300)}`);
        break;
      }
    }
    if (!names) {
      console.log(`MISS ${c.id}: no possibilities after ${turns} turns`);
      continue;
    }
    // A name counts if an accepted name appears in it as whole words, so 'Gout (acute gouty arthritis)' matches 'Gout'
    const escape = (t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const ok = names.some((n) => c.accept.some((e) => new RegExp(`\\b${escape(e)}\\b`, 'i').test(n)));
    if (ok) passed += 1;
    console.log(`${ok ? 'PASS' : 'MISS'} ${c.id}: ${names.join(' | ')} (${turns} turns)`);
  }
  console.log(`\nExpected condition in the top three for ${passed} of ${cases.length} cases.`);
  server.close();
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
