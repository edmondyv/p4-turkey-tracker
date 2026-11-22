// Roblox presence for the squad (who is in game). Cached at Vercel's edge for 60 s,
// so the function runs at most once a minute however many people have the page open.
const IDS = [216657469, 3083204118, 6079067379, 677658744];
export default async function handler(req, res) {
  let out = { at: Math.floor(Date.now() / 1000) };
  try {
    const r = await fetch("https://presence.roblox.com/v1/presence/users", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ userIds: IDS }),
    });
    const j = await r.json();
    out.presence = { list: (j.userPresences || []).map((p) => ({ userId: p.userId, type: p.userPresenceType, gameId: p.gameId || null })) };
  } catch (e) { out.presence = { error: String(e.message || e) }; }
  res.setHeader("Cache-Control", "public, s-maxage=60, stale-while-revalidate=60");
  res.status(200).json(out);
}
