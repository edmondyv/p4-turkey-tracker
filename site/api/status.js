// Roblox presence and avatar headshots for the squad. Cached at Vercel's edge for 60 s,
// so the function runs at most once a minute however many people have the page open.
const IDS = [216657469, 3083204118, 6079067379, 677658744];
export default async function handler(req, res) {
  const out = { at: Math.floor(Date.now() / 1000) };
  const [pres, heads] = await Promise.allSettled([
    fetch("https://presence.roblox.com/v1/presence/users", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ userIds: IDS }) }).then((r) => r.json()),
    fetch(`https://thumbnails.roblox.com/v1/users/avatar-headshot?userIds=${IDS.join(",")}&size=150x150&format=Png&isCircular=false`).then((r) => r.json()),
  ]);
  out.presence = pres.status === "fulfilled"
    ? { list: (pres.value.userPresences || []).map((p) => ({ userId: p.userId, type: p.userPresenceType, gameId: p.gameId || null })) }
    : { error: String(pres.reason) };
  out.avatars = heads.status === "fulfilled" ? Object.fromEntries((heads.value.data || []).filter((h) => h.imageUrl).map((h) => [h.targetId, h.imageUrl])) : {};
  res.setHeader("Cache-Control", "public, s-maxage=60, stale-while-revalidate=300");
  res.status(200).json(out);
}
