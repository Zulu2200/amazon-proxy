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
    const response = await fetch(url, {
      headers: {
        'User-Agent':      userAgent,
        'Accept-Language': 'en-GB,en;q=0.9',
        'Accept':          'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      },
      redirect: 'follow',
    });

    const body = (await response.text()).toLowerCase();
    const code = response.status;

    const blocked = body.includes('robot check') ||
                    body.includes('enter the characters') ||
                    (body.includes('captcha') && body.length < 15000);

    if (blocked) {
      return res.status(200).json({ blocked: true, hasATC: false, hasBuyNow: false, stock: 'Blocked' });
    }

    if (code === 404 ||
