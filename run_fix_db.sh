sshpass -p radxa scp -o StrictHostKeyChecking=no ~/EdgeVisionCam/fix_db.py radxa@192.168.77.29:/tmp/fix_db.py
sshpass -p radxa ssh -o StrictHostKeyChecking=no radxa@192.168.77.29 "docker cp /tmp/fix_db.py visioncam-core:/app/fix_db.py && docker exec visioncam-core python3 /app/fix_db.py && docker restart visioncam-core"
