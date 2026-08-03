import { NextResponse } from 'next/server';
import { comInquilino, contextoDoToken, sessaoDaRequisicao } from '../tenant';
import { ehSuperAdmin } from '../papeis';

export const dynamic = 'force-dynamic';

/**
 * Quem é o usuário, e o que ele pode ver.
 *
 * O console do cliente precisa saber três coisas antes de desenhar qualquer
 * tela: a que organizações a pessoa pertence, com que papel em cada uma, e
 * quais lojas isso alcança. Sem essa resposta, a interface adivinha — foi o que
 * a versão anterior fez, com uma lista de caminhos proibidos escrita à mão no
 * layout. Uma tela nova esquecida nessa lista vira um vazamento de navegação.
 *
 * A autorização de verdade continua no banco (RLS) e nas rotas. Isto aqui só
 * evita mostrar ao usuário portas que ele não conseguiria abrir.
 */

export async function GET(request: Request) {
  const sessao = sessaoDaRequisicao(request);
  if (!sessao) {
    return NextResponse.json({ error: 'Não autenticado.' }, { status: 401 });
  }

  const superAdmin = ehSuperAdmin(sessao.role);

  try {
    const dados = await comInquilino(contextoDoToken(sessao), async (cliente) => {
      // As duas consultas passam pela RLS: um usuário sem associação recebe
      // listas vazias, e é exatamente o que deve ver.
      const orgs = await cliente.query(
        `SELECT o.id, o.name, o.slug, o.plan, o.status,
                COALESCE(m.role, $2) AS papel
           FROM organizations o
           LEFT JOIN memberships m
                  ON m.organization_id = o.id AND m.user_id = $1
          ORDER BY o.name`,
        [sessao.id ?? 0, superAdmin ? 'SUPER_ADMIN' : 'STORE_VIEWER'],
      );

      const lojas = await cliente.query(
        `SELECT s.id, s.name, s.location, s.organization_id
           FROM stores s
          ORDER BY s.name`,
      );

      return { organizacoes: orgs.rows, lojas: lojas.rows };
    });

    // O papel efetivo do cliente é o mais alto que ele tem em qualquer
    // organização. Um gestor regional que administra uma rede e só observa
    // outra precisa ver o menu de equipe — a rota é que decide, por
    // organização, se a ação passa.
    const papeis = dados.organizacoes.map((o: any) => o.papel);
    const papelEfetivo = superAdmin
      ? 'SUPER_ADMIN'
      : papeis.includes('STORE_ADMIN')
        ? 'STORE_ADMIN'
        : papeis.includes('STORE_OPERATOR')
          ? 'STORE_OPERATOR'
          : 'STORE_VIEWER';

    return NextResponse.json({
      usuario: { id: sessao.id ?? null, email: sessao.email },
      papel: papelEfetivo,
      super_admin: superAdmin,
      // Um super admin sem associação nenhuma ainda é fornecedor. Um usuário
      // comum sem associação não é nada, e o console diz isso em vez de
      // mostrar uma tela vazia sem explicação.
      escopo: superAdmin ? 'fornecedor' : dados.organizacoes.length ? 'cliente' : 'sem_acesso',
      organizacoes: dados.organizacoes,
      lojas: dados.lojas,
    });
  } catch (erro: any) {
    console.error('[me GET]', erro);
    return NextResponse.json({ error: 'Falha ao carregar a sessão.' }, { status: 500 });
  }
}
