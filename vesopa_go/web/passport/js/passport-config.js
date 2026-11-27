/*
 * Vesopa Passport (passport.vesopa.com, owner 2026-11-26): verification and
 * account opening for Vesopa, with Stripe. The same steps and code as the Go
 * sign-up (js/signup.js, shared from go.vesopa.com's site at deploy), on the
 * live back office; Vesopa Auth and Stripe Identity both return to /flow/.
 */
window.GO_SIGNUP = {
  api: 'https://backoffice.vesopaepos.com',
  redirect: '/flow/',
  install: 'https://go.vesopa.com/install/',
  passport: true,
};
