/**
 * The long-lived browser process behind live_test. It runs the project's own Playwright,
 * opens one page, then reads one JSON command per line on stdin and answers each with a
 * `__TESTPILOT__{...}` line on stdout. It exits when told to close, when stdin closes
 * (the server went away) or when the user closes the browser window.
 */
export const LIVE_DRIVER_SCRIPT = String.raw`
import { createRequire } from 'node:module';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';

const send = m => process.stdout.write('__TESTPILOT__' + JSON.stringify(m) + '\n');
const firstLines = (e, n = 6) => String(e && e.message || e).split('\n').filter(l => l.trim()).slice(0, n).join('\n');
const args = JSON.parse(process.env.TESTPILOT_LIVE);

let pw;
for (const base of args.resolveFrom) {
  const req = createRequire(path.join(base, 'package.json'));
  for (const name of ['@playwright/test', 'playwright']) { try { pw = req(name); break; } catch {} }
  if (pw) break;
}
if (!pw) { send({ id: 0, ok: false, fatal: 'Playwright is not installed in this project. Run npm install, then npx playwright install chromium.' }); process.exit(0); }

const launch = {};
if (process.env.BROWSER_CHANNEL) launch.channel = process.env.BROWSER_CHANNEL;
if (process.env.BROWSER_EXECUTABLE_PATH) launch.executablePath = process.env.BROWSER_EXECUTABLE_PATH;
let headed = !!args.headed;
let headedFallback;
let browser;
try {
  browser = await pw.chromium.launch({ ...launch, headless: !headed, slowMo: headed ? args.slowMo : 0 });
} catch (e) {
  if (!headed) { send({ id: 0, ok: false, fatal: 'Could not start the browser: ' + firstLines(e, 1) + '. Run npx playwright install chromium, or set BROWSER_CHANNEL=chrome to use the installed Chrome.' }); process.exit(0); }
  headedFallback = firstLines(e, 1);
  headed = false;
  try { browser = await pw.chromium.launch({ ...launch, headless: true }); }
  catch (e2) { send({ id: 0, ok: false, fatal: 'Could not start the browser: ' + firstLines(e2, 1) + '. Run npx playwright install chromium, or set BROWSER_CHANNEL=chrome to use the installed Chrome.' }); process.exit(0); }
}
const context = await browser.newContext({ ignoreHTTPSErrors: !!args.ignoreHttpsErrors, viewport: { width: 1280, height: 800 }, ...(args.storageState ? { storageState: args.storageState } : {}) });
let page = await context.newPage();
context.on('page', p => { page = p; });
let closing = false;
browser.on('disconnected', () => { if (!closing) { send({ id: -1, ok: false, closed: true, error: 'The browser was closed.' }); process.exit(0); } });
mkdirSync(args.outDir, { recursive: true });
let shot = 0;

async function state(label) {
  await page.waitForLoadState('domcontentloaded', { timeout: 10000 }).catch(() => {});
  await page.waitForLoadState('networkidle', { timeout: 3000 }).catch(() => {});
  const snapshot = await page.locator('body').ariaSnapshot({ timeout: 10000 }).catch(() => '');
  const title = await page.title().catch(() => '');
  const testIds = await page.$$eval('[data-testid],[data-test],[data-qa],[data-cy],[data-test-id]', els => els.slice(0, 200).map(e => {
    const attr = ['data-testid', 'data-test', 'data-qa', 'data-cy', 'data-test-id'].find(a => e.hasAttribute(a));
    return { attr, value: e.getAttribute(attr), tag: e.tagName.toLowerCase(), text: (e.textContent || '').trim().slice(0, 60) };
  })).catch(() => []);
  shot++;
  let screenshot = path.join(args.outDir, String(shot).padStart(2, '0') + '-' + String(label || 'page').replace(/[^a-z0-9]+/gi, '-').slice(0, 40) + '.png');
  await page.screenshot({ path: screenshot }).catch(() => { screenshot = undefined; });
  return { url: page.url(), title, snapshot: snapshot.slice(0, 40000), testIds, screenshot };
}

function locate(t) {
  if (!t) throw new Error('This action needs a target.');
  let loc;
  const exact = t.exact ? { exact: true } : {};
  if (t.role) loc = page.getByRole(t.role, t.name !== undefined ? { name: t.name, ...exact } : {});
  else if (t.label) loc = page.getByLabel(t.label, exact);
  else if (t.placeholder) loc = page.getByPlaceholder(t.placeholder, exact);
  else if (t.text) loc = page.getByText(t.text, exact);
  else if (t.testId) loc = page.getByTestId(t.testId);
  else if (t.css) loc = page.locator(t.css);
  else throw new Error('A target needs a role (with name), label, placeholder, text, testId or css.');
  return typeof t.nth === 'number' ? loc.nth(t.nth) : loc;
}

async function poll(check, timeout, message) {
  const end = Date.now() + timeout;
  for (;;) {
    if (await check()) return;
    if (Date.now() > end) throw new Error(message());
    await new Promise(r => setTimeout(r, 200));
  }
}

async function perform(c) {
  const timeout = c.timeoutMs || 10000;
  const v = c.value ?? '';
  switch (c.action) {
    case 'goto': {
      const base = page.url() === 'about:blank' ? args.url : page.url();
      await page.goto(new URL(v || '/', base).href, { waitUntil: 'domcontentloaded', timeout: 30000 });
      return;
    }
    case 'click': return locate(c.target).click({ timeout });
    case 'fill': return locate(c.target).fill(v, { timeout });
    case 'select': return void (await locate(c.target).selectOption(v, { timeout }));
    case 'check': return locate(c.target).check({ timeout });
    case 'uncheck': return locate(c.target).uncheck({ timeout });
    case 'press': return c.target ? locate(c.target).press(v, { timeout }) : page.keyboard.press(v);
    case 'hover': return locate(c.target).hover({ timeout });
    case 'expectVisible': return locate(c.target).waitFor({ state: 'visible', timeout });
    case 'expectText':
      if (c.target) {
        const loc = locate(c.target);
        let last = '';
        return poll(async () => { last = await loc.innerText({ timeout: 2000 }).catch(() => ''); return last.includes(v); }, timeout, () => 'Expected the element to contain the text, but it showed: ' + last.slice(0, 200));
      }
      return page.getByText(v).first().waitFor({ state: 'visible', timeout });
    case 'expectUrl':
      return poll(async () => page.url().includes(v), timeout, () => 'Expected the address to contain the text, but it is ' + page.url());
    default: throw new Error('Unknown action ' + c.action);
  }
}

async function handle(c) {
  if (c.op === 'close') { closing = true; await browser.close().catch(() => {}); send({ id: c.id, ok: true, closed: true }); process.exit(0); }
  if (c.op === 'snapshot') return send({ id: c.id, ok: true, headed, ...(await state(c.label || 'snapshot')) });
  if (c.op === 'step') {
    let error;
    try { await perform(c); } catch (e) { error = firstLines(e); }
    return send({ id: c.id, ok: !error, error, headed, ...(await state(c.label || c.action)) });
  }
  send({ id: c.id, ok: false, error: 'Unknown command' });
}

let startError;
try { await page.goto(args.url, { waitUntil: 'domcontentloaded', timeout: 30000 }); } catch (e) { startError = firstLines(e, 2); }
send({ id: 0, ok: !startError, ready: true, error: startError, headed, headedFallback, ...(await state('start')) });

let chain = Promise.resolve();
const rl = readline.createInterface({ input: process.stdin });
rl.on('line', line => {
  let c;
  try { c = JSON.parse(line); } catch { return; }
  chain = chain.then(() => handle(c)).catch(e => send({ id: c.id, ok: false, error: firstLines(e) }));
});
rl.on('close', async () => { closing = true; await browser.close().catch(() => {}); process.exit(0); });
`;
