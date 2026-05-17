import { ProxyAgent, fetch as proxyFetch } from 'undici';

export default async function handler(req, res) {
  const { asin, marketplace, token } = req.query;
  // ── IP Debug mode ─────────────────────────────────────────
  if (asin === 'IPTEST') {
    const proxyHost = proxyMap[marketplace] || null;
    const pu = process.env.PROXY_USER;
    const pp = process.env.PROXY_PASS;
    
    let testDispatcher = undefined;
    if (proxyHost && pu && pp) {
      testDispatcher = new ProxyAgent({ uri: `http://${pu}:${pp}@${proxyHost}` });
    }
    
    try {
      const opts = { headers: { 'User-Agent': 'Mozilla/5.0' } };
      if (testDispatcher) opts.dispatcher = testDispatcher;
      const ipResp = await proxyFetch('https://api.ipify.org?format=json', opts);
      const ipData = await ipResp.json();
      return res.status(200).json({ 
        proxyHost, 
        hasCredentials: !!(pu && pp),
        yourIP: ipData.ip,
        usingProxy: !!testDispatcher
      });
    } catch(e) {
      return res.status(200).json({ 
        proxyHost, 
        hasCredentials: !!(pu && pp),
        error: e.message,
        usingProxy: !!testDispatcher
      });
    }
  }

  if (token !== process.env.SECRET_TOKEN) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  if (!asin || !marketplace) {
    return res.status(400).json({ error: 'Missing asin or marketplace' });
  }

  // ── Amazon domain map ─────────────────────────────────────
  const domains = {
    USA:           'amazon.com',
    US:            'amazon.com',
    Canada:        'amazon.ca',
    CA:            'amazon.ca',
    Brazil:        'amazon.com.br',
    BR:            'amazon.com.br',
    Mexico:        'amazon.com.mx',
    MX:            'amazon.com.mx',
    UK:            'amazon.co.uk',
    Germany:       'amazon.de',
    DE:            'amazon.de',
    France:        'amazon.fr',
    FR:            'amazon.fr',
    Italy:         'amazon.it',
    IT:            'amazon.it',
    Spain:         'amazon.es',
    ES:            'amazon.es',
    Netherlands:   'amazon.nl',
    NL:            'amazon.nl',
    Belgium:       'amazon.com.be',
    BE:            'amazon.com.be',
    Sweden:        'amazon.se',
    SE:            'amazon.se',
    Poland:        'amazon.pl',
    PL:            'amazon.pl',
    Ireland:       'amazon.ie',
    IE:            'amazon.ie',
    Japan:         'amazon.co.jp',
    JP:            'amazon.co.jp',
    Australia:     'amazon.com.au',
    AU:            'amazon.com.au',
    India:         'amazon.in',
    IN:            'amazon.in',
    UAE:           'amazon.ae',
    AE:            'amazon.ae',
    'Saudi Arabia':'amazon.sa',
    SA:            'amazon.sa',
  };

  // ── Proxy map — one residential IP per marketplace ────────
  const proxyMap = {
    USA:            '9.142.43.131:5301',
    US:             '9.142.43.131:5301',
    Canada:         '192.53.140.18:5114',
    CA:             '192.53.140.18:5114',
    Brazil:         '192.53.142.66:5763',
    BR:             '192.53.142.66:5763',
    Mexico:         '9.142.194.93:6761',
    MX:             '9.142.194.93:6761',
    UK:             '212.212.19.48:6199',
    Ireland:        '212.212.18.216:6867',
    IE:             '212.212.18.216:6867',
    Germany:        '166.0.42.187:6195',
    DE:             '166.0.42.187:6195',
    Netherlands:    '104.253.199.5:5284',
    NL:             '104.253.199.5:5284',
    France:         '31.98.4.142:7820',
    FR:             '31.98.4.142:7820',
    Spain:          '46.203.60.158:7158',
    ES:             '46.203.60.158:7158',
    Belgium:        '46.203.144.45:7812',
    BE:             '46.203.144.45:7812',
    Sweden:         '82.26.114.47:6749',
    SE:             '82.26.114.47:6749',
    Poland:         '82.29.47.131:7855',
    PL:             '82.29.47.131:7855',
    Italy:          '82.24.27.117:8089',
    IT:             '82.24.27.117:8089',
    Australia:      '92.71.71.244:6438',
    AU:             '92.71.71.244:6438',
    Japan:          '82.25.225.30:5678',
    JP:             '82.25.225.30:5678',
    'Saudi Arabia': '82.29.239.167:5315',
    SA:             '82.29.239.167:5315',
    UAE:            '82.29.239.167:5315',
    AE:             '82.29.239.167:5315',
    India:          '82.25.225.30:5678',
    IN:             '82.25.225.30:5678',
  };

  const domain = domains[marketplace];
  if (!domain) {
    return res.status(400).json({ error: 'Unknown marketplace: ' + marketplace });
  }

  // ── Build proxy agent ─────────────────────────────────────
  const proxyHost = proxyMap[marketplace];
  const proxyUser = process.env.PROXY_USER;
  const proxyPass = process.env.PROXY_PASS;

  let dispatcher = undefined;
  if (proxyHost && proxyUser && proxyPass) {
    dispatcher = new ProxyAgent({
      uri: `http://${proxyUser}:${proxyPass}@${proxyHost}`,
    });
  }

  // ── Country-specific Accept-Language ──────────────────────
  const langMap = {
    'amazon.de':     'de-DE,de;q=0.9',
    'amazon.fr':     'fr-FR,fr;q=0.9',
    'amazon.it':     'it-IT,it;q=0.9',
    'amazon.es':     'es-ES,es;q=0.9',
    'amazon.nl':     'nl-NL,nl;q=0.9',
    'amazon.se':     'sv-SE,sv;q=0.9',
    'amazon.pl':     'pl-PL,pl;q=0.9',
    'amazon.co.jp':  'ja-JP,ja;q=0.9',
    'amazon.com.br': 'pt-BR,pt;q=0.9',
    'amazon.com.mx': 'es-MX,es;q=0.9',
    'amazon.sa':     'ar-SA,ar;q=0.9',
  };
  const acceptLang = langMap[domain] || 'en-GB,en;q=0.9';

  const productUrl = `https://www.${domain}/dp/${asin}`;
  const aodUrl     = `https://www.${domain}/gp/product/ajax/?asin=${asin}&experienceId=aodAjaxMain&deviceType=web`;

  const desktopUA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
  const mobileUA  = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';

  // ── Helper: fetch through proxy ───────────────────────────
  async function fetchWithProxy(url, headers) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);

    const opts = {
      signal: controller.signal,
      headers,
      maxRedirections: 5,
    };
    if (dispatcher) opts.dispatcher = dispatcher;

    const resp = await proxyFetch(url, opts);
    clearTimeout(timeout);
    return resp;
  }

  try {
    // ── 1. Product page (desktop) — stock status ────────────
    const productResp = await fetchWithProxy(productUrl, {
      'User-Agent':      desktopUA,
      'Accept-Language':  acceptLang,
      'Accept':           'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    });
    const productBody = (await productResp.text()).toLowerCase();

    // CAPTCHA / bot block
    const blocked = productBody.includes('robot check') ||
                    productBody.includes('enter the characters') ||
                    (productBody.includes('captcha') && productBody.length < 15000);

    if (blocked) {
      return res.status(200).json({
        blocked: true,
        hasDesktopATC: false, hasDesktopBuy: false,
        hasMobileATC:  false, hasMobileBuy:  false,
        stock: 'Blocked'
      });
    }

    // Stock status
    const notFound = productBody.includes('looking for something') ||
                     productBody.includes('page not found') ||
                     productResp.status === 404;
    const unavail  = productBody.includes('currently unavailable');
    const oos      = productBody.includes('out of stock') ||
                     productBody.includes('temporarily out of stock') ||
                     productBody.includes('nicht auf lager') ||
                     productBody.includes('rupture de stock') ||
                     productBody.includes('esaurito') ||
                     productBody.includes('agotado') ||
                     productBody.includes('niet op voorraad') ||
                     productBody.includes('inte i lager') ||
                     productBody.includes('brak w magazynie');

    let stock = 'In stock';
    if (notFound)   stock = 'Not found';
    else if (oos)    stock = 'Out of stock';
    else if (unavail) stock = 'Unavailable';

    if (notFound) {
      return res.status(200).json({
        blocked: false,
        hasDesktopATC: false, hasDesktopBuy: false,
        hasMobileATC:  false, hasMobileBuy:  false,
        stock: 'Not found'
      });
    }

    // ── 2. AOD endpoint — Desktop ───────────────────────────
    const aodDesktopResp = await fetchWithProxy(aodUrl, {
      'User-Agent':       desktopUA,
      'Accept-Language':  acceptLang,
      'Accept':           'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Referer':          productUrl,
      'X-Requested-With': 'XMLHttpRequest',
    });
    const aodDesktopBody = (await aodDesktopResp.text()).toLowerCase();

    // ── 3. AOD endpoint — Mobile ────────────────────────────
    const aodMobileResp = await fetchWithProxy(aodUrl, {
      'User-Agent':       mobileUA,
      'Accept-Language':  acceptLang,
      'Accept':           'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Referer':          productUrl,
      'X-Requested-With': 'XMLHttpRequest',
    });
    const aodMobileBody = (await aodMobileResp.text()).toLowerCase();

    // ── Button detection ────────────────────────────────────
    function detectButtons(body) {
      const hasATC =
        body.includes('add-to-cart')           ||
        body.includes('add to cart')           ||
        body.includes('add to basket')         ||
        body.includes('addtocart')             ||
        body.includes('addtocart_feature_div') ||
        body.includes('add-to-cart-button')    ||
        body.includes('in den einkaufswagen')  ||
        body.includes('einkaufswagen')         ||
        body.includes('ajouter au panier')     ||
        body.includes('aggiungi al carrello')  ||
        body.includes('añadir al carrito')     ||
        body.includes('in winkelwagen')        ||
        body.includes('winkelwagen')           ||
        body.includes('lägg i kundvagnen')     ||
        body.includes('lägg i kundvagn')       ||
        body.includes('kundvagnen')            ||
        body.includes('dodaj do koszyka')      ||
        body.includes('koszyka')               ||
        body.includes('a-button-primary')      ||
        body.includes('submit.add-to-cart')    ||
        body.includes('submit.buy-now')        ||
        body.includes('buy-box-atc')           ||
        body.includes('attach-base-product-button');

      const hasBuy =
        body.includes('buy now')               ||
        body.includes('buy-now')               ||
        body.includes('buynow')                ||
        body.includes('buynow_feature_div')    ||
        body.includes('buy-now-button')        ||
        body.includes('jetzt kaufen')          ||
        body.includes('sofort kaufen')         ||
        body.includes('acheter maintenant')    ||
        body.includes('acquista ora')          ||
        body.includes('comprar ahora')         ||
        body.includes('nu kopen')              ||
        body.includes('köp nu')                ||
        body.includes('køb nu')                ||
        body.includes('kup teraz');

      return { hasATC, hasBuy };
    }

    const desktop  = detectButtons(aodDesktopBody);
    const mobile   = detectButtons(aodMobileBody);
    const fallback = detectButtons(productBody);

    return res.status(200).json({
      blocked:       false,
      hasDesktopATC: desktop.hasATC || fallback.hasATC,
      hasDesktopBuy: desktop.hasBuy || fallback.hasBuy,
      hasMobileATC:  mobile.hasATC  || fallback.hasATC,
      hasMobileBuy:  mobile.hasBuy  || fallback.hasBuy,
      stock,
    });

  } catch (e) {
    const msg = e.name === 'AbortError' ? 'Timed out' : e.message;
    return res.status(200).json({
      blocked:       false,
      hasDesktopATC: false, hasDesktopBuy: false,
      hasMobileATC:  false, hasMobileBuy:  false,
      stock: 'Error: ' + msg
    });
  }
}
