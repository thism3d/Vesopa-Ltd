#!/usr/bin/env bash
#
# Drop every table in the auth database and rebuild it from schema/.
#
#   bash reset-database.sh          refuses if any real user exists
#   bash reset-database.sh --force  does it anyway
#
# WHY THIS EXISTS
#
# `CREATE TABLE IF NOT EXISTS` does nothing to a table that is already there, so
# editing a column in schema.sql and re-applying it changes NOTHING and reports
# success. Before there is any data that is a trap, not a feature: the schema on
# disk and the schema in the database quietly disagree, and the first symptom is
# a query that behaves differently on the server than it did locally.
#
# Once real accounts exist this script is the wrong tool — the right one is a
# numbered migration file with `vesopa_add_column`. Hence the guard.
#
# This is also written as a FILE rather than a command passed over ssh on
# purpose: the shell quoting needed for the generated DROP statements does not
# survive the trip from Git Bash on Windows through paramiko to bash, and the
# failure mode is a script that prints "dropped" having dropped nothing.
#
set -euo pipefail

DB="vesopasoftware_authdb"
SCHEMA_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../schema" && pwd)"

users=$(mysql -N -B "$DB" -e "SELECT COUNT(*) FROM users" 2>/dev/null || echo 0)
if [ "$users" -gt 0 ] && [ "${1:-}" != "--force" ]; then
  echo "refusing: $DB holds $users user rows. Use a migration, or pass --force." >&2
  exit 1
fi

echo "▶ dropping every table in $DB"
mysql -N -B "$DB" -e "
  SELECT CONCAT('DROP TABLE IF EXISTS \`', table_name, '\`;')
    FROM information_schema.tables
   WHERE table_schema = '$DB';" > /tmp/vesopa_auth_drop.sql

{
  echo "SET FOREIGN_KEY_CHECKS = 0;"
  cat /tmp/vesopa_auth_drop.sql
  echo "SET FOREIGN_KEY_CHECKS = 1;"
} | mysql "$DB"
rm -f /tmp/vesopa_auth_drop.sql
echo "  ✓ dropped"

echo "▶ applying schema"
cd "$SCHEMA_DIR"
for f in schema.sql $(ls schema_*.sql 2>/dev/null | sort); do
  mysql "$DB" < "$f"
  echo "  ✓ $f"
done

count=$(mysql -N -B "$DB" -e "
  SELECT COUNT(*) FROM information_schema.tables WHERE table_schema = '$DB';")
echo "  $count tables"
