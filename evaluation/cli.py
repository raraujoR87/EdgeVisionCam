"""
Ferramenta de linha de comando para medir a acurácia do sistema.

Fluxo:

    1. exportar   → gera um arquivo de rotulagem a partir dos eventos gravados
    2. (humano)   → preenche `verdadeiro` em cada linha assistindo ao clipe
    3. pontuar    → compara os rótulos com os veredictos e imprime o relatório

Uso:
    python -m evaluation.cli exportar --saida rotulos.json
    python -m evaluation.cli pontuar  --rotulos rotulos.json
    python -m evaluation.cli pontuar  --rotulos rotulos.json --json > metricas.json
"""

import argparse
import json
import os
import sqlite3
import sys

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

from evaluation.metrics import avaliar, formatar_relatorio  # noqa: E402

QUEUE_DB = os.path.join(
    os.path.dirname(__file__), "..", "core", "database", "data", "queue.db"
)


def carregar_eventos(caminho_db: str):
    """Lê os eventos já processados pelo appliance."""
    if not os.path.exists(caminho_db):
        raise SystemExit(
            f"Banco de eventos não encontrado em {caminho_db}.\n"
            "Rode a partir da pasta do appliance, ou use --db."
        )

    conexao = sqlite3.connect(caminho_db)
    conexao.row_factory = sqlite3.Row
    linhas = conexao.execute(
        "SELECT id, timestamp, status, video_path, suspicion_score, payload_json "
        "FROM events ORDER BY timestamp DESC"
    ).fetchall()
    conexao.close()
    return [dict(l) for l in linhas]


def comando_exportar(args):
    eventos = carregar_eventos(args.db)
    if not eventos:
        raise SystemExit("Nenhum evento gravado ainda. Deixe o sistema rodar antes.")

    # `verdadeiro: null` é o que o humano precisa preencher. Deixar nulo em vez
    # de false evita que um arquivo não revisado seja pontuado como se todos os
    # eventos fossem inocentes — o que produziria uma precisão artificialmente
    # péssima e nenhum aviso.
    saida = {
        "_instrucoes": (
            "Assista a cada clipe e defina 'verdadeiro': true se houve furto/"
            "ocultação real, false caso contrário. Deixe null para pular o "
            "evento. Rotule ao menos 100 eventos para que os números signifiquem "
            "algo."
        ),
        "eventos": [
            {
                "id": e["id"],
                "clipe": e["video_path"],
                "timestamp": e["timestamp"],
                "veredicto_sistema": e["status"],
                "score_borda": e["suspicion_score"],
                "verdadeiro": None,
                "observacao": "",
            }
            for e in eventos
        ],
    }

    with open(args.saida, "w", encoding="utf-8") as f:
        json.dump(saida, f, indent=2, ensure_ascii=False)

    print(f"{len(eventos)} evento(s) exportado(s) para {args.saida}")
    print("Preencha o campo 'verdadeiro' de cada um e rode:")
    print(f"  python -m evaluation.cli pontuar --rotulos {args.saida}")


def comando_pontuar(args):
    with open(args.rotulos, encoding="utf-8") as f:
        dados = json.load(f)

    eventos = dados.get("eventos", dados if isinstance(dados, list) else [])

    rotulados = [e for e in eventos if e.get("verdadeiro") is not None]
    pendentes = len(eventos) - len(rotulados)

    if not rotulados:
        raise SystemExit(
            "Nenhum evento rotulado. Preencha o campo 'verdadeiro' "
            "(true/false) antes de pontuar."
        )

    pares = [
        {
            "id": e.get("id"),
            "clipe": e.get("clipe", ""),
            "verdadeiro": e["verdadeiro"],
            "veredicto": e.get("veredicto_sistema", "PENDING"),
        }
        for e in rotulados
    ]

    resultado = avaliar(pares)

    if args.json:
        print(json.dumps(resultado.como_dicionario(), indent=2, ensure_ascii=False))
        return

    print(formatar_relatorio(resultado))
    if pendentes:
        print(f"\n  ({pendentes} evento(s) ainda sem rótulo, ignorado(s))")


def main():
    parser = argparse.ArgumentParser(description=__doc__,
                                     formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = parser.add_subparsers(dest="comando", required=True)

    p_exp = sub.add_parser("exportar", help="Gera o arquivo de rotulagem")
    p_exp.add_argument("--db", default=QUEUE_DB, help="Caminho do queue.db")
    p_exp.add_argument("--saida", default="rotulos.json", help="Arquivo a gerar")
    p_exp.set_defaults(func=comando_exportar)

    p_pon = sub.add_parser("pontuar", help="Calcula as métricas")
    p_pon.add_argument("--rotulos", required=True, help="Arquivo rotulado")
    p_pon.add_argument("--json", action="store_true", help="Saída em JSON")
    p_pon.set_defaults(func=comando_pontuar)

    args = parser.parse_args()
    args.func(args)


if __name__ == "__main__":
    main()
