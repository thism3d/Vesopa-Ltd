-- The Contributor role: someone who may add files and write blog posts, and
-- who sees only their own.
--
-- The panel had two roles and neither fits. 'Admin' can do everything including
-- managing other admins; 'Subadmin' was only ever "Admin, minus the admin list"
-- — it still reaches Offices & Billing, the Collection ledger, every demo
-- request and every customer's contact details. There was no way to let someone
-- write a blog post without also handing them the billing screens.
--
-- 'Contributor' is that third role, and it is defined by subtraction: Blog and
-- File Manager, nothing else, and within those two only the rows they created.
--
-- Guarded throughout, so re-running is safe. Run against the same database as
-- schema_admin.sql:
--
--     mysql vesopa_eposdb < schema_admin_contributor.sql
--
-- `admin_table.status` is already VARCHAR(32) rather than an ENUM, so a third
-- role needs no ALTER on it — see schema.sql. That was luck rather than
-- foresight, but it is why this file is as small as it is.

DROP PROCEDURE IF EXISTS vesopa_add_column;
DELIMITER $$
CREATE PROCEDURE vesopa_add_column(
  IN tbl VARCHAR(64), IN col VARCHAR(64), IN spec VARCHAR(255))
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                 WHERE table_schema = DATABASE()
                   AND table_name = tbl AND column_name = col) THEN
    SET @s = CONCAT('ALTER TABLE `', tbl, '` ADD COLUMN `', col, '` ', spec);
    PREPARE stmt FROM @s; EXECUTE stmt; DEALLOCATE PREPARE stmt;
  END IF;
END$$
DELIMITER ;

DROP PROCEDURE IF EXISTS vesopa_add_index;
DELIMITER $$
CREATE PROCEDURE vesopa_add_index(
  IN tbl VARCHAR(64), IN idx VARCHAR(64), IN spec VARCHAR(255))
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.statistics
                 WHERE table_schema = DATABASE()
                   AND table_name = tbl AND index_name = idx) THEN
    SET @s = CONCAT('CREATE INDEX `', idx, '` ON `', tbl, '` ', spec);
    PREPARE stmt FROM @s; EXECUTE stmt; DEALLOCATE PREPARE stmt;
  END IF;
END$$
DELIMITER ;

-- ---------------------------------------------------------------------------
-- Signing in with an email address
-- ---------------------------------------------------------------------------
--
-- The panel has always signed people in by `username`, and the profile form
-- caps a username at 20 characters — shorter than most email addresses. Rather
-- than widen that and have an address silently truncated into an account
-- nobody can log into, the address gets a column of its own and the login
-- accepts either.
--
-- NULL on every account that exists, and NULL is not a value the login can
-- match: `WHERE username = ? OR email = ?` with a non-empty parameter never
-- matches a NULL email, so an existing admin is unaffected and no two accounts
-- can collide on "no address".
CALL vesopa_add_column('admin_table', 'email', 'VARCHAR(255) NULL');

-- Unique, but only over the rows that have one. MySQL's UNIQUE index ignores
-- NULLs for this purpose — several accounts may have no address, but no two may
-- share one, or `authenticate` would have to decide which of them signed in.
SET @i := (SELECT COUNT(*) FROM information_schema.statistics
           WHERE table_schema = DATABASE()
             AND table_name = 'admin_table' AND index_name = 'uq_admin_table_email');
SET @s := IF(@i = 0,
  'ALTER TABLE admin_table ADD UNIQUE KEY uq_admin_table_email (email)',
  'SELECT 1');
PREPARE stmt FROM @s; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- ---------------------------------------------------------------------------
-- Who owns a file, and who owns a post
-- ---------------------------------------------------------------------------
--
-- Both tables already record an author as *text* — `media_files.uploaded_by`
-- and `blog_posts.author` — and neither is a safe thing to scope access on. A
-- contributor can type any name they like into the blog editor's Author field,
-- so "show me the posts where author = my name" is an access rule anybody can
-- rewrite from the form that is supposed to be governed by it. And an admin who
-- renames themselves would lose everything they had written.
--
-- So ownership is the admin's id, set at creation and never editable. The text
-- fields stay exactly as they are: they are a byline, which is a different
-- question from who may edit the row.
--
-- No foreign key, deliberately, and for the same reason `offices.home_screen_id`
-- has none over in the till: deleting an admin must not cascade away the blog
-- posts they wrote. It leaves rows owned by an id that no longer exists, which
-- is precisely right — nobody but a full Admin can reach them, and a full Admin
-- can see everything anyway.
CALL vesopa_add_column('media_files', 'owner_admin_id', 'INT NULL');
CALL vesopa_add_column('blog_posts',  'owner_admin_id', 'INT NULL');

-- The listings filter on this on every page load for a contributor, paired with
-- the ordering column each screen already uses.
CALL vesopa_add_index('media_files', 'idx_media_owner', '(owner_admin_id, created_at)');
CALL vesopa_add_index('blog_posts',  'idx_blog_owner',  '(owner_admin_id, updated_at)');

-- Everything that exists was made by a full Admin, before there was anyone else
-- who could have made it. Left NULL rather than backfilled to a guess: NULL
-- means "not a contributor's", which is exactly true, and a contributor's
-- listing asks for `owner_admin_id = <their id>` and so never sees them.

DROP PROCEDURE IF EXISTS vesopa_add_column;
DROP PROCEDURE IF EXISTS vesopa_add_index;
