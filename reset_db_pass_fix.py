import sqlite3

# SHA-256 puro de 'admin', que tem 64 caracteres.
# O core/security.py vai identificar como legacy_hash e aceitar.
h = "8c6976e5b5410415bde908bd4dee15dfb167a9c873fc4bb8a81f6f2ab448a918"
c = sqlite3.connect('/app/core/database/data/system.db')
c.execute("UPDATE config SET value=? WHERE key='admin_password_hash'", (h,))
c.commit()
print("Senha resetada CORRETAMENTE para 'admin'.")
