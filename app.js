/* ============================================================
   SAJED FANTASY — FPL companion
   Data source: the public (unauthenticated) Fantasy Premier
   League API — https://fantasy.premierleague.com/api/*
   The FPL API sends no CORS header, so a browser calling it
   directly from a different origin (like GitHub Pages) gets
   blocked. We try a direct call first, then fall back through
   a short list of free public CORS relays. No API key, no
   backend, no paid service required.
   ============================================================ */

const FPL_BASE = "https://fantasy.premierleague.com/api";
const WORKER_BASE = "https://fantasy-sajed.sdsr534.workers.dev";

/* ---------------- data source: single Cloudflare Worker ---------------- */

/* Tiny persistent cache so a slow/overloaded relay never leaves the
   page blank: last successful response for each endpoint is kept in
   localStorage and served instantly while we try to refresh it. */
const CACHE_PREFIX = "sajedFantasyCache:";
function cacheGet(path) {
  try {
    const raw = localStorage.getItem(CACHE_PREFIX + path);
    return raw ? JSON.parse(raw) : null;
  } catch (e) {
    return null;
  }
}
function cacheSet(path, data) {
  try {
    localStorage.setItem(CACHE_PREFIX + path, JSON.stringify(data));
  } catch (e) {
    /* storage full or unavailable — non-fatal */
  }
}

async function tryFetch(url, timeoutMs = 6500) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { headers: { Accept: "application/json" }, signal: controller.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return JSON.parse(await res.text());
  } finally {
    clearTimeout(timer);
  }
}

async function fetchJSON(path, onProgress) {
  const url = `${WORKER_BASE}${path}`;
  try {
    onProgress?.(1, 1);
    const data = await tryFetch(url);
    cacheSet(path, data);
    return data;
  } catch (e) {
    // الـ Worker فشل — نرجع لآخر نسخة محفوظة بدل ما تفضل الصفحة فاضية
    const cached = cacheGet(path);
    if (cached) {
      onProgress?.(null, null, true);
      return cached;
    }
    throw e;
  }
}

/* ---------------- global state ---------------- */
const S = {
  bootstrap: null,
  fixtures: null,
  elementsById: new Map(),
  teamsById: new Map(),
  typesById: new Map(),
  currentEvent: null,
  nextEvent: null,
  liveCache: new Map(),
  dreamCache: new Map(),
  playersSort: { key: "total_points", dir: -1 },
  playersShown: 50,
  playersFilters: { q: "", team: "", pos: "", maxPrice: 99 },
  compareIds: [],
  liveSort: { key: "points", dir: -1 },
};

const POS_SHORT = { 1: "GKP", 2: "DEF", 3: "MID", 4: "FWD" };
const money = (v) => `£${(v / 10).toFixed(1)}m`;
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

function setStatus(text, isError = false) {
  const el = document.getElementById("statusline");
  const t = document.getElementById("statusText");
  t.textContent = text;
  el.classList.toggle("err", isError);
  el.querySelector(".spinner")?.remove();
  if (!isError) {
    const sp = document.createElement("span");
    sp.className = "spinner";
    el.prepend(sp);
  }
}
function hideStatus() {
  document.getElementById("statusline").style.display = "none";
}

/* ---------------- boot ---------------- */
async function boot(teamId, attempt = 0) {
  let usedCache = false;
  try {
    setStatus("Loading players, teams and gameweeks…");
    S.bootstrap = await fetchJSON("/bootstrap-static/", (i, n, cache) => {
      if (cache) usedCache = true;
      else setStatus(`Loading players, teams and gameweeks… (trying data route ${i}/${n})`);
    });
    S.bootstrap.elements.forEach((e) => S.elementsById.set(e.id, e));
    S.bootstrap.teams.forEach((t) => S.teamsById.set(t.id, t));
    S.bootstrap.element_types.forEach((t) => S.typesById.set(t.id, t));
    S.currentEvent = S.bootstrap.events.find((e) => e.is_current) || null;
    S.nextEvent = S.bootstrap.events.find((e) => e.is_next) || S.bootstrap.events.find((e) => !e.finished);

    setStatus("Loading fixtures…");
    S.fixtures = await fetchJSON("/fixtures/", (i, n, cache) => {
      if (cache) usedCache = true;
      else setStatus(`Loading fixtures… (trying data route ${i}/${n})`);
    });

    if (usedCache) {
      setStatus("Live data routes are busy right now — showing the last saved snapshot. Pull to refresh in a bit.");
      setTimeout(hideStatus, 5000);
    } else {
      hideStatus();
    }
    renderGwPill();
    startCountdown();
    renderDashboard();
    renderPlayersHead();
    populatePlayerFilters();
    renderPlayers();
    renderTeams();
    setupFixturePicker();
    setupLivePicker();
    setupDreamPicker();
    renderCompare();

    if (teamId) {
      document.getElementById("switchTeamBtn").style.display = "";
      loadMyTeam(teamId);
    } else {
      renderConnectPrompt("homeContent");
      renderConnectPrompt("pointsSummary");
      renderConnectPrompt("transfersSummary");
    }
  } catch (e) {
    console.error(e);

    // Transient hiccups (a flaky mobile connection, a relay that just
    // dropped) are common — retry the whole chain once automatically
    // before bothering the person with an error screen.
    if (attempt < 1) {
      setStatus("Connection hiccup — retrying automatically…");
      setTimeout(() => boot(teamId, attempt + 1), 3000);
      return;
    }

    const el = document.getElementById("statusline");
    el.classList.add("err");
    el.innerHTML =
      `<span>Couldn't reach the FPL data worker right now. This can happen if a browser extension (ad-blocker/privacy blocker) is blocking the worker domain, or if the mobile network is restrictive — try switching between Wi-Fi and mobile data, or disabling content blockers for this site, then retry. Technical detail: ${esc(e.message)}</span>` +
      `<button class="btn-more" id="retryBtn" style="margin-left:auto;flex-shrink:0;">Retry</button>`;
    document.getElementById("retryBtn").addEventListener("click", () => {
      el.classList.remove("err");
      el.style.display = "";
      el.innerHTML = `<span class="spinner"></span><span id="statusText">Retrying…</span>`;
      boot(teamId, 0);
    });
  }
}

function renderGwPill() {
  const dot = document.querySelector("#gwPill");
  const txt = document.getElementById("gwPillText");
  if (S.currentEvent) {
    dot.classList.add("live");
    txt.textContent = `${S.currentEvent.name} in progress`;
  } else if (S.nextEvent) {
    dot.classList.remove("live");
    txt.textContent = `Next: ${S.nextEvent.name}`;
  } else {
    txt.textContent = "Season complete";
  }
}

function startCountdown() {
  const target = S.nextEvent || S.currentEvent;
  const el = document.getElementById("countdown");
  const gwEl = document.getElementById("deadlineGw");
  if (!target) {
    el.textContent = "—";
    return;
  }
  gwEl.textContent = `${target.name} deadline`;
  const deadline = new Date(target.deadline_time).getTime();
  function tick() {
    const diff = deadline - Date.now();
    if (diff <= 0) {
      el.textContent = "Deadline passed";
      clearInterval(timer);
      return;
    }
    const d = Math.floor(diff / 86400000);
    const h = Math.floor((diff % 86400000) / 3600000);
    const m = Math.floor((diff % 3600000) / 60000);
    const s = Math.floor((diff % 60000) / 1000);
    el.textContent = `${d}d ${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  }
  tick();
  const timer = setInterval(tick, 1000);
}

/* ---------------- DASHBOARD ---------------- */
function renderDashboard() {
  const b = S.bootstrap;
  const totalPlayers = b.total_players?.toLocaleString?.() || b.elements.length;
  const refEvent = S.currentEvent || [...b.events].reverse().find((e) => e.finished) || S.nextEvent;

  document.getElementById("heroStats").innerHTML = [
    ["Managers worldwide", totalPlayers],
    ["Avg. GW score", refEvent?.average_entry_score ?? "—"],
    ["Highest GW score", refEvent?.highest_score ?? "—"],
    ["Players tracked", b.elements.length],
    ["Clubs", b.teams.length],
  ]
    .map(([k, v]) => `<div class="stat-box"><div class="v">${v}</div><div class="k">${k}</div></div>`)
    .join("");

  document.getElementById("topScorersGw").textContent = refEvent ? refEvent.name : "—";

  const els = [...b.elements];

  const topScorers = [...els].sort((a, c) => c.event_points - a.event_points).slice(0, 6);
  document.getElementById("topScorersList").innerHTML = topScorers.map((p) => miniRow(p, p.event_points)).join("") || emptyMsg();

  const mostIn = [...els].sort((a, c) => c.transfers_in_event - a.transfers_in_event).slice(0, 6);
  document.getElementById("mostInList").innerHTML = mostIn.map((p) => miniRow(p, `+${p.transfers_in_event.toLocaleString()}`)).join("") || emptyMsg();

  const risers = [...els].filter((p) => p.cost_change_event > 0).sort((a, c) => c.cost_change_event - a.cost_change_event).slice(0, 6);
  document.getElementById("risersList").innerHTML =
    risers.map((p) => miniRow(p, `+£${(p.cost_change_event / 10).toFixed(1)}m`)).join("") || `<div class="mini-row" style="color:var(--ink-faint)">No price changes yet today</div>`;

  const owned = [...els].sort((a, c) => parseFloat(c.selected_by_percent) - parseFloat(a.selected_by_percent)).slice(0, 6);
  document.getElementById("ownedList").innerHTML = owned.map((p) => miniRow(p, `${p.selected_by_percent}%`)).join("") || emptyMsg();
}
function emptyMsg() {
  return `<div class="mini-row" style="color:var(--ink-faint)">No data yet</div>`;
}
function miniRow(p, rightVal) {
  const team = S.teamsById.get(p.team);
  const pos = S.typesById.get(p.element_type)?.singular_name_short || "";
  return `<div class="mini-row">
    <div class="pos-chip pos-${pos}">${pos}</div>
    <div class="nm"><div class="n">${esc(p.web_name)}</div><div class="t">${esc(team?.short_name || "")}</div></div>
    <div class="pts">${rightVal}</div>
  </div>`;
}

/* ---------------- PLAYERS ---------------- */
const PLAYER_COLS = [
  { key: "web_name", label: "Player" },
  { key: "now_cost", label: "Price" },
  { key: "form", label: "Form" },
  { key: "total_points", label: "Pts" },
  { key: "points_per_game", label: "PPG" },
  { key: "selected_by_percent", label: "Own%" },
  { key: "goals_scored", label: "G" },
  { key: "assists", label: "A" },
  { key: "clean_sheets", label: "CS" },
  { key: "bonus", label: "Bonus" },
  { key: "ict_index", label: "ICT" },
  { key: "cmp", label: "" },
];

function renderPlayersHead() {
  const row = document.getElementById("playersHeadRow");
  row.innerHTML = PLAYER_COLS.map((c) => `<th data-key="${c.key}">${c.label}</th>`).join("");
  row.querySelectorAll("th[data-key]").forEach((th) => {
    th.addEventListener("click", () => {
      if (th.dataset.key === "cmp") return;
      if (S.playersSort.key === th.dataset.key) S.playersSort.dir *= -1;
      else {
        S.playersSort.key = th.dataset.key;
        S.playersSort.dir = -1;
      }
      renderPlayers();
    });
  });
}

function populatePlayerFilters() {
  const sel = document.getElementById("filterTeam");
  [...S.bootstrap.teams]
    .sort((a, b) => a.name.localeCompare(b.name))
    .forEach((t) => {
      const o = document.createElement("option");
      o.value = t.id;
      o.textContent = t.name;
      sel.appendChild(o);
    });
  sel.addEventListener("change", () => {
    S.playersFilters.team = sel.value;
    S.playersShown = 50;
    renderPlayers();
  });
  document.getElementById("filterPos").addEventListener("change", (e) => {
    S.playersFilters.pos = e.target.value;
    S.playersShown = 50;
    renderPlayers();
  });
  document.getElementById("playerSearch").addEventListener("input", (e) => {
    S.playersFilters.q = e.target.value.trim().toLowerCase();
    S.playersShown = 50;
    renderPlayers();
  });
  document.querySelectorAll(".filterbar .chipbtn").forEach((btn) => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".filterbar .chipbtn").forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      S.playersFilters.maxPrice = parseFloat(btn.dataset.maxprice);
      S.playersShown = 50;
      renderPlayers();
    });
  });
}

function getFilteredSortedPlayers() {
  const f = S.playersFilters;
  let list = S.bootstrap.elements.filter((p) => {
    if (f.q && !`${p.first_name} ${p.second_name} ${p.web_name}`.toLowerCase().includes(f.q)) return false;
    if (f.team && String(p.team) !== f.team) return false;
    if (f.pos && String(p.element_type) !== f.pos) return false;
    if (p.now_cost / 10 > f.maxPrice) return false;
    return true;
  });
  const { key, dir } = S.playersSort;
  list.sort((a, b) => {
    if (key === "web_name") return dir * String(a.web_name).localeCompare(String(b.web_name));
    const av = parseFloat(a[key]) || 0;
    const bv = parseFloat(b[key]) || 0;
    return dir === -1 ? bv - av : av - bv;
  });
  return list;
}

function renderPlayers() {
  const list = getFilteredSortedPlayers();
  document.getElementById("playerCount").textContent = `${list.length.toLocaleString()} players`;
  document.querySelectorAll("#playersHeadRow th").forEach((th) => th.classList.toggle("sorted", th.dataset.key === S.playersSort.key));

  const shown = list.slice(0, S.playersShown);
  const body = document.getElementById("playersBody");
  body.innerHTML = shown
    .map((p) => {
      const team = S.teamsById.get(p.team);
      const pos = S.typesById.get(p.element_type)?.singular_name_short || "";
      const formNum = parseFloat(p.form) || 0;
      const inCompare = S.compareIds.includes(p.id);
      return `<tr>
      <td><div class="player-cell"><div class="pos-chip pos-${pos}">${pos}</div>
        <div><div class="n">${esc(p.web_name)}</div><div class="t">${esc(team?.short_name || "")}</div></div></div></td>
      <td class="pill-price">${money(p.now_cost)}</td>
      <td class="${formNum >= 5 ? "form-up" : formNum <= 1.5 ? "form-down" : ""}">${p.form}</td>
      <td class="pill-pts">${p.total_points}</td>
      <td>${p.points_per_game}</td>
      <td>${p.selected_by_percent}%</td>
      <td>${p.goals_scored}</td>
      <td>${p.assists}</td>
      <td>${p.clean_sheets}</td>
      <td>${p.bonus}</td>
      <td>${p.ict_index}</td>
      <td><button class="compare-add" data-id="${p.id}" title="Add to compare">${inCompare ? "✓" : "+"}</button></td>
    </tr>`;
    })
    .join("");

  if (list.length > S.playersShown) {
    body.innerHTML += `<tr class="loadmore-row"><td colspan="${PLAYER_COLS.length}"><button class="btn-more" id="loadMoreBtn">Load 50 more (${list.length - S.playersShown} left)</button></td></tr>`;
    document.getElementById("loadMoreBtn").addEventListener("click", () => {
      S.playersShown += 50;
      renderPlayers();
    });
  }

  body.querySelectorAll(".compare-add").forEach((btn) => {
    btn.addEventListener("click", () => {
      const id = parseInt(btn.dataset.id, 10);
      toggleCompare(id);
      renderPlayers();
    });
  });
}

/* ---------------- TEAMS ---------------- */
function renderTeams() {
  const grid = document.getElementById("teamsGrid");
  const maxStrength = Math.max(...S.bootstrap.teams.map((t) => t.strength_attack_home));
  grid.innerHTML = S.bootstrap.teams
    .map((t) => {
      const bars = [
        ["Att H", t.strength_attack_home],
        ["Att A", t.strength_attack_away],
        ["Def H", t.strength_defence_home],
        ["Def A", t.strength_defence_away],
      ];
      return `<div class="team-card">
      <div class="row1"><div class="short">${esc(t.short_name)}</div><div class="mono" style="color:var(--ink-faint);font-size:12px;">OVR ${t.strength}</div></div>
      <h4>${esc(t.name)}</h4>
      <div class="strength-bars">${bars
        .map(([, v]) => `<div class="sbar"><i style="width:${Math.min(100, (v / (maxStrength + 400)) * 100)}%"></i></div>`)
        .join("")}</div>
      <div class="team-stats-mini">${bars.map(([l, v]) => `<span>${l} ${v}</span>`).join("")}</div>
    </div>`;
    })
    .join("");
}

/* ---------------- FIXTURES ---------------- */
function setupFixturePicker() {
  const sel = document.getElementById("fixtureGwPicker");
  sel.innerHTML = S.bootstrap.events.map((e) => `<option value="${e.id}">${esc(e.name)}</option>`).join("");
  const startAt = S.currentEvent?.id || S.nextEvent?.id || 1;
  sel.value = startAt;
  sel.addEventListener("change", () => renderFixtures(parseInt(sel.value, 10)));
  renderFixtures(startAt);
}
function renderFixtures(gwId) {
  const list = S.fixtures.filter((f) => f.event === gwId);
  const wrap = document.getElementById("fixturesList");
  if (!list.length) {
    wrap.innerHTML = `<div style="padding:20px;color:var(--ink-faint);">No fixtures found for this gameweek.</div>`;
    return;
  }
  wrap.innerHTML = list
    .map((f) => {
      const th = S.teamsById.get(f.team_h);
      const ta = S.teamsById.get(f.team_a);
      const played = f.finished;
      const mid = played
        ? `<div class="score">${f.team_h_score} - ${f.team_a_score}</div>`
        : `<div>${new Date(f.kickoff_time).toLocaleString(undefined, { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}</div>`;
      return `<div class="fixture-row">
      <div class="fx-team"><span class="fdr fdr-${f.team_h_difficulty}">${f.team_h_difficulty}</span><span>${esc(th?.name || "?")}</span></div>
      <div class="fx-mid">${mid}</div>
      <div class="fx-team away"><span class="fdr fdr-${f.team_a_difficulty}">${f.team_a_difficulty}</span><span>${esc(ta?.name || "?")}</span></div>
      <div></div>
    </div>`;
    })
    .join("");
}

/* ---------------- GAMEWEEK LIVE ---------------- */
function setupLivePicker() {
  const sel = document.getElementById("liveGwPicker");
  const playable = S.bootstrap.events.filter((e) => e.finished || e.is_current);
  sel.innerHTML = playable.map((e) => `<option value="${e.id}">${esc(e.name)}</option>`).join("");
  const startAt = S.currentEvent?.id || playable[playable.length - 1]?.id || 1;
  sel.value = startAt;
  sel.addEventListener("change", () => loadLive(parseInt(sel.value, 10)));
  document.getElementById("liveSearch").addEventListener("input", () => renderLive());
  document.querySelectorAll("#view-live thead th[data-key]").forEach((th) => {
    th.addEventListener("click", () => {
      if (S.liveSort.key === th.dataset.key) S.liveSort.dir *= -1;
      else {
        S.liveSort.key = th.dataset.key;
        S.liveSort.dir = -1;
      }
      renderLive();
    });
  });
  if (playable.length) loadLive(startAt);
  else document.getElementById("liveBody").innerHTML = `<tr><td colspan="9" style="padding:16px;color:var(--ink-faint);">No completed gameweeks yet this season.</td></tr>`;
}
async function loadLive(gwId) {
  const body = document.getElementById("liveBody");
  body.innerHTML = `<tr><td colspan="9" style="padding:16px;color:var(--ink-faint);">Loading gameweek ${gwId}…</td></tr>`;
  try {
    let data = S.liveCache.get(gwId);
    if (!data) {
      data = await fetchJSON(`/event/${gwId}/live/`);
      S.liveCache.set(gwId, data);
    }
    S.currentLiveGw = gwId;
    renderLive();
  } catch (e) {
    body.innerHTML = `<tr><td colspan="9" style="padding:16px;color:var(--red);">Couldn't load this gameweek right now.</td></tr>`;
  }
}
function renderLive() {
  const data = S.liveCache.get(S.currentLiveGw);
  if (!data) return;
  const q = document.getElementById("liveSearch").value.trim().toLowerCase();
  let rows = data.elements.map((el) => {
    const p = S.elementsById.get(el.id);
    const st = el.stats;
    return { p, st };
  }).filter((r) => r.p);
  if (q) rows = rows.filter((r) => r.p.web_name.toLowerCase().includes(q));

  const keyMap = { minutes: "minutes", goals: "goals_scored", assists: "assists", cs: "clean_sheets", bonus: "bonus", bps: "bps", points: "total_points" };
  const { key, dir } = S.liveSort;
  rows.sort((a, b) => {
    if (key === "name") return dir * a.p.web_name.localeCompare(b.p.web_name);
    if (key === "team") return dir * (a.p.team - b.p.team);
    const ak = keyMap[key] || "total_points";
    return dir === -1 ? b.st[ak] - a.st[ak] : a.st[ak] - b.st[ak];
  });

  document.getElementById("liveBody").innerHTML =
    rows
      .slice(0, 100)
      .map(({ p, st }) => {
        const team = S.teamsById.get(p.team);
        return `<tr>
      <td>${esc(p.web_name)}</td><td>${esc(team?.short_name || "")}</td><td>${st.minutes}</td>
      <td>${st.goals_scored}</td><td>${st.assists}</td><td>${st.clean_sheets}</td>
      <td>${st.bonus}</td><td class="mono">${st.bps}</td><td class="pill-pts">${st.total_points}</td>
    </tr>`;
      })
      .join("") || `<tr><td colspan="9" style="padding:16px;color:var(--ink-faint);">No players match.</td></tr>`;
}

/* ---------------- DREAM TEAM ---------------- */
function setupDreamPicker() {
  const sel = document.getElementById("dreamGwPicker");
  const playable = S.bootstrap.events.filter((e) => e.finished || e.is_current);
  sel.innerHTML = playable.map((e) => `<option value="${e.id}">${esc(e.name)}</option>`).join("");
  const startAt = S.currentEvent?.id || playable[playable.length - 1]?.id;
  if (!startAt) {
    document.getElementById("pitchWrap").innerHTML = `<div style="color:var(--ink-faint);padding:20px;">No completed gameweeks yet.</div>`;
    return;
  }
  sel.value = startAt;
  sel.addEventListener("change", () => loadDreamTeam(parseInt(sel.value, 10)));
  loadDreamTeam(startAt);
}
async function loadDreamTeam(gwId) {
  const wrap = document.getElementById("pitchWrap");
  wrap.innerHTML = `<div style="color:var(--ink-faint);padding:20px;">Loading…</div>`;
  try {
    let data = S.dreamCache.get(gwId);
    if (!data) {
      data = await fetchJSON(`/dream-team/${gwId}/`);
      S.dreamCache.set(gwId, data);
    }
    const byPos = { 1: [], 2: [], 3: [], 4: [] };
    data.team.forEach((slot) => {
      const p = S.elementsById.get(slot.element);
      if (!p) return;
      byPos[p.element_type].push({ p, points: slot.points });
    });
    wrap.innerHTML = [1, 2, 3, 4]
      .map(
        (t) =>
          `<div class="pitch-row">${byPos[t]
            .map(
              ({ p, points }) =>
                `<div class="pitch-card"><div class="n">${esc(p.web_name)}</div><div class="p">${points} pts</div></div>`
            )
            .join("")}</div>`
      )
      .join("");
  } catch (e) {
    wrap.innerHTML = `<div style="color:var(--red);padding:20px;">Couldn't load the dream team for this gameweek right now.</div>`;
  }
}

/* ---------------- COMPARE ---------------- */
function toggleCompare(id) {
  const i = S.compareIds.indexOf(id);
  if (i >= 0) S.compareIds.splice(i, 1);
  else {
    if (S.compareIds.length >= 2) S.compareIds.shift();
    S.compareIds.push(id);
  }
  renderCompare();
}
function renderCompare() {
  const wrap = document.getElementById("compareWrap");
  const slots = [0, 1].map((i) => S.compareIds[i]);
  const cells = slots.map((id, idx) => {
    if (!id) return `<div class="compare-slot empty">Slot ${idx + 1}<br>Add a player from the Players tab</div>`;
    const p = S.elementsById.get(id);
    const team = S.teamsById.get(p.team);
    const pos = S.typesById.get(p.element_type)?.singular_name_short || "";
    const stats = [
      ["Price", money(p.now_cost)],
      ["Total points", p.total_points],
      ["Points / game", p.points_per_game],
      ["Form", p.form],
      ["Ownership", `${p.selected_by_percent}%`],
      ["Minutes", p.minutes],
      ["Goals", p.goals_scored],
      ["Assists", p.assists],
      ["Clean sheets", p.clean_sheets],
      ["Bonus", p.bonus],
      ["ICT index", p.ict_index],
    ];
    return `<div class="compare-slot">
      <div class="compare-head">
        <div><h4>${esc(p.web_name)}</h4><div class="t">${esc(team?.name || "")} · ${pos}</div></div>
        <button class="compare-remove" data-id="${p.id}">✕</button>
      </div>
      <div class="compare-stats">${stats.map(([k, v]) => `<div class="compare-stat"><span>${k}</span><span>${v}</span></div>`).join("")}</div>
    </div>`;
  });
  wrap.innerHTML = `${cells[0]}<div class="compare-vs">VS</div>${cells[1]}`;
  wrap.querySelectorAll(".compare-remove").forEach((btn) =>
    btn.addEventListener("click", () => toggleCompare(parseInt(btn.dataset.id, 10)))
  );
}

/* ---------------- ENTRY GATE ----------------
   FPL has no public "Sign in with Google" and no public OAuth for
   third-party sites — the only real login lives on the official FPL
   site itself. What IS public, with no password at all, is a
   manager's numeric Team ID (visible in their own browser address
   bar). Anyone's squad/history is viewable with just that number, so
   asking for it up front is the actual "log in" screen for this app. */
const TEAM_ID_KEY = "sajedFantasyTeamId";
const CHIP_LABELS = { wildcard: "Wildcard", "3xc": "Triple Captain", bboost: "Bench Boost", freehit: "Free Hit" };

function initGate() {
  const gate = document.getElementById("gate");
  const shell = document.getElementById("appShell");
  const input = document.getElementById("gateInput");
  const btn = document.getElementById("gateBtn");
  const err = document.getElementById("gateErr");
  const skip = document.getElementById("gateSkip");
  const switchBtn = document.getElementById("switchTeamBtn");

  function openApp(id) {
    gate.style.display = "none";
    shell.style.display = "";
    boot(id || null);
  }
  function submit() {
    const id = input.value.trim();
    if (!/^\d{1,9}$/.test(id)) {
      err.style.display = "block";
      return;
    }
    err.style.display = "none";
    localStorage.setItem(TEAM_ID_KEY, id);
    openApp(id);
  }
  btn.addEventListener("click", submit);
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") submit();
  });
  skip.addEventListener("click", () => openApp(null));
  switchBtn.addEventListener("click", () => {
    localStorage.removeItem(TEAM_ID_KEY);
    location.reload();
  });

  const saved = localStorage.getItem(TEAM_ID_KEY);
  if (saved) {
    input.value = saved;
    openApp(saved);
  }
}

/* A small "connect your team" card reused inside Home/Points/Transfers
   whenever no Team ID is set yet (person hit "Skip" on the gate). */
function renderConnectPrompt(containerId) {
  const wrap = document.getElementById(containerId);
  wrap.innerHTML = `
    <div class="card" style="max-width:420px;margin:40px auto;text-align:center;">
      <h3 style="justify-content:center;">Connect your team</h3>
      <p style="color:var(--ink-dim);font-size:13.5px;line-height:1.7;margin:0 0 14px;">Enter your FPL Team ID to see your live squad, points and budget here.</p>
      <div class="filterbar" style="background:transparent;border:none;padding:0;justify-content:center;">
        <input type="text" class="connectIdInput" inputmode="numeric" placeholder="e.g. 1234567" style="max-width:200px;">
        <button class="chipbtn active connectIdBtn">Connect</button>
      </div>
    </div>`;
  const inp = wrap.querySelector(".connectIdInput");
  const go = () => {
    const id = inp.value.trim();
    if (!/^\d{1,9}$/.test(id)) return;
    localStorage.setItem(TEAM_ID_KEY, id);
    document.getElementById("switchTeamBtn").style.display = "";
    loadMyTeam(id);
  };
  wrap.querySelector(".connectIdBtn").addEventListener("click", go);
  inp.addEventListener("keydown", (e) => {
    if (e.key === "Enter") go();
  });
}

function initials(name) {
  const parts = String(name || "SF").trim().split(/\s+/);
  return ((parts[0]?.[0] || "S") + (parts[1]?.[0] || parts[0]?.[1] || "F")).toUpperCase();
}
function fmtDeadline(iso) {
  return new Date(iso).toLocaleString(undefined, { weekday: "long", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
}
function goToTab(view) {
  document.querySelector(`.tab[data-view="${view}"]`)?.click();
}

/* ---------------- HOME ---------------- */
async function loadMyTeam(id) {
  ["homeContent"].forEach((c) => (document.getElementById(c).innerHTML = `<div class="statusline"><span class="spinner"></span><span>Loading team ${esc(id)}…</span></div>`));
  try {
    const [entry, history] = await Promise.all([fetchJSON(`/entry/${id}/`), fetchJSON(`/entry/${id}/history/`)]);
    S.myTeam = { id, entry, history };
    renderHome();
    setupPointsPicker();
    setupTransfersPicker();
  } catch (e) {
    document.getElementById("homeContent").innerHTML = `<div class="statusline err">Couldn't find a team with that ID, or every data route is busy right now. Double-check the number (it's the digits after /entry/ in your FPL URL) and try again. (${esc(e.message)})</div>`;
  }
}

function renderHome() {
  const { id, entry, history } = S.myTeam;
  const refEvent = S.currentEvent || [...S.bootstrap.events].reverse().find((e) => e.finished) || S.nextEvent;
  const gwRecord = (history.current || []).find((g) => g.event === refEvent?.id);
  const userPoints = gwRecord ? gwRecord.points : entry.summary_event_points ?? "—";

  const chipsHtml =
    (history.chips || []).map((c) => `<span class="chip-used">${CHIP_LABELS[c.name] || c.name} · GW${c.event}</span>`).join("") ||
    `<span style="color:var(--ink-faint);font-size:12.5px;">No chips played yet</span>`;

  const classic = entry.leagues?.classic || [];
  const general = classic.filter((l) => l.league_type === "s");
  const mine = classic.filter((l) => l.league_type !== "s");
  const leagueRow = (l) => `<div class="league-row"><span>${esc(l.name)}</span><span class="rank">${(l.entry_rank ?? l.rank ?? "—").toLocaleString?.() ?? l.entry_rank ?? "—"}</span></div>`;
  const leaguesHtml =
    (general.length ? `<div class="league-group-title">General leagues</div>${general.map(leagueRow).join("")}` : "") +
    (mine.length ? `<div class="league-group-title">My leagues</div>${mine.map(leagueRow).join("")}` : "") ||
    `<div style="color:var(--ink-faint);font-size:13px;padding:10px 0;">No leagues joined yet.</div>`;
  const cups = entry.leagues?.cup || entry.leagues?.cup_matches || [];
  const cupsHtml = cups.length
    ? cups.map((c) => `<div class="league-row"><span>${esc(c.name || "Cup")}</span><span class="rank">${esc(c.status?.rank ?? "—")}</span></div>`).join("")
    : `<div style="color:var(--ink-faint);font-size:13px;padding:10px 0;">No cups to show yet.</div>`;

  document.getElementById("homeContent").innerHTML = `
    <div class="team-hero">
      <div class="team-hero-top">
        <div class="badge">${initials(entry.name)}</div>
        <div>
          <div class="tname">${esc(entry.name)}</div>
          <div class="mname">${esc(entry.player_first_name)} ${esc(entry.player_last_name)}</div>
        </div>
      </div>
      <div class="team-hero-stats">
        <div class="item"><div class="v">${refEvent?.average_entry_score ?? "—"}</div><div class="k">Average</div></div>
        <div class="item main"><div class="v">${userPoints}</div><div class="k">${refEvent ? esc(refEvent.name) : "Points"} points</div></div>
        <div class="item"><div class="v">${refEvent?.highest_score ?? "—"}</div><div class="k">Highest</div></div>
      </div>
      ${S.nextEvent ? `<div class="team-hero-deadline">${esc(S.nextEvent.name)} deadline: <b>${fmtDeadline(S.nextEvent.deadline_time)}</b></div>` : ""}
      <div class="team-hero-actions">
        <button class="btn-ghost" id="homePickTeamBtn">👕 Pick Team</button>
        <button class="btn-ghost" id="homeTransfersBtn">⇄ Transfers</button>
      </div>
      <button class="skip" id="homeSwitchTeamBtn" style="margin-top:14px;color:rgba(255,255,255,.6);">Switch team</button>
    </div>

    <div class="section-head"><h2>Leagues &amp; Cups</h2><span class="hint">Team ID ${id} · <span class="chips-row" style="display:inline-flex;">${chipsHtml}</span></span></div>
    <div class="league-tabs">
      <button class="active" data-tab="leagues">Leagues</button>
      <button data-tab="cups">Cups</button>
    </div>
    <div id="leaguesPane">${leaguesHtml}</div>
    <div id="cupsPane" style="display:none;">${cupsHtml}</div>
  `;

  document.getElementById("homePickTeamBtn").addEventListener("click", () => goToTab("points"));
  document.getElementById("homeTransfersBtn").addEventListener("click", () => goToTab("transfers"));
  document.getElementById("homeSwitchTeamBtn").addEventListener("click", () => {
    localStorage.removeItem(TEAM_ID_KEY);
    location.reload();
  });
  document.querySelectorAll(".league-tabs button").forEach((b) => {
    b.addEventListener("click", () => {
      document.querySelectorAll(".league-tabs button").forEach((x) => x.classList.remove("active"));
      b.classList.add("active");
      document.getElementById("leaguesPane").style.display = b.dataset.tab === "leagues" ? "" : "none";
      document.getElementById("cupsPane").style.display = b.dataset.tab === "cups" ? "" : "none";
    });
  });
}

/* ---------------- POINTS (live pitch) ---------------- */
function setupPointsPicker() {
  const sel = document.getElementById("pointsGwPicker");
  const playable = S.bootstrap.events.filter((e) => e.finished || e.is_current);
  if (!playable.length) {
    document.getElementById("pointsPitch").innerHTML = `<div style="color:var(--ink-faint);padding:20px;text-align:center;">No completed gameweeks yet.</div>`;
    return;
  }
  sel.innerHTML = playable.map((e) => `<option value="${e.id}">${esc(e.name)}</option>`).join("");
  const startAt = S.currentEvent?.id || playable[playable.length - 1].id;
  sel.value = startAt;
  sel.onchange = () => loadPoints(parseInt(sel.value, 10));
  loadPoints(startAt);
}
async function loadPoints(gw) {
  const pitch = document.getElementById("pointsPitch");
  const summary = document.getElementById("pointsSummary");
  pitch.innerHTML = `<div style="color:var(--ink-faint);padding:20px;text-align:center;">Loading gameweek ${gw}…</div>`;
  const ev = S.bootstrap.events.find((e) => e.id === gw);
  const gwRecord = (S.myTeam.history.current || []).find((g) => g.event === gw);
  summary.innerHTML = `<div class="summary-bar">
    <div class="item"><div class="v">${ev?.average_entry_score ?? "—"}</div><div class="k">Average</div></div>
    <div class="item hl"><div class="v">${gwRecord?.points ?? "—"}</div><div class="k">Total Pts</div></div>
    <div class="item"><div class="v">${ev?.highest_score ?? "—"}</div><div class="k">Highest</div></div>
  </div>`;
  try {
    const { id } = S.myTeam;
    const [picksData, liveData] = await Promise.all([
      fetchJSON(`/entry/${id}/event/${gw}/picks/`),
      S.liveCache.get(gw) ? Promise.resolve(S.liveCache.get(gw)) : fetchJSON(`/event/${gw}/live/`).then((d) => (S.liveCache.set(gw, d), d)),
    ]);
    const liveById = new Map(liveData.elements.map((e) => [e.id, e.stats]));
    const starters = picksData.picks.filter((p) => p.position <= 11);
    const bench = picksData.picks.filter((p) => p.position > 11);
    const cardFor = (pick) => {
      const p = S.elementsById.get(pick.element);
      if (!p) return "";
      const stats = liveById.get(pick.element);
      const pts = (stats?.total_points ?? 0) * pick.multiplier;
      const badge = pick.is_captain ? `<div class="badge-c">${pick.multiplier >= 3 ? "TC" : "C"}</div>` : pick.is_vice_captain ? `<div class="badge-v">V</div>` : "";
      return `<div class="pitch-card">${badge}<div class="n">${esc(p.web_name)}</div><div class="p">${pts} pts</div></div>`;
    };
    pitch.innerHTML = `
      <div class="gw-squad-row">${starters.map(cardFor).join("")}</div>
      <div class="bench-label">Bench</div>
      <div class="gw-squad-row">${bench.map(cardFor).join("")}</div>
    `;
  } catch (e) {
    pitch.innerHTML = `<div style="color:var(--red);padding:20px;text-align:center;">No public picks for this gameweek yet, or the data route is busy.</div>`;
  }
}

/* ---------------- TRANSFERS (squad & budget) ---------------- */
function setupTransfersPicker() {
  const sel = document.getElementById("transfersGwPicker");
  const upTo = S.nextEvent?.id || S.currentEvent?.id || Math.max(...S.bootstrap.events.map((e) => e.id));
  const options = S.bootstrap.events.filter((e) => e.id <= upTo);
  sel.innerHTML = options.map((e) => `<option value="${e.id}">${esc(e.name)}</option>`).join("");
  sel.value = upTo;
  sel.onchange = () => loadTransfers(parseInt(sel.value, 10));
  loadTransfers(upTo);
}
async function loadTransfers(gw) {
  const pitch = document.getElementById("transfersPitch");
  const summary = document.getElementById("transfersSummary");
  pitch.innerHTML = `<div style="color:var(--ink-faint);padding:20px;text-align:center;">Loading gameweek ${gw}…</div>`;
  summary.innerHTML = "";
  try {
    const { id, history } = S.myTeam;
    const picksData = await fetchJSON(`/entry/${id}/event/${gw}/picks/`);
    const eh = picksData.entry_history || {};
    const usedWildcard = (history.chips || []).filter((c) => c.name === "wildcard");
    const usedFreehit = (history.chips || []).find((c) => c.name === "freehit");
    const wcStatus = usedWildcard.length ? `Used GW${usedWildcard[usedWildcard.length - 1].event}` : "Available";
    const fhStatus = usedFreehit ? `Used GW${usedFreehit.event}` : "Available";

    summary.innerHTML = `<div class="budget-bar">
      <div class="budget-box"><div class="v">${money(eh.value ?? 0)}</div><div class="k">Team value</div></div>
      <div class="budget-box"><div class="v">${money(eh.bank ?? 0)}</div><div class="k">In the bank</div></div>
      <div class="budget-box"><div class="v">${eh.event_transfers ?? 0}</div><div class="k">Transfers this GW</div></div>
      <div class="budget-box"><div class="v">${eh.event_transfers_cost ?? 0}</div><div class="k">Points cost</div></div>
      <div class="budget-box"><div class="v" style="font-size:13px;">${wcStatus}</div><div class="k">Wildcard</div></div>
      <div class="budget-box"><div class="v" style="font-size:13px;">${fhStatus}</div><div class="k">Free Hit</div></div>
    </div>`;

    const cardFor = (pick) => {
      const p = S.elementsById.get(pick.element);
      if (!p) return "";
      const team = S.teamsById.get(p.team);
      const badge = pick.is_captain ? `<div class="badge-c">C</div>` : pick.is_vice_captain ? `<div class="badge-v">V</div>` : "";
      return `<div class="jersey-card">${badge}<div class="jersey">${esc(team?.short_name || "")}</div><div class="n">${esc(p.web_name)}</div><div class="price">${money(p.now_cost)}</div></div>`;
    };
    const byPos = { 1: [], 2: [], 3: [], 4: [] };
    picksData.picks.forEach((pick) => {
      const p = S.elementsById.get(pick.element);
      if (p) byPos[p.element_type].push(pick);
    });
    pitch.innerHTML = [1, 2, 3, 4].map((t) => `<div class="pitch-row">${byPos[t].map(cardFor).join("")}</div>`).join("");
  } catch (e) {
    pitch.innerHTML = `<div style="color:var(--red);padding:20px;text-align:center;">No public squad data for this gameweek yet, or the data route is busy.</div>`;
  }
}

/* ---------------- TAB NAVIGATION ---------------- */
document.getElementById("tabs").addEventListener("click", (e) => {
  const btn = e.target.closest(".tab");
  if (!btn) return;
  document.querySelectorAll(".tab").forEach((t) => t.classList.remove("active"));
  btn.classList.add("active");
  document.querySelectorAll(".view").forEach((v) => v.classList.remove("active"));
  document.getElementById(`view-${btn.dataset.view}`).classList.add("active");
  window.location.hash = btn.dataset.view;
});
window.addEventListener("hashchange", () => {
  const view = window.location.hash.replace("#", "") || "home";
  const btn = document.querySelector(`.tab[data-view="${view}"]`);
  if (btn) btn.click();
});

initGate();
