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
const PAIRS = [[216657469, 3083204118], [6079067379, 677658744]];
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
      Actions: `http, Stop alarm, ${ack}, method=POST, body=stop, clear=true; http, Snooze 1 h, ${ack}, method=POST, body=snooze, clear=true`,
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

function makePace(cycles) {
  const byS = new Map(cycles.map((c) => [c.s, c]));
  const lastS = cycles.length ? cycles[cycles.length - 1].s : 0;
  // points per Turkey for `key` over the last k Turkeys (key = league name, or "m:<uid>")
  return function pace(key, k) {
    const cur = byS.get(lastS);
    if (!cur) return null;
    const get = (c) => (key.startsWith("m:") ? c.m && c.m[key.slice(2)] : c.p[key]);
    const v1 = get(cur);
    if (v1 == null) return null;
    for (let back = k; back <= k + 3; back++) {
      const old = byS.get(lastS - back * CYCLE);
      const v0 = old && get(old);
      if (v0 != null) return (v1 - v0) / back;
    }
    return null;
  };
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
  if (hist.cycles.length > MAX_CYCLES) hist.cycles = hist.cycles.slice(-MAX_CYCLES);
  const cycles = hist.cycles;
  const pace = makePace(cycles);
  const lastS = cycles.length ? cycles[cycles.length - 1].s : s0;
  const startTime = season.startTime || (season.finishTime ? season.finishTime - 518400 : now);
  const turkeysElapsed = Math.max(1, Math.floor((now - startTime) / CYCLE));
  const turkeysLeft = season.finishTime ? Math.max(0, Math.floor((season.finishTime - now) / CYCLE)) : 0;

  // Paces are points per Turkey over the last 1, 3, 9, 18 and 72 Turkeys (last Turkey, 1 h, 3 h, 6 h, 24 h).
  // The finish projection uses the 24 h pace (it includes nights), or the since-start average until
  // a full day of history exists.
  const teamStats = (n, p) => {
    const since = p / turkeysElapsed, h24 = pace(n, 72);
    return { last: round(pace(n, 1)), h1: round(pace(n, 3)), h3: round(pace(n, 9)), h6: round(pace(n, 18)), h24: round(h24), since: round(since), proj: round(p + (h24 ?? since) * turkeysLeft) };
  };
  const rankAgo = (k) => {
    const c = cycles.find((x) => x.s === lastS - k * CYCLE);
    return c ? rankMap(c.p) : null;
  };
  const r1h = rankAgo(3), r6h = rankAgo(18);
  const enrich = (row) => ({
    ...row, ...teamStats(row.n, row.p),
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
    const members = Object.keys(SQUAD).map(Number).map((uid) => {
      const c = p4.members.find((x) => x.uid === uid) || { uid, name: SQUAD[uid], points: 0, lastAt: null };
      const lastCycle = c.lastAt ? c.lastAt - (c.lastAt % CYCLE) : null;
      const streak = lastCycle == null ? null : Math.max(0, Math.round((checkS - lastCycle) / CYCLE));
      const turkeys = cycles.slice(-13).map((cy, i, arr) => (i === 0 ? null : diff(cy.m?.[uid], arr[i - 1].m?.[uid]))).slice(1);
      return { uid, name: SQUAD[uid], display: c.display || c.name, points: c.points, lastAt: c.lastAt, streak, h1: round(pace(`m:${uid}`, 3)), turkeys };
    });
    const teamTurkeys = cycles.slice(-13).map((cy, i, arr) => (i === 0 ? null : { s: arr[i - 1].s, pts: diff(cy.p[LEAGUE], arr[i - 1].p[LEAGUE]) })).slice(1);
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
    const thisTurkey = openRec && openRec.p[LEAGUE] != null ? {
      s: s0, pts: p4.points - openRec.p[LEAGUE],
      scored: members.filter((x) => x.lastAt && x.lastAt >= s0).map((x) => x.uid),
    } : { s: s0, pts: null, scored: members.filter((x) => x.lastAt && x.lastAt >= s0).map((x) => x.uid) };
    p4out = {
      ...me, thisTurkey, icon: p4.icon, reward: p4.reward, members, turkeys: teamTurkeys, checkedTurkey: checkS, pack: packOut, projRanks,
      gaps: Object.fromEntries(marks.filter((x) => [10, 25, 100].includes(x.r)).map((x) => [x.r, x.p - p4.points])),
      need100: c100 && turkeysLeft ? round((c100.proj - p4.points) / turkeysLeft) : null,
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
    track = rows.filter((r) => r.r >= hi && r.r <= lo).map((r) => ({ r: r.r, n: r.n, p: r.p, icon: r.icon, me: r.n === LEAGUE }));
    if (!track.some((t) => t.me)) track.push({ r: p4.place, n: LEAGUE, p: p4.points, me: true });

    // ---------- alerts (one grouped message per run)
    const downNow = new Set(members.filter((x) => (x.streak ?? 0) > 0).map((x) => x.uid));
    const lines = [], backs = [];
    for (const mb of members) {
      const st = hist.alerts[mb.uid] || { notified: 0 };
      const s = mb.streak ?? 0;
      const due = s === 1 || s === 3 || (s > 3 && (s - 3) % 9 === 0);
      if (live && s > 0 && due && st.notified !== s) {
        const partner = PAIRS.find((p) => p.includes(mb.uid))?.find((u) => u !== mb.uid);
        const last = mb.lastAt ? hhmm(mb.lastAt) : "?";
        let text = s === 1
          ? `${mb.name} didn't score on the ${hhmm(checkS)} Turkey (last points ${last}).`
          : `${mb.name} has missed ${s} Turkeys in a row (last points ${last}).`;
        if (s === 1 && partner) text += downNow.has(partner) ? ` ${SQUAD[partner]} is down too: the whole pair is out.` : ` ${SQUAD[partner]} can't kill alone.`;
        lines.push(text);
        hist.log.unshift({ t: now, kind: "down", uid: mb.uid, text });
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
    const bins = [0, 500, 1000, 1500, 2000, 2500, 3000, 3500, 4000];
    const hist = bins.map((b, i) => vals.filter((v) => v >= b && (i === bins.length - 1 || v < bins[i + 1])).length);
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
  if (liveBoards.length) {
    const b = liveBoards[0], id = encodeURIComponent(b.id);
    const [cut, ...entries] = await Promise.all([
      api(`/v1/leaderboards/${id}?source=live&page=11&pageSize=100`),
      ...Object.keys(SQUAD).map((u) => api(`/v1/leaderboards/${id}/players/${u}?source=live`)),
    ]);
    catches = {
      id: b.id, endsAt: b.scoringEndsAt,
      cutoff1003: cut && cut.entries && cut.entries[2] ? cut.entries[2].Value : null,
      players: Object.keys(SQUAD).map((u, i) => ({ uid: Number(u), name: SQUAD[u], rank: entries[i]?.entry?.Rank ?? null, value: entries[i]?.entry?.Value ?? null })),
    };
  }

  const dashboard = {
    v: 2, updatedAt: now, league: LEAGUE, cycleSec: CYCLE,
    season: { id: season.id, title: season.title, state: season.state, start: startTime, finish: season.finishTime, turkeysElapsed, turkeysLeft, totalLeagues, bands: season.placementRewards || [], petIcons: hist.petIcons || {} },
    p4: p4out, marks, rivals, track,
    top20: rows.slice(0, 20).map(enrich),
    dist: { last: dist(1), h1: dist(3), aheadLast: dist(1, ahead), aheadH1: dist(3, ahead), aheadN: ahead.length },
    series, catches, log: hist.log.slice(0, 12),
    ref: cycles.length ? { boundary: lastS, takenAt: cycles[cycles.length - 1].t, lastTurkeyAt: cycles.length > 1 ? lastS - CYCLE : null } : null,
  };

  hist.lastRun = now;
  await fs.writeFile(histFile, JSON.stringify(hist));
  await fs.writeFile(path.join(DATA_DIR, "dashboard.json"), JSON.stringify(dashboard));
  console.log(`ok ${new Date(now * 1000).toISOString()} rows=${rows.length} cycles=${cycles.length} p4=${p4 ? `${p4.points}#${p4.place}` : "n/a"}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
