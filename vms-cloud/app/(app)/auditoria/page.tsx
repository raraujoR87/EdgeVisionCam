"use client"
import React, { useState } from 'react';
import useSWR from 'swr';
import { ScrollText } from 'lucide-react';
import { Cabecalho, Cartao, Carregando, Erro, Vazio, Botao, buscar, quando } from '../../../components/ui';
import { useApp } from '../../../components/contexto-app';

/**
 * Auditoria: quem fez o quê, e quando. Só cresce: não há como editar ou apagar
 * um registro por esta tela nem pela API.
 */

const POR_PAGINA = 50;

const ROTULOS: Record<string, string> = {
  'evento.revisado': 'Revisou um alerta',
  'evento.revisao_desfeita': 'Desfez uma revisão',
  'membro.papel_alterado': 'Alterou um papel',
  'membro.removido': 'Removeu um membro',
  'convite.criado': 'Criou um convite',
  'convite.cancelado': 'Cancelou um convite',
  'convite.aceito': 'Aceitou um convite',
  'agente.criado': 'Criou um agente',
  'agente.revogado': 'Revogou um agente',
  'local.criado': 'Criou um local',
  'assistente.consulta': 'Consultou o assistente',
  'organizacao.criada': 'Criou um cliente',
  'organizacao.alterada': 'Alterou um cliente',
};

export default function AuditoriaPage() {
  const { filtroOrg, podeAdministrar } = useApp();
  const [pagina, setPagina] = useState(0);
  const { data, error, isLoading, mutate } = useSWR(
    `/api/auditoria?limit=${POR_PAGINA}&offset=${pagina * POR_PAGINA}${filtroOrg ? `&${filtroOrg}` : ''}`,
    buscar,
  );

  if (!podeAdministrar) {
    return <div className="p-6 max-w-3xl mx-auto"><Vazio Icone={ScrollText} titulo="Restrito aos administradores" /></div>;
  }

  return (
    <div className="p-6 max-w-5xl mx-auto">
      <Cabecalho Icone={ScrollText} titulo="Auditoria"
        descricao="Registro de ações que alteram dados ou decisões. Não pode ser editado nem apagado." />
      {isLoading && <Carregando linhas={4} />}
      {error && <Erro mensagem={error.message} aoTentarNovamente={() => mutate()} />}
      {data && data.registros.length === 0 && <Vazio Icone={ScrollText} titulo="Nenhum registro ainda" />}

      {data && data.registros.length > 0 && (
        <Cartao className="p-2">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-[11px] uppercase tracking-wide text-slate-500 border-b border-slate-800">
                  <th className="text-left font-medium p-2.5">Quando</th>
                  <th className="text-left font-medium p-2.5">Quem</th>
                  <th className="text-left font-medium p-2.5">Ação</th>
                  <th className="text-left font-medium p-2.5">Detalhe</th>
                </tr>
              </thead>
              <tbody>
                {data.registros.map((r: any) => (
                  <tr key={r.id} className="border-b border-slate-800/60 last:border-0 align-top">
                    <td className="p-2.5 text-xs text-slate-400 whitespace-nowrap">{quando(r.created_at)}</td>
                    <td className="p-2.5 text-xs text-slate-300">{r.ator ?? r.actor_email ?? 'sistema'}</td>
                    <td className="p-2.5 text-slate-200">{ROTULOS[r.action] ?? r.action}</td>
                    <td className="p-2.5 text-[11px] text-slate-500 font-mono break-all">
                      {r.detail ? JSON.stringify(r.detail) : '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Cartao>
      )}
      {data && (pagina > 0 || data.tem_mais) && (
        <div className="flex justify-end gap-2 mt-4">
          <Botao variante="secundario" disabled={pagina === 0} onClick={() => setPagina((p) => p - 1)}>Anterior</Botao>
          <Botao variante="secundario" disabled={!data.tem_mais} onClick={() => setPagina((p) => p + 1)}>Próxima</Botao>
        </div>
      )}
    </div>
  );
}
