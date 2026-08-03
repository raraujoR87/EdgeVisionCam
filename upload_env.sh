#!/bin/bash
sshpass -p radxa scp -o StrictHostKeyChecking=no /tmp/radxa.env radxa@192.168.77.29:~/EdgeVisionCam/.env
sshpass -p radxa ssh -o StrictHostKeyChecking=no radxa@192.168.77.29 "cd ~/EdgeVisionCam && docker compose up -d visioncam-core"
