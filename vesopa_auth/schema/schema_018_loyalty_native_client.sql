-- ---------------------------------------------------------------------------
-- The loyalty client is `native`, not `spa`.
--
-- WHAT WENT WRONG
--
-- Signing in from the Windows app was refused with "That return address is not
-- registered". The registered loopback is `http://127.0.0.1:0/callback`, and a
-- native app listens on whatever port the operating system gives it -- so what
-- it actually presents is `http://127.0.0.1:54321/callback`, which is not the
-- same string.
--
-- RFC 8252 section 7.3 says the port must be ignored when matching a loopback
-- redirect, and src/oauth/clients.js does exactly that -- but only for clients
-- whose `client_type` is `native` (matchRedirect returns false for anything
-- else before it gets there). schema_016 typed this one `spa`, because the half
-- of it being written at the time was the web app.
--
-- The app is both. It ships as a browser app served from menu.vesopaepos.com
-- and as Windows, Android and iPhone builds that open the system browser and
-- listen on a loopback port, exactly as the till and the kiosk do. `native` is
-- the type that describes the redirects it needs, and it costs the web half
-- nothing: an exact string match is tried first and still succeeds for the
-- https address.
--
-- IT IS STILL A PUBLIC CLIENT. isPublic() counts `spa` and `native` alike, so
-- nothing here starts demanding a secret the app cannot keep, and PKCE is
-- required of every client regardless.
--
-- Re-runnable.
-- ---------------------------------------------------------------------------

SET NAMES utf8mb4 COLLATE utf8mb4_general_ci;

UPDATE applications
   SET client_type = 'native'
 WHERE slug = 'vesopa-loyalty'
   AND client_type <> 'native';
