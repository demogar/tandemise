// A3 — The native About panel and the Help menu. CDP cannot read a native
// window, so the options the main process passed to setAboutPanelOptions are
// read through the test-only bridge (TANDEMISE_TEST_HOOKS=1). The panel itself
// and the Help menu are then read through macOS Accessibility (System Events),
// when this machine allows it.
import { context } from '../../p0/lib/ctx.mjs';
import { Evidence } from '../../p0/lib/evidence.mjs';
import { appVersion, electronPid, gitSha, noticeCopyright, systemEvents } from '../common.mjs';

const REPO = 'https://github.com/demogar/tandemise';
const c = await context();
const ev = new Evidence('A3', 'The About panel shows version, build, copyright, license and the repository');
const options = await c.page.evaluate('window.tandemiseTest ? window.tandemiseTest.aboutPanelOptions() : null');
ev.note(`setAboutPanelOptions received: ${JSON.stringify(options)}`);
ev.check('test hook present (TANDEMISE_TEST_HOOKS=1)', options !== null);
ev.check('applicationName is Tandemise', options?.applicationName === 'Tandemise', options?.applicationName);
ev.check(`applicationVersion is ${appVersion}`, options?.applicationVersion === appVersion, options?.applicationVersion);
ev.check(`version (the build) is the commit ${gitSha}, not Electron's version`, options?.version === gitSha, options?.version);
ev.check('copyright is NOTICE\'s line plus the Apache-2.0 license', options?.copyright === `${noticeCopyright}\nLicensed under the Apache License, Version 2.0`, options?.copyright);
ev.check('credits and website point at the repository', options?.credits?.includes(REPO) && options?.website === REPO, { credits: options?.credits, website: options?.website });
ev.check('the bridge has no test hook for anything else', (await c.page.evaluate('Object.keys(window.tandemiseTest ?? {}).join(",")')) === 'aboutPanelOptions');

// The native panel, through Accessibility.
const pid = electronPid();
try {
  const help = systemEvents(pid, '  return name of every menu item of menu 1 of menu bar item "Help" of menu bar 1');
  ev.check('Help menu: Documentation, Report an Issue, Tandemise on GitHub', ['Documentation', 'Report an Issue', 'Tandemise on GitHub'].every((m) => help.includes(m)) && !help.includes('Community Discussions'), help);
  const appMenu = systemEvents(pid, '  return name of every menu item of menu 1 of menu bar item 2 of menu bar 1');
  ev.check('the app menu has About Tandemise', appMenu.includes('About Tandemise'), appMenu);
  // The panel is the one untitled window; its credits and copyright each sit in a scroll area.
  const panel = systemEvents(pid, `  set frontmost to true
  delay 0.5
  click menu item "About Tandemise" of menu 1 of menu bar item 2 of menu bar 1
  delay 1.5
  tell (first window whose name is "")
    set out to ""
    repeat with k from 1 to (count of static texts)
      set out to out & (value of static text k) & linefeed
    end repeat
    repeat with i from 1 to (count of scroll areas)
      tell scroll area i
        repeat with j from 1 to (count of UI elements)
          try
            set out to out & (value of UI element j as text) & linefeed
          end try
        end repeat
      end tell
    end repeat
    return out
  end tell`);
  ev.note(`About panel text (Accessibility):\n${panel}`);
  ev.check(`the open panel reads "Version ${appVersion} (${gitSha})"`, panel.includes(`Version ${appVersion} (${gitSha})`), panel.split('\n').filter(Boolean));
  ev.check('the open panel shows the copyright and license', panel.includes(noticeCopyright) && panel.includes('Apache License, Version 2.0'));
  ev.check('the open panel shows the repository in its credits', panel.includes(REPO));
  // Close it: the panel is the key window now.
  systemEvents(pid, '  keystroke "w" using command down');
} catch (error) {
  ev.note(`Accessibility not available here (${String(error.message).split('\n')[0]}); the options above are the proof`);
}
c.close(); ev.save();
