/**
 * The trace page: a body fragment (title and style first) with the run's entries embedded at `__TRACE__`.
 *
 * Each actor's run is shown as the states it stopped in, with the calls answered from each stop and the send that
 * moved it on; selecting a call opens the detail pane. Every row carries a relative +time badge, and a
 * "Concurrency" entry in the actor nav shows every actor's calls as lanes plotted by time, for cross-actor
 * concurrency a per-actor journey can't show. Kept free of backticks and `${` so it can live in a raw template.
 *
 * The detail pane is one exchange: the event that went in, the response that came back. Short fields sit in a
 * label column; the three pieces that carry the run break out at full width, each drawn for the role it plays —
 * where the actor is (a status bar that says how it got there: created, moved to, now at, still at, left at), what
 * it was told to do (the only prose the agent acts on, so it is set as prose, its Markdown code spans rendered),
 * and where it can go (a destination, the events that reach it, the contract each carries; a transition back into
 * the state the actor already occupies names no destination and takes its own mark). Everything shown is a field
 * of that call's own entry, bar how the actor arrived, which the journeys already read the same way.
 *
 * Chosen over a flat ledger and per-actor swimlanes, with legibility fixes from a live run — clickable create and
 * offered-next kept live; the pane itself over a diff, a two-column transaction, a question-led accordion, a record
 * and a set of zones, across four rounds.
 */
export const PAGE = String.raw`<title>Trace</title>
<style>
:root {
  --ground: #F5F6F8; --panel: #FFFFFF; --ink: #1C2027; --ink-2: #5B6472; --ink-3: #8A93A1; --line: #DDE1E7; --line-2: #EEF0F3;
  --accent: #0E7C86; --accent-soft: #E1F2F3;
  --reject: #B3261E; --reject-soft: #FBE9E7; --done: #2F6B3A; --done-soft: #E4F2E6;
  --lane-0: #0E7C86; --lane-1: #6B4FBB; --lane-2: #4E7D2A; --lane-3: #B25E1A; --lane-4: #A03A7A; --lane-run: #7A828F;
  --sans: "IBM Plex Sans", "Helvetica Neue", Arial, sans-serif; --mono: "IBM Plex Mono", Menlo, Consolas, monospace;
  color-scheme: light;
}
@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) {
    --ground: #14171C; --panel: #1C2027; --ink: #E7EAEF; --ink-2: #A9B1BD; --ink-3: #737C8A; --line: #2C323B; --line-2: #232830;
    --accent: #4FB8C0; --accent-soft: #163135;
    --reject: #F28B82; --reject-soft: #3A1F1D; --done: #7FCB8C; --done-soft: #1B2F1F;
    --lane-0: #4FB8C0; --lane-1: #A28CEB; --lane-2: #8FC46A; --lane-3: #E5935A; --lane-4: #D97BB4; --lane-run: #8E96A3;
    color-scheme: dark;
  }
}
:root[data-theme="dark"] {
  --ground: #14171C; --panel: #1C2027; --ink: #E7EAEF; --ink-2: #A9B1BD; --ink-3: #737C8A; --line: #2C323B; --line-2: #232830;
  --accent: #4FB8C0; --accent-soft: #163135;
  --reject: #F28B82; --reject-soft: #3A1F1D; --done: #7FCB8C; --done-soft: #1B2F1F;
  --lane-0: #4FB8C0; --lane-1: #A28CEB; --lane-2: #8FC46A; --lane-3: #E5935A; --lane-4: #D97BB4; --lane-run: #8E96A3;
  color-scheme: dark;
}
* { box-sizing: border-box; }
body { margin: 0; background: var(--ground); color: var(--ink); font: 14px/1.5 var(--sans); }
code, pre, .mono { font-family: var(--mono); font-size: 12.5px; }
pre { margin: 0; white-space: pre-wrap; word-break: break-word; }
button { font: inherit; color: inherit; background: none; border: 0; padding: 0; cursor: pointer; }
button:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.page { padding: 28px 32px 48px; max-width: 1480px; margin: 0 auto; }
.head { display: flex; flex-wrap: wrap; align-items: baseline; gap: 10px 28px; margin-bottom: 20px; }
.head h1 { font-size: 20px; font-weight: 600; margin: 0; letter-spacing: -0.01em; }
.head .facts { display: flex; flex-wrap: wrap; gap: 6px 22px; color: var(--ink-2); font-variant-numeric: tabular-nums; }
.head .facts b { color: var(--ink); font-weight: 500; }
.head .facts .root::before { content: ""; display: inline-block; width: 10px; height: 10px; border-radius: 2px; margin-right: 6px; vertical-align: -1px; background: var(--c); }
.head .facts .root.done b { color: var(--done); }
.head .facts .root.error b, .head .facts .root.active b { color: var(--reject); }
.legend { display: flex; flex-wrap: wrap; gap: 8px 16px; margin-bottom: 18px; color: var(--ink-2); font-size: 12.5px; }
.legend span::before { content: ""; display: inline-block; width: 10px; height: 10px; border-radius: 2px; margin-right: 6px; vertical-align: -1px; background: var(--c); }
.chip { display: inline-flex; align-items: center; gap: 6px; padding: 1px 8px; border-radius: 999px; font-size: 12px; font-weight: 500; line-height: 18px; white-space: nowrap; background: color-mix(in srgb, var(--c) 14%, transparent); color: var(--c); }
.chip::before { content: ""; width: 7px; height: 7px; border-radius: 50%; background: var(--c); }
.tag { display: inline-block; padding: 0 6px; border-radius: 4px; font-size: 11.5px; font-weight: 500; line-height: 18px; letter-spacing: 0.01em; }
.tag.rej, .tag.err { background: var(--reject-soft); color: var(--reject); }
.tag.done { background: var(--done-soft); color: var(--done); }
.state { font-family: var(--mono); font-size: 12.5px; }
.state.done { color: var(--done); }
.next { color: var(--ink-2); font-size: 12.5px; }
.next code { color: var(--ink); background: var(--line-2); padding: 0 5px; border-radius: 3px; margin-right: 4px; }
.next .none { color: var(--ink-3); font-style: italic; }
.muted { color: var(--ink-3); }
.jump { color: var(--accent); text-decoration: none; cursor: pointer; }
.jump:hover { text-decoration: underline; }
.t { display: inline-block; color: var(--ink-3); font-variant-numeric: tabular-nums; font-size: 11px; margin-right: 6px; width: 52px; }

/* Detail: one exchange. A sheet of the call's own fields, each drawn for the role it plays: where the actor is,
   what it was told to do, and where it can go next — that last one nested, since it is a destination, the events
   that reach it, and the contract each carries. */
.detail .lbl { font-size: 10.5px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.09em; color: var(--ink-3); }
.detail .kv { display: grid; grid-template-columns: max-content 1fr; gap: 3px 14px; }
.detail .kv dt { color: var(--ink-2); }
.detail .kv dd { margin: 0; }
.detail .instr { white-space: pre-wrap; }
.detail .quiet { color: var(--ink-3); font-size: 12.5px; }
.detail details > summary { cursor: pointer; color: var(--ink-2); font-size: 12.5px; }
.detail details > summary:hover { color: var(--ink); }
.detail pre.block { color: var(--ink-2); margin: 5px 0 0; padding: 8px 10px; border-radius: 5px; background: var(--ground); border: 1px solid var(--line-2); }
/* The machine's prose is Markdown; code spans are the only construct it uses, so they are the only one parsed. */
.detail .md code { background: var(--line-2); padding: 0 4px; border-radius: 3px; font-size: 0.92em; }

/* Where the actor is, and how it came to be there. */
.detail .pos { display: flex; flex-wrap: wrap; align-items: baseline; gap: 6px 12px; padding: 10px 14px; border-radius: 7px; background: var(--accent-soft); }
.detail .pos .id { font: 500 17px/1.3 var(--mono); color: var(--ink); letter-spacing: -0.01em; }
.detail .pos .st { font-size: 12px; font-weight: 500; padding: 0 7px; border-radius: 999px; background: color-mix(in srgb, var(--accent) 18%, transparent); color: var(--accent); }
.detail .pos .from { color: var(--ink-2); font-size: 12.5px; }
.detail .pos .from .was { font-family: var(--mono); }
.detail .pos .about { flex: 1 1 100%; color: var(--ink-2); font-size: 12.5px; }
.detail .pos.done { background: var(--done-soft); }
.detail .pos.done .id { color: var(--done); }
.detail .pos.done .st { background: color-mix(in srgb, var(--done) 20%, transparent); color: var(--done); }
.detail .pos.stuck { background: var(--reject-soft); }
.detail .pos.stuck .id { color: var(--reject); }
.detail .pos.stuck .st { background: color-mix(in srgb, var(--reject) 18%, transparent); color: var(--reject); }

/* What it was told to do: the only prose the agent acts on, so it is set as prose. */
.detail .do { border-left: 3px solid var(--accent); padding-left: 14px; font-size: 13.5px; line-height: 1.62; max-width: 70ch; white-space: pre-wrap; }

/* Where it can go. A transition that keeps the actor where it is takes a different mark and names no destination. */
.detail .tree .dest + .dest { margin-top: 14px; }
.detail .tree .dh { display: flex; flex-wrap: wrap; gap: 2px 8px; align-items: baseline; }
.detail .tree .dh .to { font: 500 13.5px/1.4 var(--mono); }
.detail .tree .dh .to::before { content: "\2192\00a0\00a0"; color: var(--accent); font-weight: 400; }
.detail .tree .dest.stay .dh .to { color: var(--ink-2); font-weight: 400; }
.detail .tree .dest.stay .dh .to::before { content: "\21ba\00a0\00a0"; color: var(--ink-3); }
.detail .tree .when { color: var(--ink-2); font-size: 12.5px; font-style: italic; }
.detail .tree .evs { margin: 6px 0 0 6px; padding-left: 16px; border-left: 1px solid var(--line); }
.detail .tree .dest.stay .evs { border-left-style: dashed; }
.detail .tree .evrow + .evrow { margin-top: 10px; }
.detail .tree .evrow .ev { font-family: var(--mono); font-weight: 500; font-size: 13.5px; }
.detail .tree .none { color: var(--ink-3); font-size: 12.5px; font-style: italic; }

.detail .tbl { width: 100%; border-collapse: collapse; font-size: 12.5px; }
.detail .tbl th { text-align: left; font-weight: 500; color: var(--ink-3); font-size: 10.5px; text-transform: uppercase; letter-spacing: 0.07em; border-bottom: 1px solid var(--line); padding: 0 10px 4px 0; }
.detail .tbl td { padding: 5px 10px 5px 0; border-bottom: 1px solid var(--line-2); vertical-align: top; }
.detail .tbl td.num { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; padding-right: 0; }
.detail .issue { padding: 10px 12px; border-radius: 6px; background: var(--reject-soft); border: 1px solid color-mix(in srgb, var(--reject) 28%, transparent); }
.detail .issue b { color: var(--reject); font-family: var(--mono); font-weight: 500; }
.detail .issue ul { margin: 6px 0 0; padding-left: 18px; }

/* The sheet: short fields in a label column, the roles that carry the run at full width. */
.detail .sheet { border: 1px solid var(--line); border-radius: 8px; overflow: hidden; }
.detail .sheet .grp { padding: 7px 14px 5px; background: var(--ground); border-bottom: 1px solid var(--line); }
.detail .sheet .grp + .row, .detail .sheet .grp + .full { border-top: 0; }
.detail .sheet .row { display: grid; grid-template-columns: 92px minmax(0, 1fr); gap: 14px; padding: 6px 14px; border-top: 1px solid var(--line-2); align-items: baseline; }
.detail .sheet .row > .k { color: var(--ink-3); font-size: 12px; font-family: var(--mono); }
.detail .sheet .row > .v { min-width: 0; font-size: 13px; }
.detail .sheet .row.tall { align-items: start; }
.detail .sheet .full { padding: 12px 14px; border-top: 1px solid var(--line-2); display: flex; flex-direction: column; gap: 8px; }

/* The journeys: actors on the left, the selected actor's stops in the middle, the selected call on the right. */
.journeys { display: grid; grid-template-columns: 220px minmax(0, 1fr) minmax(0, 1.2fr); gap: 16px; align-items: start; }
.jnav { background: var(--panel); border: 1px solid var(--line); border-radius: 8px; padding: 8px; position: sticky; top: 16px; }
.jnav button { display: flex; width: 100%; align-items: center; justify-content: space-between; gap: 8px; padding: 8px 10px; border-radius: 6px; text-align: left; }
.jnav button:hover { background: var(--line-2); }
.jnav button.on { background: var(--accent-soft); }
.jnav .cnt { color: var(--ink-3); font-variant-numeric: tabular-nums; font-size: 12px; }
.jnav .role { display: block; color: var(--ink-3); font-size: 11.5px; word-break: break-all; }
.chain { background: var(--panel); border: 1px solid var(--line); border-radius: 8px; padding: 18px 20px; }
.stop { position: relative; padding-left: 26px; }
.stop::before { content: ""; position: absolute; left: 6px; top: 8px; width: 10px; height: 10px; border-radius: 50%; background: var(--c); }
.stop::after { content: ""; position: absolute; left: 10px; top: 20px; bottom: -12px; width: 2px; background: var(--line); }
.stop:last-child::after { display: none; }
.stop + .stop { margin-top: 12px; }
.stop.done::before { background: var(--done); }
.stop h3 { margin: 0; font: 500 13.5px/1.5 var(--mono); }
.stop h3 small { color: var(--ink-3); font: 12px var(--sans); margin-left: 8px; }
.stop .desc { color: var(--ink-2); font-size: 12.5px; margin: 0 0 6px; }
.stop .offered { margin-bottom: 8px; }
/* The steps that got it here: what fired, not just where it ended up. */
.stop .steps { display: flex; flex-wrap: wrap; align-items: baseline; gap: 6px; margin: 0 0 8px; font-size: 12.5px; color: var(--ink-2); }
.stop .steps .if { color: var(--ink-3); font-size: 11px; letter-spacing: 0.04em; text-transform: uppercase; }
.stop .steps .to { color: var(--ink-3); }
.stop .steps .to.stays { font-style: italic; }
.stop .steps .sep { color: var(--ink-3); }
.chain ul { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 4px; }
.chain li button { display: flex; width: 100%; gap: 10px; align-items: baseline; padding: 5px 8px; border-radius: 5px; text-align: left; }
.chain li button:hover { background: var(--line-2); }
.chain li button.on { background: var(--accent-soft); }
.chain li .n { color: var(--ink-3); font-variant-numeric: tabular-nums; font-size: 12px; width: 26px; flex: none; }
.chain li code { font-weight: 500; }
.chain li .why { color: var(--ink-2); font-size: 12.5px; }
.chain li.rej code, .chain li.err code { color: var(--reject); }
.chain li.move { margin-top: 4px; }
.chain li.move button { background: color-mix(in srgb, var(--c) 8%, transparent); }
.chain li.move .arrow { color: var(--c); font-weight: 500; }
.jdetail { background: var(--panel); border: 1px solid var(--line); border-radius: 8px; padding: 16px 18px 20px; position: sticky; top: 16px; max-height: calc(100vh - 32px); overflow: auto; }
.jdetail .dh { display: flex; gap: 12px; align-items: baseline; margin-bottom: 14px; }
.jdetail .dh h3 { margin: 0; font-size: 14px; font-weight: 600; word-break: break-all; }
.jdetail .empty { color: var(--ink-3); }
@media (max-width: 1100px) { .journeys { grid-template-columns: 1fr; } .jnav, .jdetail { position: static; max-height: none; } }
@media (prefers-reduced-motion: no-preference) { .chain li button, .jnav button { transition: background 120ms; } }

/* Concurrency: one lane per actor, dots plotted by relative time. */
.gantt { background: var(--panel); border: 1px solid var(--line); border-radius: 8px; padding: 20px 22px; }
.gantt .lane { display: flex; align-items: center; gap: 12px; }
.gantt .lane + .lane { margin-top: 14px; }
.gantt .lane .lbl { width: 150px; flex: none; font-size: 12.5px; }
.gantt .lane .track { position: relative; flex: 1; height: 14px; }
.gantt .lane .track::before { content: ""; position: absolute; left: 0; right: 0; top: 50%; height: 3px; background: var(--line-2); border-radius: 2px; transform: translateY(-50%); }
.dot { position: absolute; top: 50%; width: 12px; height: 12px; border-radius: 50%; transform: translate(-50%, -50%); background: var(--c); border: 0; padding: 0; cursor: pointer; }
.dot.rej { background: var(--reject); }
.dot.on { box-shadow: 0 0 0 3px color-mix(in srgb, var(--c) 35%, transparent); }
</style>

<div class="page">
  <div class="head">
    <h1 id="title">Trace</h1>
    <div class="facts" id="facts"></div>
  </div>
  <div class="legend" id="legend"></div>
  <div id="view"></div>
</div>

<script id="trace-data" type="application/json">__TRACE__</script>
<script>
(function () {
  var TRACE = JSON.parse(document.getElementById('trace-data').textContent);
  var BIN = TRACE.bin;

  // ---- model ------------------------------------------------------------------------------------------------
  var esc = function (s) { return String(s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); };
  var fmtMs = function (ms) { return ms >= 1000 ? (ms / 1000).toFixed(1) + ' s' : Math.round(ms) + ' ms'; };
  var fmtBytes = function (n) { return n >= 1024 ? (n / 1024).toFixed(1) + ' KB' : n + ' B'; };
  var json = function (v) { return JSON.stringify(v, null, 2); };
  // A state's data is any value: a plain object reads as key/value pairs, anything else as JSON.
  var dataView = function (v) {
    if (v && typeof v === 'object' && !Array.isArray(v)) return '<dl class="kv">' + Object.keys(v).map(function (k) { return '<dt class="mono">' + esc(k) + '</dt><dd class="mono">' + esc(typeof v[k] === 'string' ? v[k] : json(v[k])) + '</dd>'; }).join('') + '</dl>';
    return '<pre class="mono">' + esc(typeof v === 'string' ? v : json(v)) + '</pre>';
  };
  var isSummary = function (r) { return r && Array.isArray(r.state); };
  var stateOf = function (r) { return r.state.map(function (s) { return s.id; }).join(' + '); };
  var offeredOf = function (r) { var out = []; (r.targets || []).forEach(function (t) { t.events.forEach(function (e) { out.push(e.type); }); }); return out; };
  var codes = function (list) { return list.map(function (t) { return '<code>' + esc(t) + '</code>'; }).join(''); };
  var lastSeg = function (id) { return id.split('/').pop(); };

  var entries = TRACE.entries.slice().sort(function (a, b) { return a.at < b.at ? -1 : a.at > b.at ? 1 : 0; });
  var t0 = entries.length ? Date.parse(entries[0].at) : 0;
  var calls = entries.map(function (e, i) {
    var argv = e.argv, cmd = argv[0] || 'brief', r = e.response;
    var c = { n: i + 1, e: e, at: Date.parse(e.at), ms: e.ms, argv: argv, cmd: cmd, r: r, exit: e.exitCode, actor: e.actorId || null,
      event: cmd === 'send' ? argv[2] : null, payload: null, kind: e.exitCode === 2 ? 'rej' : e.exitCode === 1 ? 'err' : 'ok' };
    // The payload as the runtime received it, whatever its origin: the stdin form leaves a bare '-' in argv.
    if (cmd === 'send' && e.payload !== undefined) c.payload = e.payload;
    c.summary = isSummary(r) ? r : null;
    c.landed = c.summary ? stateOf(r) : null;
    c.rel = c.at - t0;
    return c;
  });

  // Actors in order of first appearance. The root is named by the machine the run created; children by their last segment.
  var actors = {}; var order = []; var machineOf = {};
  calls.forEach(function (c) { if (c.cmd === 'create' && c.summary) machineOf[c.summary.actorId] = c.argv[1]; });
  calls.forEach(function (c) {
    if (!c.actor) return;
    if (!actors[c.actor]) {
      var root = c.actor.indexOf('/') === -1;
      actors[c.actor] = { id: c.actor, root: root, label: root ? (machineOf[c.actor] || c.actor) : lastSeg(c.actor), role: root ? 'lead' : 'worker', calls: [], c: '' };
      order.push(c.actor);
    }
    actors[c.actor].calls.push(c);
  });
  order.forEach(function (id, i) { actors[id].c = 'var(--lane-' + Math.min(i, 4) + ')'; });
  var RUN = { id: '', root: false, label: 'run', role: 'no actor', calls: calls.filter(function (c) { return !c.actor; }), c: 'var(--lane-run)' };
  var actorOf = function (c) { return c.actor ? actors[c.actor] : RUN; };
  var labelOf = function (id) { return actors[id] ? actors[id].label : id; };
  var chip = function (a) { return '<span class="chip" style="--c:' + a.c + '">' + esc(a.label) + '</span>'; };

  // What one call did to one actor: the transitions it took. Not which version — a run pins the code it
  // started with, so every stop in it ran the same code and there is nothing to compare.
  var movedFor = function (c, actorId) {
    var found = null;
    (c.e.moved || []).forEach(function (m) { if (m.actorId === actorId) found = m; });
    return found;
  };
  var stepsFor = function (c, actorId) { var m = movedFor(c, actorId); return (m && m.steps) || []; };
  // One step: the event, the condition that picked it out from its rivals on that event, and where it went. A step
  // with no target ran its actions and left the actor where it was, which is why the state alone cannot show it.
  var stepText = function (s) {
    return '<span class="step"><code>' + esc(s.event) + '</code>' + (s.guard ? ' <span class="if">if</span> <code>' + esc(s.guard) + '</code>' : '') +
      (s.to && s.to.length ? ' <span class="to">&rarr; ' + esc(s.to.join(' + ')) + '</span>' : ' <span class="to stays">stays</span>') + '</span>';
  };

  // The machine's own prose is Markdown. Code spans are the only construct it uses, so they are the only one
  // parsed; anything else stays literal rather than half-rendered. Escaping runs first, so the <childId>
  // placeholders inside a span survive as text. \x60 is the backtick, which cannot appear in this raw template.
  var md = function (s) {
    return '<span class="md">' + esc(s).replace(/\x60([^\x60]+)\x60/g, function (m, code) { return '<code>' + code + '</code>'; }) + '</span>';
  };

  // The previous call on this actor that came back with a Summary: what "still", "moved" and "now at" measure
  // against. The journeys already read the run this way to decide where one stop ends and the next begins.
  (function () {
    var last = {};
    calls.forEach(function (c) {
      c.prevLook = c.actor ? (last[c.actor] || null) : null;
      if (c.summary && c.actor) last[c.actor] = c;
    });
  })();

  // How the actor came to be where the response found it. Only a call that names an actor can move it
  // (ADR-0008), so a look that finds a different
  // state than the last one is reporting this driver's own send, never something that happened behind its back.
  var arrivalOf = function (c) {
    var p = c.prevLook;
    if (c.exit === 2) return { label: 'Left at', stuck: true };
    if (c.cmd === 'create') return { label: 'Created at' };
    if (!p) return { label: 'Where it is' };
    if (p.landed === c.landed) return { label: 'Still at' };
    return { label: c.cmd === 'send' ? 'Moved to' : 'Now at', from: p.landed };
  };

  // Data is whatever the machine chose to expose, so the page cannot know its shape. A list of objects is laid out
  // as a table -- one column per key, a list-valued key counted and its contents behind a toggle -- which keeps a
  // response that hands over a hundred rows readable without knowing anything about the machine that produced it.
  var cell = function (v) {
    if (Array.isArray(v)) return { text: v.length + (v.length === 1 ? ' item' : ' items'), num: true };
    if (v !== null && typeof v === 'object') return { text: json(v) };
    return { text: v === undefined ? '' : String(v) };
  };
  var dataBlock = function (v) {
    var rows = Array.isArray(v) ? v.filter(function (x) { return x !== null && typeof x === 'object' && !Array.isArray(x); }) : [];
    if (!Array.isArray(v) || rows.length !== v.length || !rows.length) {
      return Array.isArray(v) ? '<pre class="block">' + esc(json(v)) + '</pre>' : dataView(v);
    }
    var keys = [];
    rows.forEach(function (r) { Object.keys(r).forEach(function (k) { if (keys.indexOf(k) === -1) keys.push(k); }); });
    var lists = keys.filter(function (k) { return rows.some(function (r) { return Array.isArray(r[k]); }); });
    var first = keys[0];
    var h = '<table class="tbl"><thead><tr>' + keys.map(function (k) {
      return '<th' + (lists.indexOf(k) === -1 ? '' : ' class="num"') + '>' + esc(k) + '</th>';
    }).join('') + '</tr></thead><tbody>' + rows.map(function (r) {
      return '<tr>' + keys.map(function (k) {
        var c2 = cell(r[k]);
        return '<td' + (c2.num ? ' class="num"' : '') + '>' + esc(c2.text.length > 180 ? c2.text.slice(0, 180) + '\u2026' : c2.text) + '</td>';
      }).join('') + '</tr>';
    }).join('') + '</tbody></table>';
    lists.forEach(function (k) {
      var total = 0;
      rows.forEach(function (r) { if (Array.isArray(r[k])) total += r[k].length; });
      if (!total) return;
      h += '<details style="margin-top:8px"><summary>every ' + esc(k) + ', ' + total + ' in all</summary><table class="tbl" style="margin-top:6px"><tbody>';
      rows.forEach(function (r) {
        (r[k] || []).forEach(function (item) {
          var body = item !== null && typeof item === 'object' && !Array.isArray(item)
            ? Object.keys(item).map(function (ik) { return '<div>' + esc(String(item[ik])) + '</div>'; }).join('')
            : '<div>' + esc(json(item)) + '</div>';
          h += '<tr><td class="mono">' + esc(String(r[first])).slice(0, 60) + '</td><td>' + body + '</td></tr>';
        });
      });
      h += '</tbody></table></details>';
    });
    return h;
  };

  // An offered transition whose destination is a state the actor is already in does not move it.
  var isStay = function (r, t) { return r.state.some(function (s) { return s.id === t.id; }); };

  // One event and the contract it takes. A response withholds a contract it has already shown, so an absent schema is not the
  // same as an event that takes no payload: say only
  // that none came back in this response.
  var evRow = function (e) {
    return '<div class="evrow"><span class="ev">' + esc(e.type) + '</span>' +
      (e.description ? ' <span class="when">' + md(e.description) + '</span>' : '') +
      (e.schema ? '<pre class="block">' + esc(e.schema) + '</pre>' : '<div class="quiet">no schema in this response</div>') + '</div>';
  };

  // Where it can go: the destination and, in its own words, the condition for taking it; the events that reach it;
  // the contract each carries. A transition back into the state the actor is already in names no destination.
  var targetTree = function (r) {
    if (!r.targets || !r.targets.length) {
      return '<div class="tree"><span class="none">nothing &mdash; ' +
        (r.status === 'active' ? 'the actor moves when a child finishes' : 'the actor is ' + esc(r.status)) + '</span></div>';
    }
    var s0 = r.state[0] || {};
    return '<div class="tree">' + r.targets.map(function (t) {
      var stay = isStay(r, t);
      return '<div class="dest' + (stay ? ' stay' : '') + '"><div class="dh"><span class="to">' +
        esc(stay ? 'stays in ' + t.id : t.id) + '</span>' +
        (t.description && t.description !== s0.description ? '<span class="when">' + md(t.description) + '</span>' : '') +
        '</div><div class="evs">' + t.events.map(evRow).join('') + '</div></div>';
    }).join('') + '</div>';
  };

  // What a call's line says: the outcome a reader scans for.
  var outcome = function (c) {
    var r = c.r;
    if (c.exit === 1) return '<span class="tag err">error</span> ' + esc(r && r.error || '');
    if (c.exit === 2) return '<span class="tag rej">rejected</span> <span class="mono">' + esc(r.reason) + '</span>';
    if (c.summary) {
      var s = '<span class="state' + (r.status === 'done' ? ' done' : '') + '">' + esc(c.landed) + '</span>';
      if (r.status === 'done') s += ' <span class="tag done">done</span>';
      return s;
    }
    if (c.cmd === 'brief') return '<span class="muted">brief: ' + esc(Object.keys(r.commands || {}).join(', ')) + '</span>';
    if (c.cmd === 'describe' && r.event) return '<span class="mono">' + esc(r.event.type) + '</span> <span class="muted">&rarr; ' + esc(r.event.target.id) + '</span>';
    if (c.cmd === 'output') return '<span class="tag done">output</span> <span class="muted">' + esc(Object.keys(r.output || {}).join(', ')) + '</span>';
    return '<span class="muted">' + esc(json(r).slice(0, 80)) + '</span>';
  };
  var cmdline = function (c) {
    return BIN + ' ' + c.argv.map(function (a, i) { return (c.cmd === 'send' && i === 3) ? "'" + a + "'" : /\s/.test(a) ? '"' + a + '"' : a; }).join(' ');
  };

  // The detail: what was sent, then what came back, structured where the shape is known.
  // The detail: one exchange. Short fields keep a label column; the pieces that carry the run -- where the actor
  // is, what it was told to do, where it can go -- break out at full width, each drawn for the role it plays.
  // Nothing here is derived from another call except how the actor arrived, which the journeys already read.
  var detail = function (c) {
    var r = c.r;
    var row = function (k, v, tall) {
      return '<div class="row' + (tall ? ' tall' : '') + '"><span class="k">' + esc(k) + '</span><span class="v">' + v + '</span></div>';
    };
    var full = function (k, v) { return '<div class="full">' + (k ? '<div class="lbl">' + esc(k) + '</div>' : '') + v + '</div>'; };
    // The drive protocol, on the one call per actor that carries it. Collapsed: it is the same text every time it
    // appears, and what a reader is looking for on that call is which actor was taught, not the rules themselves.
    var protocolBlock = function (rr) {
      if (!rr || !rr.protocol || !rr.protocol.driving) return '';
      return full('how to drive', '<details><summary>the drive protocol, as delivered to this actor’s driver</summary><div class="do">' + md(rr.protocol.driving) + '</div></details>');
    };

    var h = '<div class="sheet"><div class="grp"><span class="lbl">Sent</span></div>';
    h += row('command', '<span class="mono">' + esc(BIN + ' ' + c.cmd) + '</span>');
    if (c.cmd === 'send') h += row('event', '<span class="mono" style="font-weight:500">' + esc(c.event) + '</span>');
    h += row('actor', c.actor ? chip(actorOf(c)) + ' <span class="mono muted">' + esc(c.actor) + '</span>' : '<span class="quiet">none</span>');
    h += row('timing', '<span class="quiet" title="' + esc(c.e.at) + ' (UTC), pid ' + c.e.pid + '">+' + fmtMs(c.rel) + ', took ' + fmtMs(c.ms) + ', exit ' + c.exit + '</span>');
    if (c.payload !== null) {
      var p = json(c.payload);
      h += '<div class="full"><div class="lbl">payload</div>' + (p.length <= 700 ? '<pre class="block">' + esc(p) + '</pre>'
        : '<pre class="block">' + esc(p.slice(0, 700)) + '\u2026</pre><details><summary>the whole payload, ' + fmtBytes(p.length) + '</summary><pre class="block" style="max-height:420px;overflow:auto">' + esc(p) + '</pre></details>') + '</div>';
    }

    h += '<div class="grp"><span class="lbl">Response</span></div>';
    if (c.exit === 2) {
      // One block for every reason: 'refused' is one reason among them now, and 'pending-children' lists each site
      // still waited on with the children pending there.
      h += full('rejected', '<div class="issue"><b>' + esc(r.reason) + '</b>' +
        (r.issues ? '<ul>' + r.issues.map(function (i) { return '<li>' + esc(i.message || json(i)) + (i.path ? ' <span class="mono muted">at ' + esc([].concat(i.path).join('.')) + '</span>' : '') + '</li>'; }).join('') + '</ul>' : '') +
        (r.pending ? '<ul>' + r.pending.map(function (p) { return '<li>' + esc(p.state) + ' (' + esc(p.src) + '): <span class="mono">' + esc(p.children.map(lastSeg).join(', ')) + '</span></li>'; }).join('') + '</ul>' : '') +
        (r.message ? '<div style="margin-top:6px">' + esc(r.message) + '</div>' : '') +
        (r.schema ? '<pre class="block" style="margin-top:8px">' + esc(r.schema) + '</pre>' : '') + '</div>');
    }
    if (c.summary) {
      var s0 = r.state[0] || {}, a = arrivalOf(c);
      h += '<div class="full"><div class="lbl">' + esc(a.label) + '</div><div class="pos' + (r.status === 'done' ? ' done' : a.stuck ? ' stuck' : '') + '">' +
        '<span class="id">' + r.state.map(function (s) { return esc(s.id); }).join(' + ') + '</span><span class="st">' + esc(r.status) + '</span>' +
        (a.from ? '<span class="from">from <span class="was">' + esc(a.from) + '</span></span>' : '') +
        (s0.description ? '<span class="about">' + md(s0.description) + '</span>' : '') + '</div></div>';
      if (s0.instructions) h += full('what to do', '<div class="do">' + md(s0.instructions) + '</div>');
      if (r.transition) h += full('on ' + r.transition.type, '<div class="do">' + md(r.transition.instructions) + '</div>');
      if (r.data !== undefined) h += full('data', dataBlock(r.data));
      if (r.targets !== undefined) h += full('where it can go', targetTree(r));
      if (r.children && r.children.length) {
        h += row('children', r.children.map(function (k) {
          return '<div><span class="mono">' + esc(k.id) + '</span></div>';
        }).join(''), true);
      }
      if (c.e.warnings && c.e.warnings.length) {
        h += row('undeclared', '<div class="quiet">' + c.e.warnings.map(esc).join('<br>') + '<div>a child no spawn site declares; the definition still owes this site</div></div>', true);
      }
      h += protocolBlock(r);
    } else if (c.cmd === 'describe' && r.event) {
      h += full('describes', '<div class="tree"><div class="dest"><div class="dh"><span class="to">' + esc(r.event.target.id) + '</span></div><div class="evs">' + evRow(r.event) + '</div></div></div>');
      h += protocolBlock(r);
    } else if (c.exit === 1) {
      h += full('error', '<div class="issue"><b>' + esc(r.error) + '</b></div>');
    } else if (r && r.output) {
      h += full('output', Object.keys(r.output).map(function (k) {
        var v = typeof r.output[k] === 'string' ? r.output[k] : json(r.output[k]);
        return '<details><summary>' + esc(k) + ' <span class="quiet">' + fmtBytes(v.length) + '</span></summary><pre class="block" style="max-height:380px;overflow:auto">' + esc(v) + '</pre></details>';
      }).join(''));
    } else if (r && r.machines) {
      // No protocol here: it is delivered per actor, on the first response that actor's driver receives, and a driver
      // handed a child never reaches the usage response at all. This branch used to test r.protocol for a string,
      // which ADR-0004 had already made an object, so the page had never displayed the protocol anywhere.
      h += full('the brief', '<div class="quiet">machines ' + esc(r.machines.map(function (m2) { return m2.name; }).join(', ')) +
        ' &middot; commands ' + esc(Object.keys(r.commands || {}).join(', ')) + '</div>');
    }
    var printed = json(r);
    h += row('printed', '<details><summary>the response as printed <span class="quiet">' + fmtBytes(printed.length) +
      '</span></summary><pre class="block" style="max-height:420px;overflow:auto">' + esc(printed) + '</pre></details>', true);
    return '<div class="detail">' + h + '</div></div>';
  };

  // ---- header ------------------------------------------------------------------------------------------------
  // A run may hold more than one root (a pinned directory; a stuck lead and its rescue). The
  // title names the machines; each root gets its own fact with its last word: the status of the last summary it
  // printed. A root still 'active' when the log ends never finished — the page says that, not whether anyone is still
  // driving it, which it cannot know.
  var roots = order.filter(function (id) { return actors[id].root; });
  var last = calls[calls.length - 1];
  var span = calls.length ? (last.at + last.ms) - t0 : 0;
  var rejected = calls.filter(function (c) { return c.exit === 2; }).length;
  var errors = calls.filter(function (c) { return c.exit === 1; }).length;
  var finalOf = function (a) { var st = 'active'; a.calls.forEach(function (c) { if (c.summary) st = c.r.status; }); return st; };
  var machines = []; roots.forEach(function (id) { if (machines.indexOf(actors[id].label) === -1) machines.push(actors[id].label); });
  var name = machines.length ? machines.join(' + ') : BIN;
  document.getElementById('title').textContent = name + ' run';
  document.title = name + ' trace';
  document.getElementById('facts').innerHTML =
    '<span><b>' + calls.length + '</b> calls</span><span><b>' + order.length + '</b> actors</span><span><b>' + fmtMs(span) + '</b> wall</span>' +
    '<span><b>' + rejected + '</b> rejected</span>' + (errors ? '<span><b>' + errors + '</b> ' + (errors === 1 ? 'error' : 'errors') + '</span>' : '') +
    roots.map(function (id) { var st = finalOf(actors[id]); return '<span class="root ' + st + '" style="--c:' + actors[id].c + '"><span class="mono">' + esc(id) + '</span> <b>' + (st === 'active' ? 'not finished' : st) + '</b></span>'; }).join('') +
    (calls.length ? '<span class="muted" title="' + esc(entries[0].at) + ' (UTC)">' + esc(new Date(t0).toLocaleString()) + '</span><span class="muted" title="' + esc(new Date(last.at + last.ms).toISOString()) + ' (UTC)">last call ' + esc(new Date(last.at + last.ms).toLocaleString()) + '</span>' : '');
  document.getElementById('legend').innerHTML = order.map(function (id) { return '<span style="--c:' + actors[id].c + '">' + esc(actors[id].label) + ' <span class="muted mono">' + esc(id) + '</span></span>'; }).join('') +
    '<span style="--c:var(--lane-run)">no actor (brief, usage errors)</span><span style="--c:var(--reject)">rejected</span>';

  // ---- journeys -----------------------------------------------------------------------------------------------
  // An actor's run as the states it stopped in: the calls answered from each stop, then the call that moved it on.
  function stopsOf(a) {
    var stops = []; var cur = null;
    a.calls.forEach(function (c) {
      if (!c.summary) { if (cur) cur.calls.push(c); return; }
      if (!cur) { cur = { state: c.landed, r: c.r, calls: [], moved: null, arrivedBy: c }; stops.push(cur); cur.calls.push(c); return; }
      if (c.exit === 0 && c.landed !== cur.state) { cur.moved = c; cur = { state: c.landed, r: c.r, calls: [], moved: null, arrivedBy: c }; stops.push(cur); }
      else cur.calls.push(c);
    });
    return stops;
  }
  var view = document.getElementById('view');
  var jActor = order.length ? actors[order[0]] : RUN, jCall = null;
  (function initFromHash() {
    var h = location.hash.replace(/^#/, ''); if (!h) return;
    var params = {}; h.split('&').forEach(function (p) { var kv = p.split('='); if (kv[0]) params[kv[0]] = decodeURIComponent(kv[1] || ''); });
    if (params.n) { var c = calls[Number(params.n) - 1]; if (c) { jCall = c; jActor = c.actor ? actors[c.actor] : RUN; } }
    else if (params.a !== undefined) { jActor = params.a === '__concurrency__' ? { id: '__concurrency__' } : (params.a ? actors[params.a] : RUN); }
  })();
  function why(c) {
    if (c.exit === 2) return '<span class="tag rej">rejected</span> ' + esc(c.r.reason);
    if (c.cmd === 'create') return 'created';
    if (c.summary && c.r.children && c.r.children.length) return 'stayed, spawned ' + esc(c.r.children.map(function (k) { return lastSeg(k.id); }).join(', '));
    // It stayed, but a transition still fired: a targetless one acts and leaves the actor where it was.
    if (c.summary && c.actor && stepsFor(c, c.actor).length) return 'stayed, took ' + stepsFor(c, c.actor).map(stepText).join(', ');
    if (c.summary) return 'stayed';
    return outcome(c);
  }
  function laneRow(a) {
    var totalSpan = span || 1;
    var h = '<div class="lane"><span class="lbl">' + chip(a) + '</span><div class="track">';
    a.calls.forEach(function (c) {
      var pct = Math.min(100, Math.max(0, (c.rel / totalSpan) * 100));
      h += '<button class="dot jump' + (c.exit === 2 ? ' rej' : '') + (c === jCall ? ' on' : '') + '" style="--c:' + a.c + '; left:' + pct.toFixed(2) + '%" title="#' + c.n + ' ' + esc(c.cmd === 'send' ? c.cmd + ' ' + c.event : c.cmd) + '  +' + fmtMs(c.rel) + '" data-a="' + esc(a.id) + '" data-n="' + c.n + '"></button>';
    });
    return h + '</div></div>';
  }
  function render() {
    var list = [RUN].concat(order.map(function (id) { return actors[id]; }));
    list.push({ id: '__concurrency__', label: 'Concurrency', role: 'all actors, by time', calls: calls, c: 'var(--ink-3)' });
    var h = '<div class="journeys"><nav class="jnav">';
    list.forEach(function (a) { h += '<button data-a="' + esc(a.id) + '" class="' + (a === jActor || (jActor && a.id === jActor.id) ? 'on' : '') + '"><span><span class="chip" style="--c:' + a.c + '">' + esc(a.label) + '</span><span class="role">' + esc(a.role) + (a.id && a.id !== '__concurrency__' ? ' &middot; ' + esc(a.id) : '') + '</span></span><span class="cnt">' + a.calls.length + '</span></button>'; });
    h += '</nav>';
    if (jActor.id === '__concurrency__') {
      h += '<div class="chain"><div class="gantt">' + list.filter(function (a) { return a.id !== '__concurrency__' && a.calls.length; }).map(laneRow).join('') + '</div></div>';
    } else if (jActor === RUN) {
      h += '<div class="chain" style="--c:' + jActor.c + '">';
      h += RUN.calls.length ? '<ul>' + RUN.calls.map(function (c) { return li(c, c.kind, outcome(c)); }).join('') + '</ul>' : '<span class="muted">No calls without an actor.</span>';
      h += '</div>';
    } else {
      h += '<div class="chain" style="--c:' + jActor.c + '">';
      stopsOf(jActor).forEach(function (st) {
        var s0 = st.r.state[0] || {}, by = st.arrivedBy;
        var arrivalTxt = by.cmd === 'create' ? 'created' : by.cmd === 'send' ? 'after ' + esc(by.event) : 'first seen by ' + esc(by.cmd);
        h += '<div class="stop' + (st.r.status === 'done' ? ' done' : '') + '"><h3>' + esc(st.state) + '<small>' + arrivalTxt + (st.r.status !== 'active' ? ' &middot; ' + esc(st.r.status) : '') +
          '</small></h3>' +
          (s0.description ? '<p class="desc">' + esc(s0.description) + '</p>' : '');
        var took = stepsFor(by, jActor.id);
        if (took.length) h += '<div class="steps">' + took.map(stepText).join('<span class="sep">then</span>') + '</div>';
        var lastR = st.r; st.calls.forEach(function (c) { if (c.summary) lastR = c.r; });
        if (lastR.status === 'active') { var off = offeredOf(lastR); h += '<div class="offered"><span class="next">' + (off.length ? 'offered ' + codes(off) : '<span class="none">offered nothing</span>') + '</span></div>'; }
        h += '<ul>' + st.calls.map(function (c) { return li(c, c.kind, why(c)); }).join('');
        if (st.moved) h += li(st.moved, 'move', '<span class="arrow">&rarr; ' + esc(st.moved.landed) + '</span>');
        h += '</ul></div>';
      });
      h += '</div>';
    }
    h += '<div class="jdetail">' + (jCall ? '<div class="dh"><h3>#' + jCall.n + ' ' + esc(cmdline(jCall).slice(0, 120)) + '</h3></div>' + detail(jCall) : '<span class="empty">Select a call to see what was sent and what came back.</span>') + '</div></div>';
    view.innerHTML = h;
    view.querySelectorAll('.jnav button').forEach(function (b) { b.addEventListener('click', function () { var id = b.getAttribute('data-a'); jActor = id === '__concurrency__' ? { id: '__concurrency__' } : (id ? actors[id] : RUN); jCall = null; syncHash(); render(); }); });
    view.querySelectorAll('.chain > ul > li > button, .chain .stop button').forEach(function (b) { if (!b.classList.contains('jump')) b.addEventListener('click', function () { jCall = calls[b.getAttribute('data-n') - 1]; syncHash(); render(); }); });
    view.querySelectorAll('.jump').forEach(function (b) { b.addEventListener('click', function (ev) { ev.preventDefault(); var a = b.getAttribute('data-a'), n = b.getAttribute('data-n'); jActor = a === '__concurrency__' ? { id: '__concurrency__' } : (a ? actors[a] : RUN); jCall = n ? calls[Number(n) - 1] : null; syncHash(); render(); }); });
  }
  function li(c, cls, text, extra) {
    return '<li class="' + cls + '"><button data-n="' + c.n + '" class="' + (c === jCall ? 'on' : '') + '"><span class="t">+' + fmtMs(c.rel) + '</span><span class="n">' + c.n + '</span><code>' + (c.cmd === 'send' ? esc(c.cmd + ' ' + c.event) : c.cmd === 'brief' ? '(bare)' : esc(c.cmd)) + '</code><span class="why">' + text + '</span></button>' + (extra || '') + '</li>';
  }
  function syncHash() {
    var v = jCall ? 'n=' + jCall.n : 'a=' + encodeURIComponent(jActor.id || '');
    history.replaceState(null, '', location.pathname + location.search + '#' + v);
  }
  render();
})();
</script>`
