import { sessaoDaRequisicao } from '../../../lib/auth';
import { comUsuario } from '../../../lib/tenant';
import { erro, falhaDoBanco, idDaUrl, inteiroDaUrl, json } from '../../../lib/http';

export const dynamic = 'force-dynamic';

/** Trilha de auditoria. A RLS deixa ler só para ADMIN da organização e fornecedor. */
export async function GET(request: Request) {
  const sessao = sessaoDaRequisicao(request);
  if (!sessao) return erro(401, 'Não autenticado.');
  const url = new URL(request.url);
  const organizationId = idDaUrl(url.searchParams.get('org'));
  const limite = inteiroDaUrl(url.searchParams.get('limit'), 50, 1, 200);
  const deslocamento = inteiroDaUrl(url.searchParams.get('offset'), 0, 0, 100_000);

  try {
    const registros = await comUsuario(sessao.uid, async (c) => {
      const params: unknown[] = [];
      let onde = '';
      if (organizationId) { params.push(organizationId); onde = 'WHERE a.organization_id = $1'; }
      const r = await c.query(
        `SELECT a.id, a.created_at, a.action, a.actor_email, a.actor_user_id,
                a.target_type, a.target_id, a.detail, a.ip_address, a.organization_id,
                u.email AS ator
           FROM audit_log a LEFT JOIN users u ON u.id = a.actor_user_id
           ${onde}
          ORDER BY a.created_at DESC, a.id DESC
          LIMIT ${limite + 1} OFFSET ${deslocamento}`,
        params,
      );
      // Busca uma linha a mais: é o que diz se há próxima página, sem contar tudo.
      return r.rows;
    });
    const temMais = registros.length > limite;
    return json({ registros: registros.slice(0, limite), tem_mais: temMais, limite, offset: deslocamento });
  } catch (e) {
    return falhaDoBanco(e, 'auditoria GET');
  }
}
