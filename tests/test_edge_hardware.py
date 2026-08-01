"""
Testes da adequação do stack ao hardware.

O erro que este módulo evita não aparece em bancada: aparece na loja, quando
uma placa diferente da de referência recusa subir e ninguém sabe por quê.
"""

import os
import sys

import pytest
import yaml

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

import edge_hardware as hw  # noqa: E402

COMPOSE = os.path.join(os.path.dirname(__file__), "..", "docker-compose.yml")


def _compose_base():
    with open(COMPOSE, encoding="utf-8") as arquivo:
        return yaml.safe_load(arquivo)


def _limites_do_compose():
    """mem_limit de cada serviço do compose base, em MB."""
    limites = {}
    for nome, servico in _compose_base()["services"].items():
        bruto = servico.get("mem_limit")
        if bruto:
            limites[nome] = int(bruto[:-1]) * (1024 if bruto.endswith("g") else 1)
    return limites


# ── Detecção de devices ────────────────────────────────────────────

def test_placa_sem_aceleracao_nao_declara_devices(tmp_path):
    """Declarar um device inexistente impede o Frigate de subir."""
    assert hw.devices_presentes(str(tmp_path)) == []


def test_detecta_apenas_os_devices_existentes(tmp_path):
    """
    Uma placa com GPU mas sem driver da NPU é caso comum: a imagem de sistema
    traz DRI, o galcore depende de um módulo fora da árvore.
    """
    (tmp_path / "dev").mkdir()
    (tmp_path / "dev" / "dri").mkdir()

    encontrados = hw.devices_presentes(str(tmp_path))
    assert [c for c, _ in encontrados] == ["/dev/dri"]


# ── Perfis de memória ──────────────────────────────────────────────

def test_meminfo_ilegivel_nao_encolhe_os_limites(tmp_path):
    """
    Chutar para baixo limitaria o appliance sem motivo. Na dúvida, mantém-se o
    perfil do compose base.
    """
    assert hw.memoria_total_mb(str(tmp_path / "inexistente")) is None
    assert hw.escolher_perfil(None)[2] == "completo"


def test_leitura_de_meminfo(tmp_path):
    meminfo = tmp_path / "meminfo"
    meminfo.write_text("MemTotal:        3963224 kB\nMemFree:  100 kB\n", encoding="utf-8")
    assert hw.memoria_total_mb(str(meminfo)) == 3870


@pytest.mark.parametrize(
    "total_mb,esperado",
    [(4096, "completo"), (3500, "completo"), (3499, "reduzido"), (2048, "reduzido"), (1024, "mínimo")],
)
def test_perfil_por_faixa_de_ram(total_mb, esperado):
    assert hw.escolher_perfil(total_mb)[2] == esperado


def _mb(valor):
    return int(valor[:-1]) * (1024 if valor.endswith("g") else 1)


def test_nenhum_teto_passa_da_ram_da_placa():
    """
    Um mem_limit maior que a RAM física nunca dispara: o container consome a
    placa inteira antes de chegar ao teto e o OOM killer do host mata outro
    processo. É exatamente a falha que os perfis existem para evitar, então
    vale para todos eles — inclusive o base, medido contra 4 GB.
    """
    base = _limites_do_compose()
    for _, alvo_mb, nome, limites in hw.PERFIS_DE_MEMORIA:
        efetivos = {**base, **{s: _mb(v) for s, v in limites.items()}}
        for servico, valor in efetivos.items():
            assert valor < alvo_mb, f"perfil '{nome}': {servico} com {valor}MB para {alvo_mb}MB"


def test_perfis_encolhem_monotonicamente():
    """
    Um perfil menor que afrouxasse algum teto entregaria à placa mais fraca o
    limite calibrado para a mais forte — o inverso do propósito.
    """
    anterior = _limites_do_compose()
    for _, _, nome, limites in hw.PERFIS_DE_MEMORIA:
        atual = {**anterior, **{s: _mb(v) for s, v in limites.items()}}
        for servico, valor in atual.items():
            assert valor <= anterior[servico], f"perfil '{nome}' aumentou {servico}"
        anterior = atual


# ── Geração do override ────────────────────────────────────────────

def test_hardware_de_referencia_nao_gera_override():
    """Um arquivo de override vazio só atrapalha quem for depurar depois."""
    assert hw.montar_override([], {}) == ""


def test_override_e_yaml_valido_e_mapeia_os_devices():
    devices = [("/dev/dri", "decode"), ("/dev/galcore", "NPU")]
    limites = {"visioncam-core": "1g", "frigate": "640m", "visioncam-ui": "256m"}

    doc = yaml.safe_load(hw.montar_override(devices, limites))

    assert doc["services"]["frigate"]["devices"] == ["/dev/dri:/dev/dri", "/dev/galcore:/dev/galcore"]
    assert doc["services"]["frigate"]["mem_limit"] == "640m"
    assert doc["services"]["visioncam-core"]["mem_limit"] == "1g"
    assert doc["services"]["visioncam-ui"]["mem_limit"] == "256m"


def test_override_so_com_devices_nao_inventa_limite():
    doc = yaml.safe_load(hw.montar_override([("/dev/dri", "decode")], {}))
    assert "mem_limit" not in doc["services"]["frigate"]
    assert list(doc["services"].keys()) == ["frigate"]


def test_servicos_do_override_existem_no_compose_base():
    """
    Um nome divergente vira um serviço novo e órfão em vez de sobrepor o
    original: o Compose aceita sem reclamar e o limite simplesmente não vale.
    """
    base = _compose_base()
    for _, _, _, limites in hw.PERFIS_DE_MEMORIA:
        for servico in limites:
            assert servico in base["services"], f"{servico} não existe no compose base"


def test_override_de_build_casa_com_o_compose_base():
    """
    Um serviço com nome divergente vira serviço novo em vez de sobrepor, e a
    build local sairia sem efeito: o `up` seguiria usando a imagem baixada.
    """
    caminho = os.path.join(os.path.dirname(__file__), "..", "docker-compose.build.yml")
    with open(caminho, encoding="utf-8") as arquivo:
        build = yaml.safe_load(arquivo)

    base = _compose_base()
    raiz = os.path.join(os.path.dirname(__file__), "..")

    for nome, servico in build["services"].items():
        assert nome in base["services"], f"{nome} não existe no compose base"
        # Sem `image:` no base, a build local não teria como assumir o nome que
        # o `up` procura.
        assert "image" in base["services"][nome], f"{nome} não define image no base"
        # pull_policy: never impede que o `up` baixe do registro por cima da
        # imagem recém-construída.
        assert servico.get("pull_policy") == "never", f"{nome} pode ser sobrescrito por pull"

        contexto = os.path.join(raiz, servico["build"]["context"])
        dockerfile = os.path.join(contexto, servico["build"]["dockerfile"])
        assert os.path.isfile(dockerfile), f"{nome}: {dockerfile} não existe"


def test_scripts_de_deploy_sao_executaveis_e_validos():
    """
    Um script sem bit de execução ou com erro de sintaxe só falha na hora do
    upgrade, com a loja parada.
    """
    import subprocess

    deploy = os.path.join(os.path.dirname(__file__), "..", "deploy")
    for nome in ("diagnostico.sh", "atualizar.sh", "reverter.sh", "preparar_appliance.sh"):
        caminho = os.path.join(deploy, nome)
        assert os.path.isfile(caminho), f"{nome} ausente"
        assert subprocess.run(["bash", "-n", caminho]).returncode == 0, f"{nome} tem erro de sintaxe"


def test_ordem_dos_overrides_igual_a_do_instalador():
    """
    O upgrade e a instalação limpa precisam produzir o mesmo stack. Se a ordem
    dos -f divergir, o resultado difere e a diferença só aparece em campo.
    """
    raiz = os.path.join(os.path.dirname(__file__), "..")
    with open(os.path.join(raiz, "deploy", "atualizar.sh"), encoding="utf-8") as arquivo:
        script = arquivo.read()
    with open(os.path.join(raiz, "bootstrap_installer.py"), encoding="utf-8") as arquivo:
        instalador = arquivo.read()

    for arquivo_compose in ("docker-compose.hardware.yml", "docker-compose.mgmt.yml"):
        assert arquivo_compose in script, f"{arquivo_compose} não entra em atualizar.sh"

    assert script.index("docker-compose.hardware.yml") < script.index("docker-compose.mgmt.yml")
    assert instalador.index("edge_hardware.ARQUIVO_OVERRIDE") < instalador.index("MGMT_OVERRIDE)")


def test_compose_base_nao_exige_devices():
    """
    Se os devices voltarem para o base, a placa sem galcore volta a falhar — e
    o override deixa de ter propósito.
    """
    assert "devices" not in _compose_base()["services"]["frigate"]


# ── Aplicação ──────────────────────────────────────────────────────

def test_aplicar_grava_override_em_placa_pequena(tmp_path):
    (tmp_path / "dev").mkdir()
    (tmp_path / "dev" / "galcore").write_text("")
    meminfo = tmp_path / "meminfo"
    meminfo.write_text("MemTotal:        2000000 kB\n", encoding="utf-8")
    destino = tmp_path / hw.ARQUIVO_OVERRIDE

    resumo = hw.aplicar(str(destino), str(tmp_path), str(meminfo))

    assert resumo["override_gerado"]
    assert resumo["devices"] == ["/dev/galcore"]
    assert resumo["perfil"] == "reduzido"
    assert "decode de vídeo por hardware" in resumo["ausentes"]
    assert "/dev/galcore:/dev/galcore" in destino.read_text(encoding="utf-8")


def test_aplicar_remove_override_obsoleto(tmp_path):
    """
    Placa trocada ou driver removido: um override antigo continuaria exigindo
    um device que não existe mais, e o Frigate pararia de subir sem que nada
    aparente tivesse mudado.
    """
    meminfo = tmp_path / "meminfo"
    meminfo.write_text("MemTotal:        4000000 kB\n", encoding="utf-8")
    destino = tmp_path / hw.ARQUIVO_OVERRIDE
    destino.write_text("services:\n  frigate:\n    devices:\n      - /dev/galcore:/dev/galcore\n")

    resumo = hw.aplicar(str(destino), str(tmp_path), str(meminfo))

    assert not resumo["override_gerado"]
    assert not destino.exists()


def test_descricao_avisa_que_a_npu_ficou_de_fora(tmp_path):
    """
    Sem esse aviso no log, a lentidão da CPU é atribuída a rede, câmera ou
    modelo — qualquer coisa menos a causa real.
    """
    meminfo = tmp_path / "meminfo"
    meminfo.write_text("MemTotal:        4000000 kB\n", encoding="utf-8")

    resumo = hw.aplicar(str(tmp_path / hw.ARQUIVO_OVERRIDE), str(tmp_path), str(meminfo))
    texto = "\n".join(hw.descrever(resumo))

    assert "CPU" in texto
    assert "NPU Vivante" in texto
