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

**`--optimize VIP9000NANODI_PLUS_PID0X1000003B`** — identifica a configuração
exata do silício. **Confirmado pelo hardware:** o `vpm_run` reporta
`cid=0x1000003b` nesta placa, que é exatamente o PID acima. O valor foi deduzido
de `machinfo/a733/config.mk` do ai-sdk e depois verificado no silício:

```
NPU_VERSION    = v3       ← geração do silício, escolhe o PID
NPU_SW_VERSION = v2.0     ← versão do driver, escolhe as bibliotecas
```

São coisas diferentes, e é fácil confundi-las — `v2.0` no nome do driver não
significa geração `v2`. Pelo `pegasus_setup.sh`, `v3` mapeia para
`VIP9000NANODI_PLUS_PID0X1000003B`. O A733 é da mesma família do **t536/t736**,
não do t527 (que é `v2` / `NPU_SW_VERSION=v1.13`).

Um PID de outra variante compila sem erro e produz um grafo que a NPU recusa ou
executa errado. `deploy/instalar_npu_sdk.sh` compara o chip ID reportado com o
PID configurado e avisa em caso de divergência — vale a pena rodá-lo numa placa
nova antes de compilar. Se precisar de outra variante:

```bash
OPTIMIZE=VIP9000NANOSI_PLUS_PID0X10000016 bash npu_compilation/compilar_nbg.sh  # v2: t527/mr527/ai985
OPTIMIZE=VIP9000PICO_PID0XEE              bash npu_compilation/compilar_nbg.sh  # v1: v85x/r853
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

O `vpm_run` recebe um arquivo de configuração, **não** o `.nb` direto:

```bash
cd ~/EdgeVisionCam/edge
printf '[network]\n./yolov8n-pose.nb\n' > sample.txt
vpm_run -s sample.txt
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

- **O binding em `edge/viplite.py` não executou numa NPU.** Foi transcrito de
  `vip_lite.h` e a ordem das chamadas segue o `vpm_run.c` do ai-sdk, mas nenhuma
  linha do *nosso* código rodou no silício. O que já está provado, pelo teste de
  fumaça do `deploy/instalar_npu_sdk.sh`: driver, runtime, ABI das bibliotecas e
  o próprio silício.
- **O efeito da quantização INT8 sobre a precisão não foi medido.** O
  decodificador foi validado contra o ONNX em float (IoU 0.99 na paridade com o
  ultralytics), o que cobre letterbox e decodificação, mas não o erro de
  quantização.
- **Ordem de canais na calibração.** O `inputmeta.yml` do exemplo do ai-sdk usa
  `reverse_channel: true`. Se o ACUITY carrega as imagens de calibração em RGB e
  a engine alimenta RGB, essa inversão introduz um descasamento. Compare a saída
  do `pegasus inference` com a do ONNX antes de confiar na precisão.

Medir precisão exige clipes rotulados da loja — ver `evaluation/`.

## Fatos confirmados no hardware

Colhidos do teste de fumaça em 2026-08-01, numa Radxa Cubie A7A. Servem de
referência para comparar quando algo divergir:

```
VIPLite driver software version 2.0.3.2-AW-2024-08-30
cid=0x1000003b, device_count=1, core_count=1
```

Do NBG de referência (224x224x3, rede trivial):

```
create network    1902 us
prepare network    934 us
inferência        2808 us   (2.77 M ciclos)
```

Formato dos tensores, que valida as convenções assumidas em `edge/viplite.py`:

| | valor | significado |
|---|---|---|
| `data_format=2` | `VIP_BUFFER_FORMAT_UINT8` | entrada e saída em uint8 |
| `quant_format=2` | `VIP_BUFFER_QUANTIZE_TF_ASYMM` | escala + zero point |
| entrada `scale=0.003922` | 1/255 | confirma `mean=0, scale=1/255` |
| entrada `zero_point=0` | — | faixa 0–255 mapeia 0.0–1.0 |
| saída `scale=0.001625, zero_point=128` | — | saída centrada, precisa desquantizar |

O `scale=0.003922` na entrada é a confirmação mais útil: é exatamente o
pré-processamento que `VivantePoseEngine._infer_npu` aplica (`canvas_rgb/255.0`)
e o que `compilar_nbg.sh` grava em `channel_mean_value.txt`.
