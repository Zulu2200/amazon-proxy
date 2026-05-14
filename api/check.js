export default async function handler(req, res) {
  const { url, mobile, token } = req.query;

  if (token !== process.env.SECRET_TOKEN) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  if (!url) {
    return res.status(400).json({ error: 'Missing url' });
  }

  const userAgent = mobile === 'true'
    ? 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Safari/604.1'
    : 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0.0.0 Safari/537.36';

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);

    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        'User-Agent':      userAgent,
        'Accept-Language': 'en-GB,en;q=0.9',
        'Accept':          'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      },
      redirect: 'follow',
    });

    clearTimeout(timeout);

    const body = (await response.text()).toLowerCase();
    const code = response.status;

    const blocked = body.includes('robot check') ||
                    body.includes('enter the characters') ||
                    (body.includes('captcha') && body.length < 15000);

    if (blocked) {
      return res.status(200).json({ blocked: true, hasATC: false, hasBuyNow: false, stock: 'Blocked' });
    }

    if (code === 404 || body.includes('looking for something') || body.includes('page not found')) {
      return res.status(200).json({ blocked: false, hasATC: false, hasBuyNow: false, stock: 'Not found' });
    }

    const unavail = body.includes('currently unavailable') ||
                    body.includes('nicht verfügbar') ||
                    body.includes('actuellement indisponible') ||
                    body.includes('non disponibile') ||
                    body.includes('no disponible') ||
                    body.includes('niet beschikbaar');

    const oos = body.includes('out of stock') ||
                body.includes('nicht auf lager') ||
                body.includes('rupture de stock') ||
                body.includes('esaurito') ||
                body.includes('agotado') ||
                body.includes('niet op voorraad') ||
                body.includes('inte i lager') ||
                body.includes('brak w magazynie');

    const hasATC = body.includes('add-to-cart') ||
                   body.includes('add to cart') ||
                   body.includes('in den einkaufswagen') ||
                   body.includes('ajouter au panier') ||
                   body.includes('aggiungi al carrello') ||
                   body.includes('añadir al carrito') ||
                   body.includes('in winkelwagen') ||
                   body.includes('lägg i kundvagnen') ||
                   body.includes('dodaj do koszyka');

    const hasBuyNow = body.includes('buy now') ||
                      body.includes('buy-now') ||
                      body.includes('jetzt kaufen') ||
                      body.includes('acheter maintenant') ||
                      body.includes('acquista ora') ||
                      body.includes('comprar ahora') ||
                      body.includes('nu kopen') ||
                      body.includes('köp nu') ||
                      body.includes('kup teraz');

    let stock = 'In stock';
    if (hasATC || hasBuyNow) stock = 'In stock';
    else if (oos)            stock = 'Out of stock';
    else if (unavail)        stock = 'Unavailable';

    return res.status(200).json({ blocked: false, hasATC, hasBuyNow, stock });

  } catch (e) {
    const msg = e.name === 'AbortError' ? 'Timed out' : e.message;
    return res.status(200).json({ blocked: false, hasATC: false, hasBuyNow: false, stock: 'Error: ' + msg });
  }
}
