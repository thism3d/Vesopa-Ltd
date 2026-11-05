/* The server page: live figures every ten seconds, and the small line charts. */
(() => {
  const tiles = document.getElementById('server-tiles');
  if (!tiles) return;
  const minutes = tiles.dataset.minutes;

  function line(values, max) {
    if (values.length < 2) return '';
    const top = max || Math.max(...values, 1);
    const points = values.map((v, i) => {
      const x = (i / (values.length - 1)) * 240;
      const y = 46 - (Math.min(v, top) / top) * 44;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    });
    return `<polyline points="${points.join(' ')}" fill="none" stroke="var(--lime, #A5C715)" stroke-width="2" vector-effect="non-scaling-stroke"/>`;
  }

  function draw(points) {
    const chart = (name, values, max) => {
      const svg = tiles.querySelector(`[data-chart="${name}"]`);
      if (svg) svg.innerHTML = line(values, max);
    };
    chart('cpu', points.map((p) => p.cpu), 100);
    chart('memory', points.map((p) => p.memory), 100);
    chart('disk', points.filter((p) => p.disk != null).map((p) => p.disk), 100);
    chart('net', points.map((p) => p.rx + p.tx));
  }

  function setText(name, text) {
    const el = tiles.querySelector(`[data-live="${name}"]`);
    if (el) el.textContent = text;
  }

  async function refresh() {
    try {
      const res = await fetch(`/server/live?minutes=${encodeURIComponent(minutes)}`, { headers: { Accept: 'application/json' } });
      if (!res.ok) return;
      const s = await res.json();
      if (s.latest) {
        setText('cpu', `${s.latest.cpu}%`);
        setText('memory', `${s.latest.memory}%`);
        if (s.latest.disk != null) setText('disk', `${s.latest.disk}%`);
        setText('net', `${((s.latest.rx + s.latest.tx) / 1048576).toFixed(2)} MB/s`);
      }
      draw(s.points);
      const box = document.getElementById('server-alerts');
      box.replaceChildren(...s.alerts.map((text) => {
        const div = document.createElement('div');
        div.className = 'flash bad';
        div.textContent = text;
        return div;
      }));
    } catch {
      // The next round tries again.
    }
  }

  const filter = document.getElementById('server-filter');
  filter.addEventListener('input', () => {
    const needle = filter.value.toLowerCase();
    for (const row of document.querySelectorAll('#server-processes tr[data-name]')) {
      row.hidden = !row.dataset.name.toLowerCase().includes(needle);
    }
  });

  refresh();
  setInterval(refresh, 10000);
})();
