"""Read-only: how Pontardawe RFC's food is routed to the kitchen. Changes nothing."""
import pathlib
import sys

ROOT = pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "tool"))

import deploy_pontardawe_app as app  # noqa: E402  (loads .env.claude too)

sh = app.sh
DB = app.DB


def q(client, query):
    sh(client, f"{DB} -e \"{query}\"")


def main():
    queries = sys.argv[1:]
    client = app.vesopa_ssh.connect()
    try:
        for query in queries:
            print(f"\n== {query[:100]}")
            q(client, query)
    finally:
        client.close()


if __name__ == "__main__":
    main()
