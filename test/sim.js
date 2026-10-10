// CPU同士の自己対戦で勝率を測る。 node test/sim.js [倍率]   （ジョブは並列の子プロセスで実行。王国は毎回ランダム＝第2版の26種から10種）
'use strict';
const L = require('../logic.js'), A = require('../ai.js');
const { execFile } = require('child_process');
const MUL = +process.argv[2] || 1;
const JOBS = [];
const LVS = ['weak', 'normal', 'strong', 'ultra'];
// K＝王国の数、G＝1つの王国での対戦数（席と手番を回す）
for (let a = 0; a < 4; a++) for (let b = a + 1; b < 4; b++) JOBS.push({ name: '2人 ' + LVS[b] + ' vs ' + LVS[a], focal: LVS[b], other: LVS[a], np: 2, K: LVS[b] === 'ultra' ? 40 : 200, G: LVS[b] === 'ultra' ? 10 : 2 });
JOBS.push({ name: '2人 bmu(お金だけ最適) vs normal', focal: 'bmu', other: 'normal', np: 2, K: 200, G: 2 });
JOBS.push({ name: '2人 strong vs bmu', focal: 'strong', other: 'bmu', np: 2, K: 200, G: 2 });
JOBS.push({ name: '2人 ultra vs bmu', focal: 'ultra', other: 'bmu', np: 2, K: 40, G: 10 });
JOBS.push({ name: '3人 ultra×1 vs strong×2', focal: 'ultra', other: 'strong', np: 3, K: 30, G: 12 });
JOBS.push({ name: '4人 ultra×1 vs strong×3', focal: 'ultra', other: 'strong', np: 4, K: 30, G: 12 });
JOBS.push({ name: '3人 strong×1 vs normal×2', focal: 'strong', other: 'normal', np: 3, K: 150, G: 3 });
JOBS.push({ name: '4人 混成 weak/normal/strong/ultra', mixed: ['weak', 'normal', 'strong', 'ultra'], np: 4, K: 30, G: 8 });

function seatFor(lv, kingdom, np, rnd, ultraPlan) {
  if (lv === 'bmu') return { lv: 'strong', plan: A.bmu() };
  if (lv === 'ultra') return { lv: 'ultra', plan: ultraPlan };
  return { lv: lv, plan: A.planFor(lv, kingdom, np, rnd) };
}
function run(j, ji) {
  const K = Math.max(1, Math.round(j.K * MUL)), t0 = Date.now(), score = {}, cnt = {}, picks = {};
  let games = 0, turns = 0, prov = 0, selMs = 0;
  for (let k = 0; k < K; k++) {
    const rnd = L.mulberry(1000003 * (ji + 1) + k * 7919), kingdom = L.randomKingdom(rnd, false);
    const lvs = j.mixed || [j.focal].concat(Array(j.np - 1).fill(j.other));
    let up = null;
    if (lvs.includes('ultra')) { const s0 = Date.now(); const r = A.ultraSelect(kingdom, j.np, { seed: k * 31 + 7 }); selMs += Date.now() - s0; up = r.plan; picks[r.plan.name] = (picks[r.plan.name] || 0) + 1; }
    for (let g = 0; g < j.G; g++) {
      const rot = g % j.np, lv = lvs.map((_, q) => lvs[(q + rot) % j.np]);
      const seats = lv.map(l => seatFor(l, kingdom, j.np, rnd, up));
      const S = A.simGame(kingdom, seats, 50000 + ji * 100000 + k * 101 + g, { start: Math.floor(g / j.np) % j.np });
      games++; turns += S.P.reduce((s, P) => s + P.turns, 0) / j.np; if (S.result.why === 'oukan') prov++;
      lv.forEach((l, q) => { cnt[l] = (cnt[l] || 0) + 1; if (S.result.winners.includes(q)) score[l] = (score[l] || 0) + 1 / S.result.winners.length; });
    }
  }
  const out = {};
  for (const l in cnt) out[l] = { win: +(100 * (score[l] || 0) / games).toFixed(1), seats: cnt[l] / games };
  const top = Object.entries(picks).sort((a, b) => b[1] - a[1]).slice(0, 5);
  return { name: j.name, games, kingdoms: K, rate: out, fair: +(100 / j.np).toFixed(1), turnsPerPlayer: +(turns / games).toFixed(1), oukanEnd: +(100 * prov / games).toFixed(0), ultraSelectSec: K && selMs ? +(selMs / K / 1000).toFixed(2) : undefined, ultraPicks: top.length ? top : undefined, sec: +((Date.now() - t0) / 1000).toFixed(0) };
}
if (process.argv[3] != null) { process.stdout.write(JSON.stringify(run(JOBS[+process.argv[3]], +process.argv[3]))); return; }
const res = []; let next = 0, live = 0, cpus = Math.max(1, require('os').cpus().length - 1);
function pump() {
  while (live < cpus && next < JOBS.length) {
    const k = next++; live++;
    execFile(process.execPath, [__filename, String(MUL), String(k)], { maxBuffer: 1 << 24 }, (err, so) => {
      live--; if (err) { console.error(JOBS[k].name, err.message); process.exitCode = 1; } else {
        res[k] = JSON.parse(so); const r = res[k];
        console.log(r.name + '（' + r.games + '戦・王国' + r.kingdoms + '種類・' + r.sec + '秒）: ' + Object.keys(r.rate).map(l => l + ' ' + r.rate[l].win + '%' + (r.rate[l].seats > 1 ? '(' + r.rate[l].seats + '席合計)' : '')).join(' / ') + '（公平なら1席 ' + r.fair + '%）・1人' + r.turnsPerPlayer + '手番・王冠領で終了' + r.oukanEnd + '%' + (r.ultraSelectSec ? '・作戦えらび' + r.ultraSelectSec + '秒/王国' : '') + (r.ultraPicks ? '・よく選んだ作戦 ' + r.ultraPicks.map(x => x[0] + '×' + x[1]).join('、') : ''));
      }
      if (next < JOBS.length) pump(); else if (!live) require('fs').writeFileSync(__dirname + '/sim-report.json', JSON.stringify(res, null, 1));
    });
  }
}
pump();
