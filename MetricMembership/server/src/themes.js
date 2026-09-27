/**
 * The colours of the phone's own bars around the member app: the status bar
 * at the top and the navigation bar at the bottom on Android, and the browser
 * toolbar on the web. Staff pick one under Appearance in the console.
 *
 * `stops` is the gradient the top bar moves through when `barMotion` is
 * "animated" (public/theme.js on the web, lib/ui/system_bars.dart natively).
 * The first stop is also the still colour and the manifest's theme_color.
 * `bottom` is the navigation bar (and the page background Android Chrome
 * reads it from). `dark` says the bars are dark, so their icons are white.
 */
const THEMES = {
  metric: { name: 'Metric navy', stops: ['#002788', '#00144D', '#1D3FA8'], bottom: '#002788', dark: true },
  midnight: { name: 'Midnight', stops: ['#00144D', '#050B1F', '#002788'], bottom: '#00144D', dark: true },
  signal: { name: 'Navy and green', stops: ['#002788', '#1D3FA8', '#2F7A00'], bottom: '#002788', dark: true },
  daylight: { name: 'Daylight', stops: ['#F5F7FB', '#EEF2FB', '#FFFFFF'], bottom: '#FFFFFF', dark: false },
};

/** What the web page, the manifest and the native app need for one choice. */
function resolve(choices) {
  const t = THEMES[choices.appTheme] || THEMES.metric;
  return {
    id: choices.appTheme in THEMES ? choices.appTheme : 'metric',
    name: t.name,
    top: t.stops[0],
    stops: t.stops,
    bottom: t.bottom,
    dark: t.dark,
    motion: choices.barMotion === 'still' ? 'still' : 'animated',
  };
}

module.exports = { THEMES, resolve };
