// ═══════════════════════════════════════════════════════════════════════════════
//  AMAZON LISTING CHECKER — Puppeteer + Google Sheets
//  Runs via GitHub Actions on a daily schedule
// ═══════════════════════════════════════════════════════════════════════════════

const puppeteer  = require('puppeteer');
const { google } = require('googleapis');

// ─── CONFIG ────────────────────────────────────────────────────────────────────
const SHEET_ID    = '1BQD8Qf9AMM4bhAcnDXAKBKoOwPN929F8Mydo8gzhLyU';
const PROXY_USER  = process.env.PROXY_USER;
const PROXY_PASS  = process.env.PROXY_PASS;
const SKIP_SHEETS = ['Summary', 'Template', 'Instructions'];

// Delay between checks (ms) — keeps Amazon from rate-limiting
const DELAY_BETWEEN_CHECKS = 3000;

// Marketplace config: tab name → Amazon URL + which Webshare proxy IP to use
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

// Column layout (matching your Google Sheet):
//  A=ASIN, B=SKU, C=Desktop ATC, D=Desktop Buy, E=Mobile ATC, F=Mobile Buy,
//  G=Notes, H=Last Checked, I=URL, J=Manual Check Notes (DO NOT OVERWRITE),
//  K=Stock Status, L=Alert

// ─── GOOGLE SHEETS CLIENT ──────────────────────────────────────────────────────
async function getSheetsClient() {
  const credentials = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
  const auth = new google.auth.GoogleAuth({
    credentials,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
  return google.sheets({ version: 'v4', auth });
}

// ─── GET ALL TAB NAMES FROM SPREADSHEET ────────────────────────────────────────
async function getTabNames(sheets) {
  const meta = await sheets.spreadsheets.get({ spreadsheetId: SHEET_ID });
  return meta.data.sheets.map(s => s.properties.title);
}

// ─── READ ASINs FROM A TAB (column A, skipping header row) ────────────────────
async function getASINs(sheets, tabName) {
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: `'${tabName}'!A:A`,
  });
  const rows = res.data.values || [];
  const asins = [];
  // Start at index 1 to skip the header row (row 1 in the sheet)
  for (let i = 1; i < rows.length; i++) {
    const asin = (rows[i][0] || '').trim();
    if (asin) {
      asins.push({
        asin,
        sheetRow: i + 1, // 1-based sheet row number (header = row 1, first ASIN = row 2)
      });
    }
  }
  return asins;
}

// ─── WRITE RESULTS BACK TO SHEET ───────────────────────────────────────────────
// Writes C:I and K:L — deliberately skips J (Manual Check Notes)
async function writeResults(sheets, tabName, resultRows) {
  if (resultRows.length === 0) return;

  const data = [];
  for (const r of resultRows) {
    // C through I (7 columns): Desktop ATC, Desktop Buy, Mobile ATC, Mobile Buy,
    //                           Notes, Last Checked, URL
    data.push({
      range: `'${tabName}'!C${r.sheetRow}:I${r.sheetRow}`,
      values: [r.cToI],
    });
    // K through L (2 columns, skipping J): Stock Status, Alert
    data.push({
      range: `'${tabName}'!K${r.sheetRow}:L${r.sheetRow}`,
      values: [r.kToL],
    });
  }

  await sheets.spreadsheets.values.batchUpdate({
    spreadsheetId: SHEET_ID,
    requestBody: {
      valueInputOption: 'USER_ENTERED',
      data,
    },
  });
}

// ─── CHECK A SINGLE AMAZON PAGE ────────────────────────────────────────────────
async function checkPage(browser, url, isMobile) {
  const page = await browser.newPage();

  try {
    // Authenticate with the proxy
    await page.authenticate({ username: PROXY_USER, password: PROXY_PASS });

    // Anti-detection: remove the webdriver property that flags automation
    await page.evaluateOnNewDocument(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => false });
      window.chrome = { runtime: {} };
    });

    // Set device profile
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

    // Browser-like headers
    await page.setExtraHTTPHeaders({
      'Accept':          'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.9',
      'Accept-Encoding': 'gzip, deflate, br',
      'Cache-Control':   'no-cache',
      'Pragma':          'no-cache',
    });

    // Navigate to the product page
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });

    // Wait up to 8 seconds for something useful to appear
    await page.waitForSelector(
      '#add-to-cart-button, #buy-now-button, #availability, #captchacharacters, .a-page',
      { timeout: 8000 }
    ).catch(() => {}); // Ignore timeout — we'll still read whatever loaded

    // ── Check for CAPTCHA / block ──────────────────────────────────────────────
    const pageTitle = await page.title().catch(() => '');
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

    // ── Check for Add to Cart button ───────────────────────────────────────────
    const hasATC = await page.evaluate(() => !!(
      document.querySelector('#add-to-cart-button')         ||
      document.querySelector('[name="submit.add-to-cart"]') ||
      document.querySelector('[data-action="add-to-cart"]') ||
      document.querySelector('[id*="add-to-cart"]')
    )).catch(() => false);

    // ── Check for Buy Now button ───────────────────────────────────────────────
    const hasBuy = await page.evaluate(() => !!(
      document.querySelector('#buy-now-button')         ||
      document.querySelector('[name="submit.buy-now"]') ||
      document.querySelector('[data-action="buy-now"]') ||
      document.querySelector('[id*="buy-now"]')
    )).catch(() => false);

    // ── Get stock / availability text ──────────────────────────────────────────
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

// ─── SLEEP HELPER ──────────────────────────────────────────────────────────────
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ─── MAURITIUS TIME ────────────────────────────────────────────────────────────
const muTime = () =>
  new Date().toLocaleString('en-GB', { timeZone: 'Indian/Mauritius' });

// ─── MAIN ──────────────────────────────────────────────────────────────────────
async function main() {
  console.log(`\n${'═'.repeat(60)}`);
  console.log(`  🚀  Amazon Listing Check — ${muTime()}`);
  console.log(`${'═'.repeat(60)}\n`);

  const sheets  = await getSheetsClient();
  const allTabs = await getTabNames(sheets);

  let totalChecked = 0;
  let totalBlocked = 0;
  let totalErrors  = 0;

  for (const tabName of allTabs) {
    // Skip non-marketplace tabs
    if (SKIP_SHEETS.includes(tabName)) continue;

    const marketplace = MARKETPLACES[tabName];
    if (!marketplace) {
      console.log(`⚠️  No config for tab "${tabName}" — skipping\n`);
      continue;
    }

    console.log(`\n${'─'.repeat(60)}`);
    console.log(`📦  ${tabName}  →  ${marketplace.baseUrl}`);
    console.log(`${'─'.repeat(60)}`);

    // Read ASINs from the sheet
    const asins = await getASINs(sheets, tabName);
    if (asins.length === 0) {
      console.log(`   (no ASINs found — skipping)`);
      continue;
    }
    console.log(`   ${asins.length} ASINs to check`);

    // Launch a fresh browser for this marketplace (proxy is set at launch time)
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

    const resultRows = [];

    for (const { asin, sheetRow } of asins) {
      const url       = `${marketplace.baseUrl}/dp/${asin}`;
      const checkedAt = muTime();

      process.stdout.write(`   ${asin}  `);

      // ── Desktop check ─────────────────────────────────────────────────────
      const desktop = await checkPage(browser, url, false);
      await sleep(DELAY_BETWEEN_CHECKS);

      // ── Mobile check ──────────────────────────────────────────────────────
      const mobile = await checkPage(browser, url, true);
      await sleep(DELAY_BETWEEN_CHECKS);

      // ── Determine overall status ──────────────────────────────────────────
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
      } else if (desktop.atc.includes('Found') || desktop.buy.includes('Found')) {
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

      // ── Build values for sheet columns ────────────────────────────────────
      const cToI = [
        desktop.atc,  // C — Desktop ATC
        desktop.buy,  // D — Desktop Buy
        mobile.atc,   // E — Mobile ATC
        mobile.buy,   // F — Mobile Buy
        notes,        // G — Notes
        checkedAt,    // H — Last Checked
        url,          // I — URL
      ];

      const kToL = [
        desktop.stock, // K — Stock Status
        alert,         // L — Alert
      ];

      resultRows.push({ sheetRow, cToI, kToL });
      totalChecked++;
    }

    // Close this marketplace's browser
    await browser.close().catch(() => {});

    // Write all results for this tab in one batch call
    console.log(`\n   Writing ${resultRows.length} rows to sheet...`);
    try {
      await writeResults(sheets, tabName, resultRows);
      console.log(`   ✅ ${tabName} saved`);
    } catch (err) {
      console.error(`   ❌ Failed to write ${tabName}:`, err.message);
    }
  }

  console.log(`\n${'═'.repeat(60)}`);
  console.log(`  ✅  All done — ${muTime()}`);
  console.log(`  📊  ${totalChecked} ASINs checked`);
  if (totalBlocked > 0) console.log(`  ⚠️   ${totalBlocked} blocked by Amazon`);
  if (totalErrors  > 0) console.log(`  ❌  ${totalErrors} errors`);
  console.log(`${'═'.repeat(60)}\n`);
}

// ─── RUN ───────────────────────────────────────────────────────────────────────
main().catch(err => {
  console.error('\n❌ Fatal error:', err);
  process.exit(1);
});
