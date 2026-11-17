/*
 * Which back office go.vesopa.com/signup talks to (js/signup.js): the live
 * one, as the Go app does (owner, 2026-11-17: "Live now"). Staging could not
 * take the sign-up code: it has edits made on the server that conflict with
 * the repository. New venues use the Stripe key the live back office has as
 * STRIPE_SECRET_KEY.
 */
window.GO_SIGNUP = { api: 'https://backoffice.vesopaepos.com' };
