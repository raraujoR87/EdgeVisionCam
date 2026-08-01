"""
Adaptação do stack ao hardware que realmente está na bancada.

O docker-compose.yml versionado descreve o appliance de referência: Radxa com
4 GB, driver da NPU Vivante carregado e GPU exposta em /dev/dri. Nada disso é
garantido no campo — placas chegam com 2 GB, kernels sem o módulo da NPU,
imagens de sistema sem DRI.

Duas dessas divergências derrubam a instalação de forma difícil de diagnosticar:

  - `devices:` no Compose é obrigatório. Se o node da NPU não existe, o Frigate
    não sobe e o erro fala de "device not found", sem indicar que o problema é
    o driver do kernel. Um técnico na loja não tem como saber disso.

  - `mem_limit` é teto de contenção: existe para que um vazamento derrube o
    container culpado, e não uma vítima sorteada pelo OOM killer do host. A
    soma dos tetos passar da RAM física é normal — nem todos chegam ao teto ao
    mesmo tempo. O que quebra a proteção é um teto individual MAIOR que a RAM:
    numa placa de 2 GB, o limite de 2 GB do visioncam-core nunca dispara, o
    processo consome a placa inteira antes disso e o kernel mata outra coisa.
    O sintoma vira "o Frigate reinicia sozinho às vezes".

Em vez de pedir que alguém edite YAML na loja, este módulo inspeciona a placa e
gera um override que o Compose sobrepõe ao base. O arquivo versionado continua
sendo a única fonte do stack; aqui só sai o delta do hardware.
"""

import os

# Devices de aceleração usados quando existem. A ausência degrada o desempenho
# (decode e inferência caem na CPU), mas não impede o sistema de funcionar —
# por isso são opcionais, e não pré-requisito.
#
# O node da NPU é /dev/vipcore, não /dev/galcore. O A733 traz uma VeriSilicon
# VIP9000 acessada pelo driver VIPLite (módulo `sunxi_npu`), e não a pilha
# clássica Vivante/galcore usada em outros SoCs. Procurar galcore devolve
# "NPU ausente" numa placa cuja NPU está perfeitamente funcional — foi assim
# que esta configuração passou semanas rodando em CPU sem ninguém notar.
# O nome do modulo varia por BSP: `vipcore` na imagem da Radxa para o A733,
# `sunxi_npu` em builds da Allwinner. Ver edge/viplite.MODULOS_KERNEL.
NPU_DEVICE = "/dev/vipcore"
NPU_MODULO = "vipcore"

DEVICES_OPCIONAIS = [
    ("/dev/dri", "decode de vídeo por hardware"),
    (NPU_DEVICE, "NPU VeriSilicon VIP9000 (VIPLite)"),
]

# Perfis de memória, do maior para o menor.
#
# Cada entrada é (ram_minima_mb, alvo_mb, nome, {serviço: mem_limit}), onde
# `alvo_mb` é a placa para a qual os tetos foram calibrados. Nenhum teto pode
# passar do alvo: um limite acima da RAM física nunca dispara e o container
# deixa de ser contido.
PERFIS_DE_MEMORIA = [
    (3500, 4096, "completo", {}),  # usa os limites do compose base
    (1800, 2048, "reduzido", {
        "visioncam-core": "1g",
        "frigate": "640m",
        "visioncam-ui": "256m",
    }),
    (0, 1024, "mínimo", {
        "visioncam-core": "768m",
        "frigate": "512m",
        "visioncam-ui": "192m",
    }),
]

ARQUIVO_OVERRIDE = "docker-compose.hardware.yml"


def devices_presentes(raiz="/"):
    """
    Devices de aceleração que existem nesta placa.

    `raiz` existe para os testes: apontando para um diretório temporário dá
    para simular placas sem tocar em /dev.
    """
    encontrados = []
    for caminho, descricao in DEVICES_OPCIONAIS:
        real = os.path.join(raiz, caminho.lstrip("/"))
        if os.path.exists(real):
            encontrados.append((caminho, descricao))
    return encontrados


def memoria_total_mb(caminho="/proc/meminfo"):
    """
    RAM física em MB, ou None quando não dá para determinar.

    None não é tratado como "pouca memória": chutar para baixo limitaria o
    appliance sem motivo. Na dúvida, mantém-se o perfil do compose base.
    """
    try:
        with open(caminho, encoding="utf-8") as arquivo:
            for linha in arquivo:
                if linha.startswith("MemTotal:"):
                    return int(linha.split()[1]) // 1024
    except (OSError, ValueError, IndexError):
        return None
    return None


def escolher_perfil(total_mb):
    """Perfil de memória adequado à RAM disponível."""
    if total_mb is None:
        return PERFIS_DE_MEMORIA[0]
    for perfil in PERFIS_DE_MEMORIA:
        if total_mb >= perfil[0]:
            return perfil
    return PERFIS_DE_MEMORIA[-1]


def montar_override(devices, limites):
    """
    YAML do override, ou string vazia quando o hardware casa com o base.

    Devolver vazio importa: um arquivo de override sem conteúdo útil só
    confunde quem for depurar o appliance depois.
    """
    frigate = []
    if devices:
        frigate.append("    devices:")
        for caminho, descricao in devices:
            frigate.append(f"      - {caminho}:{caminho}   # {descricao}")
    if "frigate" in limites:
        frigate.append(f"    mem_limit: {limites['frigate']}")

    blocos = []
    if frigate:
        blocos.append("  frigate:\n" + "\n".join(frigate))
    for servico in ("visioncam-core", "visioncam-ui"):
        if servico in limites:
            blocos.append(f"  {servico}:\n    mem_limit: {limites[servico]}")

    if not blocos:
        return ""

    cabecalho = (
        "# Gerado automaticamente por edge_hardware.py — NÃO EDITE À MÃO.\n"
        "# Reflete o hardware desta placa; é reescrito a cada instalação.\n"
        "# O stack em si vive no docker-compose.yml versionado.\n"
        "services:\n"
    )
    return cabecalho + "\n".join(blocos) + "\n"


def aplicar(destino=ARQUIVO_OVERRIDE, raiz="/", meminfo="/proc/meminfo"):
    """
    Inspeciona a placa, grava (ou remove) o override e devolve o resumo.

    O resumo é feito para virar log do instalador: o técnico precisa enxergar
    que a NPU ficou de fora, senão vai atribuir a lentidão a outra coisa.
    """
    devices = devices_presentes(raiz)
    total_mb = memoria_total_mb(meminfo)
    _, _, perfil, limites = escolher_perfil(total_mb)

    conteudo = montar_override(devices, limites)
    if conteudo:
        with open(destino, "w", encoding="utf-8") as arquivo:
            arquivo.write(conteudo)
    elif os.path.exists(destino):
        # Placa trocada ou driver instalado depois: um override antigo
        # continuaria exigindo um device que talvez não exista mais.
        os.remove(destino)

    ausentes = [
        descricao
        for caminho, descricao in DEVICES_OPCIONAIS
        if caminho not in [d[0] for d in devices]
    ]

    return {
        "devices": [d[0] for d in devices],
        "ausentes": ausentes,
        "memoria_mb": total_mb,
        "perfil": perfil,
        "override_gerado": bool(conteudo),
    }


def descrever(resumo):
    """Resumo em linhas para o log do instalador."""
    linhas = []
    if resumo["devices"]:
        linhas.append("Aceleração de hardware: " + ", ".join(resumo["devices"]))
    else:
        linhas.append("Nenhum device de aceleração encontrado — inferência na CPU.")
    for ausente in resumo["ausentes"]:
        linhas.append(f"  ausente: {ausente} (o sistema sobe, porém mais lento)")

    if resumo["memoria_mb"] is None:
        linhas.append("RAM não determinada — mantendo os limites padrão.")
    else:
        linhas.append(
            f"RAM: {resumo['memoria_mb']}MB — perfil de memória '{resumo['perfil']}'."
        )
    return linhas
