import React from 'react';
import { query } from '../../api/db';
import { ShieldAlert, CheckCircle, AlertTriangle, Play, Calendar, MapPin } from 'lucide-react';
import { cookies } from 'next/headers';
import Link from 'next/link';
import { verifyToken } from '../../api/auth/tokens';

export const dynamic = 'force-dynamic';

interface EventData {
  id: number;
  store_name: string;
  store_location: string;
  appliance_name?: string;
  video_url: string;
  telemetry: any;
  suspicion_score: number;
  verdict: string;
  verdict_explanation: string | null;
  human_feedback?: string | null;
  analyzed_at: string;
}

interface StoreList {
  id: number;
  name: string;
}

export default async function EventsPage({
  searchParams,
}: {
  searchParams: { store?: string; verdict?: string };
}) {
  let events: EventData[] = [];
  let stores: StoreList[] = [];
  let isOffline = false;

  // 1. Resolver Sessão do Usuário via Cookies
  const cookieStore = cookies();
  const token = cookieStore.get('admin_token')?.value || '';
  
  // A assinatura e conferida antes de qualquer uso. Esta pagina decide o que o
  // usuario pode ver a partir de `role` e `store_id`, entao confiar no conteudo
  // do cookie sem validar permitiria forjar um administrador e ler os eventos
  // de todas as lojas.
  const user = verifyToken(token);

  const isLocalOnly = process.env.NEXT_PUBLIC_LOCAL_ONLY === 'true';

  // Se for Cloud e não estiver logado
  if (!user && !isLocalOnly) {
    return (
      <div className="flex flex-col items-center justify-center min-h-[50vh] space-y-4">
        <ShieldAlert className="text-rose-500 animate-pulse" size={48} />
        <h2 className="text-xl font-bold">Acesso não autorizado</h2>
        <p className="text-slate-500 text-sm">Por favor, faça login para visualizar os relatórios da loja.</p>
        <Link href="/login" className="px-4 py-2 bg-blue-600 hover:bg-blue-500 text-white rounded-lg text-sm font-semibold transition-colors">
          Ir para Login
        </Link>
      </div>
    );
  }

  const isClient = user?.role === 'client';
  const clientStoreId = user?.store_id;

  // Filtros selecionados
  let selectedStore = searchParams.store || '';
  const selectedVerdict = searchParams.verdict || '';

  // SEGURANÇA: Se o usuário for cliente, força o filtro a ser apenas a sua própria loja (ignora manipulações na URL)
  if (isClient && clientStoreId !== null && clientStoreId !== undefined) {
    selectedStore = clientStoreId.toString();
  }

  try {
    // 2. Obter lista de lojas para filtros (admins visualizam todas, clientes não usam)
    if (!isClient) {
      const storesRes = await query('SELECT id, name FROM stores ORDER BY name ASC');
      stores = storesRes.rows as StoreList[];
    }

    // 3. Obter eventos filtrados
    let queryText = `
      SELECT e.id, e.video_url, e.telemetry, e.suspicion_score, e.verdict, e.verdict_explanation, e.human_feedback, e.analyzed_at,
             s.name as store_name, s.location as store_location,
             a.label as appliance_name
      FROM events e
      JOIN stores s ON e.store_id = s.id
      LEFT JOIN appliances a ON e.appliance_id = a.id
      WHERE 1=1
    `;
    const params: any[] = [];

    if (selectedStore) {
      params.push(parseInt(selectedStore));
      queryText += ` AND e.store_id = $${params.length}`;
    }
    if (selectedVerdict) {
      params.push(selectedVerdict);
      queryText += ` AND e.verdict = $${params.length}`;
    }

    queryText += ` ORDER BY e.analyzed_at DESC LIMIT 50`;

    const eventsRes = await query(queryText, params);
    events = eventsRes.rows as EventData[];

    // Fallback de demonstração offline se o banco central estiver vazio
    if (events.length === 0 && !selectedStore && !selectedVerdict) {
      isOffline = true;
      stores = [
        { id: 1, name: 'Supermercado Extra - Loja Centro' },
        { id: 2, name: 'Supermercado Pão de Açúcar - Pinheiros' }
      ];
      events = [
        {
          id: 101,
          store_name: 'Supermercado Extra - Loja Centro',
          store_location: 'São Paulo - SP',
          video_url: 'https://www.w3schools.com/html/mov_bbb.mp4',
          telemetry: { p_id: 4, products: ['Carne Nobre (Picanha)', 'Whisky Red Label'] },
          suspicion_score: 0.89,
          verdict: 'FURTO_CONFIRMADO',
          verdict_explanation: 'Indivíduo de jaqueta preta retirou duas peças de carne da gôndola e uma garrafa de destilado e as inseriu por dentro do zíper da jaqueta. Evidência visual inequívoca de ocultação de produto.',
          analyzed_at: new Date().toISOString()
        },
        {
          id: 102,
          store_name: 'Supermercado Pão de Açúcar - Pinheiros',
          store_location: 'São Paulo - SP',
          video_url: 'https://www.w3schools.com/html/mov_bbb.mp4',
          telemetry: { p_id: 12, products: ['Azeite de Oliva Extra Virgem'] },
          suspicion_score: 0.72,
          verdict: 'SUSPEITO',
          verdict_explanation: 'Cliente pegou três garrafas de azeite e colocou em uma sacola plástica particular no chão. Permaneceu olhando ao redor frequentemente. Recomendada verificação pelo operador local.',
          analyzed_at: new Date(Date.now() - 30 * 60000).toISOString()
        },
        {
          id: 103,
          store_name: 'Supermercado Extra - Loja Centro',
          store_location: 'São Paulo - SP',
          video_url: 'https://www.w3schools.com/html/mov_bbb.mp4',
          telemetry: { p_id: 7, products: ['Celular (Pertence Pessoal)'] },
          suspicion_score: 0.12,
          verdict: 'INOCENTADO',
          verdict_explanation: 'O suspeito apenas retirou o próprio telefone celular do bolso para olhar a tela e o guardou de volta na calça. Não houve interação com produtos da prateleira.',
          analyzed_at: new Date(Date.now() - 120 * 60000).toISOString()
        }
      ];

      // Se for cliente, filtra os dados de mock locais para garantir consistência no teste visual
      if (isClient && clientStoreId !== null && clientStoreId !== undefined) {
        events = events.filter(e => e.store_name.includes(clientStoreId === 1 ? 'Extra' : 'Pão de Açúcar'));
      }
    }
  } catch (err) {
    console.error('Erro na auditoria de eventos:', err);
    isOffline = true;
  }

  return (
    <div className="space-y-8 animate-in fade-in duration-500">
      <div className="flex justify-between items-start">
        <div>
          <h1 className="text-3xl font-extrabold tracking-tight bg-gradient-to-r from-blue-400 to-indigo-500 bg-clip-text text-transparent">
            {isClient ? 'Minha Loja — Auditoria de Vídeo' : 'Auditoria Global de Eventos'}
          </h1>
          <p className="text-slate-400 text-sm mt-1">
            {isClient ? 'Clipes e veredictos multimodal do Gemini coletados no R2 da sua loja' : 'Galeria de clipes auditados pela inteligência multimodal do Gemini na nuvem'}
          </p>
        </div>
        {isOffline && (
          <span className="px-3 py-1 bg-amber-950/40 text-amber-400 border border-amber-800/40 rounded-full text-xs font-bold font-mono">
            ⚠️ MODO DEMONSTRAÇÃO (BANCO LOCAL)
          </span>
        )}
      </div>

      {/* Barra de Filtros */}
      <div className="bg-slate-900/40 border border-slate-800/80 p-4 rounded-xl flex flex-wrap gap-4 items-center">
        <form method="GET" className="flex flex-wrap gap-4 w-full">
          {!isClient && (
            <div className="flex flex-col">
              <span className="text-[10px] uppercase font-bold text-slate-500 mb-1 ml-1">Filtrar por Loja</span>
              <select
                name="store"
                defaultValue={selectedStore}
                className="bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-sm text-slate-200 focus:outline-none focus:border-blue-500"
              >
                <option value="">Todas as Lojas</option>
                {stores.map(s => (
                  <option key={s.id} value={s.id}>{s.name}</option>
                ))}
              </select>
            </div>
          )}

          <div className="flex flex-col">
            <span className="text-[10px] uppercase font-bold text-slate-500 mb-1 ml-1">Filtrar por Veredicto</span>
            <select
              name="verdict"
              defaultValue={selectedVerdict}
              className="bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-sm text-slate-200 focus:outline-none focus:border-blue-500"
            >
              <option value="">Todos</option>
              <option value="FURTO_CONFIRMADO">Furto Confirmado</option>
              <option value="SUSPEITO">Suspeito</option>
              <option value="INOCENTADO">Inocentado</option>
            </select>
          </div>

          <button
            type="submit"
            className="mt-5 px-4 py-2 bg-blue-600 hover:bg-blue-500 text-white rounded-lg text-sm font-semibold transition-colors self-end"
          >
            Aplicar Filtros
          </button>

          {(!isClient && (selectedStore || selectedVerdict)) && (
            <Link
              href="/dashboard/events"
              className="mt-5 px-4 py-2 bg-slate-800 hover:bg-slate-700 text-slate-300 rounded-lg text-sm font-semibold transition-colors self-end"
            >
              Limpar
            </Link>
          )}
        </form>
      </div>

      {/* Grid de Eventos */}
      {events.length === 0 ? (
        <div className="text-center p-12 bg-slate-900/20 border border-slate-800/40 rounded-2xl">
          <p className="text-slate-500 text-lg">Nenhum evento suspeito registrado nesta loja.</p>
        </div>
      ) : (
        <div className="grid grid-cols-1 xl:grid-cols-2 gap-8">
          {events.map(event => {
            let badgeStyle = '';
            let BadgeIcon = AlertTriangle;

            if (event.verdict === 'FURTO_CONFIRMADO') {
              badgeStyle = 'bg-rose-950/40 text-rose-400 border border-rose-800/40';
              BadgeIcon = ShieldAlert;
            } else if (event.verdict === 'SUSPEITO') {
              badgeStyle = 'bg-amber-950/40 text-amber-400 border border-amber-800/40';
              BadgeIcon = AlertTriangle;
            } else {
              badgeStyle = 'bg-emerald-950/40 text-emerald-400 border border-emerald-800/40';
              BadgeIcon = CheckCircle;
            }

            return (
              <div
                key={event.id}
                className="bg-slate-900/50 border border-slate-800/80 rounded-2xl backdrop-blur-md overflow-hidden flex flex-col md:flex-row hover:border-slate-700/80 transition-all duration-300 group"
              >
                {/* Visualizador de Vídeo */}
                <div className="relative w-full md:w-72 bg-slate-950 flex flex-col justify-center items-center overflow-hidden border-b md:border-b-0 md:border-r border-slate-800/60 min-h-[180px]">
                  <video
                    src={event.video_url}
                    controls
                    preload="none"
                    className="w-full h-full object-cover group-hover:scale-[1.02] transition-transform duration-500"
                  />
                  <div className="absolute top-3 left-3 bg-slate-950/80 backdrop-blur-sm px-2 py-1 rounded text-[10px] font-mono text-slate-400 border border-slate-800/60">
                    ID: #{event.id}
                  </div>
                </div>

                {/* Detalhes do Evento */}
                <div className="p-6 flex-1 flex flex-col justify-between space-y-4">
                  <div>
                    <div className="flex justify-between items-start gap-4 mb-3">
                      <div>
                        <span className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-bold ${badgeStyle}`}>
                          <BadgeIcon size={12} />
                          {event.verdict.replace('_', ' ')}
                        </span>
                        {event.human_feedback && (
                          <span className={`ml-2 inline-flex items-center gap-1.5 px-2 py-1 rounded-full text-[10px] font-bold ${event.human_feedback === 'TRUE_POSITIVE' ? 'bg-emerald-900/30 text-emerald-400 border border-emerald-800/30' : 'bg-slate-800/50 text-slate-400 border border-slate-700/50'}`}>
                            {event.human_feedback === 'TRUE_POSITIVE' ? '✔ CONFIRMADO (HUMANO)' : '✖ ALARME FALSO'}
                          </span>
                        )}
                      </div>
                      <span className="text-xs text-slate-500 font-mono flex items-center gap-1">
                        <Calendar size={12} />
                        {new Date(event.analyzed_at).toLocaleString('pt-BR')}
                      </span>
                    </div>

                    <h3 className="text-lg font-bold text-white mb-1 group-hover:text-blue-400 transition-colors">
                      {event.store_name}
                    </h3>
                    <p className="text-xs text-slate-500 flex items-center gap-1 mb-4">
                      <MapPin size={12} />
                      {event.store_location}
                      {event.appliance_name && (
                        <span className="ml-2 px-1.5 py-0.5 bg-slate-800 rounded font-mono text-[10px]">{event.appliance_name}</span>
                      )}
                    </p>

                    <div className="bg-slate-950/50 p-3 rounded-lg border border-slate-800/40 text-sm text-slate-300 leading-relaxed max-h-32 overflow-y-auto custom-scrollbar">
                      <strong className="text-slate-400 block mb-1 text-xs uppercase tracking-wider">Auditoria Gemini:</strong>
                      {event.verdict_explanation || 'Sem explicação detalhada.'}
                    </div>
                  </div>

                  {!event.human_feedback && !isOffline && (
                    <div className="flex gap-2 mt-4">
                      <button className="flex-1 py-1.5 bg-emerald-900/20 hover:bg-emerald-900/40 text-emerald-400 border border-emerald-800/30 rounded text-xs font-bold transition-colors">
                        Confirmar Acerto (Verdadeiro)
                      </button>
                      <button className="flex-1 py-1.5 bg-slate-800/40 hover:bg-slate-700/50 text-slate-300 border border-slate-700/50 rounded text-xs font-bold transition-colors">
                        Alarme Falso (Falso Positivo)
                      </button>
                    </div>
                  )}

                  {/* Rodapé do Evento */}
                  <div className="pt-4 border-t border-slate-800/40 flex justify-between items-center text-xs">
                    <span className="text-slate-500">
                      Produtos: <strong className="text-slate-300 font-medium">
                        {event.telemetry?.products ? event.telemetry.products.join(', ') : 'Nenhum'}
                      </strong>
                    </span>
                    <span className="text-slate-500 font-mono">
                      Confiança: <strong className="text-blue-400">{(event.suspicion_score * 100).toFixed(0)}%</strong>
                    </span>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
