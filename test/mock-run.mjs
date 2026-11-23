// Simulates the BIG Games API over many Turkey cycles and runs the collector against it.
import fs from "node:fs/promises";
const START = 1795276800, FINISH = 1795795200, CYCLE = 1200, CREDIT = 700;
const N = 420, rnd = mulberry(7);
function mulberry(a) { return () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const names = Array.from({ length: N }, (_, i) => (i === 130 ? "P4" : "T" + i.toString(36).toUpperCase() + ["x", "zz", "q", "boo", ""][i % 5]));
const rate = names.map((n, i) => (n === "P4" ? 1600 : Math.max(200, 2600 - i * 5 + (rnd() - 0.5) * 600)));
const SQ = [216657469, 3083204118, 6079067379, 677658744];
// per turkey outcome table (deterministic)
const outcome = {};
function turkeyPts(i, s) {
  const k = i + ":" + s;
  if (outcome[k] == null) {
    const hourUTC = new Date(s * 1000).getUTCHours();
    const night = hourUTC >= 0 && hourUTC < 7;
    const up = rnd() < (night ? 0.55 : 0.9);
    outcome[k] = up ? Math.round(rate[i] * (0.85 + rnd() * 0.3) / 100) * 100 : 0;
  }
  return outcome[k];
}
function p4Members(s) { // panda drops out between cycles 60 and 66
  const idx = (s - START) / CYCLE;
  const pandaDown = idx >= 60 && idx < 66;
  return { 216657469: pandaDown ? 0 : 340, 3083204118: pandaDown ? 0 : 320, 6079067379: 360, 677658744: 340 };
}
function state(t) {
  const pts = new Array(N).fill(0), mem = Object.fromEntries(SQ.map((u) => [u, { p: 0, ts: null }]));
  // LATE=1: from cycle 80 kxngcebu kills alone with an alt, 19.5 min after landing, for 700
  const lateAt = (u, s) => process.env.LATE && u === 677658744 && (s - START) / CYCLE >= 80 ? 1170 : CREDIT - 30;
  for (let s = START; s + 30 <= t; s += CYCLE) {
    if (s + CREDIT <= t) for (let i = 0; i < N; i++) if (names[i] !== "P4") pts[i] += turkeyPts(i, s);
    const m = p4Members(s);
    for (const u of SQ) {
      const v = lateAt(u, s) === 1170 ? 700 : m[u];
      if (v > 0 && s + lateAt(u, s) <= t) { mem[u].p += v; mem[u].ts = s + lateAt(u, s); }
    }
  }
  pts[130] = SQ.reduce((a, u) => a + mem[u].p, 0);
  return { pts, mem };
}
let NOW = START;
globalThis.fetch = async (url) => {
  const u = new URL(url), p = u.pathname, sp = u.searchParams;
  const ok = (data) => ({ ok: true, status: 200, json: async () => ({ status: "ok", data }) });
  if (url.startsWith("https://ntfy.sh")) {
    if (url.includes("-ack/json")) { const ackAt = +(process.env.ACK_AT || 0); const txt = ackAt && NOW > ackAt ? JSON.stringify({ event: "message", time: ackAt, message: "stop" }) + "\n" : ""; return { ok: true, status: 200, text: async () => txt }; }
    console.log("  NTFY:", new Date(NOW * 1000).toISOString().slice(11, 16)); return { ok: true, status: 200 };
  }
  const { pts, mem } = state(NOW);
  if (p === "/v1/leagues/seasons/active") return ok({ id: "PumpkinTycoonLeague2026", title: "Caramel Apple League", state: "live", startTime: START, finishTime: FINISH, placementRewards: [] });
  if (p === "/v1/leagues") {
    const order = names.map((n, i) => ({ n, p: pts[i] })).sort((a, b) => b.p - a.p);
    const page = +sp.get("page"), size = +sp.get("pageSize");
    const slice = order.slice((page - 1) * size, page * size).map((x, j) => ({ Name: x.n, Rank: (page - 1) * size + j + 1, Points: x.p, Members: 4, Icon: null }));
    return ok({ leagues: slice, total: N, page, pageSize: size });
  }
  if (p.startsWith("/v1/leagues/P4")) {
    const order = names.map((n, i) => ({ n, p: pts[i] })).sort((a, b) => b.p - a.p);
    const place = order.findIndex((x) => x.n === "P4") + 1;
    return ok({ Name: "P4", Points: pts[130], Place: place, Reward: { placement: "101–500", items: [{ id: "Huge Caramel Apple Bunny", variant: "rainbow" }] },
      PointContributions: SQ.map((u) => ({ UserID: u, DisplayName: "d" + u, Points: mem[u].p, Timestamp: mem[u].ts, Counted: true })) });
  }
  if (p === "/v1/leaderboards") return ok({ leaderboards: [{ id: "PumpkinTycoonCatches", state: "live", scoringEndsAt: FINISH }] });
  if (p.endsWith("/players/216657469") || p.includes("/players/")) return ok({ entry: { Rank: 5000, Value: 340 } });
  if (p.startsWith("/v1/leaderboards/")) return ok({ entries: [{ Value: 1000 }, { Value: 995 }, { Value: 987 }] });
  return { ok: false, status: 404, json: async () => ({}) };
};
process.env.DATA_DIR = "/tmp/p4data";
process.env.NTFY_TOPIC = "test-topic";
await fs.rm("/tmp/p4data", { recursive: true, force: true });
const { main } = await import("../scripts/collect.mjs");
const CYCLES = +(process.argv[2] || 90);
for (let c = 0; c < CYCLES; c++) {
  for (const off of [60, 240, 600, 900, 1140]) {
    NOW = START + c * CYCLE + off; process.env.FAKE_NOW = String(NOW);
    await main();
  }
}
const d = JSON.parse(await fs.readFile("/tmp/p4data/dashboard.json", "utf8"));
console.log(JSON.stringify({ p4: { ...d.p4, members: d.p4.members.map((m) => ({ n: m.name, s: m.streak, h1: m.h1, t: m.turkeys })) }, marks: d.marks, dist: d.dist, rivals: d.rivals.slice(0, 3), log: d.log.slice(0, 4), series: d.series.slice(-2) }, null, 1).slice(0, 4000));
const size = (await fs.stat("/tmp/p4data/history.json")).size, size2 = (await fs.stat("/tmp/p4data/dashboard.json")).size;
console.log("history bytes", size, "dashboard bytes", size2);
