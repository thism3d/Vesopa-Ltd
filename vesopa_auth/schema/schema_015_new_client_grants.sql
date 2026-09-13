-- ---------------------------------------------------------------------------
-- The clients added in schema_014 could not actually be signed in to.
--
-- WHAT WENT WRONG, PLAINLY
--
-- schema_014 created Vesopa Kitchen, Vesopa Display and Vesopa Express as their
-- own OAuth clients. It copied the auth methods and set the redirect URIs, and
-- stopped there. An application is not only those things: it is also the GRANTS
-- it may use, the SCOPES it may ask for, and the ROLES it can hold. The till has
-- five scopes, five roles and two grants. The three new clients had none of any
-- of it.
--
-- A client with no grant rows is refused the authorization_code flow, and the
-- refusal is `unauthorized_client`. That is exactly what somebody saw: Vesopa
-- EPOS signed in perfectly, Vesopa Express opened Firefox, the browser said the
-- sign-in was cancelled, and the app came back with "Vesopa refused to sign in
-- (unauthorized_client)".
--
-- The till kept working throughout because nothing about the till changed.
--
-- WHY THIS WAS NOT CAUGHT
--
-- Everything that was checked after schema_014 was checked on the SERVER side:
-- the client ids existed, they were distinct, the endpoints handed out the right
-- one. None of that touches whether auth will actually issue a code for them.
-- The only test that would have found it is signing in with one, and that needs
-- a real browser and a real account -- which is precisely the test that was not
-- run before the apps were pointed at the new clients.
--
-- Copied from the till rather than typed, for the same reason the auth methods
-- were: whatever the till is allowed to do is what a machine standing beside it
-- should be allowed to do, and a list retyped by hand is a list that drifts.
--
-- Re-runnable.
-- ---------------------------------------------------------------------------

SET NAMES utf8mb4 COLLATE utf8mb4_general_ci;

SET @till := (SELECT id FROM applications WHERE slug = 'vesopa-epos' LIMIT 1);

-- The grants. This is the one that caused the refusal.
INSERT INTO application_grants (application_id, grant_type)
SELECT a.id, g.grant_type
  FROM applications a
  JOIN application_grants g ON g.application_id = @till
 WHERE a.slug IN ('vesopa-kitchen', 'vesopa-display', 'vesopa-express')
   AND NOT EXISTS (
     SELECT 1 FROM application_grants x
      WHERE x.application_id = a.id AND x.grant_type = g.grant_type);

-- What each may ask for. Without these a client that got past the grant check
-- would be refused the scopes in its authorize request instead.
INSERT INTO application_scopes (application_id, scope_id)
SELECT a.id, s.scope_id
  FROM applications a
  JOIN application_scopes s ON s.application_id = @till
 WHERE a.slug IN ('vesopa-kitchen', 'vesopa-display', 'vesopa-express')
   AND NOT EXISTS (
     SELECT 1 FROM application_scopes x
      WHERE x.application_id = a.id AND x.scope_id = s.scope_id);

-- The roles a member of one of these applications can hold. Not needed to sign
-- in, but a client whose roles are missing cannot express who may do what once
-- somebody is in -- and adding them later, after venues have members, is a
-- harder job than adding them now while nobody has any.
INSERT INTO application_roles (application_id, role_key, name, description, is_default)
SELECT a.id, r.role_key, r.name, r.description, r.is_default
  FROM applications a
  JOIN application_roles r ON r.application_id = @till
 WHERE a.slug IN ('vesopa-kitchen', 'vesopa-display', 'vesopa-express')
   AND NOT EXISTS (
     SELECT 1 FROM application_roles x
      WHERE x.application_id = a.id AND x.role_key = r.role_key);
