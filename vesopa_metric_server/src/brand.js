/**
 * Metric Group's brand, as the app and the console show it.
 *
 * Taken from Metric's public website (metricgroup.co.uk) on 2026-09-27: the
 * logo and site icon under public/brand/, the navy and green of the mark, and
 * the published contact numbers. This is a white-label build for one
 * customer, so the brand is fixed here rather than edited in a back office.
 */

module.exports = {
  appName: 'Metric Membership',
  company: 'METRIC Group Ltd',
  tagline: 'Your car is your pass.',
  colours: {
    // The mark's own navy and green (sampled from the logo), with the darker
    // pair the website uses for text and buttons.
    primary: '#002788',
    primaryDark: '#003D6B',
    accent: '#5BD601',
    accentDark: '#6BA439',
    ink: '#1F2430',
    surface: '#F4F6FA',
  },
  logo: '/brand/metric-logo.png',
  logoFull: '/brand/metric-logo-full.png',
  logoWhite: '/brand/metric-logo-white.png',
  icon: '/brand/metric-icon-512.png',
  website: 'https://www.metricgroup.co.uk/',
  phone: '01793 647800',
  servicePhone: '01793 647871',
  poweredBy: 'Vesopa',
};
