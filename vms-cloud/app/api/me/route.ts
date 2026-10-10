import { sessaoDaRequisicao } from '../../../lib/auth';
import { comUsuario } from '../../../lib/tenant';
import { erro, falhaDoBanco, json } from '../../../lib/http';

export const dynamic = 'force-dynamic';

/**
 * Quem é você e o que pode ver. Alimenta o menu e o seletor de organização.
 *
 * A lista de organizações vem da RLS: o que não aparece aqui não existe para
 * você. O menu é conveniência; a autorização de verdade está no banco.
 */
export async function GET(request: Request) {
  const sessao = sessaoDaRequisicao(request);
  if (!sessao) return erro(401, 'Não autenticado.');

  try {
    const dados = await comUsuario(sessao.uid, async (c) => {
      const usuario = await c.query(
        'SELECT id, email, is_platform_admin FROM users WHERE id = app_user_id()',
      );
      if (!usuario.rowCount) return null;

      const vinculos = await c.query(
        `SELECT o.id, o.name, o.slug, o.plan, o.status, m.role
           FROM memberships m
           JOIN organizations o ON o.id = m.organization_id
          WHERE m.user_id = app_user_id()
          ORDER BY o.name`,
      );
      return { usuario: usuario.rows[0], vinculos: vinculos.rows };
    });

    if (!dados) return erro(401, 'Sessão inválida.');

    const { usuario, vinculos } = dados;
    const plataforma = usuario.is_platform_admin as boolean;
    const escopo = plataforma ? 'fornecedor' : vinculos.length ? 'cliente' : 'sem_acesso';

    return json({
      usuario: { id: usuario.id, email: usuario.email },
      plataforma,
      escopo,
      organizacoes: vinculos.map((v) => ({
        id: v.id, nome: v.name, slug: v.slug, plano: v.plan, status: v.status, papel: v.role,
      })),
    });
  } catch (e) {
    return falhaDoBanco(e, 'me GET');
  }
}
