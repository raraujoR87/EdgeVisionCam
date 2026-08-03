import sqlite3
db = sqlite3.connect('core/database/data/system.db')
db.execute("UPDATE cameras SET rtsp_url='rtsp://192.168.77.17:8554/cam' WHERE name='camera_principal'")
db.execute("UPDATE cameras SET is_active=0 WHERE name='cam'")
db.commit()
print("DB updated!")
