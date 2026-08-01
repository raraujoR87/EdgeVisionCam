# Compilação de modelos para a NPU (Allwinner A733 / VIP9000)

A NPU não executa `.pt` nem `.onnx`. Só executa **NBG** — um grafo binário
produzido pelo compilador ACUITY, específico para a configuração de silício da
placa. Este diretório contém o caminho completo de `.pt` até o `.nb` que roda no
appliance.

## Onde cada coisa roda

| Etapa | Onde | Por quê |
|---|---|---|
| `export_onnx.py` | PC x86 | precisa do PyTorch/ultralytics |
| `prepare_calibration.py` | PC x86, com acesso à loja | captura frames da câmera real |
| `compilar_nbg.sh` | PC x86, Docker | o ACUITY é x86-only e pesa ~15 GB |
| `vpm_run` | placa | valida o grafo isoladamente |

A placa **não** compila. Além de o ACUITY ser x86-only, o container não caberia
confortavelmente no armazenamento do appliance.

## Passo 0 — preparar o host

```bash
bash npu_compilation/preparar_host.sh
# se ainda não tem Docker:
INSTALAR_DOCKER=1 bash npu_compilation/preparar_host.sh
```

Verifica arquitetura, espaço em disco, Docker, a imagem do ACUITY e as
dependências Python.

### A imagem do ACUITY

**Não está no Docker Hub.** É um download da Allwinner:

```
https://netstorage.allwinnertech.com:5001/fsdownload/Mh23BhPHq/docker_images_v2.0.x.zip
```

~11 GB, contém `ubuntu-npu:v2.0.10.1` com ACUITY 6.30.22.

```bash
unzip docker_images_v2.0.x.zip
docker load < ubuntu-npu-v2.0.10.1.tar
docker run --rm ubuntu-npu:v2.0.10.1 bash -c 'ls /root/acuity-toolkit-whl-*/bin'
```

Reserve ~35 GB no pico (zip + extraído + imagem carregada). O zip e o `.tar`
podem ser apagados depois do `docker load`.

Não há substituto aberto: o formato NBG é proprietário e o compilador também.

## Passo 1 — ONNX

```bash
python3 npu_compilation/export_onnx.py --model yolov8n-pose --imgsz 320
```

Gera `yolov8n-pose.onnx` e `npu_compilation/inputs_outputs.txt` com os nomes
reais dos tensores — o `pegasus import` não os descobre sozinho.

**Por que `yolov8n-pose` e não `yolo26n-pose`:** a saída por âncoras usa apenas
operadores que o ACUITY suporta com segurança. O YOLO26 embute o NMS no grafo, e
compiladores de NPU costumam rejeitar esses operadores. O decodificador em
`edge/vivante_pose_engine.py` aceita os dois layouts, então trocar depois é
mudar uma variável — mas começar pelo YOLOv8 evita descobrir a
incompatibilidade só no `pegasus import`.

## Passo 2 — calibração

```bash
python3 npu_compilation/prepare_calibration.py
```

**Rode com a câmera da loja conectada.** Isto não é formalidade: a quantização
INT8 dimensiona as escalas a partir dessas imagens. Calibrar com cenas genéricas
derruba a precisão no dispositivo — e não aparece em teste nenhum, porque o
teste roda o ONNX em float. O script avisa quando cai para imagens do COCO.

## Passo 3 — compilar

```bash
bash npu_compilation/compilar_nbg.sh
```

Produz `edge/yolov8n-pose.nb`.

### Três parâmetros que decidem se o grafo funciona

**`--pack-nbg-viplite`** — o exemplo do ai-sdk usa `--pack-nbg-unify`, que gera
grafo para o driver unificado. Nossa placa roda VIPLite (`/dev/vipcore`). O
arquivo errado carrega e falha depois, no meio da inferência.

**`--optimize VIP9000NANOSI_PLUS_PID0X10000016`** — identifica a configuração
exata do silício. Este é o **único parâmetro que ainda é inferência**: vem da
configuração `v2` do `pegasus_setup.sh` do ai-sdk, a mesma do Allwinner T527,
parente direto do A733, e corresponde ao `NPU_SW_VERSION=v2.0` do driver desta
placa. Não foi validado no silício.

Se o NBG carregar e devolver detecções sem sentido, este é o primeiro suspeito.
Alternativas:

```bash
OPTIMIZE=VIP9000NANODI_PLUS_PID0X1000003B bash npu_compilation/compilar_nbg.sh  # t536/mr536
OPTIMIZE=VIP9000PICO_PID0XEE             bash npu_compilation/compilar_nbg.sh  # v85x/r853
```

**`inputmeta.yml`** — descreve o pré-processamento da calibração: `mean=0`,
`scale=1/255`. Espelha o que `VivantePoseEngine._infer_npu` faz em runtime
(`canvas_rgb / 255.0`). Se divergirem, a quantização fica dimensionada para uma
distribuição de entrada que nunca ocorre em produção.

### Quantização

O padrão é `pcq` — `perchannel_symmetric_affine` com `qtype int8`, uma escala
por canal. Num detector isso pesa mais que no comum: as cabeças do YOLO
(caixas, objectness, keypoints) têm faixas dinâmicas muito diferentes, e uma
escala única por tensor achata as menores até sumirem. O sintoma é queda de
recall, não erro.

```bash
QUANT=uint8 bash npu_compilation/compilar_nbg.sh   # asymmetric_affine
QUANT=int16 bash npu_compilation/compilar_nbg.sh   # mais preciso, mais lento
QUANT=bf16  bash npu_compilation/compilar_nbg.sh   # sem quantização real
```

## Passo 4 — validar na placa

```bash
scp edge/yolov8n-pose.nb radxa@<ip>:~/EdgeVisionCam/edge/
```

Na placa, **antes** de apontar a engine:

```bash
vpm_run edge/yolov8n-pose.nb
```

Isto separa "modelo ruim" de "integração ruim". Pular esta etapa transforma
qualquer falha num problema com duas causas possíveis e nenhuma forma barata de
distinguir.

Só então:

```bash
POSE_MODEL_PATH=edge/yolov8n-pose.nb
bash deploy/atualizar.sh
```

A telemetria deve passar de `CPU_FALLBACK` para `ACTIVE_VIPLITE`.

## O que ainda não foi validado

Honestidade sobre o estado real, para que ninguém trate isto como caminho
pavimentado:

- **Nada disto rodou no silício.** O binding em `edge/viplite.py` foi transcrito
  de `vip_lite.h` e a ordem das chamadas segue o `vpm_run.c` do ai-sdk, mas
  nenhuma linha executou numa NPU.
- **O `--optimize` é inferência** — ver acima.
- **O efeito da quantização INT8 sobre a precisão não foi medido.** O
  decodificador foi validado contra o ONNX em float (IoU 0.99 na paridade com o
  ultralytics), o que cobre letterbox e decodificação, mas não o erro de
  quantização.
- **Ordem de canais na calibração.** O `inputmeta.yml` do exemplo do ai-sdk usa
  `reverse_channel: true`. Se o ACUITY carrega as imagens de calibração em RGB e
  a engine alimenta RGB, essa inversão introduz um descasamento. Compare a saída
  do `pegasus inference` com a do ONNX antes de confiar na precisão.

Medir precisão exige clipes rotulados da loja — ver `evaluation/`.
