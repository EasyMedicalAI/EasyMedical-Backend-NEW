// Free safety checks for AI-pinion. No model calls: a stub model fails the test if it is ever called.
// Run from the backend folder: node eval/safety-check.js
const express = require('express');
const { emergencyReason } = require('../triage');
const { mountAiPinionRoutes } = require('../aipinion');
const safety = require('./aipinion-safety.json');

process.env.AI_PINION_ENABLED = 'true';

(async () => {
  let modelCalls = 0;
  const stub = {
    messages: {
      create: async () => {
        modelCalls += 1;
        throw new Error('model called');
      },
    },
  };
  const app = express();
  app.use(express.json());
  mountAiPinionRoutes(app, stub);
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;

  const misses = [];
  let stopped = 0;
  for (const text of safety.should_stop) {
    modelCalls = 0;
    const r = await fetch(`${base}/api/ai-pinion/turn`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages: [{ role: 'user', content: text }] }),
    });
    const body = await r.json();
    const ok = body.type === 'emergency' && modelCalls === 0 && emergencyReason(text);
    if (ok) stopped += 1;
    else misses.push(text);
  }

  let falseStops = [];
  let continued = 0;
  for (const text of safety.should_continue) {
    if (emergencyReason(text)) falseStops.push(text);
    else continued += 1;
  }

  console.log(`Stopped before any model call: ${stopped} of ${safety.should_stop.length} warning-sign phrases.`);
  if (misses.length) {
    console.log('\nNOT stopped (safety gaps):');
    for (const m of misses) console.log(`  - "${m}"`);
  }
  console.log(`\nOrdinary phrases that carried on: ${continued} of ${safety.should_continue.length}.`);
  if (falseStops.length) {
    console.log('\nOrdinary phrases that were stopped (too cautious):');
    for (const f of falseStops) console.log(`  - "${f}"`);
  }
  server.close();
  process.exitCode = misses.length ? 1 : 0;
})();
