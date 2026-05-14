// ══════════════════════════════════════════════════════════════
// AMAZON LISTING CHECKER v6 — AOD endpoint (most accurate free method)
// ══════════════════════════════════════════════════════════════

// ── CHANGE THESE 3 LINES ──────────────────────────────────────
const NOTIFY_EMAIL = 'beekhoryzuber@gmail.com';
const VERCEL_URL   = 'https://amazon-proxy-jet.vercel.app';
const SECRET_TOKEN = 'Amazon2026!';
// ─────────────────────────────────────────────────────────────

const SKIP_SHEETS = ['Summary', 'Template', 'Instructions'];

const COL = {
  ASIN:          1,
  SKU:           2,
  DESKTOP_ATC:   3,
  DESKTOP_BUY:   4,
  MOBILE_ATC:    5,
  MOBILE_BUY:    6,
  NOTES:         7,
  LAST_CHECKED:  8,
  URL:           9,
  MANUAL_NOTES: 10,
  STOCK_STATUS: 11,
  ALERT:        12,
};

// ══════════════════════════════════════════════════════════════
// ENTRY POINT — set this as your daily trigger
// ══════════════════════════════════════════════════════════════
function startDailyCheck() {
  const props = PropertiesService.getScriptProperties();
  props.setProperties({
    sheetIndex: '0',
    rowIndex:   '2',
    alerts:     '[]',
    running:    'true'
  });
  Logger.log('Starting fresh check...');
  checkAllListings();
}

// ══════════════════════════════════════════════════════════════
// MAIN WORKER
// ══════════════════════════════════════════════════════════════
function checkAllListings() {
  const props      = PropertiesService.getScriptProperties();
  const ss         = SpreadsheetApp.getActiveSpreadsheet();
  const startTime  = Date.now();
  const TIME_LIMIT = 5 * 60 * 1000;

  let sheetIndex = parseInt(props.getProperty('sheetIndex') || '0');
  let rowIndex   = parseInt(props.getProperty('rowIndex')   || '2');
  let alerts     = JSON.parse(props.getProperty('alerts')   || '[]');
  const now      = new Date().toLocaleString();

  const allSheets = ss.getSheets().filter(s => !SKIP_SHEETS.includes(s.getName()));

  for (let si = sheetIndex; si < allSheets.length; si++) {
    const sheet   = allSheets[si];
    const tabName = sheet.getName();
    const lastRow = sheet.getLastRow();

    Logger.log('Checking tab: ' + tabName);

    const startRow = (si === sheetIndex) ? rowIndex : 2;

    for (let row = startRow; row <= lastRow; row++) {

      // Save progress and continue if near time limit
      if (Date.now() - startTime > TIME_LIMIT) {
        Logger.log('Saving progress at sheet ' + si + ', row ' + row);
        props.setProperties({
          sheetIndex: String(si),
          rowIndex:   String(row),
          alerts:     JSON.stringify(alerts),
          running:    'true'
        });
        ScriptApp.newTrigger('checkAllListings').timeBased().after(60 * 1000).create();
        Logger.log('Will resume in 1 minute...');
        return;
      }

      const asin = String(sheet.getRange(row, COL.ASIN).getValue()).trim();
      const sku  = String(sheet.getRange(row, COL.SKU).getValue()).trim();

      if (!asin) continue;

      // Call Vercel proxy with ASIN + marketplace tab name
      const result = fetchViaProxy(asin, tabName);
      Utilities.sleep(1500); // polite pause between requests

      let deskATC, deskBuy, mobATC, mobBuy, stock, issues = [];

      if (result.error) {
        deskATC = '⚠️ Error'; deskBuy = '⚠️ Error';
        mobATC  = '⚠️ Error'; mobBuy  = '⚠️ Error';
        stock   = 'Error';
        issues.push(result.error);
      } else if (result.blocked) {
        deskATC = '⚠️ Blocked'; deskBuy = '⚠️ Blocked';
        mobATC  = '⚠️ Blocked'; mobBuy  = '⚠️ Blocked';
        stock   = 'Blocked';
        issues.push('Amazon blocked request');
      } else {
        stock   = result.stock;
        deskATC = result.hasDesktopATC ? '✅ Found' : '❌ Missing';
        deskBuy = result.hasDesktopBuy ? '✅ Found' : '❌ Missing';
        mobATC  = result.hasMobileATC  ? '✅ Found' : '❌ Missing';
        mobBuy  = result.hasMobileBuy  ? '✅ Found' : '❌ Missing';

        if (stock !== 'In stock') {
          issues.push(stock);
        } else {
          if (!result.hasDesktopATC) issues.push('No Desktop Add to Cart');
          if (!result.hasDesktopBuy) issues.push('No Desktop Buy Now');
          if (!result.hasMobileATC)  issues.push('No Mobile Add to Cart');
          if (!result.hasMobileBuy)  issues.push('No Mobile Buy Now');
        }
      }

      // Write to sheet with cell-level colors
      writeCell(sheet, row, COL.DESKTOP_ATC, deskATC,
        deskATC === '✅ Found' ? '#d4edda' : deskATC === '❌ Missing' ? '#f8d7da' : '#fff3cd');
      writeCell(sheet, row, COL.DESKTOP_BUY, deskBuy,
        deskBuy === '✅ Found' ? '#d4edda' : deskBuy === '❌ Missing' ? '#f8d7da' : '#fff3cd');
      writeCell(sheet, row, COL.MOBILE_ATC, mobATC,
        mobATC === '✅ Found' ? '#d4edda' : mobATC === '❌ Missing' ? '#f8d7da' : '#fff3cd');
      writeCell(sheet, row, COL.MOBILE_BUY, mobBuy,
        mobBuy === '✅ Found' ? '#d4edda' : mobBuy === '❌ Missing' ? '#f8d7da' : '#fff3cd');
      writeCell(sheet, row, COL.STOCK_STATUS, stock,
        stock === 'In stock' ? '#d4edda' : stock === 'Out of stock' ? '#fff3cd' : '#f8d7da');

      const alertText = issues.length > 0 ? '⚠️ ' + issues.join(' | ') : '✅ OK';
      writeCell(sheet, row, COL.ALERT, alertText,
        issues.length > 0 ? '#f8d7da' : '#d4edda');

      sheet.getRange(row, COL.LAST_CHECKED).setValue(now);
      SpreadsheetApp.flush();

      if (issues.length > 0) {
        const url = String(sheet.getRange(row, COL.URL).getValue()).trim();
        alerts.push({ tab: tabName, asin, sku, url, stock, issues });
      }
    }
  }

  Logger.log('✅ All done. Issues: ' + alerts.length);
  props.deleteAllProperties();
  deleteContinuationTriggers();
  sendAlertEmail(alerts, now);
}

// ══════════════════════════════════════════════════════════════
// FETCH VIA VERCEL — sends ASIN + marketplace, gets back results
// ══════════════════════════════════════════════════════════════
function fetchViaProxy(asin, marketplace) {
  try {
    const proxyUrl = VERCEL_URL + '/api/check'
      + '?asin='        + encodeURIComponent(asin)
      + '&marketplace=' + encodeURIComponent(marketplace)
      + '&token='       + encodeURIComponent(SECRET_TOKEN);

    const resp = UrlFetchApp.fetch(proxyUrl, {
      muteHttpExceptions: true,
      deadline: 30
    });

    const code = resp.getResponseCode();
    const text = resp.getContentText();

    if (code !== 200 || !text.trim().startsWith('{')) {
      return { error: 'Proxy error: ' + text.substring(0, 100), blocked: false };
    }

    const json = JSON.parse(text);
    return {
      error:          null,
      blocked:        json.blocked        || false,
      hasDesktopATC:  json.hasDesktopATC  || false,
      hasDesktopBuy:  json.hasDesktopBuy  || false,
      hasMobileATC:   json.hasMobileATC   || false,
      hasMobileBuy:   json.hasMobileBuy   || false,
      stock:          json.stock          || 'Unknown',
    };
  } catch (e) {
    return { error: e.message, blocked: false };
  }
}

// ══════════════════════════════════════════════════════════════
// HELPERS
// ══════════════════════════════════════════════════════════════
function writeCell(sheet, row, col, value, bg) {
  const cell = sheet.getRange(row, col);
  cell.setValue(value);
  cell.setBackground(bg || null);
}

function deleteContinuationTriggers() {
  ScriptApp.getProjectTriggers().forEach(t => {
    if (t.getHandlerFunction() === 'checkAllListings') ScriptApp.deleteTrigger(t);
  });
}

// ══════════════════════════════════════════════════════════════
// EMAIL
// ══════════════════════════════════════════════════════════════
function sendAlertEmail(alerts, checkedAt) {
  if (alerts.length === 0) {
    GmailApp.sendEmail(NOTIFY_EMAIL,
      '✅ Amazon Listings — All Clear ' + new Date().toLocaleDateString(),
      'All listings checked. Everything looks good.\nChecked at: ' + checkedAt);
    return;
  }
  const rows = alerts.map(a => `
    <tr>
      <td style="padding:7px 12px;border:1px solid #ddd">${a.tab}</td>
      <td style="padding:7px 12px;border:1px solid #ddd"><a href="${a.url}">${a.asin}</a></td>
      <td style="padding:7px 12px;border:1px solid #ddd">${a.sku}</td>
      <td style="padding:7px 12px;border:1px solid #ddd;color:#721c24;font-weight:500">${a.stock}</td>
      <td style="padding:7px 12px;border:1px solid #ddd;color:#c0392b">${a.issues.join('<br>')}</td>
    </tr>`).join('');
  const html = `
    <div style="font-family:Arial,sans-serif;max-width:750px">
      <h2 style="color:#c0392b">⚠️ Amazon Listing Alert</h2>
      <p style="color:#666">${alerts.length} issue(s) — ${checkedAt}</p>
      <table style="border-collapse:collapse;width:100%;font-size:14px">
        <thead><tr style="background:#f2f2f2">
          <th style="padding:8px 12px;border:1px solid #ddd;text-align:left">Marketplace</th>
          <th style="padding:8px 12px;border:1px solid #ddd;text-align:left">ASIN</th>
          <th style="padding:8px 12px;border:1px solid #ddd;text-align:left">SKU</th>
          <th style="padding:8px 12px;border:1px solid #ddd;text-align:left">Stock</th>
          <th style="padding:8px 12px;border:1px solid #ddd;text-align:left">Issues</th>
        </tr></thead>
        <tbody>${rows}</tbody>
      </table>
      <p style="color:#999;font-size:12px;margin-top:20px">Auto-checked — ${checkedAt}</p>
    </div>`;
  GmailApp.sendEmail(NOTIFY_EMAIL,
    '⚠️ Amazon Alert — ' + alerts.length + ' issue(s) | ' + new Date().toLocaleDateString(),
    'See HTML version.', { htmlBody: html });
}
