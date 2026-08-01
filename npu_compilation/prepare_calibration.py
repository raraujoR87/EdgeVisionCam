"""
Monta o dataset de calibracao para a quantizacao INT8.

A quantizacao escolhe as escalas de cada tensor a partir das ativacoes
observadas nestas imagens. Se elas nao parecerem com o que a camera realmente
ve — iluminacao, angulo, distancia das pessoas, cor das prateleiras — as
escalas ficam mal dimensionadas e a precisao cai no dispositivo, nao no teste.
Por isso a ordem de preferencia e:

    1. Frames da propria camera configurada no appliance (melhor caso).
    2. Clipes de eventos ja gravados em edge/storage/events.
    3. Imagens genericas do COCO (ultimo recurso).

As fontes 1 e 2 so existem NA PLACA — a camera e o system.db vivem la, nao no
PC que compila. O caminho pratico e coletar na placa e trazer as imagens:

    # na Radxa
    bash npu_compilation/coletar_calibracao.sh
    # no PC
    scp -r radxa@IP:~/EdgeVisionCam/npu_compilation/calibration_images ./npu_compilation/
    python3 npu_compilation/prepare_calibration.py --dir npu_compilation/calibration_images

Uso:
    python3 npu_compilation/prepare_calibration.py                 # tenta 1, 2, 3
    python3 npu_compilation/prepare_calibration.py --fonte camera
    python3 npu_compilation/prepare_calibration.py --dir <pasta>   # ja coletadas
    python3 npu_compilation/prepare_calibration.py --quantidade 100
"""

import argparse
import glob
import os
import sqlite3
import sys

RAIZ = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
DIR_IMAGENS = os.path.join(os.path.dirname(__file__), "calibration_images")
ARQUIVO_DATASET = os.path.join(os.path.dirname(__file__), "calibrate_dataset.txt")

URLS_COCO = [
    "http://images.cocodataset.org/val2017/000000000139.jpg",
    "http://images.cocodataset.org/val2017/000000000285.jpg",
    "http://images.cocodataset.org/val2017/000000000632.jpg",
    "http://images.cocodataset.org/val2017/000000000724.jpg",
    "http://images.cocodataset.org/val2017/000000000776.jpg",
]


def rtsp_configurada():
    """Le a URL da camera ativa direto do system.db do appliance."""
    caminho = os.path.join(RAIZ, "core", "database", "data", "system.db")
    if not os.path.exists(caminho):
        return None
    try:
        conexao = sqlite3.connect(caminho)
        linha = conexao.execute(
            "SELECT rtsp_url FROM cameras WHERE is_active = 1 LIMIT 1"
        ).fetchone()
        conexao.close()
        return linha[0] if linha else None
    except Exception:
        return None


def capturar_da_camera(quantidade, intervalo_frames=15):
    """
    Captura frames espacados da camera ativa.

    O espacamento evita encher o dataset com frames quase identicos, que dariam
    ao quantizador uma visao estreita demais da cena.
    """
    import cv2

    url = rtsp_configurada()
    if not url:
        print("  [camera] Nenhuma câmera ativa no system.db.")
        return []

    print(f"  [camera] Capturando de: {url}")
    captura = cv2.VideoCapture(url)
    if not captura.isOpened():
        print("  [camera] Não foi possível abrir o stream.")
        return []

    salvos, lidos = [], 0
    while len(salvos) < quantidade:
        ok, frame = captura.read()
        if not ok:
            break
        if lidos % intervalo_frames == 0:
            destino = os.path.join(DIR_IMAGENS, f"cam_{len(salvos):04d}.jpg")
            cv2.imwrite(destino, frame)
            salvos.append(os.path.abspath(destino))
        lidos += 1
    captura.release()

    print(f"  [camera] {len(salvos)} frames capturados.")
    return salvos


def extrair_de_clipes(quantidade):
    """Aproveita os clipes de evento ja gravados — sao a cena real da loja."""
    import cv2

    clipes = sorted(glob.glob(os.path.join(RAIZ, "edge", "storage", "events", "*.mp4")))
    if not clipes:
        print("  [clipes] Nenhum clipe de evento encontrado.")
        return []

    print(f"  [clipes] {len(clipes)} clipes disponíveis.")
    salvos = []
    por_clipe = max(1, quantidade // len(clipes))

    for clipe in clipes:
        if len(salvos) >= quantidade:
            break
        captura = cv2.VideoCapture(clipe)
        total = int(captura.get(cv2.CAP_PROP_FRAME_COUNT)) or 1
        # Amostra ao longo do clipe inteiro, nao so do inicio.
        for i in range(por_clipe):
            captura.set(cv2.CAP_PROP_POS_FRAMES, int(total * (i + 0.5) / por_clipe))
            ok, frame = captura.read()
            if ok:
                destino = os.path.join(DIR_IMAGENS, f"clipe_{len(salvos):04d}.jpg")
                cv2.imwrite(destino, frame)
                salvos.append(os.path.abspath(destino))
        captura.release()

    print(f"  [clipes] {len(salvos)} frames extraídos.")
    return salvos


def usar_diretorio(caminho, quantidade):
    """
    Aproveita imagens ja coletadas — normalmente trazidas da placa.

    Existe porque a camera e o banco do appliance nao sao alcancaveis do PC que
    compila. Sem esta opcao, o unico caminho disponivel no PC seria o COCO, que
    e justamente o que degrada a precisao no dispositivo.
    """
    if not os.path.isdir(caminho):
        print(f"  [dir] {caminho} não é um diretório.")
        return []

    extensoes = ("*.jpg", "*.jpeg", "*.png")
    encontradas = []
    for extensao in extensoes:
        encontradas.extend(glob.glob(os.path.join(caminho, extensao)))
    encontradas.sort()

    if not encontradas:
        print(f"  [dir] Nenhuma imagem em {caminho}.")
        return []

    print(f"  [dir] {len(encontradas)} imagens em {caminho}.")
    return [os.path.abspath(c) for c in encontradas[:quantidade]]


def baixar_coco():
    """Ultimo recurso: imagens genericas, que nao representam a loja."""
    import urllib.request

    print("  [coco] Baixando imagens genéricas de referência...")
    salvos = []
    for i, url in enumerate(URLS_COCO):
        destino = os.path.join(DIR_IMAGENS, f"coco_{i}.jpg")
        try:
            urllib.request.urlretrieve(url, destino)
            salvos.append(os.path.abspath(destino))
        except Exception as erro:
            print(f"  [coco] Falha em {url}: {erro}")
    print(f"  [coco] {len(salvos)} imagens baixadas.")
    return salvos


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--fonte",
        choices=["auto", "camera", "clipes", "coco"],
        default="auto",
        help="Origem das imagens. 'auto' tenta câmera, depois clipes, depois COCO.",
    )
    parser.add_argument(
        "--dir",
        help=(
            "Diretório com imagens já coletadas (normalmente trazidas da placa "
            "por coletar_calibracao.sh). Tem precedência sobre --fonte."
        ),
    )
    parser.add_argument(
        "--quantidade",
        type=int,
        default=50,
        help="Número alvo de imagens. Entre 50 e 200 é o usual para INT8.",
    )
    args = parser.parse_args()

    print("=== Preparando dataset de calibração para quantização INT8 ===")
    os.makedirs(DIR_IMAGENS, exist_ok=True)

    imagens, origem = [], None
    if args.dir:
        imagens = usar_diretorio(args.dir, args.quantidade)
        origem = "diretorio" if imagens else None
        if not imagens:
            print("\n[ERRO] --dir informado mas sem imagens utilizáveis.")
            return 1
    if not imagens and args.fonte in ("auto", "camera"):
        imagens = capturar_da_camera(args.quantidade)
        origem = "camera" if imagens else None
    if not imagens and args.fonte in ("auto", "clipes"):
        imagens = extrair_de_clipes(args.quantidade)
        origem = "clipes" if imagens else None
    if not imagens and args.fonte in ("auto", "coco"):
        imagens = baixar_coco()
        origem = "coco" if imagens else None

    if not imagens:
        print("\n[ERRO] Nenhuma imagem de calibração obtida.")
        return 1

    with open(ARQUIVO_DATASET, "w", encoding="utf-8") as arquivo:
        for caminho in imagens:
            arquivo.write(f"{caminho}\n")

    print(f"\n[OK] {ARQUIVO_DATASET} gerado com {len(imagens)} imagens (fonte: {origem}).")

    if origem == "coco":
        print(
            "\n[AVISO] Calibrando com imagens genéricas do COCO. Elas não se"
            " parecem com a loja, e a quantização vai dimensionar as escalas"
            " para a distribuição errada — a precisão cai no dispositivo, sem"
            " aparecer em teste algum."
        )
        print(
            "        Colete na placa e traga as imagens:\n"
            "          bash npu_compilation/coletar_calibracao.sh   (na Radxa)\n"
            "          scp -r radxa@IP:~/EdgeVisionCam/npu_compilation/"
            "calibration_images ./npu_compilation/\n"
            "          python3 npu_compilation/prepare_calibration.py"
            " --dir npu_compilation/calibration_images"
        )

    print("\nPróximo passo: bash npu_compilation/compilar_nbg.sh")
    return 0


if __name__ == "__main__":
    sys.exit(main())
