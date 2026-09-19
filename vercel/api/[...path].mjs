export default async function handler(req, res) {
  const base = process.env.STUDYMATE_GATEWAY_URL;
  if (!base) return res.status(500).json({ error: 'STUDYMATE_GATEWAY_URL is not configured.' });
  const suffix = req.url.replace(/^\/api/, '').split('?')[0];
  const target = `${base.replace(/\/$/, '')}/api${suffix}${req.url.includes('?') ? `?${req.url.split('?')[1]}` : ''}`;
  const headers = { ...req.headers, host: new URL(base).host };
  delete headers['content-length'];
  const body = ['GET', 'HEAD'].includes(req.method) ? undefined : JSON.stringify(req.body || {});
  const response = await fetch(target, { method: req.method, headers: { ...headers, ...(body ? { 'content-type': 'application/json' } : {}) }, body });
  const text = await response.text();
  res.status(response.status);
  const setCookie = response.headers.get('set-cookie');
  if (setCookie) res.setHeader('set-cookie', setCookie);
  res.setHeader('content-type', response.headers.get('content-type') || 'application/json');
  res.send(text);
}
