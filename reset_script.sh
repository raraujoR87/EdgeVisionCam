#!/bin/bash
sshpass -p radxa ssh -o StrictHostKeyChecking=no radxa@192.168.77.29 "docker exec visioncam-core python3 -c \"import sqlite3; c=sqlite3.connect('/app/core/database/data/system.db'); c.execute('UPDATE config SET value=''a11c8a6669894e63bb701469e38e1b65eb635cf3'' WHERE key=''admin_password_hash'''); c.commit()\""
