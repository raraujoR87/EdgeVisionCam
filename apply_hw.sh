#!/bin/bash
sshpass -p radxa scp -o StrictHostKeyChecking=no /home/rarau/EdgeVisionCam/edge_hardware.py radxa@192.168.77.29:~/EdgeVisionCam/edge_hardware.py
sshpass -p radxa ssh -o StrictHostKeyChecking=no radxa@192.168.77.29 "cd ~/EdgeVisionCam && python3 -c 'import edge_hardware; edge_hardware.aplicar()' && docker compose -f docker-compose.yml -f docker-compose.hardware.yml up -d visioncam-core"
