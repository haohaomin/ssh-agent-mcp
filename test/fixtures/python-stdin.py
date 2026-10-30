import json
import sqlite3
import sys

# Keep quotes, SQL identifiers, backslashes and shell syntax as literal data.
payload = {
    "message": "中文 'single' \"double\"",
    "shell": "~/$HOME/$(printf expanded)/`printf expanded`",
    "path": r"C:\scripts\example.py",
    "lines": "first\nsecond\nthird",
    "nested": {
        "enabled": True,
        "missing": None,
        "values": [1, "two", {"three": 3}],
    },
}

connection = sqlite3.connect(":memory:")
connection.execute("""
    CREATE TABLE requests (
        id INTEGER PRIMARY KEY,
        is_stream INTEGER NOT NULL,
        metadata TEXT NOT NULL
    )
""")

encoded = json.dumps(payload, ensure_ascii=False)
connection.executemany(
    "INSERT INTO requests (id, is_stream, metadata) VALUES (?, ?, ?)",
    [(1, 1, encoded), (2, 0, encoded)],
)

# The SQL strings here must reach Python without being reinterpreted by SSH.
rows = connection.execute("""
    SELECT
        id,
        CASE WHEN is_stream THEN 'stream' ELSE 'non-stream' END AS "mode",
        metadata
    FROM requests
    ORDER BY id
""").fetchall()

records = []
for identifier, mode, metadata in rows:
    records.append({
        "id": identifier,
        "mode": mode,
        "payload": json.loads(metadata),
    })

result = {
    "source": __file__,
    "argv": sys.argv,
    "records": records,
}
connection.close()

print(json.dumps(result, ensure_ascii=False))
