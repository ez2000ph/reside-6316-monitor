import { chromium } from 'playwright';
import nodemailer from 'nodemailer';
import fs from 'node:fs/promises';
import path from 'node:path';

const FORM_URL = process.env.FORM_URL;
const TARGET_TEXT = process.env.TARGET_TEXT || '63-16 102nd Street';
const ALERT_LINK = process.env.ALERT_LINK || FORM_URL;
const SMTP_USER = process.env.SMTP_USER;
const SMTP_APP_PASSWORD = process.env.SMTP_APP_PASSWORD;
const ALERT_EMAIL = process.env.ALERT_EMAIL;
const ALERT_SMS = process.env.ALERT_SMS;
const OUT = path.resolve('artifacts');

await fs.mkdir(OUT, { recursive: true });

const state = {
  checkedAt: new Date().toISOString(),
  safeAlertOnly: true,
  target: TARGET_TEXT,
  targetFound: false,
  matches: [],
  error: null
};

const clean = (s) => String(s ?? '')
  .replace(/\u00a0/g, ' ')
  .replace(/[ \t]+/g, ' ')
  .replace(/\r/g, '')
  .trim();

const uniq = (arr) => [...new Set(arr.map(clean).filter(Boolean))];

async function save(name, body) {
  await fs.writeFile(
    path.join(OUT, name),
    typeof body === 'string' ? body : JSON.stringify(body, null, 2),
    'utf8'
  );
}

async function sendAlert(subject, message) {
  if (!SMTP_USER || !SMTP_APP_PASSWORD || !ALERT_EMAIL || !ALERT_SMS) {
    throw new Error('Missing alert secrets: SMTP_USER, SMTP_APP_PASSWORD, ALERT_EMAIL, ALERT_SMS');
  }

  const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: { user: SMTP_USER, pass: SMTP_APP_PASSWORD }
  });

  const outcomes = [];
  for (const recipient of [ALERT_EMAIL, ALERT_SMS]) {
    try {
      const info = await transporter.sendMail({
        from: SMTP_USER,
        to: recipient,
        subject,
        text: message
      });
      outcomes.push({ recipient, ok: true, messageId: info.messageId });
    } catch (error) {
      outcomes.push({ recipient, ok: false, error: error.message });
    }
  }

  await save('alert-outcomes.json', outcomes);

  if (!outcomes.some((x) => x.ok)) {
    throw new Error(`All alert deliveries failed: ${JSON.stringify(outcomes)}`);
  }
}

async function getScope(page) {
  const listbox = page.locator('[role="listbox"]:visible');
  if (await listbox.count()) return listbox.last();

  const dialog = page.locator('[role="dialog"]:visible');
  if (await dialog.count()) return dialog.last();

  return page.locator('body');
}

async function collectCandidates(page) {
  const scope = await getScope(page);
  const values = [];

  for (const selector of [
    '[role="option"]:visible',
    '[role="menuitem"]:visible',
    '[role="menuitemradio"]:visible',
    '[role="treeitem"]:visible',
    '[role="row"]:visible'
  ]) {
    try { values.push(...await page.locator(selector).allInnerTexts()); } catch {}
  }

  try { values.push(...(await scope.innerText()).split('\n')); } catch {}
  return uniq(values);
}

let browser;

try {
  browser = await chromium.launch({ headless: true });

  const context = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
    locale: 'en-US',
    timezoneId: 'America/New_York'
  });

  const page = await context.newPage();
  page.setDefaultTimeout(15000);

  await page.goto(FORM_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(1600);

  for (const name of [
    /Reject All,\s*Except Strictly Necessary/i,
    /Reject All/i,
    /Necessary Only/i
  ]) {
    const button = page.getByRole('button', { name }).first();
    if (await button.isVisible().catch(() => false)) {
      await button.click();
      await page.waitForTimeout(250);
      break;
    }
  }

  // HARD SAFETY BARRIER: this detector is not allowed to submit anything.
  await page.locator('button').evaluateAll((buttons) => {
    for (const button of buttons) {
      if ((button.innerText || '').trim().toLowerCase() === 'submit') {
        button.disabled = true;
        button.style.pointerEvents = 'none';
        button.setAttribute('data-monitor-disabled', 'true');
      }
    }
  }).catch(() => {});

  const addUnit = page.getByRole('button', { name: /Add unit/i }).first();
  await addUnit.waitFor({ state: 'visible', timeout: 30000 });
  await addUnit.click();
  await page.waitForTimeout(700);

  const search = page.locator(
    'input:visible[placeholder*="Search" i], input:visible[aria-label*="Search" i]'
  ).last();

  if (!(await search.count())) {
    throw new Error('Airtable picker opened but no search field was found.');
  }

  await search.fill(TARGET_TEXT);
  await page.waitForTimeout(900);

  const scope = await getScope(page);
  const scopeText = clean(await scope.innerText().catch(() => ''));
  const candidates = await collectCandidates(page);
  const targetLower = TARGET_TEXT.toLowerCase();
  const noResults = /\bno results\b/i.test(scopeText);

  const matches = candidates.filter((line) => {
    const l = line.toLowerCase();
    return l.includes(targetLower) && l !== targetLower;
  });

  let roleMatch = false;
  if (!noResults) {
    for (const selector of [
      '[role="option"]:visible',
      '[role="menuitem"]:visible',
      '[role="menuitemradio"]:visible',
      '[role="treeitem"]:visible',
      '[role="row"]:visible'
    ]) {
      const loc = page.locator(selector);
      const n = await loc.count().catch(() => 0);
      for (let i = 0; i < n; i++) {
        const t = clean(await loc.nth(i).innerText().catch(() => ''));
        if (t.toLowerCase().includes(targetLower)) {
          roleMatch = true;
          if (t) matches.push(t);
        }
      }
    }
  }

  state.matches = uniq(matches);
  state.targetFound = !noResults && (state.matches.length > 0 || roleMatch);

  if (state.targetFound) {
    await page.screenshot({ path: path.join(OUT, 'TARGET-FOUND.png'), fullPage: true });
    await save('TARGET-FOUND.json', state);

    const message =
`63-16 102nd Street is visible in the Reside Airtable picker.

TAP TO APPLY:
${ALERT_LINK}

Open your saved form, choose 63-16 102nd Street from + Add unit, verify the form, then submit.

Detected: ${state.checkedAt}`;

    await sendAlert('APPLY NOW - 63-16 102nd Street', message);
    console.log('TARGET FOUND. Alerts attempted.');
  } else {
    console.log(`Checked ${state.checkedAt}: target absent.`);
  }

  await save('monitor-result.json', state);

} catch (error) {
  state.error = {
    name: error?.name || 'Error',
    message: error?.message || String(error)
  };
  await save('MONITOR-ERROR.json', state);

  try {
    await sendAlert(
      'MONITOR ERROR - CHECK 63-16 NOW',
      `The GitHub detector could not reliably inspect the Airtable picker.\n\nMANUAL CHECK:\n${ALERT_LINK}\n\nError: ${state.error.message}\nTime: ${state.checkedAt}`
    );
  } catch (alertError) {
    console.error('Could not send monitor-error alert:', alertError);
  }

  console.error(error);
  process.exitCode = 1;

} finally {
  if (browser) await browser.close().catch(() => {});
}
