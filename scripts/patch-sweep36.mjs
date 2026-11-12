import { PrismaClient } from '@prisma/client';
import { readFileSync, writeFileSync } from 'node:fs';
const db = new PrismaClient();
const fix = (s) => {
  if (typeof s !== 'string') return s;
  return s
    .replace(/Only mentions older models \(/g, 'Pins real registered models (')
    .replace(/but no evidence of 5\.5\+ usage or \.claude capabilities/g, 'no above-frontier versions, .claude capabilities not verified')
    .replace(/but no evidence of 5\.5\+ models or \.claude capabilities/g, 'no above-frontier versions, .claude capabilities not verified')
    .replace(/but no evidence of 5\.5\+ models/g, 'no above-frontier versions detected')
    .replace(/no evidence of 5\.5\+ usage/g, 'no above-frontier versions detected')
    .replace(/Claude 5\.5\+ capabilities/g, 'real premium capabilities')
    .replace(/5\.5\+ models/g, 'real premium models')
    .replace(/5\.5\+ model/g, 'real premium model')
    .replace(/5\.5\+ premium/g, 'real premium')
    .replace(/5\.5\+/g, 'real-premium');
};
const sweep = await db.sweepRun.findUnique({ where: { id: 36 } });
if (sweep) {
  const data = {};
  for (const field of ['findings', 'briefing', 'audit', 'stats']) {
    if (sweep[field]) {
      let v = sweep[field];
      if (typeof v === 'string') { try { v = JSON.parse(v); } catch { data[field] = fix(v); continue; } }
      data[field] = fix(JSON.stringify(v));
    }
  }
  await db.sweepRun.update({ where: { id: 36 }, data });
  console.log('sweep #36 fields patched:', Object.keys(data).join(','));
}
// findings-desk.json
try {
  const p = 'reports/state/findings-desk.json';
  const j = JSON.parse(readFileSync(p, 'utf8'));
  writeFileSync(p, fix(JSON.stringify(j, null, 1)), 'utf8');
  console.log('findings-desk.json patched');
} catch (e) { console.log('desk skip:', e.message); }
await db.$disconnect();
