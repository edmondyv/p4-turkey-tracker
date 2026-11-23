// PS99 public servers with at most 1 player, emptiest first, read from Roblox's public server list.
// The collector on GitHub calls this when Roblox refuses GitHub's IPs. Cached at Vercel's edge for
// 2 minutes, so it runs at most once every 2 minutes.
const PLACE_ID = 8737899170;
export default async function handler(req, res) {
  const servers = [];
  let cursor = "", complete = false, status = 200;
  for (let page = 0; page < 10; page++) {
    let r = null;
    for (let tryN = 0; tryN < 2 && !r; tryN++) {
      try {
        const x = await fetch(`https://games.roblox.com/v1/games/${PLACE_ID}/servers/Public?sortOrder=Asc&limit=100${cursor ? "&cursor=" + encodeURIComponent(cursor) : ""}`);
        status = x.status;
        if (x.ok) r = await x.json();
        else await new Promise((ok) => setTimeout(ok, 1200));
      } catch (e) { status = 0; }
    }
    if (!r || !Array.isArray(r.data)) break;
    for (const s of r.data) if (s.playing <= 1) servers.push({ id: s.id, playing: s.playing, maxPlayers: s.maxPlayers, ping: s.ping });
    const lastP = r.data.length ? r.data[r.data.length - 1].playing : 99;
    if (lastP > 1 || !r.nextPageCursor) { complete = true; break; }
    cursor = r.nextPageCursor;
  }
  res.setHeader("Cache-Control", complete ? "public, s-maxage=120, stale-while-revalidate=120" : "no-store");
  res.status(complete || servers.length ? 200 : 502).json({ at: Math.floor(Date.now() / 1000), placeId: PLACE_ID, complete, status, servers });
}
