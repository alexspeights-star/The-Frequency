export default async function handler(req, res) {
  const { channelId } = req.query;

  if (!channelId || !channelId.startsWith('UC')) {
    return res.status(400).json({ error: 'Invalid channelId' });
  }

  const feedUrl = `https://www.youtube.com/feeds/videos.xml?channel_id=${channelId}`;

  try {
    const response = await fetch(feedUrl, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; FrequencyBot/1.0)' },
      signal: AbortSignal.timeout(10000),
    });

    if (!response.ok) {
      return res.status(502).json({ error: 'Feed fetch failed', status: response.status });
    }

    const xml = await response.text();
    const ids = [];
    const re = /watch\?v=([\w-]{11})/g;
    let m;
    while ((m = re.exec(xml)) !== null) {
      if (!ids.includes(m[1])) ids.push(m[1]);
    }

    // Sort for deterministic ordering across all devices
    ids.sort();

    res.setHeader('Cache-Control', 's-maxage=3600, stale-while-revalidate=3600');
    res.setHeader('Access-Control-Allow-Origin', '*');
    return res.status(200).json({ channelId, ids, count: ids.length });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
