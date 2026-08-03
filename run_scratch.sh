sshpass -p radxa scp -o StrictHostKeyChecking=no /home/rarau/EdgeVisionCam/scratch_db.py radxa@192.168.77.29:/tmp/scratch_db.py
sshpass -p radxa ssh -o StrictHostKeyChecking=no radxa@192.168.77.29 "docker cp /tmp/scratch_db.py visioncam-core:/app/scratch_db.py && docker exec visioncam-core python3 /app/scratch_db.py"
