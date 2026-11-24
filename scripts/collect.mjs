// P4 league collector. Runs every 5 minutes in GitHub Actions.
// Reads the public BIG Games API, keeps one snapshot per Turkey cycle, computes the
// dashboard stats, and sends an alert when a squad member stops scoring.
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

const API = "https://ps99.biggamesapi.io";
const LEAGUE = process.env.LEAGUE_NAME || "P4";
const DATA_DIR = process.env.DATA_DIR || "data";
const CYCLE = 1200; // a Turkey lands every 20 minutes (:00, :20, :40)
const TZ = "Europe/Brussels";
const SQUAD = {
  216657469: "MisterEdR48",
  3083204118: "p4_ndaa",
  6079067379: "Legolorde22",
  677658744: "kxngcebu",
};
const MAX_CYCLES = 600; // more than a 6-day season (432 cycles)

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const nowSec = () => (process.env.FAKE_NOW ? Number(process.env.FAKE_NOW) : Math.floor(Date.now() / 1000));
const hhmm = (t) => new Date(t * 1000).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", timeZone: TZ });
const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);
const quant = (a, f) => {
  if (!a.length) return null;
  const s = [...a].sort((x, y) => x - y), i = (s.length - 1) * f, lo = Math.floor(i), hi = Math.ceil(i);
  return s[lo] + (s[hi] - s[lo]) * (i - lo);
};
const diff = (a, b) => (a == null || b == null ? null : a - b);
const round = (x) => (x == null || !isFinite(x) ? null : Math.round(x));

// PS99's public server list from Roblox, emptiest first: every server with at most 1 player
const PLACE_ID = 8737899170;
async function quietScanDirect() {
  const out = new Map();
  let cursor = "", complete = false;
  for (let page = 0; page < 3; page++) { // Roblox allows about 3 pages in a row per IP
    if (page) await sleep(800);
    let r = null;
    for (let tryN = 0; tryN < 1 && !r; tryN++) {
      try {
        const res = await fetch(`https://games.roblox.com/v1/games/${PLACE_ID}/servers/Public?sortOrder=Asc&limit=100${cursor ? "&cursor=" + encodeURIComponent(cursor) : ""}`, { headers: { "User-Agent": "p4-turkey-tracker/2.0 (github actions)" } });
        if (res.ok) r = await res.json();
        else { console.log(`servers: Roblox answered ${res.status}`); await sleep(1500); }
      } catch (e) { console.log("servers: " + e.message); }
    }
    if (!r || !Array.isArray(r.data)) return null;
    for (const x of r.data) if (x.playing <= 1) out.set(x.id, { p: x.playing, max: x.maxPlayers, ping: x.ping });
    const lastP = r.data.length ? r.data[r.data.length - 1].playing : 99;
    if (lastP > 1 || !r.nextPageCursor) { complete = true; break; }
    cursor = r.nextPageCursor;
  }
  return { servers: out, complete };
}
// Roblox often refuses GitHub's shared IPs, so fall back to the same scan run by the site on Vercel
const SITE = process.env.SITE_URL || "https://p4-turkey-tracker.vercel.app";
async function quietScan() {
  const direct = await quietScanDirect();
  if (direct) return direct;
  try {
    const res = await fetch(`${SITE}/api/servers`);
    const j = res.ok ? await res.json() : null;
    if (j && Array.isArray(j.servers) && (j.complete || j.servers.length)) {
      console.log(`servers: via the site, ${j.servers.length} at <= 1 player`);
      return { servers: new Map(j.servers.map((x) => [x.id, { p: x.playing, max: x.maxPlayers, ping: x.ping }])), complete: !!j.complete };
    }
    console.log(`servers: site fallback failed (${res.status})`);
  } catch (e) { console.log("servers: site fallback " + e.message); }
  return null;
}

async function api(p, tries = 3) {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(API + p, { headers: { "User-Agent": "p4-turkey-tracker/2.0 (github actions)" } });
      if (r.status === 404) return null;
      if (r.ok) {
        const j = await r.json();
        if (j && j.status === "ok") return j.data;
      }
    } catch {}
    await sleep(1500 * (i + 1));
  }
  return null;
}

async function readJson(file, fallback) {
  try { return JSON.parse(await fs.readFile(file, "utf8")); } catch { return fallback; }
}

// ---------- notifications (ntfy topic and/or Discord webhook; both optional)
async function notify(title, body, tags = "turkey", priority = "default") {
  const out = [];
  if (process.env.NTFY_TOPIC) {
    out.push(fetch(`https://ntfy.sh/${encodeURIComponent(process.env.NTFY_TOPIC)}`, {
      method: "POST", body, headers: { Title: title, Tags: tags, Priority: priority },
    }).catch(() => {}));
  }
  if (process.env.DISCORD_WEBHOOK) {
    out.push(fetch(process.env.DISCORD_WEBHOOK, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: `**${title}**\n${body}` }),
    }).catch(() => {}));
  }
  await Promise.all(out);
}

// Repeating alarm for the person on watch: urgent priority with Stop / Snooze buttons.
// The buttons post to a second ntfy topic, which the next run reads to stop or pause the loop.
const ACK_TOPIC = process.env.NTFY_TOPIC ? `${process.env.NTFY_TOPIC}-ack` : null;
async function readAcks(since) {
  if (!ACK_TOPIC) return [];
  try {
    const r = await fetch(`https://ntfy.sh/${encodeURIComponent(ACK_TOPIC)}/json?poll=1&since=${since}`);
    const txt = await r.text();
    return txt.split("\n").filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } })
      .filter((m) => m && m.event === "message").map((m) => ({ t: m.time, text: String(m.message || "").toLowerCase() }));
  } catch { return []; }
}
async function alarm(title, body) {
  if (!process.env.NTFY_TOPIC) return;
  const ack = `https://ntfy.sh/${ACK_TOPIC}`;
  await fetch(`https://ntfy.sh/${encodeURIComponent(process.env.NTFY_TOPIC)}`, {
    method: "POST", body,
    headers: {
      Title: title, Tags: "rotating_light,turkey", Priority: "urgent",
      // clear=false: ntfy only silences a ringing ("insistent") notification when you swipe it away or open it.
      // If a button removed it, the sound would keep looping with nothing left to swipe.
      Actions: `http, Stop alarm, ${ack}, method=POST, body=stop, clear=false; http, Snooze 1 h, ${ack}, method=POST, body=snooze, clear=false`,
    },
  }).catch(() => {});
}

// ---------- history helpers
// Points are credited at the moment of each kill, and strong teams kill a Turkey within 1-3 minutes
// of it landing. The only moment when no Turkey can be killed is between 15 min after a landing
// (it flies off) and the next landing at 20 min. So the reference snapshot for each boundary
// (a landing time b) is ideally taken 16.5-20 min after the previous landing, i.e. just BEFORE b.
// Fallbacks: the very first ~75 s after b (data is cached up to 60 s, nobody has killed yet),
// then up to 5 min after b (may already include a few very fast kills).
// Mid-fight snapshots are used for the live ranking only, never for per-Turkey numbers.
// A record keyed b holds the totals after every Turkey that landed before b, so
// points of the Turkey that landed at b-20min = rec(b) - rec(b-20min).
const CLOSE_MIN = 990, OPEN_SAFE = 75, OPEN_MAX = 300;
function boundaryOf(t) {
  const s = t - (t % CYCLE), off = t - s;
  if (off >= CLOSE_MIN) return { b: s + CYCLE, score: Math.abs(off - 1140) };   // best: about 1 min before the next landing
  if (off <= OPEN_SAFE) return { b: s, score: 500 + off };                    // good: first minute after the landing
  if (off <= OPEN_MAX) return { b: s, score: 1000 + off };                    // last resort
  return null;
}
function upsertCycle(cycles, rec) {
  const bo = boundaryOf(rec.t);
  if (!bo) return false;
  const r = { ...rec, s: bo.b, q: bo.score };
  const i = cycles.findIndex((c) => c.s === bo.b);
  if (i === -1) { cycles.push(r); cycles.sort((a, b) => a.s - b.s); return true; }
  if (bo.score < (cycles[i].q ?? 9999)) { cycles[i] = r; return true; }
  return false;
}
// one-off migration of records stored with the old rule (keyed by the slot they were taken in)
function migrate(hist) {
  if (hist.v === 3) return;
  const old = hist.cycles || [];
  hist.cycles = [];
  for (const c of old) upsertCycle(hist.cycles, { t: c.t, p: c.p, m: c.m });
  hist.v = 3;
}

function makePace(cycles, capOf) {
  const byS = new Map(cycles.map((c) => [c.s, c]));
  const lastS = cycles.length ? cycles[cycles.length - 1].s : 0;
  const get = (key, c) => (key.startsWith("m:") ? c.m && c.m[key.slice(2)] : c.p[key]);
  // Points per Turkey for `key`, newest first. One player makes at most 1,000 per Turkey, so a team
  // can't make more than 1,000 per member; when a Turkey shows more, the excess is points from earlier
  // Turkeys that the API showed late, and it is moved back to the Turkey before (and so on).
  const memo = new Map(), capped = new Set();
  const series = (key) => {
    if (memo.has(key)) return memo.get(key);
    const out = [];
    for (let i = 0; i < 80; i++) {
      const a = byS.get(lastS - i * CYCLE), b = byS.get(lastS - (i + 1) * CYCLE);
      const va = a && get(key, a), vb = b && get(key, b);
      if (va == null || vb == null) break;
      out.push(va - vb);
    }
    const cap = key.startsWith("m:") ? 1000 : capOf ? capOf(key) : null;
    if (cap && out[0] > cap) capped.add(key);
    if (cap) for (let i = 0; i < out.length - 1; i++) if (out[i] > cap) { out[i + 1] += out[i] - cap; out[i] = cap; }
    memo.set(key, out);
    return out;
  };
  // average points per Turkey for `key` over the last k Turkeys (key = league name, or "m:<uid>")
  function pace(key, k) {
    const s = series(key);
    if (s.length >= k) return s.slice(0, k).reduce((a, b) => a + b, 0) / k;
    const cur = byS.get(lastS);
    if (!cur) return null;
    const v1 = get(key, cur);
    if (v1 == null) return null;
    for (let back = k; back <= k + 3; back++) {
      const old = byS.get(lastS - back * CYCLE);
      const v0 = old && get(key, old);
      if (v0 != null) return (v1 - v0) / back;
    }
    return null;
  }
  pace.capped = (key) => (series(key), capped.has(key)); // last Turkey had late points moved back
  return pace;
}

function rankMap(points) {
  const arr = Object.entries(points).sort((a, b) => b[1] - a[1]);
  return Object.fromEntries(arr.map(([n], i) => [n, i + 1]));
}

export async function main() {
  const now = nowSec();
  const s0 = now - (now % CYCLE);
  await fs.mkdir(DATA_DIR, { recursive: true });
  const histFile = path.join(DATA_DIR, "history.json");
  let hist = await readJson(histFile, {});

  const season = await api("/v1/leagues/seasons/active");
  if (!season || !season.id) { console.log("API unavailable, nothing written"); return; }
  if (hist.season !== season.id) hist = { season: season.id, cycles: [], alerts: {}, log: [], flags: {}, v: 3 };
  migrate(hist);
  hist.alerts ||= {}; hist.log ||= []; hist.flags ||= {};
  const live = season.state === "live";
  const q = `season=${encodeURIComponent(season.id)}`;

  // ---------- fetch
  const [pg1, pg2, pg3, r500, detail, boards] = await Promise.all([
    api(`/v1/leagues?${q}&page=1&pageSize=100`),
    api(`/v1/leagues?${q}&page=2&pageSize=100`),
    api(`/v1/leagues?${q}&page=3&pageSize=100`),
    api(`/v1/leagues?${q}&page=500&pageSize=1`),
    api(`/v1/leagues/${encodeURIComponent(LEAGUE)}?${q}`),
    api(`/v1/leaderboards`),
  ]);
  const rows = [pg1, pg2, pg3].flatMap((pg) => (pg && pg.leagues) || [])
    .filter((l) => l.Rank != null)
    .map((l) => ({ r: l.Rank, n: l.Name, p: l.Points, m: l.Members, icon: l.Icon || null }));
  if (!rows.length) { console.log("No league rows, nothing written"); return; }
  const totalLeagues = (pg1 && pg1.total) || null;

  // P4 detail
  const p4 = detail ? {
    points: detail.Points, place: detail.Place, reward: detail.Reward || null, icon: detail.Icon || null,
    members: (detail.PointContributions || []).filter((c) => c.Counted !== false).map((c) => ({
      uid: c.UserID, name: SQUAD[c.UserID] || c.DisplayName, display: c.DisplayName, points: c.Points, lastAt: c.Timestamp || null,
    })),
  } : null;

  // ---------- reward pet icons (normal + golden thumbnails), fetched once per season
  const rewardPets = [...new Set((season.placementRewards || []).flatMap((b) => (b.items || []).map((i) => i.id)))];
  hist.petIcons ||= {};
  for (const name of rewardPets.filter((n) => !hist.petIcons[n])) {
    const res = await api(`/api/collection/Pets?configName=${encodeURIComponent(name)}`);
    const p = Array.isArray(res) ? res.find((x) => x.configName === name) : null;
    if (p) hist.petIcons[name] = { n: p.configData?.thumbnail || null, g: p.configData?.goldenThumbnail || null };
  }

  // ---------- store this cycle's snapshot
  const pts = Object.fromEntries(rows.map((r) => [r.n, r.p]));
  if (p4) pts[LEAGUE] = p4.points;
  const m = p4 ? Object.fromEntries(p4.members.map((x) => [x.uid, x.points])) : {};
  if (live) upsertCycle(hist.cycles, { t: now, p: pts, m });

  // Exact squad points per Turkey. Each member's contribution carries the time of its last credit,
  // so a points increase since the previous run belongs to the Turkey that was up at that moment.
  // This stays right when a kill lands late in the 20 minutes (e.g. alone with an alt), which
  // snapshot differences would push into the next Turkey.
  if (!hist.mt) {
    // first run: seed finished Turkeys from snapshot differences and start timestamp tracking from
    // the snapshot filed for the current landing, so credits after it still land in the right Turkey
    const cy = hist.cycles, base = cy.find((c) => c.s === s0 && c.m);
    hist.mt = { since: base ? base.t : now, from: null, prev: {}, by: {} };
    if (base) {
      for (const [u, v] of Object.entries(base.m)) hist.mt.prev[u] = { points: v, lastAt: null, t: base.t };
      for (let c = s0 - CYCLE; ; c -= CYCLE) {
        const a = cy.find((x) => x.s === c && x.m), b = cy.find((x) => x.s === c + CYCLE && x.m);
        if (!a || !b || c < s0 - 72 * CYCLE) break;
        for (const [u, v] of Object.entries(b.m)) if (a.m[u] != null) (hist.mt.by[u] ||= {})[c] = v - a.m[u];
        hist.mt.from = c;
      }
    }
  }
  if (p4 && live) {
    for (const x of p4.members) {
      const pv = hist.mt.prev[x.uid];
      if (pv && x.points > pv.points && x.lastAt) {
        const c = x.lastAt - (x.lastAt % CYCLE), by = (hist.mt.by[x.uid] ||= {});
        by[c] = (by[c] || 0) + (x.points - pv.points);
      }
      hist.mt.prev[x.uid] = { points: x.points, lastAt: x.lastAt, t: now };
    }
    const keep = now - 600 * CYCLE;
    for (const by of Object.values(hist.mt.by)) for (const c of Object.keys(by)) if (+c < keep) delete by[c];
  }
  const mtFrom = hist.mt.from ?? hist.mt.since - (hist.mt.since % CYCLE) + CYCLE; // first Turkey covered
  // A member scores at most once per Turkey, but the API sometimes shows a kill's points late, in the
  // same update as the next kill, so one Turkey reads ~2x and the one before reads 0. When a Turkey
  // shows at least 1.8x the member's usual points (or more than the 1,000 one player can make) right
  // after Turkeys with nothing, spread it back evenly over those empty Turkeys. Runs every time, so
  // stored history gets repaired too.
  for (const [u, by] of Object.entries(hist.mt.by)) {
    const cs = [];
    for (let c = Math.max(mtFrom, s0 - 36 * CYCLE); c <= s0; c += CYCLE) cs.push(c);
    for (let i = 1; i < cs.length; i++) {
      const v = by[cs[i]] || 0;
      if (!v) continue;
      const prev = [];
      for (let j = i - 1; j >= 0 && prev.length < 6; j--) if (by[cs[j]] > 0) prev.push(by[cs[j]]);
      if (prev.length < 3) continue;
      const typ = prev.sort((a, b) => a - b)[Math.floor(prev.length / 2)];
      if (v < 1.8 * typ && v <= 1000) continue;
      const gaps = [];
      for (let j = i - 1; j >= 0 && !(by[cs[j]] > 0) && gaps.length < 3; j--) gaps.push(cs[j]);
      const k = Math.min(gaps.length + 1, Math.max(Math.round(v / typ), Math.ceil(v / 1000)));
      if (k < 2) continue;
      const share = Math.round(v / k);
      by[cs[i]] = v - share * (k - 1);
      for (const c of gaps.slice(0, k - 1)) by[c] = share;
      (hist.mt.fixed ||= []).push({ u: +u, c: cs[i], v, k, t: now });
      if (hist.mt.fixed.length > 50) hist.mt.fixed.shift();
    }
  }
  const exact = (uid, c) => (c >= mtFrom ? (hist.mt.by[uid]?.[c] || 0) : undefined);
  if (hist.cycles.length > MAX_CYCLES) hist.cycles = hist.cycles.slice(-MAX_CYCLES);
  const cycles = hist.cycles;
  const memberCount = new Map(rows.map((r) => [r.n, r.m]));
  const pace = makePace(cycles, (n) => (memberCount.get(n) ? 1000 * memberCount.get(n) : null));
  const lastS = cycles.length ? cycles[cycles.length - 1].s : s0;
  const startTime = season.startTime || (season.finishTime ? season.finishTime - 518400 : now);
  const turkeysElapsed = Math.max(1, Math.floor((now - startTime) / CYCLE));
  const turkeysLeft = season.finishTime ? Math.max(0, Math.floor((season.finishTime - now) / CYCLE)) : 0;

  // Paces are points per Turkey over the last 1, 3, 9, 18 and 72 Turkeys (last Turkey, 1 h, 3 h, 6 h, 24 h).
  // The finish projection uses the 24 h pace (it includes nights), or the since-start average until
  // a full day of history exists.
  const teamStats = (n, p) => {
    const since = p / turkeysElapsed, h24 = pace(n, 72);
    return { last: round(pace(n, 1)), lc: pace.capped(n) || undefined, h1: round(pace(n, 3)), h3: round(pace(n, 9)), h6: round(pace(n, 18)), h24: round(h24), since: round(since), proj: round(p + (h24 ?? since) * turkeysLeft) };
  };
  const rankAgo = (k) => {
    const c = cycles.find((x) => x.s === lastS - k * CYCLE);
    return c ? rankMap(c.p) : null;
  };
  const r1h = rankAgo(3), r6h = rankAgo(18);
  // rank change since the current Turkey landed (in its first 5 minutes: since the previous landing)
  const refS = now - s0 >= 300 ? s0 : s0 - CYCLE;
  const refRec = cycles.find((c) => c.s === refS);
  const rRef = refRec ? rankMap(refRec.p) : null;
  const enrich = (row) => ({
    ...row, ...teamStats(row.n, row.p),
    dr: rRef && rRef[row.n] ? rRef[row.n] - row.r : null,
    dr1h: r1h && r1h[row.n] ? r1h[row.n] - row.r : null,
    dr6h: r6h && r6h[row.n] ? r6h[row.n] - row.r : null,
  });

  const at = (rank) => rows.find((r) => r.r === rank);
  const marks = [1, 10, 25, 100, 101].map((k) => at(k)).filter(Boolean).map(enrich);
  if (r500 && r500.leagues && r500.leagues[0]) {
    const l = r500.leagues[0];
    marks.push({ r: l.Rank, n: l.Name, p: l.Points, m: l.Members, since: round(l.Points / turkeysElapsed) });
  }

  // P4 block
  let p4out = null, rivals = [], track = [];
  if (p4) {
    const me = enrich({ r: p4.place, n: LEAGUE, p: p4.points, m: p4.members.length });
    const c100 = marks.find((x) => x.r === 100);
    const lastCompleted = s0 - CYCLE; // Turkey that landed 20 min before the current one
    const checkS = now - s0 >= 240 ? lastCompleted : lastCompleted - CYCLE; // 4 min grace (API cache + late points)
    // the last 12 finished Turkeys (the one that is up now is shown separately as "This Turkey")
    const recAt = (c) => cycles.find((x) => x.s === c);
    const done12 = Array.from({ length: 12 }, (_, i) => s0 - (12 - i) * CYCLE);
    const members = Object.keys(SQUAD).map(Number).map((uid) => {
      const c = p4.members.find((x) => x.uid === uid) || { uid, name: SQUAD[uid], points: 0, lastAt: null };
      const lastCycle = c.lastAt ? c.lastAt - (c.lastAt % CYCLE) : null;
      const streak = lastCycle == null ? null : Math.max(0, Math.round((checkS - lastCycle) / CYCLE));
      const turkeys = done12.map((c) => exact(uid, c) ?? diff(recAt(c + CYCLE)?.m?.[uid], recAt(c)?.m?.[uid]));
      return { uid, name: SQUAD[uid], display: c.display || c.name, points: c.points, lastAt: c.lastAt, streak, h1: round(pace(`m:${uid}`, 3)), turkeys };
    });
    const uids = p4.members.map((x) => x.uid);
    const exactTeam = (c) => (c >= mtFrom ? uids.reduce((a, u) => a + exact(u, c), 0) : undefined);
    const teamTurkeys = done12.map((c) => ({ s: c, pts: exactTeam(c) ?? diff(recAt(c + CYCLE)?.p?.[LEAGUE], recAt(c)?.p?.[LEAGUE]) }));
    if (exactTeam(s0 - CYCLE) != null) me.last = exactTeam(s0 - CYCLE);
    // the 20 teams just ahead: median pace (robust to solo-killing outliers), how many we outpace,
    // and our projected rank if every top-300 team keeps its own 6-hour pace
    const myR0 = p4.place || 999;
    const pack = rows.filter((r) => r.r >= myR0 - 20 && r.r < myR0 && r.n !== LEAGUE);
    const sinceOf = (r) => r.p / turkeysElapsed;
    const med = (k) => round(quant(pack.map((r) => pace(r.n, k)).filter((v) => v != null), 0.5));
    const myNow = me.h1 ?? me.h6 ?? me.since;
    const packNow = pack.map((r) => pace(r.n, 3) ?? sinceOf(r));
    // projected rank: every top-300 team extended at its own pace (recent pace for short horizons,
    // 24 h pace for the finish because it includes nights)
    const paceFor = (n, p, horizon) => horizon === "h3" ? (pace(n, 9) ?? pace(n, 3) ?? p / turkeysElapsed)
      : horizon === "h12" ? (pace(n, 18) ?? pace(n, 9) ?? pace(n, 3) ?? p / turkeysElapsed)
      : (pace(n, 72) ?? p / turkeysElapsed);
    const projRank = (k, horizon) => {
      const mine = p4.points + paceFor(LEAGUE, p4.points, horizon) * k;
      return 1 + rows.filter((r) => r.n !== LEAGUE && r.p + paceFor(r.n, r.p, horizon) * k > mine).length;
    };
    const packOut = { n: pack.length, from: myR0 - pack.length, last: med(1), h1: med(3), h6: med(18), since: round(quant(pack.map(sinceOf), 0.5)),
      slower: packNow.filter((v) => v < myNow).length };
    const projRanks = { h3: projRank(9, "h3"), h12: projRank(36, "h12"), finish: projRank(turkeysLeft, "finish") };
    const openRec = cycles.find((c) => c.s === s0);
    // points per member since the current Turkey landed (exact: points are credited at the kill)
    const scoredNow = members.filter((x) => x.lastAt && x.lastAt >= s0).map((x) => x.uid);
    const thisTurkey = s0 >= mtFrom ? {
      s: s0, pts: exactTeam(s0), scored: scoredNow, per: Object.fromEntries(members.map((x) => [x.uid, exact(x.uid, s0)])),
    } : openRec && openRec.p[LEAGUE] != null ? {
      s: s0, pts: p4.points - openRec.p[LEAGUE], scored: scoredNow,
      per: Object.fromEntries(members.map((x) => [x.uid, openRec.m && openRec.m[x.uid] != null ? x.points - openRec.m[x.uid] : null])),
    } : { s: s0, pts: null, scored: scoredNow, per: null };
    // Top 100 at the end, three hypotheses: every other team keeps its last-6 h pace, or speeds up
    // steadily (linearly) to 2.4k or 3.2k per Turkey by the end (a team already faster keeps its pace).
    // We stay at our last-6 h pace. The 100th best other finish is the line we must beat.
    const L = turkeysLeft, v6 = (n) => pace(n, 18) ?? pace(n, 72);
    const myV = v6(LEAGUE) ?? 0, others = rows.filter((r) => r.n !== LEAGUE);
    const outlook = L && others.length >= 100 ? [null, 2400, 3200].map((T) => {
      const fin = others.map((r) => { const v = v6(r.n); if (v == null) return r.p; return r.p + L * (T == null ? v : (v + Math.max(v, T)) / 2); }).sort((a, b) => b - a);
      const line = fin[99], myFin = p4.points + L * myV;
      return {
        T, line: round(line), need: round(Math.max(0, (line - p4.points) / L)),
        rank: 1 + fin.filter((f) => f > myFin).length,
        stopRank: 1 + fin.filter((f) => f > p4.points).length, // teams we track: the top 300
        miss: myV > 0 ? Math.max(0, Math.min(L, Math.floor(L - (line - p4.points) / myV))) : null,
      };
    }) : null;
    p4out = {
      ...me, thisTurkey, icon: p4.icon, reward: p4.reward, members, turkeys: teamTurkeys, checkedTurkey: checkS, pack: packOut, projRanks, outlook, tracked: others.length + 1, v6: round(myV),
      gaps: Object.fromEntries(marks.filter((x) => [10, 25, 100].includes(x.r)).map((x) => [x.r, x.p - p4.points])),
      need100: outlook ? outlook[0].need : null,
    };
    // rivals: nine places either side of P4
    const myR = p4.place || 999;
    rivals = rows.filter((r) => r.r >= myR - 9 && r.r <= myR + 9 && r.n !== LEAGUE).map(enrich);
    rivals.push(me);
    rivals.sort((a, b) => a.r - b.r);
    rivals = rivals.map((x) => {
      const gap = x.p - p4.points;
      const rel = (me.h1 ?? me.since) - (x.h1 ?? x.since);
      const eta = gap > 0 && rel > 0 ? Math.ceil(gap / rel) : gap < 0 && rel < 0 ? Math.ceil(-gap / -rel) : null;
      return { ...x, gap, eta, me: x.n === LEAGUE };
    });
    // race track: from the top-100 line down to a little below P4
    const lo = Math.max(myR + 8, 108), hi = Math.min(92, myR - 4);
    track = rows.filter((r) => r.r >= hi && r.r <= lo).map((r) => ({ r: r.r, n: r.n, p: r.p, m: r.m, icon: r.icon,
      last: round(pace(r.n, 1)), lc: pace.capped(r.n) || undefined, h1: round(pace(r.n, 3)), h3: round(pace(r.n, 9)), me: r.n === LEAGUE }));
    if (!track.some((t) => t.me)) track.push({ r: p4.place, n: LEAGUE, p: p4.points, h1: round(pace(LEAGUE, 3)), me: true });

    // ---------- alerts (one grouped message per run)
    const downNow = new Set(members.filter((x) => (x.streak ?? 0) > 0).map((x) => x.uid));
    const lines = [], backs = [];
    for (const mb of members) {
      const st = hist.alerts[mb.uid] || { notified: 0 };
      const s = mb.streak ?? 0;
      const due = s === 1 || s === 3 || (s > 3 && (s - 3) % 9 === 0);
      if (live && s > 0 && due && st.notified !== s) {
        // the alert uses Brussels time; the site log gets {{t:…}} tokens shown in each viewer's time zone
        const msg = (fmt) => {
          const last = mb.lastAt ? fmt(mb.lastAt) : "?";
          let t = s === 1
            ? `${mb.name} didn't score on the ${fmt(checkS)} Turkey (last points ${last}).`
            : `${mb.name} has missed ${s} Turkeys in a row (last points ${last}).`;
          return t;
        };
        lines.push(msg(hhmm));
        hist.log.unshift({ t: now, kind: "down", uid: mb.uid, text: msg((t) => `{{t:${t}}}`) });
        st.notified = s;
      }
      if (s === 0 && st.notified > 0) {
        backs.push(mb.name);
        hist.log.unshift({ t: now, kind: "back", uid: mb.uid, text: `${mb.name} is scoring again.` });
        st.notified = 0;
      }
      hist.alerts[mb.uid] = st;
    }
    // Discord (if configured) gets the milestone messages; the phone gets a repeating alarm.
    if (lines.length && process.env.DISCORD_WEBHOOK) {
      const who = members.filter((x) => lines.some((l) => l.startsWith(x.name))).map((x) => x.name);
      await fetch(process.env.DISCORD_WEBHOOK, { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: `**P4: ${who.join(" and ")} down**\n${lines.join("\n")}` }) }).catch(() => {});
    }
    const down = members.filter((x) => (x.streak ?? 0) > 0);
    if (live && down.length) {
      const o = hist.outage ||= { since: now, acked: false, snoozeUntil: 0, lastSent: 0 };
      for (const a of await readAcks(o.since)) {
        if (a.text.includes("stop")) o.acked = true;
        if (a.text.includes("snooze")) o.snoozeUntil = Math.max(o.snoozeUntil, a.t + 3600);
      }
      if (!o.acked && now >= o.snoozeUntil && now - o.lastSent >= 270) {
        const who = down.map((x) => x.name);
        const body = down.map((x) => `${x.name}: missed ${x.streak} Turkey${x.streak > 1 ? "s" : ""}, last points ${x.lastAt ? hhmm(x.lastAt) : "?"}`).join("\n")
          + "\nRepeats every 5 min until they score again. Stop or snooze below.";
        await alarm(`P4: ${who.join(" and ")} ${who.length > 1 ? "are" : "is"} down`, body);
        o.lastSent = now;
      }
    } else if (hist.outage) {
      await notify("P4: everyone is scoring again", `All four scored on the ${hhmm(checkS)} Turkey.`, "white_check_mark,turkey", "default");
      hist.outage = null;
    }
    const inTop = (p4.place || 999) <= 100;
    if (live && hist.flags.inTop100 !== undefined && hist.flags.inTop100 !== inTop) {
      const text = inTop ? `P4 is in the top 100 (#${p4.place}). Titanic zone!` : `P4 dropped out of the top 100 (#${p4.place}).`;
      await notify(inTop ? "P4: top 100!" : "P4: out of the top 100", text, inTop ? "tada" : "chart_with_downwards_trend");
      hist.log.unshift({ t: now, kind: inTop ? "up" : "drop", text });
    }
    hist.flags.inTop100 = inTop;
    hist.log = hist.log.slice(0, 30);
  }

  // ---------- pace distributions (points per Turkey): the top 100, and every team ranked above P4
  const top100 = rows.filter((r) => r.r <= 100);
  const ahead = p4 && p4.place ? rows.filter((r) => r.r < p4.place) : [];
  const myPaceK = (k) => (p4 ? pace(LEAGUE, k) : null);
  const dist = (k, group = top100) => {
    const vals = group.map((r) => pace(r.n, k)).filter((v) => v != null);
    if (!vals.length) return null;
    // bars centred on round values: the "2k" bar holds 1,750-2,249, the last bar everything from 3,750
    const bins = [0, 500, 1000, 1500, 2000, 2500, 3000, 3500, 4000];
    const binOf = (v) => Math.max(0, Math.min(bins.length - 1, Math.round(v / 500)));
    const hist = bins.map((_, i) => vals.filter((v) => binOf(v) === i).length);
    const me = myPaceK(k);
    return {
      n: vals.length, mean: round(mean(vals)), median: round(quant(vals, 0.5)), q1: round(quant(vals, 0.25)), q3: round(quant(vals, 0.75)),
      at2k: vals.filter((v) => v >= 1950 && v <= 2050).length, above2k: vals.filter((v) => v > 2050).length, bins, hist,
      me: round(me), less: me == null ? null : vals.filter((v) => v < me - 50).length,
      same: me == null ? null : vals.filter((v) => Math.abs(v - me) <= 50).length, more: me == null ? null : vals.filter((v) => v > me + 50).length,
    };
  };

  // ---------- season series (one point per cycle)
  const series = cycles.map((c) => {
    const rk = rankMap(c.p);
    const sorted = Object.values(c.p).sort((a, b) => b - a);
    return { s: c.s, p4: c.p[LEAGUE] ?? null, rank: rk[LEAGUE] ?? null, c100: sorted[99] ?? null, c25: sorted[24] ?? null, c10: sorted[9] ?? null };
  });

  // ---------- catches leaderboard (solo)
  let catches = null;
  const list = boards && (boards.leaderboards || boards.boards || (Array.isArray(boards) ? boards : []));
  const liveBoards = (Array.isArray(list) ? list : []).filter((b) => b.state === "live" && b.scoringEndsAt > now).sort((a, b) => b.scoringEndsAt - a.scoringEndsAt);
  // players followed on the catches board on top of the squad
  const CATCH_EXTRA = { 4191632998: "Cocosdelamuerte" };
  const catchPeople = { ...SQUAD, ...CATCH_EXTRA };
  if (liveBoards.length) {
    const b = liveBoards[0], id = encodeURIComponent(b.id);
    const size = b.listSize || 10000; // the board only lists this many players
    const [cut, last, p1, p3, p5, ...entries] = await Promise.all([
      api(`/v1/leaderboards/${id}?source=live&page=11&pageSize=100`),
      api(`/v1/leaderboards/${id}?source=live&page=${size}&pageSize=1`),
      api(`/v1/leaderboards/${id}?source=live&page=1&pageSize=100`),
      api(`/v1/leaderboards/${id}?source=live&page=3&pageSize=100`),
      api(`/v1/leaderboards/${id}?source=live&page=5&pageSize=100`),
      ...Object.keys(catchPeople).map((u) => api(`/v1/leaderboards/${id}/players/${u}?source=live`)),
    ]);
    // benchmark ranks, and their pace over the last 6 hours from a snapshot kept every 30 minutes
    const at = (pg, i) => (pg && pg.entries && pg.entries[i] ? pg.entries[i].Value : null);
    const bench = { 1: at(p1, 0), 10: at(p1, 9), 100: at(p1, 99), 250: at(p3, 49), 500: at(p5, 99), 1003: at(cut, 2) };
    if (live) {
      hist.cb ||= [];
      if (!hist.cb.length || now - hist.cb[hist.cb.length - 1].t >= 1800) hist.cb.push({ t: now, v: bench });
      hist.cb = hist.cb.filter((x) => x.t > now - 8 * 86400);
    }
    const ref = (hist.cb || []).find((x) => x.t >= now - 6 * 3600), span = ref ? now - ref.t : 0;
    const paceH = span >= 7200 ? Object.fromEntries(Object.keys(bench).map((r) => [r, bench[r] != null && ref.v[r] != null ? ((bench[r] - ref.v[r]) / span) * 3600 : null])) : null;
    catches = {
      id: b.id, endsAt: b.scoringEndsAt, bench, paceH, paceSpanH: span / 3600,
      cutoff1003: cut && cut.entries && cut.entries[2] ? cut.entries[2].Value : null,
      listSize: size, floor: last && last.entries && last.entries[0] ? last.entries[0].Value : null,
      players: Object.keys(catchPeople).map((u, i) => ({ uid: Number(u), name: catchPeople[u], rank: entries[i]?.entry?.Rank ?? null, value: entries[i]?.entry?.Value ?? null })),
    };
  }

  // ---------- quiet servers: how long each public server has stayed at 1 player or fewer
  let quiet = null;
  const scan = live ? await quietScan() : null;
  if (scan) {
    // after a long gap we can't know what happened in between, so restart the tracking
    if ((hist.srvAt && now - hist.srvAt > 3600) || hist.srvV !== 2) { hist.srv = {}; hist.srvFrom = now; hist.srvV = 2; }
    hist.srv ||= {};
    hist.srvFrom ||= now;
    for (const [id, x] of scan.servers) {
      const o = (hist.srv[id] ||= { since: now });
      o.last = now; o.p = x.p; o.max = x.max; o.ping = x.ping;
    }
    for (const [id, o] of Object.entries(hist.srv)) {
      // a full scan lists every server with <= 1 player, so one that's missing went above 1 or closed
      // a partial scan (more than 300 quiet servers) may just not reach it: keep it 15 minutes
      if (o.last !== now && (scan.complete || now - o.last > 900)) delete hist.srv[id];
    }
    const list = Object.entries(hist.srv).filter(([, o]) => o.last === now).sort((a, b) => a[1].since - b[1].since);
    hist.srvAt = now; hist.srvTotal = scan.servers.size;
    quiet = { at: now, placeId: PLACE_ID, total: scan.servers.size, complete: scan.complete, tracking: hist.srvFrom,
      top: list.slice(0, 15).map(([id, o]) => ({ id, since: o.since, p: o.p, max: o.max, ping: o.ping })) };
  } else if (hist.srv && hist.srvAt) {
    // scan failed: show the last good list, marked with its age
    const list = Object.entries(hist.srv).filter(([, o]) => o.last === hist.srvAt).sort((a, b) => a[1].since - b[1].since);
    quiet = { at: hist.srvAt, placeId: PLACE_ID, total: hist.srvTotal || list.length, complete: false, stale: true, tracking: hist.srvFrom,
      top: list.slice(0, 15).map(([id, o]) => ({ id, since: o.since, p: o.p, max: o.max, ping: o.ping })) };
  }

  const dashboard = {
    v: 2, updatedAt: now, league: LEAGUE, cycleSec: CYCLE,
    season: { id: season.id, title: season.title, state: season.state, start: startTime, finish: season.finishTime, turkeysElapsed, turkeysLeft, totalLeagues, bands: season.placementRewards || [], petIcons: hist.petIcons || {} },
    p4: p4out, marks, rivals, track,
    top20: rows.slice(0, 20).map(enrich),
    dist: { last: dist(1), h1: dist(3), aheadLast: dist(1, ahead), aheadH1: dist(3, ahead), aheadN: ahead.length },
    series, catches, quiet, log: hist.log.slice(0, 12),
    ref: cycles.length ? { boundary: lastS, takenAt: cycles[cycles.length - 1].t, lastTurkeyAt: cycles.length > 1 ? lastS - CYCLE : null, rankSince: refRec ? refS : null } : null,
  };

  hist.lastRun = now;
  await fs.writeFile(histFile, JSON.stringify(hist));
  await fs.writeFile(path.join(DATA_DIR, "dashboard.json"), JSON.stringify(dashboard));
  console.log(`ok ${new Date(now * 1000).toISOString()} rows=${rows.length} cycles=${cycles.length} p4=${p4 ? `${p4.points}#${p4.place}` : "n/a"}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
