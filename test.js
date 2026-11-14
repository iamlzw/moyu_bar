'use strict';
// Smoke test: node test.js  (expects a fresh server on PORT, default 8787, started with SING_MS=1500)
const WebSocket = require('ws');
const URL = 'ws://127.0.0.1:' + (process.env.PORT || 8787) + '/ws';
const sleep = ms => new Promise(r => setTimeout(r, ms));
let fails = 0;
const check = (ok, what) => { console.log((ok ? 'PASS ' : 'FAIL ') + what); if (!ok) fails++; };

function client(hello){
  return new Promise((res, rej) => {
    const ws = new WebSocket(URL); ws.msgs = [];
    ws.on('message', d => ws.msgs.push(JSON.parse(d)));
    ws.on('open', () => { if (hello) ws.send(JSON.stringify(hello)); res(ws); });
    ws.on('error', rej);
  });
}
const closed = ws => new Promise(r => { if (ws.readyState === 3) return r(true); ws.on('close', () => r(true)); setTimeout(() => r(false), 3000); });
const got = (ws, f) => ws.msgs.find(f);

(async () => {
  const H = (a, n) => ({ t: 'hello', a, n, c: 1, d: -1, l: 0 });
  const A = await client(H(0, 0)); await sleep(150);
  const B = await client(H(1, 2)); await sleep(150);
  const C = await client(H(2, 3)); await sleep(300);
  const wa = got(A, m => m.t === 'welcome'), wc = got(C, m => m.t === 'welcome');
  check(wa && wa.roster.length === 1, 'A welcome roster size 1');
  check(wc && wc.roster.length === 3 && wc.room === wa.room, 'C welcome roster size 3, same room');
  check(A.msgs.filter(m => m.t === 'join').length === 2, 'A saw 2 joins');

  A.send(JSON.stringify({ t: 'drink', d: 7, l: 5 }));
  A.send(JSON.stringify({ t: 'g', g: 1 }));
  await sleep(300);
  check(got(B, m => m.t === 'upd' && m.id === wa.id && m.d === 7 && m.l === 5), 'B sees A drink update');
  const gb = got(B, m => m.t === 'g' && m.id === wa.id && m.g === 1), gc = got(C, m => m.t === 'g' && m.id === wa.id);
  check(gb && gc && gb.toasts === 1, 'toast gesture broadcast to B and C, room toasts = 1');

  B.send(JSON.stringify({ t: 'round', d: 3 }));
  await sleep(300);
  const ok = [A, B, C].every(w => got(w, m => m.t === 'round' && m.drink === 3 && m.rounds === 1));
  check(ok, 'round broadcast reaches all 3 clients');
  C.send(JSON.stringify({ t: 'round', d: 4 }));
  B.send(JSON.stringify({ t: 'round', d: 4 }));
  await sleep(300);
  const nc = got(C, m => m.t === 'roundno'), nb = got(B, m => m.t === 'roundno');
  check(nc && nc.s > 0 && nc.s <= 60, 'second round in room cooldown refused (C waits ' + (nc && nc.s) + 's)');
  check(nb && nb.s > 60, 'buyer cooldown refused (B waits ' + (nb && nb.s) + 's)');
  check(!got(A, m => m.t === 'round' && m.drink === 4), 'no second round broadcast');

  // seats: bar stools first, move to an empty seat, refuse an occupied one, cooldown
  const wb = got(B, m => m.t === 'welcome');
  check(wa.roster[0].s === 0 && wb.roster.find(p => p.id === wb.id).s === 1 && wc.roster.find(p => p.id === wc.id).s === 2, 'seat assignment 0,1,2 (bar first)');
  A.send(JSON.stringify({ t: 'seat', s: 40 }));
  await sleep(250);
  check([A, B, C].every(w => got(w, m => m.t === 'upd' && m.id === wa.id && m.s === 40)), 'valid seat move broadcast to all');
  B.send(JSON.stringify({ t: 'seat', s: 2 }));
  A.send(JSON.stringify({ t: 'seat', s: 41 }));
  await sleep(250);
  check(got(B, m => m.t === 'seatno' && m.s === 2 && m.why === 0), 'move to occupied seat refused');
  check(got(A, m => m.t === 'seatno' && m.s === 41 && m.why === 1), 'second move inside cooldown refused');

  // dice: server rolls, broadcast with 5 values; a second roll right away is ignored
  C.send(JSON.stringify({ t: 'dice' }));
  await sleep(250);
  const dv = got(A, m => m.t === 'dice' && m.id === wc.id);
  check(dv && dv.v.length === 5 && dv.v.every(x => Number.isInteger(x) && x >= 1 && x <= 6) && got(B, m => m.t === 'dice'), 'dice roll broadcast: ' + (dv && dv.v.join(',')));
  C.send(JSON.stringify({ t: 'dice' }));
  await sleep(250);
  check(A.msgs.filter(m => m.t === 'dice').length === 1, 'second roll inside cooldown ignored');

  // jukebox: change, room cooldown, late joiner sees the mood
  B.send(JSON.stringify({ t: 'song', m: 3 }));
  await sleep(250);
  check([A, B, C].every(w => got(w, m => m.t === 'song' && m.id === wb.id && m.m === 3)), 'song change broadcast');
  C.send(JSON.stringify({ t: 'song', m: 1 }));
  await sleep(250);
  const sn = got(C, m => m.t === 'songno');
  check(sn && sn.s > 80 && sn.s <= 90, 'second song inside 90s refused (' + (sn && sn.s) + 's left)');

  // performance: start, second performer refused, cheers counted, end; late joiner sees performer
  A.send(JSON.stringify({ t: 'sing', m: 2 }));
  await sleep(200);
  check([A, B, C].every(w => got(w, m => m.t === 'sing' && m.id === wa.id && m.m === 2 && m.left > 0)), 'sing start broadcast');
  B.send(JSON.stringify({ t: 'sing', m: 1 }));
  const D = await client(H(5, 5)); await sleep(250);
  check(got(B, m => m.t === 'singno' && m.why === 0), 'second performer refused while one is on stage');
  const wd = got(D, m => m.t === 'welcome');
  check(wd && wd.song === 3 && wd.perf && wd.perf.id === wa.id, 'late joiner welcome has song and performer');
  B.send(JSON.stringify({ t: 'g', g: 0 })); await sleep(100); C.send(JSON.stringify({ t: 'g', g: 1 })); await sleep(100);
  A.send(JSON.stringify({ t: 'g', g: 1 })); // performer's own toast does not count
  await sleep(1600);
  const se = got(B, m => m.t === 'singend' && m.id === wa.id);
  check(se && se.cheers === 2, 'sing end broadcast with cheer count ' + (se && se.cheers));
  A.send(JSON.stringify({ t: 'sing', m: 0 })); await sleep(200);
  check(got(A, m => m.t === 'singno' && m.why === 1), 'performer cooldown refused');
  D.send(JSON.stringify({ t: 'sing', m: 4 })); await sleep(200);
  check(got(B, m => m.t === 'sing' && m.id === wd.id), 'D starts singing');
  D.close(); await sleep(300);
  check(got(B, m => m.t === 'singend' && m.id === wd.id), 'performer disconnect ends the performance');

  // malformed inputs: each should get the socket dropped
  const bad = [
    ['out-of-range gesture', JSON.stringify({ t: 'g', g: 9 })],
    ['free text field', JSON.stringify({ t: 'g', g: 1, text: 'hi' })],
    ['not JSON', 'hello there'],
    ['unknown type', JSON.stringify({ t: 'chat', g: 1 })],
    ['seat out of range', JSON.stringify({ t: 'seat', s: 100 })],
    ['dice with a value', JSON.stringify({ t: 'dice', v: 6 })],
    ['mood out of range', JSON.stringify({ t: 'song', m: 5 })],
  ];
  for (const [what, payload] of bad) {
    const X = await client(H(3, 3)); await sleep(100);
    X.send(payload);
    check(await closed(X), 'dropped on ' + what);
  }
  const Y = await client(null); Y.send(JSON.stringify({ t: 'g', g: 1 }));
  check(await closed(Y), 'dropped when first message is not hello');
  const Z = await client(H(0, 0)); await sleep(100); Z.send(JSON.stringify({ t: 'g', g: 0, pad: 'x'.repeat(400) }));
  check(await closed(Z), 'dropped on oversize message');
  const R = await client(H(0, 0)); await sleep(100);
  for (let i = 0; i < 40; i++) R.send(JSON.stringify({ t: 'g', g: 2 }));
  check(await closed(R), 'dropped on rate limit flood');

  await sleep(200);
  check(got(A, m => m.t === 'leave'), 'A sees leave events');
  [A, B, C].forEach(w => w.close());
  console.log(fails ? fails + ' FAILED' : 'ALL PASSED');
  process.exit(fails ? 1 : 0);
})().catch(e => { console.error(e); process.exit(2); });
