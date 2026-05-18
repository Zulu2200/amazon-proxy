// ═══════════════════════════════════════════════════════════════════════════════
//  AMAZON LISTING CHECKER — Puppeteer + Google Sheets
//  Runs via GitHub Actions daily at 1am Mauritius time
//  Can also be triggered from Google Sheet for a single marketplace
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
const ONLY_TAB      = (process.env.MARKETPLACE || '').trim(); // blank = run all
const SKIP_SHEETS   = ['Summary', 'Template', 'Instructions', 'History'];
const HISTORY_TAB   = 'History';

// Random delay 3–8 seconds — mimics human browsing
const randomDelay = () => Math.floor(Math.random() * 5000) + 3000;

// ─── COLUMN LAYOUT ─────────────────────────────────────────────────────────────
// A(0)=Category, B(1)=ASIN, C(2)=SKU,
// D(3)=Desktop ATC, E(4)=Desktop Buy, F(5)=Mobile ATC, G(6)=Mobile Buy,
// H(7)=Notes, I(8)=Last Checked, J(9)=URL,
// K(10)=Manual Check Notes ← NEVER OVERWRITTEN,
// L(11)=Stock Status, M(12)=Alert

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

// ─── APPLY CONDITIONAL FORMATTING TO ALL TABS ──────────────────────────────────
async function applyConditionalFormatting(sheets) {
  console.log('🎨 Setting up conditional formatting on all tabs...');

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

// ─── READ ASINs AND SKUs FROM COLUMNS B & C ────────────────────────────────────
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
      return { atc: 'BLOCKED', buy: 'BLOCKED', stock: 'CAPTCHA detected', isBlocked: true };
    }

    const hasATC = await page.evaluate(() => !!(
      document.querySelector('#add-to-cart-button')         ||
      document.querySelector('[name="submit.add-to-cart"]') ||
      document.querySelector('[data-action="add-to-cart"]') ||
      document.querySelector('[id*="add-to-cart"]')
    )).catch(() => false);

    const hasBuy = await page.evaluate(() => !!(
      document.querySelector('#buy-now-button')         ||
      document.querySelector('[name="submit.buy-now"]') ||
      document.querySelector('[data-action="buy-now"]') ||
      document.querySelector('[id*="buy-now"]')
    )).catch(() => false);

    const stockText = await page.evaluate(() => {
      const el = document.querySelector('#availability, #availability_feature_div');
      return el ? el.innerText.replace(/\s+/g, ' ').trim() : '';
    }).catch(() => '');

    return {
      atc:       hasATC ? 'Found ✅' : 'Missing ❌',
      buy:       hasBuy ? 'Found ✅' : 'Missing ❌',
      stock:     stockText.substring(0, 60),
      isBlocked: false,
    };

  } catch (err) {
    const msg = (err.message || '').substring(0, 60);
    console.log(`      ⚠ Page error: ${msg}`);
    return { atc: 'Error', buy: 'Error', stock: msg, isBlocked: false };

  } finally {
    await page.close().catch(() => {});
  }
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

  const scope = ONLY_TAB ? `${ONLY_TAB} only` : 'all 16 marketplaces';

  const html = `
    <h2 style="color:#333;font-family:Arial,sans-serif">
      Amazon Listing Check — ${muTime()}
    </h2>
    <p style="font-family:Arial,sans-serif">
      ✅ <strong>${totalChecked}</strong> ASINs checked (${scope})<br>
      ⏱ Completed in <strong>${duration} minutes</strong><br>
      ${totalBlocked > 0 ? `⚠️ <strong>${totalBlocked}</strong> blocked by Amazon<br>` : ''}
      ${totalErrors  > 0 ? `❌ <strong>${totalErrors}</strong> errors<br>`           : ''}
    </p>
    ${issues.length === 0
      ? `<p style="color:green;font-weight:bold;font-family:Arial,sans-serif">
           ✅ All listings are LIVE — no issues found!
         </p>`
      : `<h3 style="color:#c00;font-family:Arial,sans-serif">
           ⚠️ ${issues.length} issue(s) need attention:
         </h3>
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
    </p>
  `;

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
  if (ONLY_TAB) {
    console.log(`  🚀  Amazon Check — ${ONLY_TAB} only — ${muTime()}`);
  } else {
    console.log(`  🚀  Amazon Check — ALL tabs — ${muTime()}`);
  }
  console.log(`${'═'.repeat(60)}\n`);

  const sheets = await getSheetsClient();

  await applyConditionalFormatting(sheets);
  await ensureHistoryTab(sheets);

  const allTabs = await getTabNames(sheets);

  let totalChecked  = 0;
  let totalBlocked  = 0;
  let totalErrors   = 0;
  const summary     = [];
  const historyRows = [];

  const today = new Date().toLocaleDateString('en-GB', { timeZone: 'Indian/Mauritius' });
  const now   = new Date().toLocaleTimeString('en-GB', { timeZone: 'Indian/Mauritius' });

  for (const tabName of allTabs) {
    if (SKIP_SHEETS.includes(tabName)) continue;

    // ── If a specific marketplace was requested, skip all others ──────────────
    if (ONLY_TAB && tabName !== ONLY_TAB) continue;

    const marketplace = MARKETPLACES[tabName];
    if (!marketplace) {
      console.log(`⚠️  No config for tab "${tabName}" — skipping\n`);
      continue;
    }

    console.log(`\n${'─'.repeat(60)}`);
    console.log(`📦  ${tabName}  →  ${marketplace.baseUrl}`);
    console.log(`${'─'.repeat(60)}`);

    const asins = await getASINs(sheets, tabName);
    if (asins.length === 0) {
      console.log(`   (no ASINs found — skipping)`);
      continue;
    }
    console.log(`   ${asins.length} ASINs to check\n`);

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

    for (const { asin, sku, sheetRow } of asins) {
      const url       = `${marketplace.baseUrl}/dp/${asin}`;
      const checkedAt = muTime();

      process.stdout.write(`   ${asin}  `);

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
      } else if (desktop.atc === 'Found ✅' || desktop.buy === 'Found ✅') {
        alert = '✅ LIVE';
      } else {
        alert = '🔴 NO BUTTONS';
        notes = desktop.stock || 'No ATC or Buy Now found';
      }

      console.log(
        `Desktop: ATC=${desktop.atc}  Buy=${desktop.buy}  ` +
        `| Mobile: ATC=${mobile.atc}  Buy=${mobile.buy}  ` +
        `| ${alert}`
      );

      const dToJ = [
        desktop.atc, desktop.buy, mobile.atc, mobile.buy,
        notes, checkedAt, url,
      ];

      const lToM = [desktop.stock, alert];

      try {
        await writeOneRow(sheets, tabName, sheetRow, dToJ, lToM);
      } catch (err) {
        console.log(`      ⚠ Sheet write failed for ${asin}: ${err.message}`);
      }

      if (alert !== '✅ LIVE') {
        historyRows.push([today, now, tabName, asin, sku, alert, notes]);
      }

      summary.push({ marketplace: tabName, asin, sku, alert, notes });
      totalChecked++;
    }

    await browser.close().catch(() => {});
    console.log(`\n   ✅ ${tabName} complete`);
  }

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
