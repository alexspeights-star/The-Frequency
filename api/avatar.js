export default async function handler(req, res) {
  const { channelId } = req.query;

  if (!channelId || !channelId.startsWith('UC')) {
    return res.status(400).json({ error: 'Invalid channelId' });
  }

  const channelUrl = `https://www.youtube.com/channel/${channelId}`;

  try {
    const response = await fetch(channelUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept-Language': 'en-US,en;q=0.9',
      },
      signal: AbortSignal.timeout(10000),
    });

    if (!response.ok) {
      return res.status(502).json({ error: 'Channel page fetch failed' });
    }

    const html = await response.text();

    // og:image on a channel page is the channel avatar
    const match = html.match(/<meta property="og:image" content="([^"]+)"/);
    const avatarUrl = match ? match[1] : null;

    res.setHeader('Cache-Control', 's-maxage=86400, stale-while-revalidate=86400');
    res.setHeader('Access-Control-Allow-Origin', '*');
    return res.status(200).json({ channelId, avatarUrl });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
