import { chromium } from 'playwright';
import fs from 'node:fs/promises';
import path from 'node:path';

const FORM_URL = process.env.FORM_URL || 'https://airtable.com/appsseXTOVx59HC0W/pagcVengefPFQvMZC/form';
const TARGET_TEXT = process.env.TARGET_TEXT || '63-16 102nd Street';
const OUT = path.resolve('artifacts');
await fs.mkdir(OUT, { recursive: true });

const result = {
  safeDryRun: true,
  formUrl: FORM_URL,
  target: TARGET_TEXT,
  startedAt: new Date().toISOString(),
  formLoaded: false,
  cookieHandled: false,
  addUnitClicked: false,
  targetFound: false,
  targetMatches: [],
  candidateOptions: [],
  notes: []
};

const write = async (name, data) => {
  const body = typeof data === 'string' ? data : JSON.stringify(data, null, 2);
  await fs.writeFile(path.join(OUT, name), body, 'utf8');
};

const clean = (s) => String(s ?? '')
  .replace(/\u00a0/g, ' ')
  .replace(/[ \t]+/g, ' ')
  .replace(/\r/g, '')
  .trim();

const uniq = (arr) => [...new Set(arr.map(clean).filter(Boolean))];

async function getScope(page) {
  const dialog = page.locator('[role="dialog"]:visible');
  if (await dialog.count()) return dialog.last();

  const listbox = page.locator('[role="listbox"]:visible');
  if (await listbox.count()) return listbox.last();

  return page.locator('body');
}

async function collectRoleText(page) {
  const selectors = [
    '[role="option"]:visible',
    '[role="menuitem"]:visible',
    '[role="menuitemradio"]:visible',
    '[role="treeitem"]:visible',
    '[role="row"]:visible'
  ];
  const out = [];
  for (const selector of selectors) {
    try { out.push(...await page.locator(selector).allInnerTexts()); } catch {}
  }
  return uniq(out);
}

async function collectWithScroll(scope, page) {
  const seen = new Set();

  async function capture() {
    for (const t of await collectRoleText(page)) seen.add(t);
    try {
      const raw = await scope.innerText();
      for (const line of raw.split('\n')) {
        const t = clean(line);
        if (t) seen.add(t);
      }
    } catch {}
  }

  await capture();

  const descendants = scope.locator('*');
  const n = await descendants.count();
  let scrolled = 0;

  for (let i = 0; i < n && scrolled < 8; i++) {
    const el = descendants.nth(i);
    const metrics = await el.evaluate((node) => {
      const s = getComputedStyle(node);
      if (
        node.scrollHeight > node.clientHeight + 20 &&
        node.clientHeight > 60 &&
        (s.overflowY === 'auto' || s.overflowY === 'scroll')
      ) {
        return { h: node.scrollHeight, c: node.clientHeight };
      }
      return null;
    }).catch(() => null);

    if (!metrics) continue;
    scrolled++;

    const max = Math.max(0, metrics.h - metrics.c);
    const step = Math.max(80, Math.floor(metrics.c * 0.75));

    for (let y = 0, guard = 0; y <= max && guard < 60; y += step, guard++) {
      await el.evaluate((node, top) => { node.scrollTop = top; }, y).catch(() => {});
      await page.waitForTimeout(100);
      await capture();
    }
    await el.evaluate((node) => { node.scrollTop = 0; }).catch(() => {});
  }

  result.notes.push(`Scrollable containers inspected: ${scrolled}`);
  return uniq([...seen]);
}

let browser;
try {
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: 1440, height: 1200 },
    locale: 'en-US',
    timezoneId: 'America/New_York'
  });

  const page = await context.newPage();
  page.setDefaultTimeout(15000);

  await page.goto(FORM_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(2000);
  result.formLoaded = true;

  await page.screenshot({ path: path.join(OUT, '01-form-loaded.png'), fullPage: true });

  for (const name of [
    /Reject All,\s*Except Strictly Necessary/i,
    /Reject All/i,
    /Necessary Only/i
  ]) {
    const b = page.getByRole('button', { name }).first();
    if (await b.isVisible().catch(() => false)) {
      await b.click();
      result.cookieHandled = true;
      await page.waitForTimeout(400);
      break;
    }
  }

  // HARD SAFETY BARRIER: disable any visible button whose text is exactly Submit.
  // This script contains no Submit-click routine.
  await page.locator('button').evaluateAll((buttons) => {
    for (const b of buttons) {
      if ((b.innerText || '').trim().toLowerCase() === 'submit') {
        b.disabled = true;
        b.style.pointerEvents = 'none';
        b.setAttribute('data-safe-dry-run-disabled', 'true');
      }
    }
  }).catch(() => {});

  const addUnit = page.getByRole('button', { name: /Add unit/i }).first();
  await addUnit.waitFor({ state: 'visible', timeout: 30000 });
  await addUnit.click();
  result.addUnitClicked = true;
  await page.waitForTimeout(1500);

  await page.screenshot({ path: path.join(OUT, '02-picker-open.png'), fullPage: true });

  const interactive = await page.locator(
    'button:visible, input:visible, [role="dialog"]:visible, [role="listbox"]:visible, ' +
    '[role="option"]:visible, [role="menuitem"]:visible, [role="menuitemradio"]:visible'
  ).evaluateAll((els) => els.map((el) => ({
    tag: el.tagName,
    role: el.getAttribute('role'),
    type: el.getAttribute('type'),
    placeholder: el.getAttribute('placeholder'),
    ariaLabel: el.getAttribute('aria-label'),
    text: (el.innerText || el.value || '').trim()
  })));
  await write('interactive-elements.json', interactive);

  const scope = await getScope(page);
  const raw = await scope.innerText().catch(() => '');
  await write('picker-raw-visible-text.txt', raw || '[NO VISIBLE PICKER TEXT CAPTURED]');

  result.candidateOptions = await collectWithScroll(scope, page);

  const targetLower = TARGET_TEXT.toLowerCase();
  result.targetMatches = result.candidateOptions.filter(
    (x) => x.toLowerCase().includes(targetLower)
  );
  result.targetFound = result.targetMatches.length > 0;

  const search = page.locator(
    'input:visible[placeholder*="Search" i], input:visible[aria-label*="Search" i]'
  ).last();

  if (await search.count()) {
    try {
      await search.fill(TARGET_TEXT);
      await page.waitForTimeout(1000);
      const searchedScope = await getScope(page);
      const searchedText = await searchedScope.innerText().catch(() => '');
      await write('target-search-visible-text.txt', searchedText || '[NO SEARCH RESULT TEXT CAPTURED]');
      await page.screenshot({ path: path.join(OUT, '03-target-search.png'), fullPage: true });

      if (searchedText.toLowerCase().includes(targetLower)) {
        result.targetFound = true;
        result.targetMatches = uniq([
          ...result.targetMatches,
          ...searchedText.split('\n').filter((x) => clean(x).toLowerCase().includes(targetLower))
        ]);
      }
    } catch (e) {
      result.notes.push(`Picker search diagnostic unavailable: ${e.message}`);
    }
  } else {
    result.notes.push('No visible picker search input detected.');
  }

  // DOM evidence with input values stripped, in case selectors need refinement.
  const html = await page.locator('body').evaluate((body) => {
    const clone = body.cloneNode(true);
    clone.querySelectorAll('input, textarea').forEach((el) => {
      el.removeAttribute('value');
      el.textContent = '';
    });
    return clone.innerHTML;
  }).catch(() => '[DOM SNAPSHOT UNAVAILABLE]');
  await write('visible-dom-snapshot.html', html);

  result.completedAt = new Date().toISOString();
  await write('result.json', result);

  console.log(`SAFE DRY RUN COMPLETE. Target found: ${result.targetFound}`);
  console.log(`Candidate text items captured: ${result.candidateOptions.length}`);
  console.log('No form submission was attempted.');

} catch (error) {
  result.error = {
    name: error?.name,
    message: error?.message,
    stack: error?.stack
  };
  result.completedAt = new Date().toISOString();
  await write('result.json', result);
  await write('ERROR.txt', `${error?.stack || error}\n`);
  console.error(error);
  process.exitCode = 1;
} finally {
  if (browser) await browser.close().catch(() => {});
}
