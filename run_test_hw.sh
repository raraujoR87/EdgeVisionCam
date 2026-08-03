#!/bin/bash
sshpass -p radxa scp -o StrictHostKeyChecking=no /home/rarau/EdgeVisionCam/test_hw.py radxa@192.168.77.29:~/EdgeVisionCam/test_hw.py
sshpass -p radxa ssh -o StrictHostKeyChecking=no radxa@192.168.77.29 "cd ~/EdgeVisionCam && python3 test_hw.py"
