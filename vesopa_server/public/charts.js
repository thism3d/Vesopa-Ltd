/**
 * Charts for the back office.
 *
 * Hand-rolled SVG rather than a charting library: the admin is deliberately a
 * no-build vanilla-JS app, and pulling in a bundled library would either mean
 * adding a build step or loading a CDN script the page's CSP forbids. These
 * cover what a venue actually looks at — trend over time, share of a total,
 * and comparison between named things.
 *
 * Everything is drawn from data the server has already aggregated, so no chart
 * here iterates over raw sales rows.
 */

const Charts = (() => {
  const NS = 'http://www.w3.org/2000/svg';

  /** Text going into SVG must be escaped exactly as it would be for HTML. */
  const esc = (v) =>
    String(v ?? '').replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    })[c]);

  const money = (minor) =>
    `£${((Number(minor) || 0) / 100).toLocaleString('en-GB', {
      minimumFractionDigits: 2, maximumFractionDigits: 2,
    })}`;

  const compact = (minor) => {
    const v = (Number(minor) || 0) / 100;
    if (Math.abs(v) >= 1000) return `£${(v / 1000).toFixed(1)}k`;
    return `£${v.toFixed(0)}`;
  };

  /** The palette. Ordered so adjacent series stay distinguishable. */
  const PALETTE = ['#b5179e', '#4361ee', '#4cc9f0', '#f72585', '#7209b7',
    '#3a0ca3', '#4895ef', '#f77f00', '#06d6a0', '#ef476f'];

  function empty(el, message = 'No data yet.') {
    el.innerHTML = `<p class="muted small chart-empty">${esc(message)}</p>`;
  }

  /**
   * Line/area chart over time.
   *
   * `rows` is [{ label, value }]. Values are minor units; the axis is
   * formatted compactly so a busy venue's £12,400 does not overflow the gutter.
   */
  function line(el, rows, { colour = '#b5179e', height = 200, format = money } = {}) {
    if (!rows?.length) return empty(el);

    const w = 800;
    const h = height;
    const pad = { top: 14, right: 14, bottom: 26, left: 52 };
    const innerW = w - pad.left - pad.right;
    const innerH = h - pad.top - pad.bottom;

    const values = rows.map((r) => Number(r.value) || 0);
    const max = Math.max(...values, 1);
    // Always anchor at zero: a line chart with a floating baseline exaggerates
    // small changes, which is misleading on takings.
    const x = (i) => pad.left + (rows.length === 1
      ? innerW / 2
      : (i / (rows.length - 1)) * innerW);
    const y = (v) => pad.top + innerH - (v / max) * innerH;

    const points = rows.map((r, i) => `${x(i)},${y(Number(r.value) || 0)}`);
    const area = `M${pad.left},${pad.top + innerH} L${points.join(' L')} L${x(rows.length - 1)},${pad.top + innerH} Z`;

    // Four gridlines is enough to read a value off without crowding the plot.
    const ticks = [0, 0.25, 0.5, 0.75, 1].map((f) => ({
      v: max * f,
      y: pad.top + innerH - f * innerH,
    }));

    // Label every nth point, so a 90-day window does not overprint itself.
    const step = Math.max(1, Math.ceil(rows.length / 8));

    el.innerHTML = `
      <svg class="chart" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none"
           role="img" aria-label="Trend chart">
        <defs>
          <linearGradient id="cg-${colour.slice(1)}" x1="0" x2="0" y1="0" y2="1">
            <stop offset="0%" stop-color="${colour}" stop-opacity="0.28"/>
            <stop offset="100%" stop-color="${colour}" stop-opacity="0"/>
          </linearGradient>
        </defs>
        ${ticks.map((t) => `
          <line x1="${pad.left}" x2="${w - pad.right}" y1="${t.y}" y2="${t.y}"
                class="chart-grid"/>
          <text x="${pad.left - 8}" y="${t.y + 4}" class="chart-axis" text-anchor="end">
            ${esc(compact(t.v))}
          </text>`).join('')}
        <path d="${area}" fill="url(#cg-${colour.slice(1)})"/>
        <polyline points="${points.join(' ')}" fill="none" stroke="${colour}"
                  stroke-width="2.5" stroke-linejoin="round" stroke-linecap="round"/>
        ${rows.map((r, i) => `
          <circle cx="${x(i)}" cy="${y(Number(r.value) || 0)}" r="3.5"
                  fill="#fff" stroke="${colour}" stroke-width="2">
            <title>${esc(r.label)} — ${esc(format(r.value))}</title>
          </circle>`).join('')}
        ${rows.map((r, i) => (i % step === 0 || i === rows.length - 1) ? `
          <text x="${x(i)}" y="${h - 8}" class="chart-axis" text-anchor="middle">
            ${esc(r.label)}
          </text>` : '').join('')}
      </svg>`;
  }

  /** Vertical bars — trade by hour, takings by weekday. */
  function bar(el, rows, { colour = '#4361ee', height = 200, format = money } = {}) {
    if (!rows?.length) return empty(el);

    const w = 800;
    const h = height;
    const pad = { top: 14, right: 14, bottom: 26, left: 52 };
    const innerW = w - pad.left - pad.right;
    const innerH = h - pad.top - pad.bottom;

    const max = Math.max(...rows.map((r) => Number(r.value) || 0), 1);
    const slot = innerW / rows.length;
    // Leave a gap between bars, but never let them vanish on a 24-hour chart.
    const barW = Math.max(3, Math.min(slot * 0.62, 46));

    const ticks = [0, 0.5, 1].map((f) => ({
      v: max * f, y: pad.top + innerH - f * innerH,
    }));

    el.innerHTML = `
      <svg class="chart" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none"
           role="img" aria-label="Bar chart">
        ${ticks.map((t) => `
          <line x1="${pad.left}" x2="${w - pad.right}" y1="${t.y}" y2="${t.y}"
                class="chart-grid"/>
          <text x="${pad.left - 8}" y="${t.y + 4}" class="chart-axis" text-anchor="end">
            ${esc(compact(t.v))}
          </text>`).join('')}
        ${rows.map((r, i) => {
          const v = Number(r.value) || 0;
          const bh = (v / max) * innerH;
          const bx = pad.left + i * slot + (slot - barW) / 2;
          const by = pad.top + innerH - bh;
          return `<rect x="${bx}" y="${by}" width="${barW}" height="${Math.max(bh, 0)}"
                        rx="3" fill="${r.colour || colour}" opacity="0.9">
                    <title>${esc(r.label)} — ${esc(format(v))}</title>
                  </rect>`;
        }).join('')}
        ${rows.map((r, i) => {
          const step = Math.max(1, Math.ceil(rows.length / 12));
          if (i % step !== 0 && i !== rows.length - 1) return '';
          return `<text x="${pad.left + i * slot + slot / 2}" y="${h - 8}"
                        class="chart-axis" text-anchor="middle">${esc(r.label)}</text>`;
        }).join('')}
      </svg>`;
  }

  /** Donut — share of a total, e.g. cash vs card. */
  function donut(el, rows, { size = 190, thickness = 26, format = money } = {}) {
    const data = (rows || []).filter((r) => (Number(r.value) || 0) > 0);
    if (!data.length) return empty(el);

    const total = data.reduce((s, r) => s + (Number(r.value) || 0), 0);
    const r = size / 2 - thickness / 2;
    const c = size / 2;
    const circumference = 2 * Math.PI * r;

    let offset = 0;
    const segments = data.map((row, i) => {
      const value = Number(row.value) || 0;
      const fraction = value / total;
      const dash = fraction * circumference;
      const seg = `
        <circle cx="${c}" cy="${c}" r="${r}" fill="none"
                stroke="${row.colour || PALETTE[i % PALETTE.length]}"
                stroke-width="${thickness}"
                stroke-dasharray="${dash} ${circumference - dash}"
                stroke-dashoffset="${-offset}"
                transform="rotate(-90 ${c} ${c})">
          <title>${esc(row.label)} — ${esc(format(value))} (${(fraction * 100).toFixed(1)}%)</title>
        </circle>`;
      offset += dash;
      return seg;
    }).join('');

    el.innerHTML = `
      <div class="donut-wrap">
        <svg class="donut" viewBox="0 0 ${size} ${size}" width="${size}" height="${size}"
             role="img" aria-label="Share chart">
          ${segments}
          <text x="${c}" y="${c - 4}" text-anchor="middle" class="donut-total">
            ${esc(compact(total))}
          </text>
          <text x="${c}" y="${c + 14}" text-anchor="middle" class="donut-caption">
            total
          </text>
        </svg>
        <ul class="chart-legend">
          ${data.map((row, i) => `
            <li>
              <span class="swatch" style="background:${row.colour || PALETTE[i % PALETTE.length]}"></span>
              <span class="legend-label">${esc(row.label)}</span>
              <span class="legend-value">${esc(format(row.value))}</span>
            </li>`).join('')}
        </ul>
      </div>`;
  }

  /** Horizontal ranked bars — top products, departments, clerks. */
  function ranked(el, rows, { colour = '#7209b7', format = money, limit = 10 } = {}) {
    const data = (rows || []).slice(0, limit);
    if (!data.length) return empty(el);

    const max = Math.max(...data.map((r) => Number(r.value) || 0), 1);
    el.innerHTML = `
      <div class="ranked">
        ${data.map((r, i) => {
          const v = Number(r.value) || 0;
          const pct = Math.round((v / max) * 100);
          return `
            <div class="ranked-row">
              <span class="ranked-rank">${i + 1}</span>
              <span class="ranked-label" title="${esc(r.label)}">${esc(r.label)}</span>
              <span class="ranked-track">
                <span class="ranked-fill" style="width:${pct}%;background:${r.colour || colour}"></span>
              </span>
              <span class="ranked-value">${esc(format(v))}</span>
              ${r.meta ? `<span class="ranked-meta">${esc(r.meta)}</span>` : ''}
            </div>`;
        }).join('')}
      </div>`;
  }

  /**
   * Headline figure with an optional comparison against the previous period.
   * The arrow direction is computed here rather than by the caller so "up"
   * always means the same thing.
   */
  function stat(el, { label, value, previous, format = money, hint }) {
    const now = Number(value) || 0;
    const before = Number(previous);
    let delta = '';

    if (Number.isFinite(before) && before > 0) {
      const change = ((now - before) / before) * 100;
      const up = change >= 0;
      delta = `<span class="stat-delta ${up ? 'up' : 'down'}">
        ${up ? '▲' : '▼'} ${Math.abs(change).toFixed(1)}%
      </span>`;
    }

    el.innerHTML = `
      <span class="stat-label">${esc(label)}</span>
      <span class="stat-value">${esc(format(now))}</span>
      ${delta}
      ${hint ? `<span class="stat-hint">${esc(hint)}</span>` : ''}`;
  }

  return { line, bar, donut, ranked, stat, money, compact, PALETTE, esc };
})();
