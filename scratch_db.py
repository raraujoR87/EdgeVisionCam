import sqlite3
db = sqlite3.connect('core/database/data/system.db')
db.row_factory = sqlite3.Row
rows = db.execute('SELECT * FROM zones').fetchall()
print('ZONES:')
for r in rows:
    print(dict(r))
print('CAMERAS:')
cams = db.execute('SELECT * FROM cameras').fetchall()
for c in cams:
    print(dict(c))
