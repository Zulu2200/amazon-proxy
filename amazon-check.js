// ═══════════════════════════════════════════════════════════════════════════════
//  AMAZON LISTING CHECKER — Puppeteer + Google Sheets
//  Two modes: full (updates sheet) and spotcheck (Telegram only)
// ═══════════════════════════════════════════════════════════════════════════════

const puppeteer  = require('puppeteer');
const { google } = require('googleapis');
const nodemailer = require('nodemailer');

// ─── CONFIG ────────────────────────────────────────────────────────────────────
const SHEET_ID        = '1BQD8Qf9AMM4bhAcnDXAKBKoOwPN929F8Mydo8gzhLyU';
const PROXY_USER      = process.env.PROXY_USER;
const PROXY_PASS      = process.env.PROXY_PASS;
const GMAIL_USER      = process.env.GMAIL_USER;
const GMAIL_PASS      = process.env.GMAIL_PASS;
const TELEGRAM_TOKEN  = process.env.TELEGRAM_TOKEN;
const TELEGRAM_CHAT   = (process.env.TELEGRAM_CHAT_ID || '435507536').trim();
const ONLY_TAB        = (process.env.MARKETPLACE     || '').trim();
const RUN_MODE        = (process.env.RUN_MODE         || 'full').trim();
const IDENTIFIERS_RAW = (process.env.IDENTIFIERS     || '').trim();
const MARKETS_RAW     = (process.env.MARKETS         || 'ALL').trim();
const RUN_SOURCE      = (process.env.RUN_SOURCE || 'github').trim();
const SKIP_SHEETS     = ['Summary', 'Template', 'Instructions', 'History'];
const HISTORY_TAB     = 'History';
const SHEET_URL       = `https://docs.google.com/spreadsheets/d/${SHEET_ID}`;

// Source label for notifications
const sourceLabel = () => {
  const icons = { telegram: '📱 Telegram', sheet: '📊 Google Sheet', github: '🌐 GitHub', automatic: '⏰ Automatic' };
  return icons[RUN_SOURCE] || '🌐 GitHub';
};

// Saudi Arabia runs in parallel with others; UAE runs after Saudi Arabia
// (they share the same IP so can't run simultaneously)
const AFTER_SAUDI = ['UAE'];

const randomDelay = () => Math.floor(Math.random() * 3000) + 2000;

// ─── SUPPRESSED KEYWORDS (column K) ───────────────────────────────────────────
// If manual note matches any of these, suppress from email/Telegram alerts
// (but still check, write to sheet, write to history)
const isSuppressed = note => /^(closed|oos|not listed)$/i.test((note || '').trim());

// ─── UNAVAILABLE PHRASES ───────────────────────────────────────────────────────
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
  'USA':          { baseUrl: 'https://www.amazon.com',    flag: '🇺🇸', proxy: '9.142.43.131:5301'   },
  'Canada':       { baseUrl: 'https://www.amazon.ca',     flag: '🇨🇦', proxy: '192.53.140.18:5114', zipCode: 'M5V 0A1' },
  'UK':           { baseUrl: 'https://www.amazon.co.uk',  flag: '🇬🇧', proxy: '212.212.19.48:6199'  },
 'Ireland': { baseUrl: 'https://www.amazon.ie', flag: '🇮🇪', proxy: '212.212.18.216:6867' },
  'Germany':      { baseUrl: 'https://www.amazon.de',     flag: '🇩🇪', proxy: '166.0.42.187:6195'   },
  'France':       { baseUrl: 'https://www.amazon.fr',     flag: '🇫🇷', proxy: '31.98.4.142:7820'    },
  'Belgium':      { baseUrl: 'https://www.amazon.com.be', flag: '🇧🇪', proxy: '46.203.144.45:7812', zipCode: '1000'    },
  'Netherlands':  { baseUrl: 'https://www.amazon.nl',     flag: '🇳🇱', proxy: '104.253.199.5:5284'  },
  'Spain':        { baseUrl: 'https://www.amazon.es',     flag: '🇪🇸', proxy: '46.203.60.158:7158', zipCode: '28001'   },
  'Italy':        { baseUrl: 'https://www.amazon.it',     flag: '🇮🇹', proxy: '82.24.27.117:8089'   },
  'Sweden':       { baseUrl: 'https://www.amazon.se',     flag: '🇸🇪', proxy: '82.26.114.47:6749'   },
  'Poland':       { baseUrl: 'https://www.amazon.pl',     flag: '🇵🇱', proxy: '82.29.47.131:7855'   },
  'Brazil':       { baseUrl: 'https://www.amazon.com.br', flag: '🇧🇷', proxy: '192.53.142.66:5763'  },
  'Mexico':       { baseUrl: 'https://www.amazon.com.mx', flag: '🇲🇽', proxy: '9.142.194.93:6761'   },
  'Saudi Arabia': { baseUrl: 'https://www.amazon.sa',     flag: '🇸🇦', proxy: '82.29.239.167:5315'  },
  'UAE':          { baseUrl: 'https://www.amazon.ae',     flag: '🇦🇪', proxy: '82.29.239.167:5315'  },
};

// ─── COLORS ────────────────────────────────────────────────────────────────────
const COLOR = {
  green: { red: 0.714, green: 0.843, blue: 0.659 },
  red:   { red: 0.918, green: 0.600, blue: 0.600 },
  amber: { red: 1.000, green: 0.898, blue: 0.600 },
};

// ─── HELPERS ───────────────────────────────────────────────────────────────────
const sleep  = ms => new Promise(r => setTimeout(r, ms));
const muTime = ()  => new Date().toLocaleString('en-GB', { timeZone: 'Indian/Mauritius' });

// ─── SEND TELEGRAM MESSAGE (auto-splits if over 4096 chars) ──────────────────
async function sendTelegramChunk(text, chatId) {
  try {
    const res = await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML' }),
    });
    const data = await res.json();
    if (!data.ok) {
      console.log('Telegram API error:', JSON.stringify(data));
    } else {
      console.log('Telegram message sent');
    }
  } catch (e) {
    console.log('Telegram send error:', e.message);
  }
}

async function sendTelegram(text, chatId = TELEGRAM_CHAT) {
  if (!chatId || !TELEGRAM_TOKEN) {
    console.log('Telegram not configured - skipping');
    return;
  }
  const MAX = 4000;
  if (text.length <= MAX) {
    await sendTelegramChunk(text, chatId);
    return;
  }
  const lines = text.split('\n');
  let chunk = '';
  let part  = 1;
  for (const line of lines) {
    if ((chunk + '\n' + line).length > MAX) {
      await sendTelegramChunk(chunk + '\n<i>(continued...)</i>', chatId);
      chunk = '<i>(part ' + (++part) + ')</i>\n' + line;
      await new Promise(r => setTimeout(r, 500));
    } else {
      chunk = chunk ? chunk + '\n' + line : line;
    }
  }
  if (chunk) await sendTelegramChunk(chunk, chatId);
}

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
    await sheets.spreadsheets.batchUpdate({ spreadsheetId: SHEET_ID, requestBody: { requests: deleteRequests } });
  }
  if (addRequests.length > 0) {
    await sheets.spreadsheets.batchUpdate({ spreadsheetId: SHEET_ID, requestBody: { requests: addRequests } });
  }
  console.log('✅ Conditional formatting applied\n');
}

// ─── ENSURE HISTORY TAB ────────────────────────────────────────────────────────
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

// ─── APPEND TO HISTORY ─────────────────────────────────────────────────────────
async function appendToHistory(sheets, historyRows) {
  if (historyRows.length === 0) return;
  await sheets.spreadsheets.values.append({
    spreadsheetId: SHEET_ID, range: `'${HISTORY_TAB}'!A:G`,
    valueInputOption: 'USER_ENTERED', insertDataOption: 'INSERT_ROWS',
    requestBody: { values: historyRows },
  });
  console.log(`   📋 ${historyRows.length} row(s) logged to History tab`);
}

// ─── GET ALL TAB NAMES ─────────────────────────────────────────────────────────
async function getTabNames(sheets) {
  const meta = await sheets.spreadsheets.get({ spreadsheetId: SHEET_ID });
  return meta.data.sheets.map(s => s.properties.title);
}

// ─── READ ASINs, SKUs AND MANUAL NOTES ────────────────────────────────────────
async function getASINs(sheets, tabName) {
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: `'${tabName}'!B:K`,
  });
  const rows = res.data.values || [];
  const asins = [];
  for (let i = 1; i < rows.length; i++) {
    const asin       = (rows[i][0] || '').trim();
    const sku        = (rows[i][1] || '').trim();
    const manualNote = (rows[i][9] || '').trim();
    if (asin) asins.push({ asin, sku, manualNote, sheetRow: i + 1 });
  }
  return asins;
}

// ─── READ ALL ASINs FOR SPOT CHECK ────────────────────────────────────────────
async function getAllASINsFromSheet(sheets, tabNames) {
  const result = {};
  for (const tabName of tabNames) {
    if (SKIP_SHEETS.includes(tabName) || !MARKETPLACES[tabName]) continue;
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId: SHEET_ID,
      range: `'${tabName}'!B:C`,
    });
    const rows = (res.data.values || []).slice(1);
    result[tabName] = rows
      .filter(r => (r[0] || '').trim())
      .map(r => ({ asin: (r[0] || '').trim(), sku: (r[1] || '').trim() }));
  }
  return result;
}

// ─── WRITE ONE ROW ─────────────────────────────────────────────────────────────
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


// ─── HANDLE AMAZON "CONTINUE SHOPPING" SOFT BLOCK ─────────────────────────────
// Amazon sometimes shows a soft interstitial on desktop:
// "Click the button below to continue shopping". This is not a product page.
// We click the Continue shopping button and wait before checking product buttons.
async function handleContinueShopping(page, url, label = '') {
  for (let attempt = 1; attempt <= 2; attempt++) {
    const bodyText = await page.evaluate(() =>
      document.body ? document.body.innerText.replace(/\s+/g, ' ').trim() : ''
    ).catch(() => '');

    const pageShape = await page.evaluate(() => ({
      hasCoreProductArea: !!(
        document.querySelector('#ppd') ||
        document.querySelector('#centerCol') ||
        document.querySelector('#rightCol') ||
        document.querySelector('#buybox') ||
        document.querySelector('#desktop_buybox') ||
        document.querySelector('#add-to-cart-button') ||
        document.querySelector('#buy-now-button') ||
        document.querySelector('input[name="submit.add-to-cart"]') ||
        document.querySelector('input[name="submit.buy-now"]')
      )
    })).catch(() => ({ hasCoreProductArea: false }));

    const hasContinueShoppingText = /continue shopping/i.test(bodyText);

    const isContinueShoppingPage =
      /click the button below to continue shopping/i.test(bodyText) ||
      /^continue shopping$/i.test(bodyText) ||
      /continue shopping conditions of use/i.test(bodyText) ||
      (
        hasContinueShoppingText &&
        !pageShape.hasCoreProductArea &&
        /interest-based ads notice|skip to main content|conditions of use/i.test(bodyText)
      );

    if (!isContinueShoppingPage) return false;

    console.log(`      🟡 ${label} Amazon Continue Shopping page detected — clicking through (attempt ${attempt})`);

    const clicked = await page.evaluate(() => {
      const candidates = Array.from(document.querySelectorAll('button, input[type="submit"], input[type="button"], a'));
      const target = candidates.find(el => {
        const text = ((el.innerText || el.value || el.getAttribute('aria-label') || '') + '').trim();
        return /continue shopping/i.test(text);
      });

      if (target) {
        target.click();
        return true;
      }

      const form = document.querySelector('form');
      if (form) {
        form.submit();
        return true;
      }

      return false;
    }).catch(() => false);

    if (clicked) {
      await sleep(5000);
      await page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 12000 }).catch(() => {});
      await sleep(3000);
    } else {
      console.log(`      ⚠️ ${label} Continue Shopping page found but no clickable button/form was detected`);
      return true;
    }

    // Some Amazon versions do not navigate cleanly after clicking.
    // Reload the target product URL once after clicking through.
    if (attempt === 1) {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
      await sleep(3000);
    }
  }

  return true;
}


// ─── CHECK A SINGLE AMAZON PAGE ────────────────────────────────────────────────
async function checkPage(browser, url, isMobile, baseUrl, zipCode) {
  const page = await browser.newPage();
  try {
    await page.authenticate({ username: PROXY_USER, password: PROXY_PASS });
    await page.evaluateOnNewDocument(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => false });
      window.chrome = { runtime: {} };
    });

    if (isMobile) {
      await page.setUserAgent('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1');
      await page.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true });
    } else {
      await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36');
      await page.setViewport({ width: 1366, height: 768 });
    }

    await page.setExtraHTTPHeaders({
      'Accept':          'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.9',
      'Accept-Encoding': 'gzip, deflate, br',
    });

    if (zipCode && !isMobile) {
      try {
        await page.goto(baseUrl, { waitUntil: 'domcontentloaded', timeout: 15000 });
        await page.evaluate(async (baseUrl, zipCode) => {
          await fetch(`${baseUrl}/portal-migration/hz/glow/address-change`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({ locationType: 'LOCATION_INPUT', zipCode, storeContext: 'generic', deviceType: 'web', pageType: 'Gateway', actionSource: 'glow' }),
            credentials: 'include',
          });
        }, baseUrl, zipCode);
        await sleep(1500);
      } catch (e) {}
    }

    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });

    // Canada/Brazil desktop sometimes gets Amazon's soft "Continue shopping" page.
    // Click through it before trying to detect Add to Cart / Buy Now.
    if (!isMobile && (baseUrl.includes('amazon.ca') || baseUrl.includes('amazon.com.br'))) {
      await handleContinueShopping(page, url, baseUrl.includes('amazon.ca') ? 'Canada desktop' : 'Brazil desktop');
    }

    // Keep normal marketplaces exactly like before.
    // Only Canada desktop gets a stronger wait because amazon.ca desktop buy box can load late.
    const isCanadaDesktop = baseUrl.includes('amazon.ca') && !isMobile;
    const waitSelector = isCanadaDesktop
      ? '#add-to-cart-button, #buy-now-button, input[name="submit.add-to-cart"], input[name="submit.buy-now"], #availability, #availability_feature_div, #captchacharacters'
      : '#add-to-cart-button, #buy-now-button, #availability, #captchacharacters, .a-page';

    await page.waitForSelector(waitSelector, { timeout: isCanadaDesktop ? 18000 : 8000 }).catch(() => {});

    if (isCanadaDesktop) {
      await sleep(5000);
      await page.evaluate(() => window.scrollBy(0, 350)).catch(() => {});
      await sleep(2000);
    }

    const pageTitle   = await page.title().catch(() => '');
    const bodySnippet = await page.evaluate(() => document.body ? document.body.innerText.substring(0, 600) : '').catch(() => '');
    const isBlocked =
      /robot|captcha|verify|sorry|unusual traffic/i.test(pageTitle) ||
      /enter the characters|type the characters|are you a human/i.test(bodySnippet) ||
      /click the button below to continue shopping/i.test(bodySnippet);

    if (isBlocked) {
      return {
        atc: 'BLOCKED',
        buy: 'BLOCKED',
        stock: /click the button below to continue shopping/i.test(bodySnippet)
          ? 'Amazon Continue Shopping soft block'
          : 'CAPTCHA detected',
        isBlocked: true,
        isUnavailable: false
      };
    }

    const pageState = await page.evaluate(() => {
      const hasAny = selectors => selectors.some(selector => !!document.querySelector(selector));

      const atcSelectors = [
        '#add-to-cart-button',
        'input[name="submit.add-to-cart"]',
      ];

      const buySelectors = [
        '#buy-now-button',
        'input[name="submit.buy-now"]',
      ];

      const purchaseBoxSelectors = [
        '#buybox',
        '#desktop_buybox',
        '#newAccordionRow',
        '#add-to-cart-button',
        '#buy-now-button',
        'input[name="submit.add-to-cart"]',
        'input[name="submit.buy-now"]',
      ];

      const el = document.querySelector('#availability, #availability_feature_div');
      const stockText = el ? el.innerText.replace(/\s+/g, ' ').trim() : '';

      return {
        hasATC: hasAny(atcSelectors),
        hasBuy: hasAny(buySelectors),
        hasPurchaseBox: hasAny(purchaseBoxSelectors),
        stockText,
      };
    }).catch(() => ({ hasATC: false, hasBuy: false, hasPurchaseBox: false, stockText: '' }));

    // Detailed desktop debug logs for Canada/Brazil only.
    // This tells us what Amazon is actually showing to desktop Puppeteer.
    const needsDesktopDebug =
      !isMobile &&
      (baseUrl.includes('amazon.ca') || baseUrl.includes('amazon.com.br')) &&
      !pageState.hasATC &&
      !pageState.hasBuy;

    if (needsDesktopDebug) {
      const desktopDebug = await page.evaluate(() => {
        const getText = selector => {
          const el = document.querySelector(selector);
          return el ? el.innerText.replace(/\s+/g, ' ').trim().substring(0, 400) : '';
        };

        const bodyText = document.body
          ? document.body.innerText.replace(/\s+/g, ' ').trim()
          : '';

        return {
          title: document.title,
          currentUrl: location.href,
          deliveryLine1: getText('#glow-ingress-line1'),
          deliveryLine2: getText('#glow-ingress-line2'),
          availability: getText('#availability, #availability_feature_div'),
          hasBuybox: !!document.querySelector('#buybox'),
          hasDesktopBuybox: !!document.querySelector('#desktop_buybox'),
          hasRightCol: !!document.querySelector('#rightCol'),
          hasCenterCol: !!document.querySelector('#centerCol'),
          hasPpd: !!document.querySelector('#ppd'),
          hasNewAccordionRow: !!document.querySelector('#newAccordionRow'),
          hasATCId: !!document.querySelector('#add-to-cart-button'),
          hasBuyNowId: !!document.querySelector('#buy-now-button'),
          hasATCInput: !!document.querySelector('input[name="submit.add-to-cart"]'),
          hasBuyNowInput: !!document.querySelector('input[name="submit.buy-now"]'),
          hasAllBuyingOptionsText: /see all buying options|ver todas as opções de compra|voir toutes les options d'achat/i.test(bodyText),
          hasUnavailableText: /currently unavailable|not available|atualmente indisponível|indisponível|sem estoque/i.test(bodyText),
          bodyStart: bodyText.substring(0, 900),
        };
      }).catch(e => ({ error: e.message }));

      console.log('🧪 DESKTOP DEBUG START');
      console.log(JSON.stringify(desktopDebug, null, 2));
      console.log('🧪 DESKTOP DEBUG END');
    }

    // Buttons win. This restores the old reliable mobile behavior, while still
    // allowing Canada desktop to detect alternate Amazon button inputs.
    if (pageState.hasATC || pageState.hasBuy) {
      return {
        atc:           pageState.hasATC ? 'Found ✅' : 'Missing ❌',
        buy:           pageState.hasBuy ? 'Found ✅' : 'Missing ❌',
        stock:         pageState.stockText.substring(0, 60) || 'In Stock',
        isBlocked:     false,
        isUnavailable: false,
      };
    }

    const availText = pageState.stockText.toLowerCase();
    const isUnavailable = UNAVAILABLE_PHRASES.some(p => availText.includes(p)) || !pageState.hasPurchaseBox;
    if (isUnavailable) {
      return {
        atc: 'Missing ❌',
        buy: 'Missing ❌',
        stock: pageState.stockText.substring(0, 60) || 'Unavailable',
        isBlocked: false,
        isUnavailable: true,
      };
    }

    return {
      atc:           'Missing ❌',
      buy:           'Missing ❌',
      stock:         pageState.stockText.substring(0, 60) || 'No buttons found',
      isBlocked:     false,
      isUnavailable: false,
    };
  } catch (err) {
    return { atc: 'Error', buy: 'Error', stock: (err.message || '').substring(0, 60), isBlocked: false, isUnavailable: false };
  } finally {
    await page.close().catch(() => {});
  }
}

// ─── CHECK ONE ASIN WITH RETRY ─────────────────────────────────────────────────
async function checkPageWithRetry(browser, url, isMobile, baseUrl, zipCode) {
  const result = await checkPage(browser, url, isMobile, baseUrl, zipCode);

  // Retry once if blocked or error
  if (result.isBlocked || result.atc === 'Error') {
    console.log(`      ↩ Retrying in 10 seconds...`);
    await sleep(10000);
    return await checkPage(browser, url, isMobile, baseUrl, zipCode);
  }

  return result;
}

// ─── PROCESS ONE MARKETPLACE TAB ──────────────────────────────────────────────
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

  // Minimal restart logic: only for Canada/Brazil, where desktop can degrade
  // after several product pages. Other marketplaces stay unchanged.
  const RESTART_MARKETS = ['Brazil']; // Canada removed: restart was causing Amazon's desktop soft-block page
  const RESTART_EVERY = RESTART_MARKETS.includes(tabName) ? 8 : 9999;
  let browser = null;
  let checksInThisBrowser = 0;

  async function launchMarketBrowser() {
    if (browser) {
      await browser.close().catch(() => {});
    }

    const userDataDir = `/tmp/chrome-${tabName.replace(/\s+/g, '-')}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    return await puppeteer.launch({
      headless: 'new',
      userDataDir,
      args: [
        `--proxy-server=http://${proxyHost}:${proxyPort}`,
        '--no-sandbox', '--disable-setuid-sandbox',
        '--disable-dev-shm-usage', '--disable-gpu',
        '--disable-blink-features=AutomationControlled',
        '--window-size=1366,768',
      ],
    });
  }

  browser = await launchMarketBrowser();

  const summary     = [];
  const historyRows = [];
  let totalBlocked  = 0;
  let totalErrors   = 0;

  for (const { asin, sku, manualNote, sheetRow } of asins) {
    if (checksInThisBrowser >= RESTART_EVERY) {
      console.log(`   [${tabName}] 🔄 Restarting browser after ${checksInThisBrowser} ASINs`);
      browser = await launchMarketBrowser();
      checksInThisBrowser = 0;
      await sleep(5000);
    }

    const url       = `${marketplace.baseUrl}/dp/${asin}`;
    const checkedAt = muTime();
    const suppressed = isSuppressed(manualNote);

    process.stdout.write(`   [${tabName}] ${asin}${suppressed ? ' [' + manualNote.toUpperCase() + ']' : ''}  `);

    let desktop = await checkPageWithRetry(browser, url, false, marketplace.baseUrl, marketplace.zipCode);
    await sleep(randomDelay());
    const mobile  = await checkPageWithRetry(browser, url, true,  marketplace.baseUrl, marketplace.zipCode);
    await sleep(randomDelay());

    // Canada/Brazil desktop rescue:
    // If mobile proves the listing is live but desktop missed the buttons,
    // restart Chrome and retry desktop once in a completely fresh browser.
    const earlyDesktopFoundButtons = desktop.atc === 'Found ✅' || desktop.buy === 'Found ✅';
    const earlyMobileFoundButtons  = mobile.atc === 'Found ✅' || mobile.buy === 'Found ✅';

    if (!earlyDesktopFoundButtons && earlyMobileFoundButtons && ['Canada', 'Brazil'].includes(tabName)) {
      console.log(`      🔁 Desktop missed buttons but mobile found them — restarting Chrome and retrying desktop once`);
      console.log(`      🔎 Before rescue: desktop ATC=${desktop.atc} Buy=${desktop.buy} Stock=${desktop.stock} | mobile ATC=${mobile.atc} Buy=${mobile.buy} Stock=${mobile.stock}`);

      browser = await launchMarketBrowser();
      checksInThisBrowser = 0;

      await sleep(10000);

      desktop = await checkPageWithRetry(browser, url, false, marketplace.baseUrl, marketplace.zipCode);
      await sleep(randomDelay());

      console.log(`      🔁 Desktop rescue result: ATC=${desktop.atc} Buy=${desktop.buy} Stock=${desktop.stock}`);
    }

    let alert       = '';
    let notes       = '';
    let reactivated = false;

    // Mobile is more reliable than desktop — if mobile finds buttons, listing is LIVE
    const mobileFoundButtons = mobile.atc === 'Found ✅' || mobile.buy === 'Found ✅';
    const desktopFoundButtons = desktop.atc === 'Found ✅' || desktop.buy === 'Found ✅';

    if (desktop.isBlocked && !mobileFoundButtons) {
      alert = '⚠️ BLOCKED'; notes = 'Amazon blocked this check'; totalBlocked++;
    } else if (desktop.atc === 'Error' && !mobileFoundButtons) {
      alert = '⚠️ ERROR'; notes = desktop.stock; totalErrors++;
    } else if (desktopFoundButtons || mobileFoundButtons) {
      // Either desktop or mobile found buttons — listing is LIVE
      alert = '✅ LIVE';
      // Add note if desktop disagreed with mobile
      if (!desktopFoundButtons && mobileFoundButtons) {
        notes = 'Mobile confirmed live (desktop detection issue)';
      }
      if (suppressed) {
        reactivated = true;
        alert = '🟢 REACTIVATED';
        notes = `Was marked ${manualNote.toUpperCase()} but is now LIVE!`;
      }
    } else if (desktop.isUnavailable) {
      alert = '🔴 UNAVAILABLE'; notes = desktop.stock || 'Listing unavailable';
    } else {
      alert = '🔴 NO BUTTONS'; notes = desktop.stock || 'No ATC or Buy Now found';
    }

    console.log(`D: ATC=${desktop.atc} Buy=${desktop.buy} | M: ATC=${mobile.atc} Buy=${mobile.buy} | ${alert}`);

    const dToJ = [desktop.atc, desktop.buy, mobile.atc, mobile.buy, notes, checkedAt, url];
    const lToM = [desktop.stock, alert];

    try {
      // Small random delay before writing to avoid parallel write conflicts
      await sleep(Math.floor(Math.random() * 500) + 100);
      await writeOneRow(sheets, tabName, sheetRow, dToJ, lToM);
    } catch (err) {
      console.log(`   [${tabName}] ⚠ Sheet write failed for ${asin}: ${err.message}`);
      // Retry once after a longer delay
      try {
        await sleep(2000);
        await writeOneRow(sheets, tabName, sheetRow, dToJ, lToM);
        console.log(`   [${tabName}] ✅ Retry write succeeded for ${asin}`);
      } catch (err2) {
        console.log(`   [${tabName}] ❌ Retry also failed for ${asin}: ${err2.message}`);
      }
    }

    historyRows.push([today, now, tabName, asin, sku, alert, notes]);
    summary.push({
      marketplace: tabName,
      asin, sku, alert, notes,
      suppress:    suppressed && !reactivated,
      reactivated,
    });

    checksInThisBrowser++;
  }

  await browser.close().catch(() => {});
  console.log(`   ✅ [${tabName}] complete`);
  return { summary, historyRows, totalBlocked, totalErrors };
}

// ─── SPOT CHECK MODE ───────────────────────────────────────────────────────────
async function runSpotCheck(sheets, telegramChatId) {
  const identifiers = IDENTIFIERS_RAW.split(',').map(s => s.trim().toUpperCase()).filter(Boolean);
  const allTabs     = await getTabNames(sheets);

  let marketsToCheck;
  if (MARKETS_RAW === 'ALL' || !MARKETS_RAW) {
    marketsToCheck = allTabs.filter(t => !SKIP_SHEETS.includes(t) && MARKETPLACES[t]);
  } else {
    marketsToCheck = MARKETS_RAW.split(',').map(s => s.trim()).filter(m => MARKETPLACES[m]);
  }

  console.log(`🔍 Spot check: ${identifiers.join(', ')} across ${marketsToCheck.join(', ')}`);

  const sheetData   = await getAllASINsFromSheet(sheets, marketsToCheck);
  const results     = [];
  const historyRows = [];
  const today = new Date().toLocaleDateString('en-GB', { timeZone: 'Indian/Mauritius' });
  const now   = new Date().toLocaleTimeString('en-GB', { timeZone: 'Indian/Mauritius' });

  for (const market of marketsToCheck) {
    const config   = MARKETPLACES[market];
    const tabItems = sheetData[market] || [];

    const matches = [];
    for (const identifier of identifiers) {
      const match = tabItems.find(item =>
        item.asin.toUpperCase() === identifier || item.sku.toUpperCase() === identifier
      );
      if (match) matches.push({ ...match, identifier });
      else results.push({ market, identifier, status: '❓ NOT FOUND', detail: 'Not in sheet for this marketplace' });
    }

    if (matches.length === 0) continue;

    const [proxyHost, proxyPort] = config.proxy.split(':');
    const browser = await puppeteer.launch({
      headless: 'new',
      args: [
        `--proxy-server=http://${proxyHost}:${proxyPort}`,
        '--no-sandbox', '--disable-setuid-sandbox',
        '--disable-dev-shm-usage', '--disable-gpu',
        '--disable-blink-features=AutomationControlled',
      ],
    });

    for (const { asin, sku, identifier } of matches) {
      const url     = `${config.baseUrl}/dp/${asin}`;
      const desktop = await checkPageWithRetry(browser, url, false, config.baseUrl, config.zipCode);
      await sleep(randomDelay());

      let status = '';
      let detail = '';

      if (desktop.isBlocked)           { status = '⚠️ BLOCKED';     detail = 'CAPTCHA detected'; }
      else if (desktop.atc === 'Error') { status = '⚠️ ERROR';       detail = desktop.stock; }
      else if (desktop.isUnavailable)   { status = '🔴 UNAVAILABLE'; detail = desktop.stock || 'Unavailable'; }
      else if (desktop.atc === 'Found ✅' || desktop.buy === 'Found ✅') { status = '✅ LIVE'; detail = desktop.stock; }
      else                              { status = '🔴 NO BUTTONS';  detail = desktop.stock || 'No buttons found'; }

      results.push({ market, identifier, asin, sku, status, detail });
      historyRows.push([today, now, market, asin, sku, status, (detail || '') + ' (spot check)']);
      console.log(`   [${market}] ${identifier} (${asin}) → ${status}`);
      await sleep(randomDelay());
    }

    await browser.close().catch(() => {});
  }

  await appendToHistory(sheets, historyRows);

  let msg = `📋 <b>Spot Check Results</b> — ${muTime()}\n${'─'.repeat(30)}\n`;
  for (const r of results) {
    const flag = MARKETPLACES[r.market]?.flag || '🌐';
    msg += `\n${flag} <b>${r.market}</b>\n`;
    msg += `  ${r.identifier} → ${r.status}\n`;
    if (r.detail) msg += `  <i>${r.detail}</i>\n`;
  }
  msg += `\n<a href="${SHEET_URL}">📊 Open Google Sheet</a>`;

  await sendTelegram(msg, telegramChatId || TELEGRAM_CHAT);
  console.log(`📱 Spot check results sent to Telegram`);
}

// ─── FORMAT TELEGRAM SUMMARY ──────────────────────────────────────────────────
function formatTelegramSummary(summary, totalChecked, totalBlocked, totalErrors, startTime, scope) {
  const duration    = Math.round((Date.now() - startTime) / 60000);
  const reactivated = summary.filter(r => r.reactivated);
  const issues      = summary.filter(r => r.alert !== '✅ LIVE' && !r.suppress && !r.reactivated);

  let msg = `📊 <b>Amazon Check Complete</b>\n`;
  msg += `${'─'.repeat(30)}\n`;
  msg += `📦 ${scope}\n`;
  msg += `✅ ${totalChecked} ASINs checked\n`;
  msg += `⏱ ${duration} minute(s)\n`;
  if (totalBlocked > 0) msg += `⚠️ ${totalBlocked} blocked\n`;
  if (totalErrors  > 0) msg += `❌ ${totalErrors} errors\n`;
  msg += '\n';

  if (reactivated.length > 0) {
    msg += `🚨 <b>URGENT — ${reactivated.length} previously closed listing(s) now LIVE:</b>\n`;
    for (const r of reactivated) {
      const flag = MARKETPLACES[r.marketplace]?.flag || '🌐';
      msg += `  ${flag} ${r.marketplace} | ${r.asin} | ${r.sku}\n`;
      msg += `  <i>${r.notes}</i>\n`;
    }
    msg += '\n';
  }

  if (issues.length === 0 && reactivated.length === 0) {
    msg += `✅ All active listings are LIVE — no issues!`;
  } else if (issues.length > 0) {
    msg += `⚠️ <b>${issues.length} issue(s) need attention:</b>\n`;
    for (const r of issues) {
      const flag = MARKETPLACES[r.marketplace]?.flag || '🌐';
      msg += `\n${flag} ${r.marketplace} | ${r.asin} | ${r.sku}\n`;
      msg += `  ${r.alert}${r.notes ? ' — ' + r.notes : ''}\n`;
    }
  }

  msg += `\n\n<a href="${SHEET_URL}">📊 Open Google Sheet</a>`;
  return msg;
}

// ─── SEND EMAIL SUMMARY ────────────────────────────────────────────────────────
async function sendEmailSummary(summary, totalChecked, totalBlocked, totalErrors, startTime, scope) {
  if (!GMAIL_USER || !GMAIL_PASS) return;

  const duration    = Math.round((Date.now() - startTime) / 60000);
  const reactivated = summary.filter(r => r.reactivated);
  const issues      = summary.filter(r => r.alert !== '✅ LIVE' && !r.suppress && !r.reactivated);

  const makeRows = arr => arr.map(r =>
    `<tr${r.reactivated ? ' style="background:#fff3cd"' : ''}>
      <td style="padding:4px 8px;border:1px solid #ddd">${r.marketplace}</td>
      <td style="padding:4px 8px;border:1px solid #ddd">${r.asin}</td>
      <td style="padding:4px 8px;border:1px solid #ddd">${r.sku}</td>
      <td style="padding:4px 8px;border:1px solid #ddd">${r.alert}</td>
      <td style="padding:4px 8px;border:1px solid #ddd">${r.notes || ''}</td>
    </tr>`
  ).join('');

  const tableHeader = `<tr style="background:#f0f0f0">
    <th style="padding:4px 8px;border:1px solid #ddd">Marketplace</th>
    <th style="padding:4px 8px;border:1px solid #ddd">ASIN</th>
    <th style="padding:4px 8px;border:1px solid #ddd">SKU</th>
    <th style="padding:4px 8px;border:1px solid #ddd">Status</th>
    <th style="padding:4px 8px;border:1px solid #ddd">Notes</th>
  </tr>`;

  const html = `
    <h2 style="color:#333;font-family:Arial,sans-serif">Amazon Listing Check — ${muTime()}</h2>
    <p style="font-family:Arial,sans-serif">
      📦 <strong>${scope}</strong><br>
      ✅ <strong>${totalChecked}</strong> ASINs checked<br>
      ⏱ Completed in <strong>${duration} minutes</strong><br>
      ${totalBlocked > 0 ? `⚠️ <strong>${totalBlocked}</strong> blocked<br>` : ''}
      ${totalErrors  > 0 ? `❌ <strong>${totalErrors}</strong> errors<br>` : ''}
    </p>
    ${reactivated.length > 0 ? `
      <h3 style="color:#856404;font-family:Arial,sans-serif">🚨 URGENT — Previously closed listing(s) now LIVE:</h3>
      <table style="border-collapse:collapse;font-size:13px;font-family:Arial,sans-serif">${tableHeader}${makeRows(reactivated)}</table><br>` : ''}
    ${issues.length === 0 && reactivated.length === 0
      ? `<p style="color:green;font-weight:bold;font-family:Arial,sans-serif">✅ All active listings LIVE — no issues!</p>`
      : issues.length > 0
        ? `<h3 style="color:#c00;font-family:Arial,sans-serif">⚠️ ${issues.length} issue(s):</h3>
           <table style="border-collapse:collapse;font-size:13px;font-family:Arial,sans-serif">${tableHeader}${makeRows(issues)}</table>` : ''
    }
    <p style="margin-top:24px;font-family:Arial,sans-serif">
      <a href="${SHEET_URL}" style="background:#4285f4;color:white;padding:8px 16px;border-radius:4px;text-decoration:none">Open Google Sheet</a>
    </p>`;

  const hasUrgent = reactivated.length > 0;
  const subject = hasUrgent
    ? `🚨 URGENT — ${reactivated.length} closed listing(s) now LIVE (${muTime()})`
    : issues.length === 0
      ? `✅ Amazon Check Done — All ${totalChecked} listings LIVE (${muTime()})`
      : `⚠️ Amazon Check — ${issues.length} issue(s) found (${muTime()})`;

  const transporter = nodemailer.createTransport({ service: 'gmail', auth: { user: GMAIL_USER, pass: GMAIL_PASS } });
  await transporter.sendMail({ from: `Amazon Checker <${GMAIL_USER}>`, to: GMAIL_USER, subject, html });
  console.log(`   📧 Email sent`);
}

// ─── MAIN ──────────────────────────────────────────────────────────────────────
async function main() {
  const startTime = Date.now();

  console.log(`\n${'═'.repeat(60)}`);
  console.log(`  🚀  Mode: ${RUN_MODE.toUpperCase()} — ${muTime()}`);
  console.log(`${'═'.repeat(60)}\n`);

  const sheets = await getSheetsClient();

  // ── SPOT CHECK MODE ────────────────────────────────────────────────────────
  if (RUN_MODE === 'spotcheck' && IDENTIFIERS_RAW) {
    await runSpotCheck(sheets, TELEGRAM_CHAT);
    return;
  }

  // ── FULL RUN MODE ──────────────────────────────────────────────────────────
  await applyConditionalFormatting(sheets);
  await ensureHistoryTab(sheets);

  const allTabs   = await getTabNames(sheets);
  const tabsToRun = allTabs.filter(t => {
    if (SKIP_SHEETS.includes(t)) return false;
    if (!MARKETPLACES[t]) return false;
    if (ONLY_TAB && t !== ONLY_TAB) return false;
    return true;
  });

  const scope = ONLY_TAB
    ? ONLY_TAB
    : tabsToRun.length >= Object.keys(MARKETPLACES).length
      ? 'all 16 marketplaces'
      : tabsToRun.join(', ');

  // Send start notification
  await sendTelegram(
    `🚀 <b>Check started!</b>\n\n📦 Running: <i>${scope}</i>\n📌 Triggered from: ${sourceLabel()}\nResults will arrive here + email when done.`
  );

  const today = new Date().toLocaleDateString('en-GB', { timeZone: 'Indian/Mauritius' });
  const now   = new Date().toLocaleTimeString('en-GB', { timeZone: 'Indian/Mauritius' });

  // Split tabs: parallel group, Saudi Arabia, then UAE after Saudi
  const afterSaudiTabs = tabsToRun.filter(t => AFTER_SAUDI.includes(t));
  const parallelTabs   = tabsToRun.filter(t => !AFTER_SAUDI.includes(t));

  console.log(`🔁 Running ${parallelTabs.length + afterSaudiTabs.length} tabs sequentially (one at a time)`);

  // Run each tab sequentially — slower but more reliable (no Chrome proxy conflicts)
  const allResults = [];
  for (const t of [...parallelTabs, ...afterSaudiTabs]) {
    allResults.push(await processTab(sheets, t, today, now));
  }
  const summary      = allResults.flatMap(r => r.summary);
  const historyRows  = allResults.flatMap(r => r.historyRows);
  const totalChecked = summary.length;
  const totalBlocked = allResults.reduce((n, r) => n + r.totalBlocked, 0);
  const totalErrors  = allResults.reduce((n, r) => n + r.totalErrors,  0);

  console.log(`\n📋 Writing to History tab...`);
  await appendToHistory(sheets, historyRows);

  console.log(`\n${'═'.repeat(60)}`);
  console.log(`  ✅  All done — ${muTime()}`);
  console.log(`  📊  ${totalChecked} ASINs checked`);
  if (totalBlocked > 0) console.log(`  ⚠️   ${totalBlocked} blocked`);
  if (totalErrors  > 0) console.log(`  ❌  ${totalErrors} errors`);
  console.log(`${'═'.repeat(60)}\n`);

  // Send Telegram summary
  console.log('📱 Sending Telegram summary...');
  const telegramMsg = formatTelegramSummary(summary, totalChecked, totalBlocked, totalErrors, startTime, scope);
  await sendTelegram(telegramMsg);

  // Send email
  console.log('📧 Sending email summary...');
  await sendEmailSummary(summary, totalChecked, totalBlocked, totalErrors, startTime, scope);
}

main().catch(err => {
  console.error('\n❌ Fatal error:', err);
  process.exit(1);
});
