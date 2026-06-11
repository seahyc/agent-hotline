/**
 * Embedded single-page web UI served at GET /.
 * No build step, no dependencies — vanilla JS polling the local REST API.
 * Humans browse rooms/DMs/activity and send messages as the "human" identity.
 */
export const UI_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Agent Hotline</title>
<style>
  :root {
    --bg: #0f1117; --panel: #171a23; --border: #262b38; --text: #d7dce6;
    --dim: #7d8597; --accent: #5dd3a4; --accent2: #6aa6ff; --me: #2a3142;
  }
  * { box-sizing: border-box; margin: 0; }
  body { background: var(--bg); color: var(--text); font: 14px/1.45 ui-monospace, "SF Mono", Menlo, monospace; height: 100vh; display: flex; flex-direction: column; }
  header { padding: 10px 16px; border-bottom: 1px solid var(--border); display: flex; align-items: baseline; gap: 12px; }
  header h1 { font-size: 15px; color: var(--accent); }
  header .meta { color: var(--dim); font-size: 12px; }
  main { flex: 1; display: flex; min-height: 0; }
  nav { width: 230px; border-right: 1px solid var(--border); overflow-y: auto; padding: 10px 0; flex-shrink: 0; }
  nav h2 { font-size: 11px; text-transform: uppercase; letter-spacing: .08em; color: var(--dim); padding: 8px 14px 4px; }
  nav .item { padding: 6px 14px; cursor: pointer; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  nav .item:hover { background: var(--panel); }
  nav .item.active { background: var(--me); color: #fff; }
  nav .item .sub { color: var(--dim); font-size: 11px; display: block; }
  .dot { display: inline-block; width: 7px; height: 7px; border-radius: 50%; background: var(--accent); margin-right: 6px; }
  .dot.off { background: #444b5c; }
  section { flex: 1; display: flex; flex-direction: column; min-width: 0; }
  #timeline { flex: 1; overflow-y: auto; padding: 14px 18px; }
  .msg { margin-bottom: 12px; max-width: 860px; }
  .msg .head { color: var(--dim); font-size: 11px; margin-bottom: 2px; }
  .msg .head .from { color: var(--accent2); font-weight: 600; }
  .msg .head .room-tag { color: var(--accent); }
  .msg .body { white-space: pre-wrap; word-break: break-word; background: var(--panel); border: 1px solid var(--border); border-radius: 6px; padding: 8px 10px; }
  .msg.mine .body { background: var(--me); }
  form { display: flex; gap: 8px; padding: 12px 16px; border-top: 1px solid var(--border); }
  textarea { flex: 1; background: var(--panel); border: 1px solid var(--border); border-radius: 6px; color: var(--text); padding: 8px 10px; font: inherit; resize: none; height: 60px; }
  button { background: var(--accent); border: 0; border-radius: 6px; color: #0c0f14; font: inherit; font-weight: 700; padding: 0 18px; cursor: pointer; }
  button:disabled { opacity: .4; cursor: default; }
  .empty { color: var(--dim); padding: 30px; text-align: center; }
</style>
</head>
<body>
<header>
  <h1>&#128222; Agent Hotline</h1>
  <span class="meta" id="server-meta">connecting&hellip;</span>
</header>
<main>
  <nav>
    <h2>Views</h2>
    <div class="item" data-view="all">All activity</div>
    <h2>Rooms</h2>
    <div id="rooms"></div>
    <h2>Agents</h2>
    <div id="agents"></div>
  </nav>
  <section>
    <div id="timeline"><div class="empty">Loading&hellip;</div></div>
    <form id="composer">
      <textarea id="input" placeholder="Message as human&hellip; (Enter to send, Shift+Enter for newline)"></textarea>
      <button id="send" type="submit">Send</button>
    </form>
  </section>
</main>
<script>
const $ = (s) => document.querySelector(s);
let view = { type: "all" };           // {type:"all"} | {type:"room",name} | {type:"dm",id,name}
let names = {};                        // session_id -> display name
let timer = null;

const disp = (id) => names[id] || (id.length > 12 ? id.slice(0, 8) : id);
const esc = (s) => s.replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const fmtTime = (t) => new Date(t).toLocaleTimeString();

async function api(path, opts) {
  const res = await fetch(path, opts);
  if (!res.ok) throw new Error(path + " -> " + res.status);
  return res.json();
}

async function heartbeatHuman() {
  try { await api("/api/heartbeat", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ session_id: "human", title: "human" }) }); } catch {}
}

async function refreshRoster() {
  try {
    const status = await api("/api/status");
    $("#server-meta").textContent = "v" + status.server.version + " \\u00b7 mesh " + (status.server.mesh ? "on (" + status.server.peers + " peers)" : "off");
    const agents = await api("/api/agents");
    names = {};
    for (const a of agents) if (a.name) names[a.session_id] = a.name;
    const online = agents.filter(a => a.online && a.session_id !== "human");
    const offline = agents.filter(a => !a.online && a.session_id !== "human").slice(0, 10);
    $("#agents").innerHTML = online.concat(offline).map(a => {
      const loc = [a.machine, a.branch, (a.cwd || "").split("/").pop()].filter(Boolean).join(" \\u00b7 ");
      const active = view.type === "dm" && view.id === a.session_id ? " active" : "";
      return '<div class="item' + active + '" data-dm="' + a.session_id + '"><span class="dot' + (a.online ? "" : " off") + '"></span>' + esc(disp(a.session_id)) + '<span class="sub">' + esc(loc) + '</span></div>';
    }).join("") || '<div class="item"><span class="sub">no agents</span></div>';
    const rooms = await api("/api/rooms?all=true");
    $("#rooms").innerHTML = rooms.map(r => {
      const active = view.type === "room" && view.name === r.name ? " active" : "";
      return '<div class="item' + active + '" data-room="' + esc(r.name) + '">#' + esc(r.name) + ' <span class="sub">' + r.memberCount + ' member(s)</span></div>';
    }).join("") || '<div class="item"><span class="sub">no rooms</span></div>';
    document.querySelector('[data-view="all"]').className = "item" + (view.type === "all" ? " active" : "");
  } catch (e) {
    $("#server-meta").textContent = "server unreachable";
  }
}

function renderMessages(items) {
  const el = $("#timeline");
  const stick = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
  if (!items.length) { el.innerHTML = '<div class="empty">No messages yet</div>'; return; }
  el.innerHTML = items.map(m => {
    const mine = m.from === "human";
    const target = m.room ? ' <span class="room-tag">#' + esc(m.room) + "</span>" : (m.to ? " \\u2192 " + esc(disp(m.to)) : "");
    return '<div class="msg' + (mine ? " mine" : "") + '"><div class="head"><span class="from">' + esc(disp(m.from)) + "</span>" + target + " \\u00b7 " + fmtTime(m.time) + '</div><div class="body">' + esc(m.content) + "</div></div>";
  }).join("");
  if (stick) el.scrollTop = el.scrollHeight;
}

async function refreshTimeline() {
  try {
    let items = [];
    if (view.type === "all") {
      const rows = await api("/api/activity?limit=150");
      for (const r of rows) {
        if (r.from_name) names[r.from] = r.from_name;
        if (r.to && r.to_name) names[r.to] = r.to_name;
      }
      items = rows.map(r => ({ from: r.from, to: r.to, room: r.room, content: r.content, time: r.time }));
    } else if (view.type === "room") {
      const rows = await api("/api/messages?room=" + encodeURIComponent(view.name) + "&limit=150");
      items = rows.map(r => ({ from: r.from, room: view.name, content: r.content, time: r.time }));
    } else {
      const rows = await api("/api/messages?dm=" + encodeURIComponent(view.id) + "&session_id=human&limit=150");
      items = rows.map(r => ({ from: r.from, to: r.from === "human" ? view.id : "human", content: r.content, time: r.time }));
    }
    items.sort((a, b) => new Date(a.time) - new Date(b.time));
    renderMessages(items);
  } catch (e) { /* keep last view */ }
}

function setView(v) {
  view = v;
  $("#input").placeholder = v.type === "room" ? "Message #" + v.name + " as human\\u2026"
    : v.type === "dm" ? "Message " + disp(v.id) + " as human\\u2026"
    : "Pick a room or agent to send, or broadcast with *\\u2026";
  refreshTimeline();
  refreshRoster();
}

document.body.addEventListener("click", (e) => {
  const room = e.target.closest("[data-room]");
  const dm = e.target.closest("[data-dm]");
  const all = e.target.closest('[data-view="all"]');
  if (room) setView({ type: "room", name: room.dataset.room });
  else if (dm) setView({ type: "dm", id: dm.dataset.dm });
  else if (all) setView({ type: "all" });
});

$("#composer").addEventListener("submit", async (e) => {
  e.preventDefault();
  const content = $("#input").value.trim();
  if (!content) return;
  const to = view.type === "room" ? "#" + view.name : view.type === "dm" ? view.id : "*";
  $("#send").disabled = true;
  try {
    await api("/api/message", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ from: "human", to, content }) });
    $("#input").value = "";
    await refreshTimeline();
  } catch (err) {
    alert("Send failed: " + err.message);
  } finally {
    $("#send").disabled = false;
  }
});

$("#input").addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    $("#composer").requestSubmit();
  }
});

heartbeatHuman();
refreshRoster();
refreshTimeline();
timer = setInterval(() => { refreshTimeline(); refreshRoster(); }, 3000);
setInterval(heartbeatHuman, 30000);
</script>
</body>
</html>`;
