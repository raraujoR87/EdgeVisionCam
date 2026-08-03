#!/bin/bash
sshpass -p radxa scp -o StrictHostKeyChecking=no /home/rarau/EdgeVisionCam/reset_db_pass.py radxa@192.168.77.29:/tmp/reset_db_pass.py
sshpass -p radxa ssh -o StrictHostKeyChecking=no radxa@192.168.77.29 "docker cp /tmp/reset_db_pass.py visioncam-core:/tmp/reset_db_pass.py && docker exec visioncam-core python3 /tmp/reset_db_pass.py"
