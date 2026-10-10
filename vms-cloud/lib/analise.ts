import { GoogleGenerativeAI } from '@google/generative-ai';

/**
 * Análise de um frame pelo Gemini.
 *
 * Duas partes, separadas de propósito:
 *   - `interpretarResposta` e `validarEntrada` são funções puras. Decidem o que
 *     é uma resposta aceitável. Testadas sem rede.
 *   - `criarAnalisadorGemini` faz a chamada. Fica atrás da interface `Analisador`,
 *     então a ingestão é testada com um analisador falso.
 *
 * Regra: resposta fora do formato é ERRO, não "sem indício". Um fallback silencioso
 * transformaria falha do modelo em falso negativo invisível.
 */

export const VEREDICTOS = ['SUSPEITO', 'SEM_INDICIO', 'INCONCLUSIVO'] as const;
export type Veredicto = (typeof VEREDICTOS)[number];

export interface Analise {
  veredicto: Veredicto;
  confianca: number;
  resumo: string;
  rotulos: string[];
  modelo: string;
}

export class ErroDeAnalise extends Error {}

const TAMANHO_MAXIMO_RESUMO = 500;
const MAXIMO_ROTULOS = 10;
const TAMANHO_MAXIMO_ROTULO = 40;

export const PROMPT_ANALISE = `Você analisa UM frame de câmera de uma loja e verifica se há sinais de ocultação de mercadoria (furto).

Regras:
- Descreva apenas comportamento e objetos. Não identifique pessoas e não estime idade, gênero ou etnia.
- Marque SUSPEITO somente com evidência visível de produto sendo ocultado.
- Marque INCONCLUSIVO quando a imagem não permitir concluir: oclusão, baixa qualidade, ninguém em quadro.
- Responda SOMENTE com JSON neste formato:
{"veredicto": "SUSPEITO" | "SEM_INDICIO" | "INCONCLUSIVO", "confianca": número entre 0 e 1, "resumo": "até 300 caracteres, em português", "rotulos": ["até 10 rótulos curtos"]}`;

/** Interpreta o texto devolvido pelo modelo. Lança ErroDeAnalise se não for aceitável. */
export function interpretarResposta(texto: string): Omit<Analise, 'modelo'> {
  let dados: unknown;
  try {
    dados = JSON.parse(texto);
  } catch {
    throw new ErroDeAnalise('o modelo não devolveu JSON válido');
  }
  if (typeof dados !== 'object' || dados === null || Array.isArray(dados)) {
    throw new ErroDeAnalise('a resposta do modelo não é um objeto');
  }
  const r = dados as Record<string, unknown>;

  if (typeof r.veredicto !== 'string' || !(VEREDICTOS as readonly string[]).includes(r.veredicto)) {
    throw new ErroDeAnalise(`veredicto inválido: ${String(r.veredicto)}`);
  }

  // Rejeita em vez de corrigir: um modelo que devolve 0–100 em vez de 0–1 está
  // errado, e "consertar" a escala esconderia isso.
  if (typeof r.confianca !== 'number' || !Number.isFinite(r.confianca) || r.confianca < 0 || r.confianca > 1) {
    throw new ErroDeAnalise('confiança fora do intervalo 0–1');
  }

  if (typeof r.resumo !== 'string' || r.resumo.trim() === '') {
    throw new ErroDeAnalise('resumo ausente');
  }

  const rotulos = Array.isArray(r.rotulos) ? r.rotulos : [];
  const rotulosLimpos = rotulos
    .filter((x): x is string => typeof x === 'string' && x.trim() !== '')
    .map((x) => x.trim().slice(0, TAMANHO_MAXIMO_ROTULO))
    .slice(0, MAXIMO_ROTULOS);

  return {
    veredicto: r.veredicto as Veredicto,
    confianca: r.confianca,
    resumo: r.resumo.trim().slice(0, TAMANHO_MAXIMO_RESUMO),
    rotulos: rotulosLimpos,
  };
}

export interface EntradaAnalise {
  jpegBase64: string;
  contexto: string;
}

export interface Analisador {
  analisar(entrada: EntradaAnalise): Promise<Analise>;
}

const TIMEOUT_MS = 20_000;

export function criarAnalisadorGemini(opcoes: { chave?: string; modelo?: string } = {}): Analisador {
  const chave = opcoes.chave ?? process.env.GEMINI_API_KEY;
  const modelo = opcoes.modelo ?? process.env.GEMINI_MODEL ?? 'gemini-2.5-flash';

  return {
    async analisar({ jpegBase64, contexto }) {
      if (!chave) {
        throw new ErroDeAnalise('GEMINI_API_KEY não configurada');
      }
      const genAI = new GoogleGenerativeAI(chave);
      const m = genAI.getGenerativeModel({
        model: modelo,
        generationConfig: { responseMimeType: 'application/json', temperature: 0.1 },
      });
      const resposta = await m.generateContent(
        {
          contents: [
            {
              role: 'user',
              parts: [
                { text: `${PROMPT_ANALISE}\n\nContexto do equipamento: ${contexto}` },
                { inlineData: { mimeType: 'image/jpeg', data: jpegBase64 } },
              ],
            },
          ],
        },
        { timeout: TIMEOUT_MS },
      );
      return { ...interpretarResposta(resposta.response.text()), modelo };
    },
  };
}

// ── Validação da entrada do agente ───────────────────────────────────

const MAXIMO_BASE64 = 2_000_000; // ~1,5 MB de JPEG
const TOLERANCIA_FUTURO_MS = 5 * 60 * 1000;
const JANELA_ANTIGUIDADE_MS = 24 * 60 * 60 * 1000;
const MAXIMO_METADADOS_BYTES = 4096;

export interface EntradaEvento {
  cameraRef: string;
  cameraNome: string | null;
  ocorridoEm: Date;
  jpegBase64: string;
  metadados: Record<string, unknown> | null;
}

export type ResultadoValidacao =
  | { ok: true; valor: EntradaEvento }
  | { ok: false; erro: string };

/**
 * Valida o corpo enviado pelo agente. `agora` é injetável para teste.
 * Rejeita o que não deve ser analisado: JPEG inválido, data absurda, corpo gigante.
 */
export function validarEntrada(corpo: unknown, agora = Date.now()): ResultadoValidacao {
  if (typeof corpo !== 'object' || corpo === null || Array.isArray(corpo)) {
    return { ok: false, erro: 'corpo deve ser um objeto JSON' };
  }
  const c = corpo as Record<string, unknown>;

  if (typeof c.camera_ref !== 'string' || c.camera_ref.trim() === '' || c.camera_ref.length > 80) {
    return { ok: false, erro: 'camera_ref é obrigatório (1 a 80 caracteres)' };
  }

  let cameraNome: string | null = null;
  if (c.camera_nome !== undefined && c.camera_nome !== null) {
    if (typeof c.camera_nome !== 'string' || c.camera_nome.length > 120) {
      return { ok: false, erro: 'camera_nome deve ser texto de até 120 caracteres' };
    }
    cameraNome = c.camera_nome.trim() || null;
  }

  if (typeof c.ocorrido_em !== 'string') {
    return { ok: false, erro: 'ocorrido_em é obrigatório (ISO 8601)' };
  }
  const ocorridoEm = new Date(c.ocorrido_em);
  if (Number.isNaN(ocorridoEm.getTime())) {
    return { ok: false, erro: 'ocorrido_em não é uma data válida' };
  }
  if (ocorridoEm.getTime() > agora + TOLERANCIA_FUTURO_MS) {
    return { ok: false, erro: 'ocorrido_em está no futuro' };
  }
  if (ocorridoEm.getTime() < agora - JANELA_ANTIGUIDADE_MS) {
    return { ok: false, erro: 'ocorrido_em é mais antigo que 24 horas' };
  }

  if (typeof c.imagem_jpeg_base64 !== 'string' || c.imagem_jpeg_base64.length === 0) {
    return { ok: false, erro: 'imagem_jpeg_base64 é obrigatório' };
  }
  if (c.imagem_jpeg_base64.length > MAXIMO_BASE64) {
    return { ok: false, erro: 'imagem acima do tamanho permitido (1,5 MB)' };
  }
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(c.imagem_jpeg_base64)) {
    return { ok: false, erro: 'imagem_jpeg_base64 contém caracteres inválidos' };
  }
  // Magic bytes FF D8 FF em base64 começam com "/9j/". Confere que é JPEG de fato.
  if (!c.imagem_jpeg_base64.startsWith('/9j/')) {
    return { ok: false, erro: 'a imagem precisa ser JPEG' };
  }

  let metadados: Record<string, unknown> | null = null;
  if (c.metadados !== undefined && c.metadados !== null) {
    if (typeof c.metadados !== 'object' || Array.isArray(c.metadados)) {
      return { ok: false, erro: 'metadados deve ser um objeto' };
    }
    if (JSON.stringify(c.metadados).length > MAXIMO_METADADOS_BYTES) {
      return { ok: false, erro: 'metadados acima de 4 KB' };
    }
    metadados = c.metadados as Record<string, unknown>;
  }

  return {
    ok: true,
    valor: {
      cameraRef: c.camera_ref.trim(),
      cameraNome,
      ocorridoEm,
      jpegBase64: c.imagem_jpeg_base64,
      metadados,
    },
  };
}
