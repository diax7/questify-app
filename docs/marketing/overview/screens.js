/* Builds the phone screens, dashboard mockups, QR art and charts for the overview pages.
   Everything shown is sample content for a fictional event. */

const A = (name) => `assets/${name}.png`;

function qr(size, seed, color = "#3b2410") {
  const n = 25;
  let s = seed;
  const rnd = () => {
    s = (s * 9301 + 49297) % 233280;
    return s / 233280;
  };
  const inFinder = (x, y) =>
    (x < 8 && y < 8) || (x > n - 9 && y < 8) || (x < 8 && y > n - 9);
  let cells = "";
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      if (!inFinder(x, y) && rnd() > 0.52) cells += `M${x} ${y}h1v1h-1z`;
    }
  }
  const finder = (x, y) =>
    `M${x} ${y}h7v7h-7z M${x + 1} ${y + 1}v5h5v-5z M${x + 2} ${y + 2}h3v3h-3z`;
  const f = finder(0, 0) + finder(n - 7, 0) + finder(0, n - 7);
  return `<svg class="qr" width="${size}" height="${size}" viewBox="-1 -1 ${n + 2} ${n + 2}">
    <rect x="-1" y="-1" width="${n + 2}" height="${n + 2}" fill="#fffaf0"/>
    <path d="${cells}" fill="${color}"/><path d="${f}" fill="${color}" fill-rule="evenodd"/></svg>`;
}

const statusBar = () => `
  <div class="status"><span>9:41</span>
    <span class="ind"><span class="bars"><i style="height:4px"></i><i style="height:6px"></i><i style="height:8px"></i><i style="height:10px"></i></span>
    <span class="batt"><i></i></span></span></div>`;

const appBar = (coins = "1,250") => `
  <div class="appbar">${statusBar()}
    <div class="approw"><img class="logo" src="${A("logo-wordmark-en")}" alt="Questify">
      ${coins ? `<span class="coinpill"><img src="${A("icon-coin-star")}" alt="">${coins}</span>` : ""}</div></div>`;

const TABS = [
  ["home", "icon-home", "Home"],
  ["quests", "icon-quest-scroll", "Quests"],
  ["scan", "icon-scan", "Scan"],
  ["rank", "icon-leaderboard", "Ranking"],
  ["prizes", "icon-treasure-chest", "Rewards"],
];
const navBar = (on) => `<div class="navbar">${TABS.map(
  ([k, icon, label]) =>
    `<div class="tab${k === on ? " on" : ""}"><img src="${A(icon)}" alt="">${label}</div>`,
).join("")}</div>`;

const avatar = (animal, frame = "avatar-frame-gold", size) => `
  <div class="ava"${size ? ` style="width:${size}px;height:${size}px"` : ""}>
    <div class="a"><img src="${A("avatar-" + animal)}" alt=""></div>
    <img class="f" src="${A(frame)}" alt=""></div>`;

const pts = (v, cls = "") =>
  `<span class="pts ${cls}"><img src="${A("icon-coin-star")}" alt="">${v}</span>`;

const SCREENS = {
  join: () => `${appBar(null)}
    <div class="content">
      <div class="ribbon">Join an event</div>
      <div class="card joinbox">
        <img src="${A("icon-key")}" alt="">
        <b>Enter the event code</b>
        <span class="muted">It is on the event poster and your ticket.</span>
        <div class="codebox"><span>N</span><span>J</span><span>D</span><span>7</span><span>2</span><span>6</span></div>
        <div class="btn go">Join the event</div>
      </div>
      <div class="ordiv"><i></i>or<i></i></div>
      <div class="card qcard"><img src="${A("icon-scan")}" alt="">
        <div class="tt"><b>Scan the event poster</b><span class="muted">Opens the event straight away</span></div></div>
      <div class="card evprev"><img src="${A("event-festival")}" alt="">
        <div class="tt"><b>Najd Innovation Fest</b><span class="muted">Today · Riyadh · 2,450 players</span></div></div>
    </div>${navBar("home")}`,

  home: () => `${appBar()}
    <div class="content">
      <div class="hero"><img src="${A("ill-quest-stage")}" alt="">
        <div class="t"><span class="gt dark">Najd<br>Innovation<br>Fest</span></div>
        <span class="chip">Day 1 · Riyadh</span></div>
      <div class="card player">${avatar("falcon")}
        <div class="xp"><div class="n"><span>Sara</span><span class="muted" style="font-size:11.5px">Level 7</span></div>
          <div class="bar"><i style="width:68%"></i></div><div class="muted" style="font-size:10px;margin-top:2px">680 / 1,000 XP</div></div>
        <span class="rankchip">#12</span></div>
      <div class="ribbon green">Up next</div>
      <div class="card qcard"><img src="${A("icon-quest-scan")}" alt="">
        <div class="tt"><b>Find the main stage</b><span class="muted">Scan a QR code · ${pts("+50")}</span></div>
        <span class="btn go">GO</span></div>
      <div class="tiles">
        <div class="card tile"><img src="${A("icon-quest-scroll")}" alt="">12 quests</div>
        <div class="card tile"><img src="${A("icon-leaderboard")}" alt="">Ranking</div>
        <div class="card tile"><img src="${A("icon-treasure-chest")}" alt="">Rewards</div>
        <div class="card tile"><img src="${A("icon-map-pin")}" alt="">Map</div>
      </div>
    </div>${navBar("home")}`,

  quests: () => `${appBar()}
    <div class="content">
      <div class="ribbon">Quests</div>
      <div class="chips"><span class="on">All</span><span>Stage</span><span>Sponsors</span><span>Food</span></div>
      <div class="prog"><div style="display:flex;justify-content:space-between"><span>7 of 19 done</span><span class="muted">Day 1</span></div>
        <div class="bar" style="height:8px"><i style="width:37%"></i></div></div>
      <div class="qlist">
        <div class="card qrow flash"><img src="${A("icon-lightning")}" alt="">
          <div class="tt"><b><span class="flashtag">FLASH</span>Stage selfie</b><span>Photo · 09:42 left</span></div>
          <div class="side">${pts("+100")}</div></div>
        <div class="card qrow"><img src="${A("icon-quest-sponsor")}" alt="">
          <div class="tt"><b>Visit 3 sponsor booths</b><span>Scan at each booth · 2 of 3</span>
            <div class="bar mini"><i style="width:66%"></i></div></div>
          <div class="side">${pts("+120")}</div></div>
        <div class="card qrow"><img src="${A("icon-quest-quiz")}" alt="">
          <div class="tt"><b>Saudi coffee quiz</b><span>Quiz · 5 questions</span></div>
          <div class="side">${pts("+80")}</div></div>
        <div class="card qrow"><img src="${A("icon-quest-challenge")}" alt="">
          <div class="tt"><b>Hit the target</b><span>Challenge at booth B4</span></div>
          <div class="side">${pts("+60")}</div></div>
        <div class="card qrow"><img src="${A("icon-speech-bubble")}" alt="">
          <div class="tt"><b>Vote: best start-up pitch</b><span>Vote · closes 16:00</span></div>
          <div class="side">${pts("+30")}</div></div>
        <div class="card qrow done"><img src="${A("icon-quest-scan")}" alt="">
          <div class="tt"><b>Find the main stage</b><span>Scan a QR code · done</span></div>
          <img class="chk" src="${A("icon-check-coin")}" alt=""></div>
      </div>
    </div>${navBar("quests")}`,

  scan: () => `${appBar()}
    <div class="content" style="padding:0">
      <div class="cam"></div>
      <div class="scan-title"><b>Scan the quest code</b><span>Point your camera at the code</span></div>
      <div class="viewfinder"><img class="tgt" src="${A("icon-quest-scan")}" alt="">
        <img class="fr" src="${A("ui-scanner-frame")}" alt=""><div class="line"></div></div>
      <img class="burst" src="${A("pt-coin-angle")}" style="left:40px;bottom:300px;transform:rotate(-20deg)" alt="">
      <img class="burst" src="${A("pt-coin-front")}" style="right:40px;bottom:320px;width:30px" alt="">
      <img class="burst" src="${A("orn-sparkle")}" style="right:80px;bottom:360px;width:22px" alt="">
      <div class="card sheet"><div class="sheetrow"><img class="cel" src="${A("cel-quest-complete")}" alt="">
        <div><span class="gt dark">Quest complete!</span>
        <div class="plus"><img src="${A("icon-coin-star")}" alt="">+50 points</div>
        <div class="muted" style="font-size:12px">Find the main stage</div></div></div>
        <div class="btn go">Continue</div></div>
    </div>${navBar("scan")}`,

  rank: () => {
    const rows = [
      [4, "owl", "Khalid", "1,870"],
      [5, "lantern", "Reem", "1,760"],
      [6, "explorer-hat", "Abdullah", "1,690"],
    ];
    return `${appBar()}
    <div class="content">
      <div class="ribbon">Live ranking</div>
      <div class="seg"><span>Today</span><span class="on">Whole event</span></div>
      <div class="podium">
        <div class="pod">${avatar("fox", "avatar-frame-silver")}<div class="nm">Omar</div>
          <div class="blk" style="height:60px"><span class="n">2</span>${pts("2,140")}</div></div>
        <div class="pod p1"><img class="crown" src="${A("icon-crown")}" alt="">${avatar("camel", "avatar-frame-gold")}<div class="nm">Noura</div>
          <div class="blk" style="height:80px"><span class="n">1</span>${pts("2,310")}</div></div>
        <div class="pod">${avatar("owl", "avatar-frame-bronze")}<div class="nm">Faisal</div>
          <div class="blk" style="height:52px"><span class="n">3</span>${pts("1,980")}</div></div>
      </div>
      <div class="rlist">
        ${rows
          .map(
            ([n, a, nm, p]) =>
              `<div class="card rrow"><span class="no">${n}</span><span class="sa"><img src="${A("avatar-" + a)}" alt=""></span><span class="nm">${nm}</span>${pts(p)}</div>`,
          )
          .join("")}
        <div class="card rrow me"><span class="no">12</span><span class="sa"><img src="${A("avatar-falcon")}" alt=""></span><span class="nm">Sara (you)</span>${pts("1,250")}</div>
      </div>
    </div>${navBar("rank")}`;
  },

  prizes: () => `${appBar("650")}
    <div class="content">
      <div class="ribbon">Rewards</div>
      <div class="card ticket">
        <div class="l"><img src="${A("reward-tote")}" alt="">
          <div><span class="tag">READY</span><b>Festival tote bag</b>
            <span class="muted" style="font-size:11px">Reserved for 600 points. Collect it at the prize desk.</span></div></div>
        <div class="r">${qr(62, 7)}<span class="code">Q7-4K2</span><small>Show at the desk</small></div>
      </div>
      <div class="rgrid">
        <div class="card rtile"><img src="${A("reward-arabic-coffee")}" alt=""><b>Arabic coffee</b>${pts("150")}<div class="btn claim">Reserve</div></div>
        <div class="card rtile"><img src="${A("reward-cap")}" alt=""><b>Event cap</b>${pts("300")}<div class="btn claim">Reserve</div></div>
        <div class="card rtile"><span class="left">3 left</span><img src="${A("reward-tshirt")}" alt=""><b>T-shirt</b>${pts("450")}<div class="btn claim">Reserve</div></div>
        <div class="card rtile"><img src="${A("reward-vip-pass")}" alt=""><b>VIP lounge pass</b>${pts("900")}<div class="btn off">Need 250 more</div></div>
      </div>
    </div>${navBar("prizes")}`,
};

function renderPhones() {
  document.querySelectorAll("[data-screen]").forEach((el) => {
    const key = el.dataset.screen;
    const dark = key === "scan" ? " dark" : "";
    el.innerHTML = `<div class="phone"><div class="screen${dark}"><div class="island"></div>${SCREENS[key]()}</div></div>`;
  });
}

/* ---------- dashboard mockups ---------- */
const chromeBar = (label) =>
  `<div class="chrome"><i></i><i></i><i></i><span class="url">${label}</span></div>`;
const dashHead = () => `<div class="dhead"><img src="${A("logo-wordmark-en")}" alt="Questify"><span class="sep"></span>Dashboard
  <span class="nav"><span>Home</span><span>My account</span></span></div>`;
const side = (on) => {
  const groups = [
    ["Najd Events Co", ["Events", "Event overview"]],
    ["During the event", ["Control room", "Players", "Big screen", "Help desk"]],
    ["Review", ["Analytics", "Submissions"]],
  ];
  return `<div class="dside">${groups
    .map(
      ([h, items]) =>
        `<h6>${h}</h6>${items.map((i) => `<div class="${i === on ? "on" : ""}">${i}</div>`).join("")}`,
    )
    .join("")}</div>`;
};

function sparkline(w, h, data, color) {
  const max = Math.max(...data) * 1.1;
  const step = w / (data.length - 1);
  const pts = data.map((v, i) => [i * step, h - (v / max) * h]);
  const line = pts.map((p, i) => `${i ? "L" : "M"}${p[0].toFixed(1)} ${p[1].toFixed(1)}`).join("");
  return `<svg width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" style="display:block;overflow:visible">
    <path d="${line}L${w} ${h}L0 ${h}Z" fill="${color}" opacity=".16"/>
    <path d="${line}" fill="none" stroke="${color}" stroke-width="2.5" stroke-linejoin="round"/>
    <circle cx="${pts.at(-1)[0]}" cy="${pts.at(-1)[1]}" r="5" fill="${color}" stroke="#fffcf5" stroke-width="2"/></svg>`;
}

function controlRoom() {
  const feed = [
    ["falcon", "<b>Sara</b> finished <b>Find the main stage</b>", "+50", "14:32"],
    ["camel", "<b>Noura</b> finished <b>Saudi coffee quiz</b>", "+80", "14:32"],
    ["fox", "<b>Omar</b> scanned at <b>Sponsor booth B2</b>", "+40", "14:31"],
    ["owl", "<b>Faisal</b> collected <b>Event cap</b> at the desk", "", "14:31"],
    ["lantern", "<b>Reem</b> finished <b>Hit the target</b>", "+60", "14:30"],
  ];
  const scans = [22, 30, 28, 35, 41, 38, 46, 52, 49, 58, 63, 60, 71, 68, 76, 82, 79, 88];
  return `${chromeBar("Questify dashboard · Control room")}
  <div style="height:calc(100% - 30px)">${dashHead()}<div class="dbody">${side("Control room")}
    <div class="dmain">
      <div class="dtitle"><h3>Control room</h3><span class="live">LIVE</span>
        <span class="sub">Najd Innovation Fest · Day 1 · 14:32</span></div>
      <div class="kpis">
        <div class="dcard kpi"><img src="${A("icon-profile")}" alt=""><div><div class="v">1,284</div><div class="l">Players playing now</div></div></div>
        <div class="dcard kpi"><img src="${A("icon-quest-scan")}" alt=""><div><div class="v">3,912</div><div class="l">Scans this hour</div></div></div>
        <div class="dcard kpi"><img src="${A("reward-gift-box")}" alt=""><div><div class="v">214</div><div class="l">Prizes handed out</div></div></div>
        <div class="dcard kpi"><img src="${A("icon-speech-bubble")}" alt=""><div><div class="v">3</div><div class="l">Waiting at help desk</div></div></div>
      </div>
      <div style="display:flex;gap:14px;flex:1;min-height:0">
        <div class="dcard feed" style="flex:1.35"><h4>Live scan feed</h4>
          ${feed
            .map(
              ([a, t, p, tm]) =>
                `<div><span class="sa"><img src="${A("avatar-" + a)}" alt=""></span><span class="t">${t}</span>${p ? pts(p) : ""}<span class="tm">${tm}</span></div>`,
            )
            .join("")}</div>
        <div style="flex:1;display:flex;flex-direction:column;gap:14px">
          <div class="dcard"><h4 style="display:flex;justify-content:space-between">Scans per minute<span style="font-family:var(--display);font-size:20px">88</span></h4>
            ${sparkline(380, 62, scans, "#3f8f36")}</div>
          <div class="dcard" style="flex:1"><h4>Live actions</h4><div class="acts">
            <div class="act"><img src="${A("icon-lightning")}" alt="">Flash quest</div>
            <div class="act"><img src="${A("currency-coin-stack")}" alt="">Double points</div>
            <div class="act"><img src="${A("icon-megaphone")}" alt="">Announcement</div>
            <div class="act"><img src="${A("icon-quest-quiz")}" alt="">Live poll</div></div></div>
        </div>
      </div>
    </div></div></div>`;
}

function analytics() {
  const hours = ["09", "10", "11", "12", "13", "14", "15", "16", "17"];
  const players = [180, 620, 1150, 1420, 1380, 1610, 1840, 1720, 1240];
  const W = 330;
  const H = 150;
  const max = 2000;
  const x = (i) => 40 + (i * (W - 64)) / (hours.length - 1);
  const y = (v) => 10 + (H - 34) * (1 - v / max);
  const line = players.map((v, i) => `${i ? "L" : "M"}${x(i)} ${y(v)}`).join("");
  const grid = [0, 1000, 2000]
    .map(
      (g) =>
        `<line x1="34" x2="${W - 10}" y1="${y(g)}" y2="${y(g)}" stroke="#ead9b9" stroke-width="1"/><text x="28" y="${y(g) + 4}" font-size="11" text-anchor="end" fill="#8a6a44">${g ? g.toLocaleString("en-US") : 0}</text>`,
    )
    .join("");
  const xl = hours
    .map((h, i) => `<text x="${x(i)}" y="${H - 6}" font-size="11" text-anchor="middle" fill="#8a6a44">${h}:00</text>`)
    .join("");
  const playersSvg = `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">${grid}${xl}
    <path d="${line}L${x(8)} ${y(0)}L${x(0)} ${y(0)}Z" fill="#3f8f36" opacity=".14"/>
    <path d="${line}" fill="none" stroke="#3f8f36" stroke-width="2.5" stroke-linejoin="round"/>
    <circle cx="${x(6)}" cy="${y(1840)}" r="5" fill="#3f8f36" stroke="#fffcf5" stroke-width="2"/>
    <text x="${x(6)}" y="${y(1840) - 10}" font-size="12" font-weight="700" text-anchor="middle" fill="#3b2410">1,840 at 15:00</text></svg>`;
  const quests = [
    ["Find the main stage", 2210],
    ["Visit 3 sponsor booths", 1860],
    ["Saudi coffee quiz", 1540],
    ["Hit the target", 1190],
    ["Stage selfie", 870],
  ];
  const bw = 130;
  const bars = quests
    .map(
      ([n, v], i) => `<text x="0" y="${i * 27 + 14}" font-size="12" fill="#3b2410">${n}</text>
      <rect x="146" y="${i * 27 + 3}" width="${(v / 2210) * bw}" height="14" rx="4" fill="#8b5a2b"/>
      <text x="${146 + (v / 2210) * bw + 6}" y="${i * 27 + 14}" font-size="11.5" font-weight="600" fill="#3b2410">${v.toLocaleString("en-US")}</text>`,
    )
    .join("");
  return `${chromeBar("Questify dashboard · Analytics")}
  <div style="height:calc(100% - 30px)">${dashHead()}<div class="dbody">${side("Analytics")}
    <div class="dmain" style="gap:12px;padding:16px 20px">
      <div class="dtitle"><h3>Analytics</h3><span class="sub">Najd Innovation Fest</span>
        <span class="dtabs"><span class="on">Players</span><span>Quests</span><span>Rewards</span><span>Sponsors</span><span>Export</span></span></div>
      <div class="kpis">
        <div class="dcard kpi" style="padding:10px 14px"><div><div class="v">2,450</div><div class="l">Joined</div></div></div>
        <div class="dcard kpi" style="padding:10px 14px"><div><div class="v">87%</div><div class="l">Played a quest</div></div></div>
        <div class="dcard kpi" style="padding:10px 14px"><div><div class="v">18,320</div><div class="l">Quests finished</div></div></div>
        <div class="dcard kpi" style="padding:10px 14px"><div><div class="v">642</div><div class="l">Prizes collected</div></div></div>
      </div>
      <div style="display:flex;gap:12px">
        <div class="dcard" style="flex:1;padding:10px 14px"><h4>Players in the event, by hour</h4>${playersSvg}</div>
        <div class="dcard" style="flex:1;padding:10px 14px"><h4>Most finished quests</h4>
          <svg width="330" height="140" viewBox="0 0 330 140">${bars}</svg></div>
      </div>
    </div></div></div>`;
}

function builder() {
  return `${chromeBar("Questify dashboard · Event builder")}
    <img src="assets/shot-event-builder.jpg" alt="Questify dashboard, event builder" style="width:100%">`;
}

function bigScreen() {
  const rows = [
    [4, "owl", "Khalid", "1,870"],
    [5, "lantern", "Reem", "1,760"],
    [6, "explorer-hat", "Abdullah", "1,690"],
    [7, "fox", "Maha", "1,610"],
    [8, "falcon", "Turki", "1,540"],
    [9, "camel", "Lina", "1,470"],
    [10, "owl", "Yousef", "1,410"],
  ];
  const podium = (a, f, nm, p, rank, size, top) => `
    <div style="position:absolute;left:${top[0]}px;top:${top[1]}px;width:210px;text-align:center">
      ${avatar(a, f, size)}
      <div style="font-family:var(--display);font-weight:800;font-size:${rank === 1 ? 40 : 32}px;color:#fff3d8;margin-top:6px;line-height:1">${nm}</div>
      <div style="display:flex;justify-content:center;align-items:center;gap:8px;font-family:var(--display);font-weight:800;font-size:30px;color:var(--gold)"><img src="${A("icon-coin-star")}" style="width:30px" alt="">${p}</div></div>`;
  return `<div class="big">
    <img src="${A("logo-wordmark-en")}" style="position:absolute;left:44px;top:34px;height:74px" alt="Questify">
    <div style="position:absolute;left:0;right:0;top:30px;text-align:center"><span class="gt" style="font-size:66px">Live ranking</span></div>
    <div style="position:absolute;right:46px;top:46px;text-align:right;font-size:22px;font-weight:600">Najd Innovation Fest<br><span class="live" style="font-size:18px;margin-top:8px">LIVE</span></div>
    <img src="${A("pt-star-burst")}" style="position:absolute;left:175px;top:150px;width:280px;opacity:.35" alt="">
    <img src="${A("icon-crown")}" style="position:absolute;left:278px;top:132px;width:74px;z-index:2" alt="">
    ${podium("camel", "avatar-frame-gold", "Noura", "2,310", 1, 160, [210, 205])}
    ${podium("fox", "avatar-frame-silver", "Omar", "2,140", 2, 124, [0, 300])}
    ${podium("owl", "avatar-frame-bronze", "Faisal", "1,980", 3, 124, [420, 300])}
    <div style="position:absolute;left:670px;right:46px;top:150px;display:flex;flex-direction:column;gap:9px">
      ${rows
        .map(
          ([n, a, nm, p]) => `<div style="display:flex;align-items:center;gap:18px;height:60px;padding:0 22px;border-radius:14px;background:rgba(40,20,6,.62);border:2px solid rgba(227,166,58,.7)">
          <span style="width:40px;font-family:var(--display);font-weight:800;font-size:32px;color:var(--gold)">${n}</span>
          <span style="width:44px;height:44px;border-radius:50%;overflow:hidden;background:#f6e3bb;border:3px solid #e3a63a"><img src="${A("avatar-" + a)}" style="width:100%" alt=""></span>
          <span style="flex:1;font-size:28px;font-weight:600">${nm}</span>
          <span style="display:flex;align-items:center;gap:8px;font-family:var(--display);font-weight:800;font-size:30px;color:#ffe9b0"><img src="${A("icon-coin-star")}" style="width:28px" alt="">${p}</span></div>`,
        )
        .join("")}</div>
    <div style="position:absolute;left:44px;bottom:36px;display:flex;align-items:center;gap:16px;background:rgba(40,20,6,.7);border:2px solid #e3a63a;border-radius:16px;padding:12px 20px 12px 12px">
      ${qr(92, 11)}<div style="font-size:24px;font-weight:600;line-height:1.25">Scan to join<br><span style="font-family:var(--display);font-weight:800;color:var(--gold);font-size:30px;letter-spacing:2px">NJD726</span></div></div>
  </div>`;
}

/* ---------- illustrative charts (page 5) ---------- */
function funnelChart() {
  const steps = [
    ["Joined the event", 2400],
    ["Finished a first quest", 2050],
    ["Finished 5 or more quests", 1370],
    ["Collected a prize", 910],
  ];
  const W = 470;
  const labelW = 0;
  const barMax = 360;
  let out = "";
  steps.forEach(([label, v], i) => {
    const yy = i * 52;
    const w = (v / 2400) * barMax;
    const pct = Math.round((v / 2400) * 100);
    out += `<text x="${labelW}" y="${yy + 14}" font-size="13" font-weight="600" fill="#3b2410">${label}</text>
      <rect x="${labelW}" y="${yy + 22}" width="${barMax}" height="20" rx="4" fill="#efe2c6"/>
      <rect x="${labelW}" y="${yy + 22}" width="${w}" height="20" rx="4" fill="#3f8f36"/>
      <text x="${barMax + 12}" y="${yy + 37}" font-size="14" font-weight="700" fill="#3b2410">${v.toLocaleString("en-US")}</text>
      <text x="${W}" y="${yy + 37}" font-size="13" text-anchor="end" fill="#6b4a2c">${pct}%</text>`;
  });
  return `<svg width="${W}" height="210" viewBox="0 0 ${W} 210" role="img" aria-label="Illustrative engagement funnel">${out}</svg>`;
}

function boothChart() {
  const booths = [
    ["Telecom", 1420],
    ["Bank", 1180],
    ["Coffee", 960],
    ["Airline", 870],
    ["Start-ups", 640],
    ["Books", 510],
  ];
  const W = 470;
  const H = 210;
  const base = H - 26;
  const top = 22;
  const max = 1500;
  const slot = W / booths.length;
  const bw = 40;
  let out = `<line x1="0" x2="${W}" y1="${base}" y2="${base}" stroke="#b89a6e" stroke-width="1.5"/>`;
  booths.forEach(([n, v], i) => {
    const h = ((base - top) * v) / max;
    const cx = slot * i + slot / 2;
    out += `<path d="M${cx - bw / 2} ${base}V${base - h + 4}q0 -4 4 -4h${bw - 8}q4 0 4 4V${base}Z" fill="#8b5a2b"/>
      <text x="${cx}" y="${base - h - 7}" font-size="13" font-weight="700" text-anchor="middle" fill="#3b2410">${v.toLocaleString("en-US")}</text>
      <text x="${cx}" y="${base + 18}" font-size="12.5" text-anchor="middle" fill="#6b4a2c">${n}</text>`;
  });
  return `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="Illustrative sponsor booth visits">${out}</svg>`;
}


function fill(id, html) {
  const el = document.getElementById(id);
  if (!el) throw new Error(`overview: missing slot #${id}`);
  el.innerHTML = html;
}

renderPhones();
fill("cr", controlRoom());
fill("an", analytics());
fill("eb", builder());
fill("bs", bigScreen());
fill("funnel", funnelChart());
fill("booths", boothChart());
Promise.all([...document.fonts].map((face) => face.load())).then(() => {
  document.body.dataset.ready = "1";
});
