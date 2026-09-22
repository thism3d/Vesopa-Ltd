-- ---------------------------------------------------------------------------
-- Apple, Microsoft and GitHub go back on the sign-in page.
--
-- WHAT WENT WRONG
--
-- schema_008 introduced `application_auth_methods` — which buttons each
-- application shows — and backfilled it so that "nothing changes the moment
-- this lands". It backfilled password, email codes, SMS codes, passkeys and
-- Google. Not Apple, not Microsoft, not GitHub.
--
-- The comment beside it said "the others are added by the seed when their
-- credentials appear". That was already untrue when it was written: all four
-- providers' credentials were in the server's `.env` at the time, and no seed
-- ever adds a row. So the instant per-application methods went live, three of
-- the four social buttons disappeared from every sign-in page at once, and the
-- change that removed them was the one described as changing nothing.
--
-- It is worth naming the shape of this mistake, because it is a common one: a
-- migration that enumerates what exists is a migration that silently drops
-- whatever the author forgot. The enumeration was the bug, not the omission.
--
-- WHY SEEDING ALL FOUR IS SAFE
--
-- A row here does not make a button appear. `authmethods.KNOWN` gates every
-- provider on `available()`, which asks `providers.enabled()`, which requires
-- a real client id and secret on this server. So a row for a provider with no
-- credentials renders nothing — exactly as it should — and the row is simply
-- ready for the day the credentials are added. That is the right way round:
-- the table says what an application PERMITS, the environment says what the
-- server CAN DO, and a button needs both.
--
-- Safe to re-run: INSERT IGNORE against the table's unique key.
-- ---------------------------------------------------------------------------

INSERT IGNORE INTO application_auth_methods (application_id, method, enabled, sort)
SELECT a.id, m.method, 1, m.sort
  FROM applications a
  JOIN (
        SELECT 'apple'     AS method, 60 AS sort
  UNION SELECT 'microsoft',  70
  UNION SELECT 'github',     80
  ) m
 WHERE a.deleted_at IS NULL;

-- ---------------------------------------------------------------------------
-- The QR menu keeps its own answer.
--
-- schema_008 deliberately took the password away from the dine-in menu: a
-- diner at a table has no Vesopa password and is not about to invent one. That
-- decision stands and is not disturbed here — the three providers above are
-- added to it like everywhere else, because "sign in with the Apple account
-- you already have" is exactly the right offer to somebody holding a phone.
-- ---------------------------------------------------------------------------
