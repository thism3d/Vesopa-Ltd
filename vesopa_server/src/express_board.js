/**
 * The collection board: "Preparing" and "Ready", in numbers big enough to read
 * from the back of the queue.
 *
 * A self-contained page -- its style and its script are inline -- because it
 * runs on whatever the venue has: a smart TV's browser, a cheap stick behind
 * a screen, a laptop propped on a shelf. It asks the server for numbers every
 * four seconds and draws them. That is all it does, and all it can see.
 *
 * Built by string concatenation rather than one template literal on purpose:
 * see the dine-in page, where a backtick in a comment or a backslash in a
 * regex inside the literal broke the served page five times with nothing in
 * the repository noticing.
 */

function escapeHtml(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const STYLE = [
  ':root{--lime:#A5C715;--ink:#10130A;--night:#0B0D08;--panel:#15180F;--line:#262A1C;--soft:#EFF6D8;--mute:#8C9478}',
  '*{box-sizing:border-box;margin:0;padding:0}',
  'html,body{height:100%;background:var(--night);color:var(--soft);font-family:"Segoe UI",Montserrat,system-ui,sans-serif;overflow:hidden}',
  '.bar{display:flex;align-items:center;justify-content:space-between;padding:2.2vh 3vw;border-bottom:1px solid var(--line)}',
  '.venue{font-weight:700;font-size:3.2vh;letter-spacing:.02em}',
  '.brand{display:flex;align-items:center;gap:1vw;color:var(--mute);font-size:2vh;letter-spacing:.2em;text-transform:uppercase}',
  '.brand svg{height:3vh;width:auto}',
  '.cols{display:grid;grid-template-columns:1fr 1fr;height:calc(100% - 9vh)}',
  '@media (orientation:portrait){.cols{grid-template-columns:1fr;grid-template-rows:1fr 1fr}}',
  '.col{padding:3vh 3vw;display:flex;flex-direction:column;min-height:0}',
  '.col+.col{border-left:1px solid var(--line)}',
  '@media (orientation:portrait){.col+.col{border-left:0;border-top:1px solid var(--line)}}',
  '.col h2{font-size:3.4vh;font-weight:700;letter-spacing:.14em;text-transform:uppercase;display:flex;align-items:center;gap:1vw;margin-bottom:2.4vh}',
  '.dot{width:1.6vh;height:1.6vh;border-radius:50%;background:var(--mute)}',
  '.ready h2{color:var(--lime)} .ready .dot{background:var(--lime);box-shadow:0 0 2vh var(--lime)}',
  '.nums{display:flex;flex-wrap:wrap;align-content:flex-start;gap:2vh 2vw;overflow:hidden}',
  '.n{font-variant-numeric:tabular-nums;font-weight:800;font-size:9vh;line-height:1;min-width:2.6ch;padding:1.6vh 1.4vw;border-radius:1.6vh;background:var(--panel);text-align:center;border:1px solid var(--line)}',
  '.ready .n{background:var(--lime);color:var(--ink);border-color:var(--lime);animation:pop .5s ease-out}',
  '.ready .n.fresh{animation:pop .5s ease-out,glow 2s ease-in-out 3}',
  '@keyframes pop{from{transform:scale(.6);opacity:0}to{transform:scale(1);opacity:1}}',
  '@keyframes glow{50%{box-shadow:0 0 5vh var(--lime)}}',
  '.empty{color:var(--mute);font-size:2.6vh}',
  '.off{position:fixed;left:0;right:0;bottom:0;padding:1vh 3vw;background:#3a1a12;color:#ffb4a3;font-size:2vh;display:none}',
  '.missing{display:flex;height:100%;align-items:center;justify-content:center;flex-direction:column;gap:2vh;text-align:center;padding:4vw}',
  '.missing h1{font-size:4vh}',
  '.missing p{color:var(--mute);font-size:2.4vh;max-width:60ch}',
].join('\n');

const MARK =
  '<svg viewBox="0 0 46.35 33.09" aria-hidden="true"><polygon points="9.95 0 0 0 18.01 33.09 27.96 33.09 9.95 0" fill="#A5C715"/>' +
  '<polygon points="27.4 16.54 37.35 16.54 46.35 0 36.4 0 27.4 16.54" fill="#A5C715"/>' +
  '<polygon points="27.4 16.54 18.39 33.09 28.34 33.09 37.35 16.54 27.4 16.54" fill="#EFF6D8"/></svg>';

/*
 * The page's own script. Plain ES5 and no regular expressions, for the oldest
 * TV browser a venue might own -- and so nothing in it can be mangled by an
 * escape on the way through.
 */
const SCRIPT = [
  '(function(){',
  '  var token = document.body.getAttribute("data-token");',
  '  var shown = {};',
  '  var failures = 0;',
  '  function draw(id, list, ready){',
  '    var box = document.getElementById(id);',
  '    if (!list.length){ box.innerHTML = "<p class=\\"empty\\">" + (ready ? "Nothing ready just now" : "No orders being prepared") + "</p>"; return; }',
  '    var html = "";',
  '    for (var i = 0; i < list.length; i++){',
  '      var n = String(list[i]);',
  '      var fresh = ready && !shown[n];',
  '      html += "<div class=\\"n" + (fresh ? " fresh" : "") + "\\">" + n + "</div>";',
  '      if (ready) shown[n] = true;',
  '    }',
  '    box.innerHTML = html;',
  '  }',
  '  function tick(){',
  '    var xhr = new XMLHttpRequest();',
  '    xhr.open("GET", "/express/board/" + token + "/data", true);',
  '    xhr.onload = function(){',
  '      if (xhr.status !== 200){ fail(); return; }',
  '      try { var d = JSON.parse(xhr.responseText); } catch (e) { fail(); return; }',
  '      failures = 0; document.getElementById("off").style.display = "none";',
  '      draw("preparing", d.preparing || [], false);',
  '      draw("ready", d.ready || [], true);',
  '    };',
  '    xhr.onerror = fail;',
  '    xhr.send();',
  '  }',
  '  function fail(){ failures++; if (failures > 2) document.getElementById("off").style.display = "block"; }',
  '  tick(); setInterval(tick, 4000);',
  '})();',
].join('\n');

function boardPage({ venueName, token, missing } = {}) {
  const head =
    '<!doctype html><html lang="en"><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width,initial-scale=1">' +
    '<meta name="robots" content="noindex">' +
    '<title>' + escapeHtml(venueName ? venueName + ' - Orders' : 'Vesopa Express') + '</title>' +
    '<style>' + STYLE + '</style></head>';

  if (missing) {
    return head +
      '<body><div class="missing"><div class="brand">' + MARK + ' Vesopa Express</div>' +
      '<h1>This board is not available</h1>' +
      '<p>The address may have been changed in the back office, or the collection board has been switched off. ' +
      'The current address is under Vesopa Express in the back office.</p></div></body></html>';
  }

  return head +
    '<body data-token="' + escapeHtml(token) + '">' +
    '<div class="bar"><div class="venue">' + escapeHtml(venueName || 'Your order') + '</div>' +
    '<div class="brand">' + MARK + ' Vesopa Express</div></div>' +
    '<div class="cols">' +
    '<section class="col"><h2><span class="dot"></span>Preparing</h2><div class="nums" id="preparing"></div></section>' +
    '<section class="col ready"><h2><span class="dot"></span>Ready to collect</h2><div class="nums" id="ready"></div></section>' +
    '</div>' +
    '<div class="off" id="off">Reconnecting to the kitchen&hellip;</div>' +
    '<script>' + SCRIPT + '</script></body></html>';
}

module.exports = { boardPage, escapeHtml };
