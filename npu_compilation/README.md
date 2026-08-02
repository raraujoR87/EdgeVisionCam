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

## Compilando no Windows

O PC Windows **serve** — ele é x86_64, e o container do ACUITY roda nele
nativamente. O que não roda no Windows são os scripts em bash. A ponte é o
**WSL2**, que o próprio Docker Desktop já usa como backend.

```powershell
# PowerShell como administrador
wsl --install
```

Reinicie, e instale o [Docker Desktop](https://www.docker.com/products/docker-desktop/).
Em *Settings → Resources → WSL Integration*, ative a distro (Ubuntu).

A partir daí, tudo acontece dentro do Ubuntu do WSL:

```bash
git clone https://github.com/raraujoR87/EdgeVisionCam.git
cd EdgeVisionCam
git checkout claude/ajustes-radxa
bash npu_compilation/preparar_host.sh
```

O `docker` dentro do WSL fala com o Docker Desktop do Windows — não é preciso
instalar Docker separado.

### Dois detalhes que economizam tempo

**Trabalhe no sistema de arquivos do Linux**, não em `/mnt/c/...`. O acesso do
WSL ao disco do Windows passa por uma camada de tradução e fica ordens de
grandeza mais lento — com ~11 GB de imagem e milhares de arquivos temporários
do ACUITY, a diferença é de minutos para horas.

**Memória.** Por padrão o WSL2 toma até metade da RAM do host. Se a máquina
tiver 8 GB ou menos, vale limitar para o Windows não travar, criando
`C:\Users\<você>\.wslconfig`:

```ini
[wsl2]
memory=8GB
swap=8GB
```

Depois `wsl --shutdown` e abra de novo.

### E na Radxa, não dá?

Tecnicamente dá — com `qemu-user-static` e `binfmt_misc` a placa executa
containers x86. Mas não compensa:

- emulação x86 sobre ARM roda 5 a 20× mais devagar, e a quantização já é a
  etapa pesada;
- o ACUITY é baseado em TensorFlow; nos 4 GB da placa, com a stack de produção
  no ar (~2,2 GB livres), a chance de OOM no meio da quantização é alta;
- ~15 GB de imagem ocupando o armazenamento do appliance.

Seria trocar o caminho fácil pelo difícil. Se ainda assim for a única opção,
o roteiro é `docker run --platform linux/amd64` depois de
`docker run --privileged --rm tonistiigi/binfmt --install amd64` — mas conte
com horas em vez de minutos, e com a possibilidade de não terminar.

## Passo 0 — preparar o host

```bash
bash npu_compilation/preparar_host.sh
# se ainda não tem Docker:
INSTALAR_DOCKER=1 bash npu_compilation/preparar_host.sh
```

Verifica arquitetura, espaço em disco, Docker, a imagem do ACUITY e as
dependências Python.

### A imagem do ACUITY

**Não está no Docker Hub.** É um download da Netdisk da Allwinner:

```
https://netstorage.allwinnertech.com:5001/fsdownload/Mh23BhPHq/
```

`docker_images_v2.0.x` é uma **pasta**, não um arquivo. Entre nela e baixe o
`ubuntu-npu_<versão>.tar.zip` — a revisão muda com o tempo (v2.0.10.1,
v2.0.10.2, …), e os scripts aceitam qualquer `ubuntu-npu:*` que estiver
carregada:

```
docker_images_v2.0.x/ubuntu-npu_v2.0.10.2.tar.zip
```

**Não use "baixar pasta".** O Synology monta esse zip em tempo real durante a
transferência, e para 11 GB ele trunca com frequência. O resultado é um arquivo
aparentemente completo que o `unzip` recusa com *"End-of-central-directory
signature not found"* — sem indicar que a causa foi o download.

```bash
unzip ubuntu-npu_*.tar.zip
docker load -i ubuntu-npu_*.tar
docker images | grep ubuntu-npu
```

Reserve ~35 GB no pico (zip + extraído + imagem carregada). Apague o zip e o
`.tar` **logo após** o `docker load`.

> **No WSL isso é uma armadilha.** O `df` dentro da distro mostra o teto
> virtual do `ext4.vhdx` (~1 TB), não o espaço real. O limite é o disco do
> Windows, onde o VHDX cresce. Quando ele acaba, o sintoma **não** é "disco
> cheio": são erros de I/O em binários do sistema (`/usr/bin/sed: Input/output
> error`) e `Bus error`, que parecem corrupção da distro. Se isso acontecer:
> libere espaço no Windows, rode `wsl --shutdown` no PowerShell e reabra.

Se o link estiver fora do ar, o roteiro oficial está em
`docs.radxa.com/en/cubie/a7a/app-dev/npu-dev/cubie_acuity_env`.

O `readme` que acompanha a imagem confirma o conteúdo e a forma de uso:

| | v2.0.10.2 |
|---|---|
| ACUITY | 6.30.22 |
| Vivante IDE | 5.11.0 |
| `ACUITY_PATH` | `~/acuity-toolkit-whl-x.x.x/bin` |

O `x.x.x` é do próprio fabricante — a versão está no nome do diretório e muda
entre revisões. Por isso `compilar_nbg.sh` descobre os caminhos do ACUITY e do
Vivante IDE dentro do container em vez de fixá-los.

O readme também é explícito quanto ao uso: *"o container serve apenas como
ambiente de desenvolvimento; o código fica num diretório da máquina Linux local
e o container acessa por montagem de arquivos"* — que é exatamente o desenho do
`compilar_nbg.sh` (`-v $RAIZ/npu_compilation/trabalho:/work`).

**Documentação oficial da NPU:** baixe o `aw_npu_model_zoo` em
[open.allwinnertech.com](https://open.allwinnertech.com/); os documentos estão
em `aw_npu_model_zoo/docs`. É a fonte mais completa sobre operadores suportados
— útil se o `pegasus import` recusar alguma camada do YOLO.

Não há substituto aberto: o formato NBG é proprietário e o compilador também.

### Se o unzip reclamar

```bash
ls -lh ubuntu-npu_*.tar.zip   # esperado: ~11 GB
file  ubuntu-npu_*.tar.zip    # esperado: "Zip archive data"
```

| O que aparece | O que aconteceu |
|---|---|
| poucos KB, `HTML document` | veio a página de login/erro, não o arquivo |
| tamanho parcial | download interrompido — refaça, de preferência com um gerenciador que retome |
| ~11 GB mas `unzip` falha | baixou a pasta em vez do arquivo, ou o zip truncou |

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

A quantização INT8 dimensiona as escalas de cada tensor a partir destas
imagens. Se elas não se parecerem com o que a câmera vê — iluminação da loja,
ângulo, distância das pessoas, cor das prateleiras — as escalas ficam
calibradas para outra distribuição e a precisão cai **no dispositivo**. Não no
teste: o teste roda o ONNX em float e continua verde.

**A câmera e o banco vivem na placa, não no PC que compila.** Colete lá e traga
as imagens:

```bash
# na Radxa
bash npu_compilation/coletar_calibracao.sh
```

Roda dentro do container `visioncam-core`, que já tem OpenCV e enxerga o banco
e os clipes. Tenta, nesta ordem: câmera ao vivo → clipes de evento gravados →
COCO. Ao final diz de onde vieram as imagens — se aparecer COCO, nem a câmera
nem os clipes foram alcançados, e vale investigar antes de compilar.

```bash
# no PC (WSL), dentro do clone
scp -r radxa@IP:~/EdgeVisionCam/npu_compilation/calibration_images ./npu_compilation/
python3 npu_compilation/prepare_calibration.py --dir npu_compilation/calibration_images
```

Se o appliance já roda há algum tempo, os clipes de evento são uma fonte
excelente: são exatamente as cenas que o sistema precisa acertar.

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

### Quantização — leia antes de compilar

O padrão é `pcq` (`perchannel_symmetric_affine`, `qtype int8`).

**Correção de uma afirmação anterior deste documento:** eu dizia que o `pcq`
resolvia a diferença de faixa dinâmica entre as cabeças do YOLO. Não resolve.
`pcq` dá uma escala por canal aos **pesos**; o **tensor de saída** continua
quantizado por tensor, com uma escala só. E o problema está exatamente ali.

A saída do YOLOv8-pose é uma linha concatenada:

```
[cx, cy, w, h,  conf,  kpt_x, kpt_y, kpt_conf, ...]
 └── 0..320 ──┘ └0..1┘ └── 0..320 ──┘ └─ 0..1 ─┘
```

Uma escala única é dominada pelas coordenadas. Medido nesta placa: **1,57**.
Com `int8`, o valor real é `q × 1,57`, então a confiança só consegue
representar `0` ou `1,57` — tudo abaixo de 0,785 vira zero. O detector perde a
confiança inteira, e o sintoma é "class scores zerados", não um erro.

Ordem para atacar, do mais barato ao mais trabalhoso:

```bash
# 1. int16: escala cai para ~0,006 e a confiança ganha ~160 níveis.
#    Um comando, sem mudar código. Mais lento que int8, ainda muito
#    mais rápido que os 120-145 ms de CPU.
QUANT=int16 bash npu_compilation/compilar_nbg.sh
```

**2. Separar as saídas no ONNX.** Exportar sem o `Concat` final, de modo que
caixas, confiança e keypoints saiam como tensores distintos — cada um com sua
própria escala. É a solução canônica para YOLO em NPU, e exige ajustar o
decodificador para múltiplas saídas.

**3. Quantização híbrida**, mantendo a camada de saída em `bf16`/`fp16`.

```bash
QUANT=uint8 bash npu_compilation/compilar_nbg.sh   # asymmetric_affine
QUANT=bf16  bash npu_compilation/compilar_nbg.sh   # sem quantização real
```

Não tente compensar isso no decodificador. Já foi tentado — usar a confiança
máxima dos keypoints no lugar da confiança da caixa — e o resultado foi
**excesso de falsos positivos em quadros vazios**. Num antifurto isso é pior
que não detectar: alarme sem ninguém na cena destrói a confiança do operador
no sistema. A informação foi perdida na quantização; nenhum pós-processamento
a recupera.

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
