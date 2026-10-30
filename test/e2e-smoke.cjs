// Browser smoke test: drives every game mode through the real UI in headless Chromium.
// Usage: node tools/serve.mjs 8080 & NODE_PATH=$(npm root -g) node test/e2e-smoke.cjs [outDir]
const { chromium } = require('playwright');
const OUT = (process.argv[2] ?? '/tmp') + '/';
const URL = process.env.URL ?? 'http://localhost:8080/?q=low';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const b = await chromium.launch({ args: ['--enable-unsafe-swiftshader', '--use-gl=angle', '--use-angle=swiftshader', '--autoplay-policy=no-user-gesture-required'] });
  const p = await b.newPage({ viewport: { width: 960, height: 540 } });
  const errors = [];
  p.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
  p.on('pageerror', (e) => errors.push('PAGEERROR: ' + e.message + ' ' + (e.stack ?? '').split('\n')[1]));
  const step = async (name, fn) => { try { await fn(); console.log('ok  ', name); } catch (e) { errors.push(`${name}: ${e.message}`); console.log('FAIL', name, e.message); } };
  const waitSession = () => p.waitForFunction(() => window.app.session && !document.querySelector('.loading'), null, { timeout: 60000 });
  const waitNoSession = () => p.waitForFunction(() => !window.app.session, null, { timeout: 180000 });

  await p.goto(URL);
  await sleep(500);
  await step('main menu', async () => { await p.waitForSelector('[data-go="gp"]'); await p.screenshot({ path: OUT + 'e-menu.png' }); });

  // ---- Grand Prix: full weekend, practice -> garage go out -> drive -> end
  await step('gp full weekend setup', async () => {
    await p.click('[data-go="gp"]');
    await p.click('[data-seg="format"] [data-v="full"]');
    await p.click('[data-seg="laps"] [data-v="3"]');
    await p.click('[data-track="kaltwald"]');
    await p.click('[data-act="start"]');
    await p.waitForSelector('[data-act="play"]');
    await p.screenshot({ path: OUT + 'e-hub.png' });
  });
  await step('practice garage + drive', async () => {
    await p.click('[data-act="play"]');
    await waitSession();
    await p.waitForSelector('[data-g="go"]');
    await p.screenshot({ path: OUT + 'e-garage.png' });
    await p.click('[data-g="go"]');
    await p.keyboard.down('KeyW');
    await sleep(1500);
    await p.evaluate(() => { const s = window.app.session; s.setPlayerInput({ throttle: 1, brake: 0, steer: 0 }); s.simulate(12); });
    await sleep(1500);
    await p.keyboard.up('KeyW');
    const st = await p.evaluate(() => ({ status: window.app.session.player.status, v: window.app.session.player.car.vx, dist: window.app.session.player.car.distance }));
    if (st.status !== 'running' || st.dist < 3) throw new Error('player did not drive: ' + JSON.stringify(st));
    await p.keyboard.press('Tab');
    await sleep(400);
    await p.screenshot({ path: OUT + 'e-practice.png' });
    await p.keyboard.press('Tab');
  });
  await step('end practice -> results', async () => {
    await p.evaluate(() => window.app.skipSession());
    await waitNoSession();
    await p.waitForSelector('[data-act="continue"]');
    await p.click('[data-act="continue"]');
  });
  await step('skip qualifying (estimate)', async () => {
    await p.waitForSelector('[data-act="skip"]');
    await p.click('[data-act="skip"]');
    await p.waitForSelector('[data-act="play"]');
    await p.screenshot({ path: OUT + 'e-hub2.png' });
  });
  await step('race start + drive + MFD pit request', async () => {
    await p.click('[data-act="play"]');
    await waitSession();
    await p.evaluate(() => window.app.session.simulate(9));
    await p.waitForFunction(() => window.app.session.phase === 'racing', null, { timeout: 60000 });
    await p.keyboard.down('KeyW');
    await p.evaluate(() => { const s = window.app.session; s.setPlayerInput({ throttle: 1, brake: 0, steer: 0 }); s.simulate(4); });
    await sleep(1500);
    await p.keyboard.press('KeyP');
    await p.keyboard.press('KeyC');
    await sleep(1500);
    await p.screenshot({ path: OUT + 'e-race.png' });
    await p.keyboard.up('KeyW');
    const req = await p.evaluate(() => window.app.session.player.pit.requested);
    if (!req) throw new Error('pit request not set');
  });
  await step('pause menu + simulate race to finish', async () => {
    await p.keyboard.press('Escape');
    await p.waitForSelector('[data-act="skip"]');
    await p.screenshot({ path: OUT + 'e-pause.png' });
    await p.click('[data-act="skip"]');
    await waitNoSession();
    await p.waitForSelector('[data-act="continue"]');
    await p.screenshot({ path: OUT + 'e-results.png' });
    await p.click('[data-act="continue"]');
    await p.waitForSelector('[data-go="career"]');
  });

  // ---- Time trial
  await step('time trial', async () => {
    await p.click('[data-go="tt"]');
    await p.click('[data-track="marina"]');
    await p.click('[data-act="start"]');
    await waitSession();
    await p.evaluate(() => { const s = window.app.session; s.setPlayerInput({ throttle: 1, brake: 0, steer: 0 }); s.simulate(4); });
    await sleep(1000);
    await p.keyboard.press('KeyC'); await p.keyboard.press('KeyC'); await p.keyboard.press('KeyC');
    await sleep(800);
    await p.screenshot({ path: OUT + 'e-tt.png' });
    await p.keyboard.press('Escape');
    await p.click('[data-act="quit"]');
    await p.waitForSelector('[data-act="back"]');
    await p.click('[data-act="back"]');
  });

  // ---- Career
  await step('career create + R&D + weekend', async () => {
    await p.click('[data-go="career"]');
    await p.fill('#cname', 'Test Driver');
    await p.click('[data-team="vortex"]');
    await p.click('[data-act="create"]');
    await p.waitForSelector('[data-act="weekend"]');
    await p.click('[data-seg="ctab"] [data-v="rd"]');
    await p.click('[data-buy="aero"]');
    await p.screenshot({ path: OUT + 'e-career.png' });
    const lvl = await p.evaluate(() => window.app.save.career.upgrades.aero);
    if (lvl !== 1) throw new Error('upgrade not bought');
    await p.click('[data-act="weekend"]');
    await p.waitForSelector('[data-act="skip"]');
    await p.click('[data-act="skip"]'); // practice
    await p.click('[data-act="skip"]'); // quali
    await p.click('[data-act="play"]');
    await waitSession();
    await p.evaluate(() => window.app.skipSession());
    await waitNoSession();
    await p.waitForSelector('[data-act="continue"]');
    await p.click('[data-act="continue"]');
    await p.waitForSelector('[data-act="weekend"]');
    const r = await p.evaluate(() => window.app.save.career.round);
    if (r !== 1) throw new Error('career round not advanced');
  });

  // ---- settings & help & records
  await step('settings/help/records', async () => {
    await p.click('[data-act="back"]');
    await p.click('[data-go="settings"]');
    await p.click('[data-seg="quality"] [data-v="low"]');
    await p.screenshot({ path: OUT + 'e-settings.png' });
    await p.click('[data-act="back"]');
    await p.click('[data-go="help"]'); await p.click('[data-act="back"]');
    await p.click('[data-go="records"]'); await p.click('[data-act="back"]');
  });

  console.log(errors.length ? 'ERRORS:\n' + errors.join('\n') : 'ALL OK');
  await b.close();
  process.exit(errors.length ? 1 : 0);
})();
