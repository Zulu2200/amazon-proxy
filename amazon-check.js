// ═══════════════════════════════════════════════════════════════════════════════
//  AMAZON LISTING CHECKER — Puppeteer + Google Sheets
//  Runs via GitHub Actions daily at 1am Mauritius time
// ═══════════════════════════════════════════════════════════════════════════════

const puppeteer  = require('puppeteer');
const { google } = require('googleapis');
const nodemailer = require('nodemailer');

// ─── CONFIG ────────────────────────────────────────────────────────────────────
const SHEET_ID      = '1BQD8Qf9AMM4bhAcnDXAKBKoOwPN929F8Mydo8gzhLyU';
const PROXY_USER    = process.env.PROXY_USER;
const PROXY_PASS    = process.env.PROXY_PASS;
const GMAIL_USER    = process.env.GMAIL_USER;    // your gmail address
const GMAIL_PASS    = process.env.GMAIL_PASS;    // your gmail app password
const NOTIFY_EMAIL  = process.env.GMAIL_USER;    // send to yourself
const SKIP_SHEETS   = ['Summary', 'Template', 'Instructions'];

// Random delay 3–8 seconds between checks — mimics human browsing
const randomDelay = () => Math.floor(Math.random() * 5000) + 3000;

// ─── COLUMN LAYOUT ─────────────────────────────────────────────────────────────
// A=Category, B=ASIN, C=SKU,
// D=Desktop ATC, E=Desktop Buy, F=Mobile ATC, G=Mobile Buy,
// H=Notes, I=Last Checked, J=URL,
// K=Manual Check Notes ← NEVER OVERWRITTEN,
// L=Stock Status, M=Alert

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

// ─── GOOGLE SHEETS CLIENT ──────────────────────────────────────────────────────
async function getSheetsClient() {
  const credentials = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
  const auth = new google.auth.GoogleAuth({
    credentials,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
  return google.sheets({ version: 'v4', auth });
}

// ─── GET ALL TAB NAMES ─────────────────────────────────────────────────────────
async function getTabNames(sheets) {
  const meta = await sheets.spreadsheets.get({ spreadsheetId: SHEET_ID });
  return meta.data.sheets.map(s => s.properties.title);
}

// ─── READ ASINs FROM COLUMN B (skipping header row 1) ─────────────────────────
async function getASINs(sheets, tabName) {
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: `'${tabName}'!B:B`,  // Column B = ASIN
  });
  const rows = res.data.values || [];
  const asins = [];
  for (let i = 1; i < rows.length; i++) {  // i=0 is header
    const asin = (rows[i][0] || '').trim();
    if (asin) {
      asins.push({
        asin,
        sheetRow: i + 1, // 1-based (header=row1, first data=row2)
      });
    }
  }
  return asins;
}

// ─── WRITE ONE ROW IMMEDIATELY ─────────────────────────────────────────────────
// Writes D:J (ATC, Buy, Mobile ATC, Mobile Buy, Notes, Last Checked, URL)
// and L:M (Stock Status, Alert)
// Column K (Manual Check Notes) is NEVER touched
async function writeOneRow(sheets, tabName, sheetRow, dToJ, lToM) {
  await sheets.spreadsheets.values.batchUpdate({
    spreadsheetId: SHEET_ID,
    requestBody: {
      valueInputOption: 'USER_ENTERED',
      data: [
        {
          range: `'${tabName}'!D${sheetRow}:J${sheetRow}`,
          values: [dToJ],   // 7 values: D,E,F,G,H,I,J
        },
        {
          range: `'${tabName}'!L${sheetRow}:M${sheetRow}`,
          values: [lToM],   // 2 values: L,M  (skipping K)
        },
      ],
    },
  });
}

// ─── CHECK A SINGLE AMAZON PAGE ────────────────────────────────────────────────
async function checkPage(browser, url, isMobile) {
  const page = await browser.newPage();

  try {
    await page.authenticate({ username: PROXY_USER, password: PROXY_PASS });

    // Hide automation flag
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

    // Check for CAPTCHA / block
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

    // Check for Add to Cart button
    const hasATC = await page.evaluate(() => !!(
      document.querySelector('#add-to-cart-button')         ||
      document.querySelector('[name="submit.add-to-cart"]') ||
      document.querySelector('[data-action="add-to-cart"]') ||
      document.querySelector('[id*="add-to-cart"]')
    )).catch(() => false);

    // Check for Buy Now button
    const hasBuy = await page.evaluate(() => !!(
      document.querySelector('#buy-now-button')         ||
      document.querySelector('[name="submit.buy-now"]') ||
      document.querySelector('[data-action="buy-now"]') ||
      document.querySelector('[id*="buy-now"]')
    )).catch(() => false);

    // Get stock / availability text
    const stockText = await page.evaluate(() => {
      const el = document.querySelector('#availability, #availability_feature_div');
      return el ? el.innerText.replace(/\s+/g, ' ').trim() : '';
    }).catch(() => '');

    return {
      atc:       hasATC ? 'Found' : 'Missing',
      buy:       hasBuy ? 'Found' : 'Missing',
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
    console.log('   (no email credentials set — skipping email)');
    return;
  }

  const duration = Math.round((Date.now() - startTime) / 60000);

  // Build a clean HTML table of issues (blocked or missing buttons)
  const issues = summary.filter(r => r.alert !== '✅ LIVE');
  const issueRows = issues.map(r =>
    `<tr>
      <td style="padding:4px 8px;border:1px solid #ddd">${r.marketplace}</td>
      <td style="padding:4px 8px;border:1px solid #ddd">${r.asin}</td>
      <td style="padding:4px 8px;border:1px solid #ddd">${r.alert}</td>
      <td style="padding:4px 8px;border:1px solid #ddd">${r.notes || ''}</td>
    </tr>`
  ).join('');

  const html = `
    <h2 style="color:#333">Amazon Listing Check — ${muTime()}</h2>
    <p>
      ✅ <strong>${totalChecked}</strong> ASINs checked across 16 marketplaces<br>
      ⏱ Completed in <strong>${duration} minutes</strong><br>
      ${totalBlocked > 0 ? `⚠️ <strong>${totalBlocked}</strong> blocked by Amazon<br>` : ''}
      ${totalErrors  > 0 ? `❌ <strong>${totalErrors}</strong> errors<br>`           : ''}
    </p>

    ${issues.length === 0
      ? `<p style="color:green;font-weight:bold">✅ All listings are LIVE — no issues found!</p>`
      : `<h3 style="color:#c00">⚠️ ${issues.length} issue(s) need attention:</h3>
         <table style="border-collapse:collapse;font-size:13px">
           <tr style="background:#f0f0f0">
             <th style="padding:4px 8px;border:1px solid #ddd">Marketplace</th>
             <th style="padding:4px 8px;border:1px solid #ddd">ASIN</th>
             <th style="padding:4px 8px;border:1px solid #ddd">Status</th>
             <th style="padding:4px 8px;border:1px solid #ddd">Notes</th>
           </tr>
           ${issueRows}
         </table>`
    }

    <p style="margin-top:20px;color:#888;font-size:12px">
      Full results: 
      <a href="https://docs.google.com/spreadsheets/d/${SHEET_ID}">Open Google Sheet</a>
    </p>
  `;

  const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: { user: GMAIL_USER, pass: GMAIL_PASS },
  });

  await transporter.sendMail({
    from:    `Amazon Checker <${GMAIL_USER}>`,
    to:      NOTIFY_EMAIL,
    subject: issues.length === 0
      ? `✅ Amazon Check Done — All ${totalChecked} listings LIVE`
      : `⚠️ Amazon Check — ${issues.length} issue(s) found`,
    html,
  });

  console.log(`   📧 Email sent to ${NOTIFY_EMAIL}`);
}

// ─── HELPERS ───────────────────────────────────────────────────────────────────
const sleep  = ms => new Promise(r => setTimeout(r, ms));
const muTime = ()  => new Date().toLocaleString('en-GB', { timeZone: 'Indian/Mauritius' });

// ─── MAIN ──────────────────────────────────────────────────────────────────────
async function main() {
  const startTime = Date.now();

  console.log(`\n${'═'.repeat(60)}`);
  console.log(`  🚀  Amazon Listing Check — ${muTime()}`);
  console.log(`${'═'.repeat(60)}\n`);

  const sheets  = await getSheetsClient();
  const allTabs = await getTabNames(sheets);

  let totalChecked = 0;
  let totalBlocked = 0;
  let totalErrors  = 0;
  const summary    = []; // collects all results for the email

  for (const tabName of allTabs) {
    if (SKIP_SHEETS.includes(tabName)) continue;

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

    for (const { asin, sheetRow } of asins) {
      const url       = `${marketplace.baseUrl}/dp/${asin}`;
      const checkedAt = muTime();

      process.stdout.write(`   ${asin}  `);

      // Desktop check
      const desktop = await checkPage(browser, url, false);
      await sleep(randomDelay());

      // Mobile check
      const mobile = await checkPage(browser, url, true);
      await sleep(randomDelay());

      // Determine overall status
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
      } else if (desktop.atc === 'Found' || desktop.buy === 'Found') {
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

      // D:J — 7 columns
      const dToJ = [
        desktop.atc,   // D — Desktop ATC
        desktop.buy,   // E — Desktop Buy
        mobile.atc,    // F — Mobile ATC
        mobile.buy,    // G — Mobile Buy
        notes,         // H — Notes
        checkedAt,     // I — Last Checked
        url,           // J — URL
      ];

      // L:M — 2 columns (K = Manual Check Notes is skipped)
      const lToM = [
        desktop.stock, // L — Stock Status
        alert,         // M — Alert
      ];

      // Write immediately — live row-by-row update in the sheet
      try {
        await writeOneRow(sheets, tabName, sheetRow, dToJ, lToM);
      } catch (err) {
        console.log(`      ⚠ Sheet write failed for ${asin}: ${err.message}`);
      }

      // Add to summary for email
      summary.push({ marketplace: tabName, asin, alert, notes });
      totalChecked++;
    }

    await browser.close().catch(() => {});
    console.log(`\n   ✅ ${tabName} complete`);
  }

  console.log(`\n${'═'.repeat(60)}`);
  console.log(`  ✅  All done — ${muTime()}`);
  console.log(`  📊  ${totalChecked} ASINs checked`);
  if (totalBlocked > 0) console.log(`  ⚠️   ${totalBlocked} blocked by Amazon`);
  if (totalErrors  > 0) console.log(`  ❌  ${totalErrors} errors`);
  console.log(`${'═'.repeat(60)}\n`);

  // Send email summary
  console.log('📧 Sending email summary...');
  await sendEmailSummary(summary, totalChecked, totalBlocked, totalErrors, startTime);
}

// ─── RUN ───────────────────────────────────────────────────────────────────────
main().catch(err => {
  console.error('\n❌ Fatal error:', err);
  process.exit(1);
});
