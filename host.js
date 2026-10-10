/* 王国争覇：ホスト側のゲーム進行（authoritative）。山札・手札・進行・CPUの思考はここだけ */
'use strict';
function hostId(code) { return ID_PREFIX + code; }
function defCpu() { return CH_KEYS.map(function (c) { return { lv: 'normal', ch: c }; }); }
function newRoom(name, solo) {
  return { code: solo ? 'SOLO' : genCode(), solo: !!solo, phase: 'lobby',
    opts: { np: 2, kmode: 'set', set: 'first', ed1: false, kingdom: L.sortK(L.SETS[0].k), pick: [], autoHanebashi: true, cpu: defCpu() },
    nextSid: 2, gameNo: 0, seats: [{ sid: 1, name: name, kind: 'host', clientId: myId, connected: true }], G: null, notice: null, lobbyReq: null, last: null };
}
function startHost(name, saved, solo) {
  document.body.classList.add('is-host');
  var room = saved ? saved.room : newRoom(name, solo);
  host = { room: room, conns: {}, lastSeen: {}, tries: 0, opened: false };
  document.body.classList.toggle('solo', !!room.solo);
  if (saved) {
    room.seats.forEach(function (s) { if (s.kind === 'remote') s.connected = false; });
    room.G = null;
    if (saved.g && room.phase !== 'lobby') { try { room.G = restoreGame(saved.g); } catch (e) { console.warn(e); room.phase = 'lobby'; room.notice = { id: 1, msg: '前回のゲームは再開できませんでした' }; } }
    if (!room.G && room.phase !== 'lobby') room.phase = 'lobby';
  }
  if (room.solo) { host.opened = true; hostRender(); saveHost(true); }
  else { connecting(true, saved ? '部屋を再開しています…' : '部屋を作っています…', 'シグナリングサーバーに接続中', function () { location.href = location.pathname; }); openHostPeer(); }
  setInterval(hostHeartbeat, 2000);
  setInterval(hostTick, TURBO ? 20 : 60);
}
function npRange(nh) { return [Math.max(2, nh), 4]; }
// 席：人間が参加順に前から。残りは CPU（キャラは opts.cpu の順）
function planOwners(seats, opts) {
  var np = Math.min(4, Math.max(opts.np, seats.length, 2)), out = [], ci = 0;
  for (var i = 0; i < np; i++) {
    var h = seats[i];
    if (h) out.push({ kind: 'human', sid: h.sid, name: h.name });
    else { var c = opts.cpu[ci++] || { lv: 'normal', ch: 'fuu' }; out.push({ kind: 'cpu', lv: c.lv, ch: c.ch, name: CH[c.ch].name, e: CH[c.ch].e }); }
  }
  return out;
}
// ロビーで選んだ王国（10種）
function kingdomFor(opts) {
  if (opts.kmode === 'set') { var s = L.SETS.filter(function (x) { return x.id === opts.set; })[0] || L.SETS[0]; return s.k.slice(); }
  if (opts.kmode === 'custom') return L.randomKingdom(Math.random, opts.ed1, opts.pick.slice(0, 10));
  return opts.kingdom.length === 10 ? opts.kingdom.slice() : L.randomKingdom(Math.random, opts.ed1);
}
function rollKingdom() { var o = host.room.opts; o.kingdom = L.sortK(L.randomKingdom(Math.random, o.ed1)); }
function makePlans(G) {
  var S = G.S;
  G.plans = G.owners.map(function (o, i) {
    if (o.kind !== 'cpu') return null;
    if (o.lv === 'ultra') return G.uplan ? AI.planById(G.uplan, S.kingdom, S.np) : null;
    return G.planIds && G.planIds[i] ? AI.planById(G.planIds[i], S.kingdom, S.np) : AI.planFor(o.lv, S.kingdom, S.np, Math.random);
  });
  G.planIds = G.plans.map(function (p) { return p ? p.id : null; });
  G.proxy = AI.strongPlan(S.kingdom, S.np);
}
function hostStartGame(sameKingdom) {
  var R = host.room;
  if (!R.seats.length) return;
  if (R.seats.length > 4) { toast('4人までです'); return; }
  var owners = planOwners(R.seats, R.opts), np = owners.length;
  var kingdom = sameKingdom && R.last ? R.last.kingdom.slice() : kingdomFor(R.opts);
  // 続けて遊ぶとき：前のゲームで1人だけ勝った人が最後（その次の人から）。同点なら ランダム（公式ルール）
  var start;
  if (R.last && R.last.np === np && R.last.winners.length === 1 && R.last.sids.join() === owners.map(function (o) { return o.sid || o.ch; }).join()) start = (R.last.winners[0] + 1) % np;
  var seed = Math.floor(Math.random() * 2147483647);
  var S = L.newGame({ np: np, kingdom: kingdom, seed: seed, start: start });
  R.gameNo++; R.lobbyReq = null;
  var ultraI = -1; owners.forEach(function (o, i) { if (o.kind === 'cpu' && o.lv === 'ultra' && ultraI < 0) ultraI = i; });
  var G = { S: S, seed: seed, start: S.first, owners: owners, ultra: ultraI >= 0 ? owners[ultraI].ch : null, uplan: null, uprog: ultraI >= 0 ? 0 : 1,
    startAt: Date.now() + (ultraI >= 0 ? T.awaken : 700), started: false, cpuAt: 0, nextAt: 0, say: null, seenEv: S.evId, endAt: 0 };
  if (ultraI >= 0) G.ugen = AI.ultraSelectGen(kingdom, np, { seed: seed % 100000 + 1, g1: TURBO ? 6 : 24, g2: TURBO ? 10 : 60 });
  makePlans(G);
  R.G = G; R.phase = 'game';
  hostBroadcast();
}
function restoreGame(g) {
  var S = L.replay({ np: g.np, kingdom: g.kingdom, seed: g.seed, start: g.start }, g.log || []);
  var G = { S: S, seed: g.seed, start: g.start, owners: g.owners, ultra: g.ultra, uplan: g.uplan, uprog: g.uplan || !g.ultra ? 1 : 0, planIds: g.planIds,
    startAt: Date.now() + 800, started: false, cpuAt: 0, nextAt: 0, say: null, seenEv: S.evId, endAt: 0 };
  if (g.ultra && !g.uplan) G.ugen = AI.ultraSelectGen(g.kingdom, g.np, { seed: g.seed % 100000 + 1, g1: TURBO ? 6 : 24, g2: TURBO ? 10 : 60 });
  makePlans(G);
  return G;
}
function say(p, key, o) {
  var G = host.room.G, ow = G.owners[p]; if (!ow || ow.kind !== 'cpu') return;
  var lines = CH[ow.ch].L[key]; if (!lines) return;
  G.say = { id: (G.say ? G.say.id : 0) + 1, p: p, text: fill(pick(lines), o || {}) + (ow.lv === 'ultra' && Math.random() < 0.5 ? '😎' : '') };
}
function isCpu(p) { var o = host.room.G.owners[p]; return o && o.kind === 'cpu'; }
// 新しく起きた出来事に CPU がひとこと
function afterEvents() {
  var G = host.room.G, S = G.S;
  S.ev.forEach(function (e) {
    if (e.id <= G.seenEv) return;
    G.seenEv = e.id;
    var r = Math.random();
    if (e.k === 'turn') { G.nPlay = 0; if (e.n === 1 && S.turnNo <= 1) { var cs = G.owners.map(function (o, i) { return i; }).filter(isCpu); if (cs.length) say(pick(cs), 'greet'); } }
    else if (e.k === 'play' && isCpu(e.p)) {
      G.nPlay = (G.nPlay || 0) + 1;
      if (L.isA(e.c, 'attack') && !e.n && r < 0.35) say(e.p, 'attack');
      else if (G.nPlay === 5) say(e.p, 'combo');
    } else if (e.k === 'gain' && isCpu(e.p)) {
      if (e.c === 'oukan' && r < 0.7) say(e.p, 'prov');
      else if (e.c === 'gold' && e.why === 'buy' && r < 0.25) say(e.p, 'gold');
      else if (e.c === 'hakuryo' && r < 0.2) say(e.p, 'hakuryo');
      else if (e.c === 'curse' && e.why === 'jujutsu' && r < 0.4) say(e.p, 'cursed');
    } else if (e.k === 'hanebashi' && isCpu(e.p) && r < 0.6) say(e.p, 'hanebashi');
    else if (e.k === 'trash' && isCpu(e.p) && e.why === 'zange' && e.cards.length >= 3 && r < 0.5) say(e.p, 'trash');
    else if (e.k === 'over') {
      var w = e.winners.filter(isCpu), l = G.owners.map(function (o, i) { return i; }).filter(function (i) { return isCpu(i) && e.winners.indexOf(i) < 0; });
      if (w.length) say(pick(w), 'mwin'); else if (l.length) say(pick(l), 'mlose');
    }
  });
}
function delayFor() {
  var S = host.room.G.S, e = S.ev[S.ev.length - 1], d = 500;
  if (!e) return 400;
  if (e.k === 'play') d = L.isA(e.c, 'attack') ? 1100 : 750;
  else if (e.k === 'gain') d = e.c === 'oukan' ? 1100 : 750;
  else if (e.k === 'treasures') d = 500;
  else if (e.k === 'turn') d = 600;
  else if (e.k === 'reveal' || e.k === 'revealHand' || e.k === 'trash') d = 1000;
  else if (e.k === 'over') d = 400;
  return d * T.k;
}
function applyAct(p, a) {
  var G = host.room.G, S = G.S;
  var err = L.act(S, p, a); if (err) return err;
  afterEvents(); G.nextAt = Date.now() + delayFor(); G.cpuAt = 0;
  if (S.over && !G.endAt) G.endAt = Date.now() + T.roundEnd;
  hostBroadcast(); return null;
}
// 参加者から届いた答えは、必要なキーだけを型をそろえて取り出す
function cleanAnswer(nd, v) {
  v = v && typeof v === 'object' ? v : {};
  var ints = function (x) { return Array.isArray(x) ? x.slice(0, 12).map(function (n) { return n | 0; }) : []; };
  switch (nd.k) {
    case 'action': return v.a === 'play' ? { a: 'play', i: v.i | 0 } : { a: 'end' };
    case 'buy': return v.a === 'all' ? { a: 'all' } : v.a === 'treasure' ? { a: 'treasure', i: v.i | 0 } : v.a === 'buy' ? { a: 'buy', c: String(v.c || ''), auto: !!v.auto } : { a: 'end' };
    case 'hand': case 'pick': return { sel: ints(v.sel) };
    case 'supply': return { c: v.c == null ? null : String(v.c) };
    case 'yn': return { y: !!v.y };
    case 'monomi': return { fate: Array.isArray(v.fate) ? v.fate.slice(0, 2).map(String) : [], order: ints(v.order) };
  }
  return {};
}
function hostAction(sid, m) {
  var R = host.room, G = R.G; if (!G || R.phase !== 'game') return null;
  var S = G.S, nd = S.need;
  if (!G.started || !nd || S.over) return null;
  if (m.k !== S.seq) return null;   // 古い画面からの操作は無視
  var o = G.owners[nd.p];
  if (!o || o.kind !== 'human' || o.sid !== sid) return 'あなたの番ではありません';
  return applyAct(nd.p, cleanAnswer(nd, m.v));
}
// アストラウルトラの作戦えらび（覚醒の演出のあいだに少しずつ計算）
function stepUltra(G, budget) {
  var t0 = performance.now(), r;
  while (performance.now() - t0 < budget) {
    r = G.ugen.next();
    if (r.done) { G.uplan = r.value.plan.id; G.utable = r.value.table; G.uprog = 1; G.ugen = null; makePlans(G); console.log('アストラウルトラの作戦：', r.value.table); return; }
    G.uprog = r.value || G.uprog;
  }
}
function hostTick() {
  if (!host || !host.opened) return;
  var R = host.room, G = R.G, now = Date.now();
  if (R.phase !== 'game' || !G) return;
  if (G.ugen) { stepUltra(G, now < G.startAt ? 40 : 50); if (G.ugen) { if (now - (G.tickAt || 0) > 500) { G.tickAt = now; hostBroadcast(); } return; } }
  if (now < G.startAt) return;
  if (!G.started) { G.started = true; G.nextAt = now + 300; afterEvents(); hostBroadcast(); return; }
  var S = G.S;
  if (S.over) {
    if (now >= G.endAt) {
      R.phase = 'end';
      R.last = { kingdom: S.kingdom.slice(), np: S.np, winners: S.result.winners.slice(), sids: G.owners.map(function (o) { return o.sid || o.ch; }) };
      hostBroadcast();
    }
    return;
  }
  var nd = S.need; if (!nd) return;
  var p = nd.p, o = G.owners[p], seat = o.kind === 'human' ? seatBySid(o.sid) : null;
  // 跳ね橋：CPU と「自動で見せる」設定の人は すぐ答える（待ち時間で持っていることがばれないように）
  if (nd.why === 'hanebashi' && (o.kind === 'cpu' || R.opts.autoHanebashi)) { applyAct(p, o.kind === 'cpu' ? AI.decide(S, p, o.lv, G.plans[p]) || { y: true } : { y: true }); G.nextAt = now; return; }
  var proxy = o.kind === 'human' && seat && seat.kind === 'remote' && !seat.connected;
  if (o.kind !== 'cpu' && !proxy) { G.cpuAt = 0; return; }
  if (now < G.nextAt) return;
  if (!G.cpuAt) {
    var base = nd.k === 'buy' ? rand(T.cpu) : nd.k === 'action' ? rand(T.cpu) * 0.8 : rand(T.cpu) * 0.6;
    G.cpuAt = now + (o.kind === 'cpu' ? base : T.off); hostBroadcast(); return;
  }
  if (now < G.cpuAt) return;
  G.cpuAt = 0;
  if (proxy) toastAll('切断中の ' + seat.name + ' のかわりに CPU が選びました');
  var a = AI.decide(S, p, o.kind === 'cpu' ? o.lv : 'strong', o.kind === 'cpu' ? G.plans[p] : G.proxy) || AI.fallback(S);
  if (applyAct(p, a)) applyAct(p, AI.fallback(S));
}
function viewFor(sid) {
  var R = host.room, G = R.G, now = Date.now(), you = -1;
  R.seats.forEach(function (s, i) { if (s.sid === sid) you = i; });
  var v = { t: 'state', phase: R.phase, code: R.code, solo: R.solo, you: you, sid: sid, gameNo: R.gameNo, opts: JSON.parse(JSON.stringify(R.opts)),
    seats: R.seats.map(function (s) { return { sid: s.sid, name: s.name, kind: s.kind, connected: s.kind !== 'remote' || s.connected }; }), notice: R.notice };
  if (sid === 1 && R.lobbyReq && R.phase !== 'lobby') v.lobbyReq = R.lobbyReq;
  if (R.phase === 'lobby' || !G) return v;
  var S = G.S, me = -1;
  G.owners.forEach(function (o, i) { if (o.kind === 'human' && o.sid === sid) me = i; });
  v.g = L.viewFor(S, me, 80);   // ← 自分が見てよい情報だけ（他人の手札・山札の中身と並びは入らない）
  v.g.me = me;
  v.g.owners = G.owners.map(function (o) { var s = o.kind === 'human' ? seatBySid(o.sid) : null; return { kind: o.kind, sid: o.sid, name: o.name, lv: o.lv, ch: o.ch, e: o.e, connected: !s || s.kind !== 'remote' || s.connected }; });
  v.g.ultra = G.ultra; v.g.uprog = G.uprog; v.g.wait = G.started ? 0 : Math.max(0, G.startAt - now) || (G.ugen ? 1 : 0);
  v.g.say = G.say; v.g.thinking = G.cpuAt && S.need ? S.need.p : -1;
  if (S.over) v.g.decks = S.P.map(function (P) { return L.counts(L.owned(P)); });   // ゲームが終わったら全員のデッキを公開
  return v;
}
function seatByClient(cid) { return host.room.seats.filter(function (s) { return s.clientId === cid; })[0]; }
function seatBySid(sid) { return host.room.seats.filter(function (s) { return s.sid === sid; })[0]; }
function toastAll(msg) { var R = host.room; R.notice = { id: (R.notice ? R.notice.id : 0) + 1, msg: msg, toast: true }; }
function hostToLobby(msg) {
  var R = host.room;
  R.phase = 'lobby'; R.G = null; R.lobbyReq = null;
  R.seats = R.seats.filter(function (s) { if (s.kind === 'remote') { s.left = false; return !!s.connected; } return true; });
  R.notice = { id: (R.notice ? R.notice.id : 0) + 1, msg: msg };
  hostBroadcast();
}
function hostLobbyReq(seat) {
  var R = host.room;
  if (seat.kind !== 'remote' || R.phase === 'lobby') return;
  if (R.lobbyReq && R.lobbyReq.sid === seat.sid && Date.now() - R.lobbyReq.at < 5000) return;
  R.lobbyReq = { sid: seat.sid, name: seat.name, at: Date.now() };
  hostBroadcast();
}
function hostBroadcast() {
  var R = host.room;
  R.seats.forEach(function (s) { if (s.kind !== 'remote') return; var c = host.conns[s.clientId]; if (c && c.open) { try { c.send(viewFor(s.sid)); } catch (e) {} } });
  hostRender(); saveHost();
}
function hostRender() { render(viewFor(1)); }
// 保存：ゲームは「seed＋判断の列」で保存し、再開のときに作り直す（山札の並びなどを丸ごと保存しない）
var saveT = 0, saveLater = 0;
function saveHost(force) {
  var now = Date.now();
  if (!force && now - saveT < 800 && host.room.phase === 'game') { clearTimeout(saveLater); saveLater = setTimeout(function () { saveHost(true); }, 900); return; }
  saveT = now;
  var R = host.room, G = R.G, g = null;
  if (G) g = { np: G.S.np, kingdom: G.S.kingdom, seed: G.seed, start: G.start, log: G.S.log, owners: G.owners, ultra: G.ultra, uplan: G.uplan, planIds: G.planIds };
  try { localStorage.setItem(LS_HOST, JSON.stringify({ room: R, g: g, saved: now }, function (k, v) { return k === 'G' ? undefined : v; })); } catch (e) {}
}
