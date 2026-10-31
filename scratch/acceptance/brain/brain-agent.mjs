#!/usr/bin/env node
// The brain acceptance's stand-in for a model (#51). A Generic CLI runtime
// (promptVia: stdin) routed to the project's roles:
//
//   - a reflector prompt gets one lesson back, as a fenced JSON block;
//   - a promoter prompt gets each target file back with the lessons appended;
//   - any other prompt is handed to the P0 scripted agent unchanged, so the
//     project's ordinary steps run exactly as in every other suite.
import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const prompt = Buffer.concat(chunks).toString('utf8');

if (prompt.includes("You are the reflector for a software team's shared memory.")) {
  // A hold whose diff says what changed teaches one lesson; anything else teaches nothing new.
  const lessons = /Changed while held: [1-9]/.test(prompt)
    ? [{ text: 'Keep the header sticky on mobile.', scope: { role: 'development' } }]
    : [];
  process.stdout.write(`I looked at the correction.\n\n\`\`\`json\n${JSON.stringify({ lessons, tags: [] })}\n\`\`\`\n`);
  process.exit(0);
}

if (prompt.includes('You turn lessons that keep proving useful into curated rules')) {
  const lessons = [...prompt.matchAll(/^- \[[^\]]+\] (.+?) \(helpful/gm)].map((m) => m[1]);
  const files = [...prompt.matchAll(/<target path="([^"]+)">\n([\s\S]*?)\n<\/target>/g)].map((m) => {
    const current = m[2] === '(a new file)' ? '' : m[2];
    const head = current === '' ? `# Rules\n` : current.replace(/\n*$/, '\n');
    return { path: m[1], content: `${head}${lessons.map((l) => `- ${l}`).join('\n')}\n` };
  });
  process.stdout.write(`\`\`\`json\n${JSON.stringify({ files })}\n\`\`\`\n`);
  process.exit(0);
}

const child = spawn(process.execPath, [join(here, '..', 'p0', 'scripted-agent.mjs'), ...process.argv.slice(2)], { stdio: ['pipe', 'inherit', 'inherit'] });
child.stdin.end(prompt);
child.on('close', (code) => process.exit(code ?? 1));
