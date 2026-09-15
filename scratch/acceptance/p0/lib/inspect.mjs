// Prints what a scenario can see and press on the current screen.
import { connect } from './cdp.mjs';
const port = Number(process.env.CDP_PORT ?? 9333);
const p = await connect(port, { timeoutMs: 90000 });
if (process.argv[2]) await p.navigate(process.argv[2]);
await new Promise((r) => setTimeout(r, 1500));
const info = await p.evaluate(`(() => {
  const vis = (el) => el.offsetParent !== null;
  const buttons = [...document.querySelectorAll('button,a,[role=tab],[role=button]')].filter(vis).map(b => (b.innerText||b.getAttribute('aria-label')||'').trim().replace(/\\s+/g,' ')).filter(Boolean);
  const fields = [...document.querySelectorAll('input,textarea,select')].filter(vis).map(f => {
    const l = f.labels?.[0]?.innerText?.trim() || f.getAttribute('aria-label') || f.placeholder || f.name;
    const opts = f.tagName === 'SELECT' ? ' [' + [...f.options].map(o=>o.text).join(' | ') + ']' : '';
    return f.tagName.toLowerCase() + ':' + l + opts;
  });
  return { hash: location.hash, buttons: [...new Set(buttons)], fields };
})()`);
console.log(JSON.stringify(info, null, 1));
if (process.argv[3]) await p.screenshot(process.argv[3]);
p.close();
