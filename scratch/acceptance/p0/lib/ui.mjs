// Scenario-level UI helpers built on the CDP page.
import { sleep, until } from './api.mjs';

export function ui(page) {
  const buttons = () => page.evaluate(`[...document.querySelectorAll('button')].filter(b=>b.offsetParent).map(b=>b.innerText.trim().replace(/\\s+/g,' ')).filter(Boolean)`);
  const clickLast = (label) => page.evaluate(`(() => { const b = [...document.querySelectorAll('button')].filter(x => x.offsetParent !== null && x.innerText.trim() === ${JSON.stringify(label)}); const el = b[b.length-1]; if (!el) return false; el.scrollIntoView({block:'center'}); el.click(); return true; })()`);
  const clickStarting = (prefix) => page.evaluate(`(() => { const b = [...document.querySelectorAll('button')].filter(x => x.offsetParent !== null && x.innerText.trim().replace(/\\s+/g,' ').startsWith(${JSON.stringify(prefix)})); const el = b[0]; if (!el) return false; el.scrollIntoView({block:'center'}); el.click(); return true; })()`);
  return {
    buttons, clickLast, clickStarting,
    async inbox(filter) {
      await page.navigate('#/inbox');
      await sleep(900);
      if (filter) { await clickStarting(filter); await sleep(500); }
      return page.text('main');
    },
    /** Opens the inbox item whose button text starts with `title`. */
    async openItem(title, filter = 'Everyone') {
      const end = Date.now() + 30000;
      for (;;) {
        await this.inbox(filter);
        if (await clickStarting(title)) break;
        if (Date.now() > end) throw new Error(`inbox item "${title}" never appeared`);
        await sleep(1500);
      }
      await sleep(700);
      const open = async () => /YOUR OPTIONS|YOUR ANSWER|Mark done|Claim for|Done by/.test(await page.text('main'));
      if (!(await open())) { await clickStarting(title); await sleep(700); }
    },
    /** Opens the inbox row for task `key` that belongs to the mission titled `missionTitle`. */
    async openTask(key, missionTitle, filter = 'Everyone') {
      const end = Date.now() + 30000;
      const clickRow = () => page.evaluate(`(() => { const b = [...document.querySelectorAll('button')].find(x => x.offsetParent && x.innerText.trim().startsWith(${JSON.stringify(key)}) && x.innerText.includes(${JSON.stringify(missionTitle)})); if (!b) return false; b.scrollIntoView({block:'center'}); b.click(); return true; })()`);
      for (;;) {
        await this.inbox(filter);
        if (await clickRow()) break;
        if (Date.now() > end) throw new Error(`inbox task "${key}" for "${missionTitle}" never appeared`);
        await sleep(1500);
      }
      await sleep(700);
      if (!/YOUR OPTIONS|YOUR ANSWER|Mark done|Claim for|Done by/.test(await page.text('main'))) { await clickRow(); await sleep(700); }
    },
    async radio(label) {
      const ok = await page.evaluate(`(() => { const el = [...document.querySelectorAll('label,[role=radio],button')].find(x => x.offsetParent && x.innerText.trim().replace(/\\s+/g,' ').startsWith(${JSON.stringify(label)})); if (!el) return false; el.click(); return true; })()`);
      if (!ok) throw new Error(`no option "${label}"`);
      await sleep(300);
    },
  };
}
