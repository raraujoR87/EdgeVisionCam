"""
Métricas de classificação para os veredictos do sistema.

Implementadas à mão, sem scikit-learn: são quatro contagens e cinco divisões, e
não vale arrastar mais uma dependência pesada para a imagem do appliance.
"""

from dataclasses import dataclass, field
from typing import Dict, List, Optional


# Veredictos possíveis do pipeline. O local usa THEFT_CONFIRMED/CLEARED, o
# cognitivo usa FURTO_CONFIRMADO/SUSPEITO/INOCENTADO — ambos reduzidos ao
# binário "isto vira alerta para o lojista?".
VEREDICTOS_ALERTA = {"THEFT_CONFIRMED", "FURTO_CONFIRMADO", "SUSPEITO"}
VEREDICTOS_LIMPO = {"CLEARED", "INOCENTADO", "PENDING"}


def e_alerta(veredicto: str) -> bool:
    """
    True se o veredicto resultaria em alerta ao lojista.

    SUSPEITO conta como alerta: na prática ele mobiliza alguém a abordar o
    cliente, então um SUSPEITO sobre um inocente carrega o mesmo custo de um
    falso positivo declarado.
    """
    return veredicto.strip().upper() in VEREDICTOS_ALERTA


@dataclass
class Resultado:
    """Matriz de confusão e as métricas derivadas dela."""

    verdadeiro_positivo: int = 0   # furto real, alertado
    falso_positivo: int = 0        # inocente, alertado  ← o erro caro
    verdadeiro_negativo: int = 0   # inocente, não alertado
    falso_negativo: int = 0        # furto real, não alertado
    erros: List[Dict] = field(default_factory=list)

    @property
    def total(self) -> int:
        return (self.verdadeiro_positivo + self.falso_positivo
                + self.verdadeiro_negativo + self.falso_negativo)

    @property
    def precisao(self) -> Optional[float]:
        """
        Dos alertas emitidos, quantos eram furto de verdade.

        É a métrica que o lojista sente: precisão de 0,6 significa que 4 em cada
        10 abordagens são sobre um cliente inocente.
        """
        emitidos = self.verdadeiro_positivo + self.falso_positivo
        return self.verdadeiro_positivo / emitidos if emitidos else None

    @property
    def revocacao(self) -> Optional[float]:
        """Dos furtos reais, quantos o sistema pegou."""
        reais = self.verdadeiro_positivo + self.falso_negativo
        return self.verdadeiro_positivo / reais if reais else None

    @property
    def f1(self) -> Optional[float]:
        p, r = self.precisao, self.revocacao
        if p is None or r is None or (p + r) == 0:
            return None
        return 2 * p * r / (p + r)

    @property
    def taxa_falso_alarme(self) -> Optional[float]:
        """
        Fração dos eventos inocentes que geraram alerta.

        Complementa a precisão: com poucos furtos na amostra, uma taxa de falso
        alarme baixa ainda pode produzir precisão ruim, e é essa combinação que
        determina se a operação aguenta o volume de abordagens.
        """
        inocentes = self.verdadeiro_negativo + self.falso_positivo
        return self.falso_positivo / inocentes if inocentes else None

    def como_dicionario(self) -> Dict:
        return {
            "total": self.total,
            "verdadeiro_positivo": self.verdadeiro_positivo,
            "falso_positivo": self.falso_positivo,
            "verdadeiro_negativo": self.verdadeiro_negativo,
            "falso_negativo": self.falso_negativo,
            "precisao": self.precisao,
            "revocacao": self.revocacao,
            "f1": self.f1,
            "taxa_falso_alarme": self.taxa_falso_alarme,
        }


def avaliar(pares) -> Resultado:
    """
    Compara veredictos do sistema com os rótulos humanos.

    `pares` é um iterável de dicionários com pelo menos `verdadeiro` (bool) e
    `veredicto` (str). Campos extras são preservados na lista de erros, para
    que o relatório consiga apontar quais clipes revisar.
    """
    r = Resultado()

    for par in pares:
        real = bool(par["verdadeiro"])
        alertou = e_alerta(par["veredicto"])

        if real and alertou:
            r.verdadeiro_positivo += 1
        elif real and not alertou:
            r.falso_negativo += 1
            r.erros.append({**par, "tipo_erro": "FALSO_NEGATIVO"})
        elif not real and alertou:
            r.falso_positivo += 1
            r.erros.append({**par, "tipo_erro": "FALSO_POSITIVO"})
        else:
            r.verdadeiro_negativo += 1

    return r


def formatar_relatorio(r: Resultado, titulo: str = "Acurácia do VisionCam") -> str:
    """Relatório de texto para terminal e para colar num e-mail."""

    def pct(valor: Optional[float]) -> str:
        return "n/d" if valor is None else f"{valor * 100:.1f}%"

    linhas = [
        "=" * 62,
        f"  {titulo}",
        "=" * 62,
        f"  Eventos avaliados: {r.total}",
        "",
        "  MATRIZ DE CONFUSÃO",
        f"    Furto detectado corretamente ...... {r.verdadeiro_positivo}",
        f"    Inocente alertado (falso positivo)  {r.falso_positivo}",
        f"    Furto não detectado ............... {r.falso_negativo}",
        f"    Inocente ignorado corretamente .... {r.verdadeiro_negativo}",
        "",
        "  MÉTRICAS",
        f"    Precisão .......... {pct(r.precisao)}   (dos alertas, quantos eram furto)",
        f"    Revocação ......... {pct(r.revocacao)}   (dos furtos, quantos pegou)",
        f"    F1 ................ {pct(r.f1)}",
        f"    Falso alarme ...... {pct(r.taxa_falso_alarme)}   (dos inocentes, quantos alertou)",
    ]

    if r.total == 0:
        linhas += ["", "  Nenhum evento rotulado. Veja evaluation/README.md."]
    elif r.total < 100:
        linhas += [
            "",
            f"  ⚠  Amostra de {r.total} eventos é pequena demais para conclusão.",
            "     Abaixo de ~100 rotulados, um acerto ou erro a mais move os",
            "     percentuais vários pontos. Trate como indicativo, não medida.",
        ]

    if r.falso_positivo:
        linhas += [
            "",
            f"  {r.falso_positivo} cliente(s) inocente(s) seriam abordado(s).",
            "  Revise estes clipes antes de ajustar limiares:",
        ]
        for e in r.erros:
            if e["tipo_erro"] == "FALSO_POSITIVO":
                linhas.append(f"    - {e.get('id', '?')}  {e.get('clipe', '')}")

    linhas.append("=" * 62)
    return "\n".join(linhas)
