-- ---------------------------------------------------------------------------
-- Proves the "unique while active, reusable once revoked" rule on the real
-- database, then rolls back. Run it after any change to user_identities:
--
--   mysql vesopasoftware_authdb < verify-uniqueness.sql
--
-- The rule is not something to take on trust from a comment. MySQL's treatment
-- of NULL in a UNIQUE index is the entire mechanism, and a schema change that
-- makes active_flag NOT NULL would silently turn a hard constraint into no
-- constraint at all — every test below would still pass except the first.
-- ---------------------------------------------------------------------------

-- The duplicate check has to catch error 1062, and a DECLARE ... HANDLER only
-- exists inside a routine body. The mysql client splits this file on `;`, so
-- the handler must be wrapped in a procedure with the delimiter changed —
-- writing it as a bare BEGIN NOT ATOMIC block parses as a syntax error.
DROP PROCEDURE IF EXISTS verify_duplicate_refused;
DELIMITER //
CREATE PROCEDURE verify_duplicate_refused(IN p_user INT UNSIGNED)
BEGIN
  DECLARE CONTINUE HANDLER FOR 1062 SET @failed := 1;
  SET @failed := 0;
  INSERT INTO user_identities (user_id, type, identifier, identifier_norm)
  VALUES (p_user, 'email', 'owner@example.com', 'owner@example.com');
END //
DELIMITER ;

START TRANSACTION;

INSERT INTO users (public_id, display_name) VALUES ('TESTUSERAAAAAAAAAAAAAAAAAA', 'Test A');
SET @a = LAST_INSERT_ID();
INSERT INTO users (public_id, display_name) VALUES ('TESTUSERBBBBBBBBBBBBBBBBBB', 'Test B');
SET @b = LAST_INSERT_ID();

-- 1. First claim on an address succeeds.
INSERT INTO user_identities (user_id, type, identifier, identifier_norm, verified_at)
VALUES (@a, 'email', 'Owner@Example.com', 'owner@example.com', NOW());
SELECT '1. first claim accepted' AS check_result;

-- 2. A second live claim on the same address must be refused.
--    Expected: ERROR 1062 (duplicate entry). If this line does NOT error, the
--    constraint is gone and two accounts can hold one address.
CALL verify_duplicate_refused(@b);
SELECT IF(@failed = 1, '2. duplicate refused — PASS', '2. DUPLICATE ACCEPTED — FAIL') AS check_result;

-- 3. Revoke the first, and the address becomes free.
UPDATE user_identities SET revoked_at = NOW(), revoked_reason = 'test'
 WHERE user_id = @a AND identifier_norm = 'owner@example.com';
INSERT INTO user_identities (user_id, type, identifier, identifier_norm)
VALUES (@b, 'email', 'owner@example.com', 'owner@example.com');
SELECT '3. re-claim after revocation accepted — PASS' AS check_result;

-- 4. History survives: both rows are still there, one live and one revoked.
SELECT CONCAT('4. rows for this address: ', COUNT(*),
              ' (live: ', SUM(revoked_at IS NULL), ') — ',
              IF(COUNT(*) = 2 AND SUM(revoked_at IS NULL) = 1, 'PASS', 'FAIL')) AS check_result
  FROM user_identities WHERE identifier_norm = 'owner@example.com';

-- 5. Many revoked rows for one address may coexist.
UPDATE user_identities SET revoked_at = NOW() WHERE identifier_norm = 'owner@example.com';
INSERT INTO user_identities (user_id, type, identifier, identifier_norm)
VALUES (@a, 'email', 'owner@example.com', 'owner@example.com');
UPDATE user_identities SET revoked_at = NOW() WHERE identifier_norm = 'owner@example.com';
SELECT CONCAT('5. revoked rows coexisting: ', COUNT(*), ' — ',
              IF(COUNT(*) = 3, 'PASS', 'FAIL')) AS check_result
  FROM user_identities WHERE identifier_norm = 'owner@example.com';

-- 6. The same address as a DIFFERENT type is a different identifier.
INSERT INTO user_identities (user_id, type, identifier, identifier_norm)
VALUES (@a, 'google', 'owner@example.com', 'owner@example.com');
SELECT '6. same string under another provider accepted — PASS' AS check_result;

ROLLBACK;

SELECT CONCAT('cleanup: test users remaining = ', COUNT(*)) AS check_result
  FROM users WHERE public_id LIKE 'TESTUSER%';
