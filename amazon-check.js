// ═══════════════════════════════════════════════════════════════════════════════
//  AMAZON LISTING CHECKER — Puppeteer + Google Sheets
//  Parallel execution — all marketplaces run simultaneously
//  Saudi Arabia + UAE share an IP so they run sequentially
// ═══════════════════════════════════════════════════════════════════════════════

const puppeteer  = require('puppeteer');
const { google } = require('googleapis');
const nodemailer = require('nodemailer');

// ─── CONFIG ────────────────────────────────────────────────────────────────────
const SHEET_ID      = '1BQD8Qf9AMM4bhAcnDXAKBKoOwPN929F8Mydo8gzhLyU';
const PROXY_USER    = process.env.PROXY_USER;
const PROXY_PASS    = process.env.PROXY_PASS;
const GMAIL_USER    = process.env.GMAIL_USER;
const GMAIL_PASS    = process.env.GMAIL_PASS;
const ONLY_TAB      = (process.env.MARKETPLACE || '').trim();
const SKIP_SHEETS   = ['Summary', 'Template', 'Instructions', 'History'];
const HISTORY_TAB   = 'History';

// These two share the same proxy IP — must run sequentially, not in parallel
const SEQUENTIAL_GROUP = ['Saudi Arabia', 'UAE'];

// Random delay 2–5 seconds between checks within a tab
const randomDelay = () => Math.floor(Math.random() * 3000) + 2000;

// ─── UNAVAILABLE PHRASES (all Amazon languages) ────────────────────────────────
const UNAVAILABLE_PHRASES = [
  'currently unavailable', 'not available', 'this item is unavailable',
  'derzeit nicht verfügbar', 'nicht auf lager', 'nicht verfügbar',
  'actuellement indisponible', 'non disponible', 'en rupture de stock',
  'actualmente no disponible', 'no disponible', 'agotado',
  'attualmente non disponibile', 'non disponibile', 'esaurito',
  'momenteel niet beschikbaar', 'niet beschikbaar', 'uitverkocht',
  'obecnie niedostępny', 'niedostępny', 'chwilowo niedostępny',
  'för tillfället inte tillgänglig', 'inte tillgänglig', 'slut i lager',
  'atualmente indisponível', 'indisponível', 'sem estoque',
  'غير متوفر حاليا', 'غير متوفر',
];

// ─── MARKETPLACE CONFIG ────────────────────────────────────────────────────────
const MARKETPLACES = {
  'USA':          { baseUrl: 'https://www.amazon.com',    proxy: '9.142.43.131:5301'   },
  'Canada':       { baseUrl: 'https://www.amazon.ca',     proxy: '192.53.140.18:5114'  },
  'UK':           { baseUrl: 'https://www.amazon.co.uk',  proxy: '212.212.19.48:6199'  },
  'Ireland':      { baseUrl: 'https://www.amazon.co.uk',  proxy: '212.212.18.216:6867' },
  'Germany':      { baseUrl: 'https://www.amazon.de',     proxy: '166.0.42.187:6195'   },
  'France':       { baseUrl: 'https://www.amazon.fr',     proxy: '31.98.4.142:7820'    },
  'Belgium':      { baseUrl: 'https://www.amazon.com.be', proxy: '46.203.144.45:7812'  },
  'Netherlands':  { baseUrl: 'https://www.amazon.nl',     proxy: '104.253.199.5:5284'  },
  'Spain':        { baseUrl: 'https://www.amazon.es',     proxy: '46.203.60.158:7158'  },
  'Italy':        { baseUrl: 'https://www.amazon.it',     proxy: '82.24.27.117:8089'   },
  'Sweden':       { baseUrl: 'https://www.amazon.se',     proxy: '82.26.114.47:6749'   },
  'Poland':       { baseUrl: 'https://www.amazon.pl',     proxy: '82.29.47.131:7855'   },
  'Brazil':       { baseUrl: 'https://www.amazon.com.br', proxy: '192.53.142.66:5763'  },
  'Mexico':       { baseUrl: 'https://www.amazon.com.mx', proxy: '9.142.194.93:6761'   },
  'Saudi Arabia': { baseUrl: 'https://www.amazon.sa',     proxy: '82.29.239.167:5315'  },
  'UAE':          { baseUrl: 'https://www.amazon.ae',     proxy: '82.29.239.167:5315'  },
};

// ─── COLORS ────────────────────────────────────────────────────────────────────
const COLOR = {
  green: { red: 0.714, green: 0.843, blue: 0.659 },
  red:   { red: 0.918, green: 0.600, blue: 0.600 },
  amber: { red: 1.000, green: 0.898, blue: 0.600 },
};

// ─── GOOGLE SHEETS CLIENT ──────────────────────────────────────────────────────
async function getSheetsClient() {
  const credentials = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
  const auth = new google.auth.GoogleAuth({
    credentials,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
  return google.sheets({ version: 'v4', auth });
}

// ─── APPLY CONDITIONAL FORMATTING ──────────────────────────────────────────────
async function applyConditionalFormatting(sheets) {
  console.log('🎨 Setting up conditional formatting...');

  const meta = await sheets.spreadsheets.get({
    spreadsheetId: SHEET_ID,
    fields: 'sheets(properties(sheetId,title),conditionalFormats)',
  });

  const deleteRequests = [];
  const addRequests    = [];

  for (const sheet of meta.data.sheets) {
    const tabName = sheet.properties.title;
    if (SKIP_SHEETS.includes(tabName) || !MARKETPLACES[tabName]) continue;

    const sheetId       = sheet.properties.sheetId;
    const existingRules = sheet.conditionalFormats || [];

    for (let i = existingRules.length - 1; i >= 0; i--) {
      deleteRequests.push({ deleteConditionalFormatRule: { sheetId, index: i } });
    }

    const buttonRange = { sheetId, startRowIndex: 1, startColumnIndex: 3,  endColumnIndex: 7  };
    const stockRange  = { sheetId, startRowIndex: 1, startColumnIndex: 11, endColumnIndex: 12 };
    const alertRange  = { sheetId, startRowIndex: 1, startColumnIndex: 12, endColumnIndex: 13 };

    const rule = (ranges, containsText, bgColor) => ({
      addConditionalFormatRule: {
        rule: {
          ranges,
          booleanRule: {
            condition: { type: 'TEXT_CONTAINS', values: [{ userEnteredValue: containsText }] },
            format: { backgroundColor: bgColor },
          },
        },
        index: 0,
      },
    });

    addRequests.push(rule([buttonRange], 'Found',                 COLOR.green));
    addRequests.push(rule([buttonRange], 'Missing',               COLOR.red));
    addRequests.push(rule([buttonRange], 'BLOCKED',               COLOR.amber));
    addRequests.push(rule([buttonRange], 'Error',                 COLOR.amber));
    addRequests.push(rule([stockRange],  'In Stock',              COLOR.green));
    addRequests.push(rule([stockRange],  'left in sto',           COLOR.amber));
    addRequests.push(rule([stockRange],  'Currently unavailable', COLOR.red));
    addRequests.push(rule([alertRange],  'LIVE',                  COLOR.green));
    addRequests.push(rule([alertRange],  'NO BUTTONS',            COLOR.red));
    addRequests.push(rule([alertRange],  'UNAVAILABLE',           COLOR.red));
    addRequests.push(rule([alertRange],  'BLOCKED',               COLOR.amber));
    addRequests.push(rule([alertRange],  'ERROR',                 COLOR.amber));
  }

  if (deleteRequests.length > 0) {
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId: SHEET_ID,
      requestBody: { requests: deleteRequests },
    });
  }
  if (addRequests.length > 0) {
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId: SHEET_ID,
      requestBody: { requests: addRequests },
    });
  }

  console.log('✅ Conditional formatting applied\n');
}

// ─── ENSURE HISTORY TAB EXISTS ─────────────────────────────────────────────────
async function ensureHistoryTab(sheets) {
  const meta   = await sheets.spreadsheets.get({ spreadsheetId: SHEET_ID });
  const exists = meta.data.sheets.some(s => s.properties.title === HISTORY_TAB);

  if (!exists) {
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId: SHEET_ID,
      requestBody: { requests: [{ addSheet: { properties: { title: HISTORY_TAB } } }] },
    });
    await sheets.spreadsheets.values.update({
      spreadsheetId: SHEET_ID,
      range: `'${HISTORY_TAB}'!A1:G1`,
      valueInputOption: 'USER_ENTERED',
      requestBody: { values: [['Date', 'Time', 'Marketplace', 'ASIN', 'SKU', 'Status', 'Notes']] },
    });
    console.log('📋 History tab created\n');
  }
}

// ─── APPEND TO HISTORY TAB ─────────────────────────────────────────────────────
async function appendToHistory(sheets, historyRows) {
  if (historyRows.length === 0) return;

  await sheets.spreadsheets.values.append({
    spreadsheetId:    SHEET_ID,
    range:            `'${HISTORY_TAB}'!A:G`,
    valueInputOption: 'USER_ENTERED',
    insertDataOption: 'INSERT_ROWS',
    requestBody:      { values: historyRows },
  });

  console.log(`   📋 ${historyRows.length} issue(s) logged to History tab`);
}

// ─── GET ALL TAB NAMES ─────────────────────────────────────────────────────────
async function getTabNames(sheets) {
  const meta = await sheets.spreadsheets.get({ spreadsheetId: SHEET_ID });
  return meta.data.sheets.map(s => s.properties.title);
}

// ─── READ ASINs AND SKUs ───────────────────────────────────────────────────────
async function getASINs(sheets, tabName) {
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: `'${tabName}'!B:C`,
  });
  const rows  = res.data.values || [];
  const asins = [];
  for (let i = 1; i < rows.length; i++) {
    const asin = (rows[i][0] || '').trim();
    const sku  = (rows[i][1] || '').trim();
    if (asin) asins.push({ asin, sku, sheetRow: i + 1 });
  }
  return asins;
}

// ─── WRITE ONE ROW IMMEDIATELY ─────────────────────────────────────────────────
async function writeOneRow(sheets, tabName, sheetRow, dToJ, lToM) {
  await sheets.spreadsheets.values.batchUpdate({
    spreadsheetId: SHEET_ID,
    requestBody: {
      valueInputOption: 'USER_ENTERED',
      data: [
        { range: `'${tabName}'!D${sheetRow}:J${sheetRow}`, values: [dToJ] },
        { range: `'${tabName}'!L${sheetRow}:M${sheetRow}`, values: [lToM] },
      ],
    },
  });
}

// ─── CHECK A SINGLE AMAZON PAGE ────────────────────────────────────────────────
async function checkPage(browser, url, isMobile) {
  const page = await browser.newPage();

  try {
    await page.authenticate({ username: PROXY_USER, password: PROXY_PASS });

    await page.evaluateOnNewDocument(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => false });
      window.chrome = { runtime: {} };
    });

    if (isMobile) {
      await page.setUserAgent(
        'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) ' +
        'AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1'
      );
      await page.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true });
    } else {
      await page.setUserAgent(
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) ' +
        'AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
      );
      await page.setViewport({ width: 1366, height: 768 });
    }

    await page.setExtraHTTPHeaders({
      'Accept':          'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.9',
      'Accept-Encoding': 'gzip, deflate, br',
    });

    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });

    await page.waitForSelector(
      '#add-to-cart-button, #buy-now-button, #availability, #captchacharacters, .a-page',
      { timeout: 8000 }
    ).catch(() => {});

    const pageTitle   = await page.title().catch(() => '');
    const bodySnippet = await page.evaluate(
      () => (document.body ? document.body.innerText.substring(0, 600) : '')
    ).catch(() => '');

    const isBlocked = (
      /robot|captcha|verify|sorry|unusual traffic/i.test(pageTitle) ||
      /enter the characters|type the characters|are you a human/i.test(bodySnippet)
    );

    if (isBlocked) {
      return { atc: 'BLOCKED', buy: 'BLOCKED', stock: 'CAPTCHA detected', isBlocked: true, isUnavailable: false };
    }

    const availabilityText = await page.evaluate(() => {
      const el = document.querySelector('#availability, #availability_feature_div');
      return el ? el.innerText.toLowerCase().trim() : '';
    }).catch(() => '');

    const hasPurchaseBox = await page.evaluate(() => !!(
      document.querySelector('#buybox')             ||
      document.querySelector('#desktop_buybox')     ||
      document.querySelector('#newAccordionRow')     ||
      document.querySelector('#add-to-cart-button') ||
      document.querySelector('#buy-now-button')
    )).catch(() => false);

    const isUnavailable = (
      UNAVAILABLE_PHRASES.some(phrase => availabilityText.includes(phrase)) ||
      !hasPurchaseBox
    );

    if (isUnavailable) {
      return {
        atc:           'Missing ❌',
        buy:           'Missing ❌',
        stock:         availabilityText.substring(0, 60) || 'Unavailable',
        isBlocked:     false,
        isUnavailable: true,
      };
    }

    const hasATC = await page.evaluate(() =>
      !!(document.querySelector('#add-to-cart-button'))
    ).catch(() => false);

    const hasBuy = await page.evaluate(() =>
      !!(document.querySelector('#buy-now-button'))
    ).catch(() => false);

    const stockText = await page.evaluate(() => {
      const el = document.querySelector('#availability, #availability_feature_div');
      return el ? el.innerText.replace(/\s+/g, ' ').trim() : '';
    }).catch(() => '');

    return {
      atc:           hasATC ? 'Found ✅' : 'Missing ❌',
      buy:           hasBuy ? 'Found ✅' : 'Missing ❌',
      stock:         stockText.substring(0, 60),
      isBlocked:     false,
      isUnavailable: false,
    };

  } catch (err) {
    const msg = (err.message || '').substring(0, 60);
    return { atc: 'Error', buy: 'Error', stock: msg, isBlocked: false, isUnavailable: false };

  } finally {
    await page.close().catch(() => {});
  }
}

// ─── PROCESS ONE MARKETPLACE TAB ──────────────────────────────────────────────
// This function handles one complete tab end-to-end.
// Returns { summary, historyRows, totalBlocked, totalErrors }
async function processTab(sheets, tabName, today, now) {
  const marketplace = MARKETPLACES[tabName];

  console.log(`\n${'─'.repeat(50)}`);
  console.log(`📦  ${tabName}  →  ${marketplace.baseUrl}`);
  console.log(`${'─'.repeat(50)}`);

  const asins = await getASINs(sheets, tabName);
  if (asins.length === 0) {
    console.log(`   [${tabName}] no ASINs found — skipping`);
    return { summary: [], historyRows: [], totalBlocked: 0, totalErrors: 0 };
  }
  console.log(`   [${tabName}] ${asins.length} ASINs to check`);

  const [proxyHost, proxyPort] = marketplace.proxy.split(':');

  const browser = await puppeteer.launch({
    headless: 'new',
    args: [
      `--proxy-server=http://${proxyHost}:${proxyPort}`,
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--disable-blink-features=AutomationControlled',
      '--window-size=1366,768',
    ],
  });

  const summary     = [];
  const historyRows = [];
  let totalBlocked  = 0;
  let totalErrors   = 0;

  for (const { asin, sku, sheetRow } of asins) {
    const url       = `${marketplace.baseUrl}/dp/${asin}`;
    const checkedAt = muTime();

    const desktop = await checkPage(browser, url, false);
    await sleep(randomDelay());

    const mobile = await checkPage(browser, url, true);
    await sleep(randomDelay());

    let alert = '';
    let notes = '';

    if (desktop.isBlocked) {
      alert = '⚠️ BLOCKED';
      notes = 'Amazon blocked this check';
      totalBlocked++;
    } else if (desktop.atc === 'Error') {
      alert = '⚠️ ERROR';
      notes = desktop.stock;
      totalErrors++;
    } else if (desktop.isUnavailable) {
      alert = '🔴 UNAVAILABLE';
      notes = desktop.stock || 'Listing unavailable';
    } else if (desktop.atc === 'Found ✅' || desktop.buy === 'Found ✅') {
      alert = '✅ LIVE';
    } else {
      alert = '🔴 NO BUTTONS';
      notes = desktop.stock || 'No ATC or Buy Now found';
    }

    console.log(
      `   [${tabName}] ${asin} | ` +
      `D: ATC=${desktop.atc} Buy=${desktop.buy} | ` +
      `M: ATC=${mobile.atc} Buy=${mobile.buy} | ${alert}`
    );

    const dToJ = [
      desktop.atc, desktop.buy, mobile.atc, mobile.buy,
      notes, checkedAt, url,
    ];
    const lToM = [desktop.stock, alert];

    try {
      await writeOneRow(sheets, tabName, sheetRow, dToJ, lToM);
    } catch (err) {
      console.log(`   [${tabName}] ⚠ Sheet write failed for ${asin}: ${err.message}`);
    }

    if (alert !== '✅ LIVE') {
      historyRows.push([today, now, tabName, asin, sku, alert, notes]);
    }

    summary.push({ marketplace: tabName, asin, sku, alert, notes });
  }

  await browser.close().catch(() => {});
  console.log(`   ✅ [${tabName}] complete`);

  return { summary, historyRows, totalBlocked, totalErrors };
}

// ─── SEND EMAIL SUMMARY ────────────────────────────────────────────────────────
async function sendEmailSummary(summary, totalChecked, totalBlocked, totalErrors, startTime) {
  if (!GMAIL_USER || !GMAIL_PASS) {
    console.log('   (no email credentials — skipping email)');
    return;
  }

  const duration  = Math.round((Date.now() - startTime) / 60000);
  const issues    = summary.filter(r => r.alert !== '✅ LIVE');
  const issueRows = issues.map(r =>
    `<tr>
      <td style="padding:4px 8px;border:1px solid #ddd">${r.marketplace}</td>
      <td style="padding:4px 8px;border:1px solid #ddd">${r.asin}</td>
      <td style="padding:4px 8px;border:1px solid #ddd">${r.sku}</td>
      <td style="padding:4px 8px;border:1px solid #ddd">${r.alert}</td>
      <td style="padding:4px 8px;border:1px solid #ddd">${r.notes || ''}</td>
    </tr>`
  ).join('');

  const scope = ONLY_TAB ? `${ONLY_TAB} only` : 'all marketplaces';

  const html = `
    <h2 style="color:#333;font-family:Arial,sans-serif">Amazon Listing Check — ${muTime()}</h2>
    <p style="font-family:Arial,sans-serif">
      ✅ <strong>${totalChecked}</strong> ASINs checked (${scope})<br>
      ⏱ Completed in <strong>${duration} minutes</strong><br>
      ${totalBlocked > 0 ? `⚠️ <strong>${totalBlocked}</strong> blocked by Amazon<br>` : ''}
      ${totalErrors  > 0 ? `❌ <strong>${totalErrors}</strong> errors<br>`           : ''}
    </p>
    ${issues.length === 0
      ? `<p style="color:green;font-weight:bold;font-family:Arial,sans-serif">✅ All listings are LIVE — no issues found!</p>`
      : `<h3 style="color:#c00;font-family:Arial,sans-serif">⚠️ ${issues.length} issue(s) need attention:</h3>
         <table style="border-collapse:collapse;font-size:13px;font-family:Arial,sans-serif">
           <tr style="background:#f0f0f0">
             <th style="padding:4px 8px;border:1px solid #ddd">Marketplace</th>
             <th style="padding:4px 8px;border:1px solid #ddd">ASIN</th>
             <th style="padding:4px 8px;border:1px solid #ddd">SKU</th>
             <th style="padding:4px 8px;border:1px solid #ddd">Status</th>
             <th style="padding:4px 8px;border:1px solid #ddd">Notes</th>
           </tr>
           ${issueRows}
         </table>`
    }
    <p style="margin-top:24px;font-family:Arial,sans-serif">
      <a href="https://docs.google.com/spreadsheets/d/${SHEET_ID}"
         style="background:#4285f4;color:white;padding:8px 16px;border-radius:4px;text-decoration:none">
        Open Google Sheet
      </a>
    </p>`;

  const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: { user: GMAIL_USER, pass: GMAIL_PASS },
  });

  await transporter.sendMail({
    from:    `Amazon Checker <${GMAIL_USER}>`,
    to:      GMAIL_USER,
    subject: issues.length === 0
      ? `✅ Amazon Check Done — All ${totalChecked} listings LIVE (${muTime()})`
      : `⚠️ Amazon Check — ${issues.length} issue(s) found (${muTime()})`,
    html,
  });

  console.log(`   📧 Email sent to ${GMAIL_USER}`);
}

// ─── HELPERS ───────────────────────────────────────────────────────────────────
const sleep  = ms => new Promise(r => setTimeout(r, ms));
const muTime = ()  => new Date().toLocaleString('en-GB', { timeZone: 'Indian/Mauritius' });

// ─── MAIN ──────────────────────────────────────────────────────────────────────
async function main() {
  const startTime = Date.now();

  console.log(`\n${'═'.repeat(60)}`);
  console.log(ONLY_TAB
    ? `  🚀  Amazon Check — ${ONLY_TAB} only — ${muTime()}`
    : `  🚀  Amazon Check — ALL tabs PARALLEL — ${muTime()}`
  );
  console.log(`${'═'.repeat(60)}\n`);

  const sheets = await getSheetsClient();

  await applyConditionalFormatting(sheets);
  await ensureHistoryTab(sheets);

  const allTabs = await getTabNames(sheets);

  // Filter to only marketplace tabs we know about
  const tabsToRun = allTabs.filter(t => {
    if (SKIP_SHEETS.includes(t)) return false;
    if (!MARKETPLACES[t]) return false;
    if (ONLY_TAB && t !== ONLY_TAB) return false;
    return true;
  });

  const today = new Date().toLocaleDateString('en-GB', { timeZone: 'Indian/Mauritius' });
  const now   = new Date().toLocaleTimeString('en-GB', { timeZone: 'Indian/Mauritius' });

  // ── Split into parallel group and sequential group ─────────────────────────
  // Saudi Arabia + UAE share the same IP — run them one after the other
  // Everything else runs fully in parallel
  const parallelTabs   = tabsToRun.filter(t => !SEQUENTIAL_GROUP.includes(t));
  const sequentialTabs = tabsToRun.filter(t =>  SEQUENTIAL_GROUP.includes(t));

  console.log(`🔀 Running ${parallelTabs.length} tabs in parallel`);
  if (sequentialTabs.length > 0) {
    console.log(`🔁 Running ${sequentialTabs.length} tab(s) sequentially (shared IP): ${sequentialTabs.join(', ')}`);
  }
  console.log();

  // ── Run all parallel tabs at the same time ─────────────────────────────────
  const parallelResults = await Promise.all(
    parallelTabs.map(tabName => processTab(sheets, tabName, today, now))
  );

  // ── Run sequential tabs one after the other ────────────────────────────────
  const sequentialResults = [];
  for (const tabName of sequentialTabs) {
    const result = await processTab(sheets, tabName, today, now);
    sequentialResults.push(result);
  }

  // ── Collect all results ────────────────────────────────────────────────────
  const allResults    = [...parallelResults, ...sequentialResults];
  const summary       = allResults.flatMap(r => r.summary);
  const historyRows   = allResults.flatMap(r => r.historyRows);
  const totalChecked  = summary.length;
  const totalBlocked  = allResults.reduce((n, r) => n + r.totalBlocked, 0);
  const totalErrors   = allResults.reduce((n, r) => n + r.totalErrors,  0);

  // ── Write history ──────────────────────────────────────────────────────────
  console.log(`\n📋 Writing to History tab...`);
  await appendToHistory(sheets, historyRows);

  console.log(`\n${'═'.repeat(60)}`);
  console.log(`  ✅  All done — ${muTime()}`);
  console.log(`  📊  ${totalChecked} ASINs checked`);
  if (totalBlocked > 0) console.log(`  ⚠️   ${totalBlocked} blocked by Amazon`);
  if (totalErrors  > 0) console.log(`  ❌  ${totalErrors} errors`);
  console.log(`${'═'.repeat(60)}\n`);

  console.log('📧 Sending email summary...');
  await sendEmailSummary(summary, totalChecked, totalBlocked, totalErrors, startTime);
}

// ─── RUN ───────────────────────────────────────────────────────────────────────
main().catch(err => {
  console.error('\n❌ Fatal error:', err);
  process.exit(1);
});
