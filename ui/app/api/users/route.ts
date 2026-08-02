import { NextResponse } from 'next/server';
import { verifyToken, TokenPayload } from '../auth/tokens';
import { gerarHash } from '../auth/passwords';
import {
  comInquilino,
  contextoDoToken,
  registrarAuditoria,
  ipDaRequisicao,
} from '../tenant';
import {
  ehSuperAdmin,
  papelDeOrganizacaoValido,
  PAPEIS_DE_ORGANIZACAO,
  STORE_ADMIN,
} from '../papeis';

export const dynamic = 'force-dynamic';

/**
 * Gestão de usuários e associações.
 *
 * A versão anterior tratava `users.store_id` como o vínculo: um usuário
 * pertencia a UMA loja, com UM papel para a vida toda. O vínculo agora é a
 * associação (`memberships`), que permite a mesma pessoa ser STORE_ADMIN numa
 * rede e VIEWER em outra — o caso do gestor regional e da franquia.
 *
 * `users.store_id` continua sendo preenchido enquanto a migração não termina.
 * Remover uma coluna ainda lida por código em produção derruba a aplicação no
 * intervalo entre a migração e o deploy.
 */



function extrairSessao(request: Request): TokenPayload | null {
  const header = request.headers.get('Authorization') || '';
  if (!header.startsWith('Bearer ')) return null;
  try {
    return verifyToken(header.slice(7).trim());
  } catch {
    console.error('[users] Não foi possível validar o token.');
    return null;
  }
}



async function orgsQueAdministra(cliente: any, userId: number | string): Promise<number[]> {
  const res = await cliente.query(
    `SELECT organization_id FROM memberships
      WHERE user_id = $1 AND role = 'STORE_ADMIN'`,
    [userId],
  );
  return res.rows.map((r: any) => Number(r.organization_id));
}

/**
 * GET — lista os usuários visíveis.
 *
 * A RLS não protege `users` diretamente: a tabela não tem coluna de inquilino,
 * porque uma mesma pessoa pode pertencer a várias organizações. O recorte vem
 * do JOIN com `memberships`, que a RLS já limita pelas organizações do
 * solicitante.
 */
export async function GET(request: Request) {
  const sessao = extrairSessao(request);
  if (!sessao) {
    return NextResponse.json({ error: 'Não autenticado.' }, { status: 401 });
  }

  const superAdmin = ehSuperAdmin(sessao.role);
  if (!superAdmin && sessao.role !== STORE_ADMIN) {
    return NextResponse.json({ error: 'Acesso negado.' }, { status: 403 });
  }

  try {
    const usuarios = await comInquilino(contextoDoToken(sessao), async (cliente) => {
      if (superAdmin) {
        const res = await cliente.query(`
          SELECT u.id, u.email, u.is_super_admin, u.created_at,
                 COALESCE(
                   json_agg(
                     json_build_object('organization_id', m.organization_id,
                                       'organization_name', o.name,
                                       'role', m.role,
                                       'store_id', m.store_id)
                   ) FILTER (WHERE m.id IS NOT NULL), '[]'
                 ) AS memberships
            FROM users u
            LEFT JOIN memberships m ON m.user_id = u.id
            LEFT JOIN organizations o ON o.id = m.organization_id
           GROUP BY u.id
           ORDER BY u.id DESC
        `);
        return res.rows;
      }

      // STORE_ADMIN: apenas quem compartilha organização com ele. O IN abaixo
      // é filtrado pela RLS em `memberships`, então não há como alcançar a
      // associação de uma organização alheia mesmo forjando o id.
      const res = await cliente.query(
        `SELECT u.id, u.email, u.created_at,
                m.role, m.organization_id, m.store_id, o.name AS organization_name
           FROM memberships m
           JOIN users u ON u.id = m.user_id
           LEFT JOIN organizations o ON o.id = m.organization_id
          WHERE m.organization_id IN (
                  SELECT organization_id FROM memberships
                   WHERE user_id = $1 AND role = 'STORE_ADMIN')
          ORDER BY u.id DESC`,
        [sessao.id ?? 0],
      );
      return res.rows;
    });

    return NextResponse.json(usuarios);
  } catch (erro: any) {
    console.error('[users GET]', erro);
    return NextResponse.json({ error: 'Falha ao listar usuários.' }, { status: 500 });
  }
}

/**
 * POST — convida um usuário para uma organização.
 *
 * Cria o usuário se ainda não existir, e sempre cria a associação. Convidar
 * alguém que já tem conta noutra organização precisa funcionar: é o caso de um
 * consultor que atende várias redes.
 */
export async function POST(request: Request) {
  const sessao = extrairSessao(request);
  if (!sessao) {
    return NextResponse.json({ error: 'Não autenticado.' }, { status: 401 });
  }

  const superAdmin = ehSuperAdmin(sessao.role);
  if (!superAdmin && sessao.role !== STORE_ADMIN) {
    return NextResponse.json({ error: 'Acesso negado.' }, { status: 403 });
  }

  let corpo: any;
  try {
    corpo = await request.json();
  } catch {
    return NextResponse.json({ error: 'Corpo inválido.' }, { status: 400 });
  }

  const { email, password, role, organization_id, store_id } = corpo;
  if (!email || !password || !role) {
    return NextResponse.json(
      { error: 'email, password e role são obrigatórios.' },
      { status: 400 },
    );
  }

  // A lista é fechada: aceitar um papel arbitrário deixaria o valor cair na
  // coluna e ser interpretado por qualquer checagem futura que use string solta.
  if (!papelDeOrganizacaoValido(role)) {
    return NextResponse.json(
      { error: `role inválido. Aceitos: ${PAPEIS_DE_ORGANIZACAO.join(', ')}.` },
      { status: 400 },
    );
  }

  try {
    const resultado = await comInquilino(contextoDoToken(sessao), async (cliente) => {
      let orgId = Number(organization_id) || 0;

      if (!superAdmin) {
        const minhas = await orgsQueAdministra(cliente, sessao.id ?? 0);
        if (!minhas.length) {
          return { erro: 'Você não administra nenhuma organização.', status: 403 };
        }
        // Ignora o organization_id do corpo: aceitá-lo permitiria a um
        // STORE_ADMIN inserir um usuário na organização de outro cliente.
        if (orgId && !minhas.includes(orgId)) {
          return { erro: 'Organização fora do seu escopo.', status: 403 };
        }
        orgId = orgId || minhas[0];
      }

      if (!orgId) {
        return { erro: 'organization_id é obrigatório.', status: 400 };
      }

      // Reaproveita a conta se o e-mail já existir. A senha só é definida na
      // criação: um convite não pode redefinir a senha de uma conta existente,
      // ou viraria um caminho de tomada de conta.
      const existente = await cliente.query('SELECT id FROM users WHERE email = $1', [email]);
      let userId: number;
      let criouConta = false;

      if (existente.rowCount) {
        userId = existente.rows[0].id;
      } else {
        const novo = await cliente.query(
          `INSERT INTO users (email, password_hash, role, store_id)
           VALUES ($1, $2, $3, $4) RETURNING id`,
          [email, gerarHash(password), role, store_id || null],
        );
        userId = novo.rows[0].id;
        criouConta = true;
      }

      const jaAssociado = await cliente.query(
        `SELECT id FROM memberships
          WHERE user_id = $1 AND organization_id = $2
            AND store_id IS NOT DISTINCT FROM $3`,
        [userId, orgId, store_id || null],
      );
      if (jaAssociado.rowCount) {
        return { erro: 'Usuário já pertence a esta organização.', status: 409 };
      }

      await cliente.query(
        `INSERT INTO memberships (user_id, organization_id, role, store_id)
         VALUES ($1, $2, $3, $4)`,
        [userId, orgId, role, store_id || null],
      );

      await registrarAuditoria(cliente, {
        organizationId: orgId,
        userId: sessao.id,
        actorEmail: sessao.email,
        action: criouConta ? 'user.create' : 'user.invite',
        resourceType: 'user',
        resourceId: userId,
        detail: { email, role, store_id: store_id || null },
        ipAddress: ipDaRequisicao(request),
      });

      return { usuario: { id: userId, email, role, organization_id: orgId } };
    });

    if ('erro' in resultado) {
      return NextResponse.json({ error: resultado.erro }, { status: resultado.status });
    }
    return NextResponse.json(resultado.usuario, { status: 201 });
  } catch (erro: any) {
    console.error('[users POST]', erro);
    if (String(erro.message || '').includes('unique')) {
      return NextResponse.json({ error: 'E-mail já cadastrado.' }, { status: 409 });
    }
    return NextResponse.json({ error: 'Falha ao criar usuário.' }, { status: 500 });
  }
}

/**
 * DELETE — remove a associação de um usuário com a organização.
 *
 * Remove o vínculo, não a conta. Alguém que atende três redes e sai de uma
 * continua com acesso às outras duas.
 */
export async function DELETE(request: Request) {
  const sessao = extrairSessao(request);
  if (!sessao) {
    return NextResponse.json({ error: 'Não autenticado.' }, { status: 401 });
  }

  const superAdmin = ehSuperAdmin(sessao.role);
  if (!superAdmin && sessao.role !== STORE_ADMIN) {
    return NextResponse.json({ error: 'Acesso negado.' }, { status: 403 });
  }

  const { searchParams } = new URL(request.url);
  const membershipId = searchParams.get('membership_id');
  if (!membershipId) {
    return NextResponse.json({ error: 'membership_id é obrigatório.' }, { status: 400 });
  }

  try {
    const resultado = await comInquilino(contextoDoToken(sessao), async (cliente) => {
      const alvo = await cliente.query(
        `SELECT m.id, m.organization_id, m.user_id, m.role, u.email
           FROM memberships m JOIN users u ON u.id = m.user_id
          WHERE m.id = $1`,
        [membershipId],
      );
      if (!alvo.rowCount) {
        return { erro: 'Associação não encontrada.', status: 404 };
      }

      const orgId = Number(alvo.rows[0].organization_id);
      if (!superAdmin) {
        const minhas = await orgsQueAdministra(cliente, sessao.id ?? 0);
        if (!minhas.includes(orgId)) {
          return { erro: 'Associação não encontrada.', status: 404 };
        }
      }

      // Impede que a organização fique sem administrador. Sem esta checagem,
      // um STORE_ADMIN se remove por engano e ninguém mais consegue convidar
      // equipe — só um SUPER_ADMIN destrava, o que vira chamado de suporte.
      if (alvo.rows[0].role === 'STORE_ADMIN') {
        const restantes = await cliente.query(
          `SELECT COUNT(*)::int AS n FROM memberships
            WHERE organization_id = $1 AND role = 'STORE_ADMIN' AND id <> $2`,
          [orgId, membershipId],
        );
        if (restantes.rows[0].n === 0) {
          return {
            erro: 'Esta é a última administração da organização. Promova outro usuário antes.',
            status: 409,
          };
        }
      }

      await cliente.query('DELETE FROM memberships WHERE id = $1', [membershipId]);

      await registrarAuditoria(cliente, {
        organizationId: orgId,
        userId: sessao.id,
        actorEmail: sessao.email,
        action: 'membership.revoke',
        resourceType: 'membership',
        resourceId: membershipId,
        detail: { email: alvo.rows[0].email, role: alvo.rows[0].role },
        ipAddress: ipDaRequisicao(request),
      });

      return { ok: true };
    });

    if ('erro' in resultado) {
      return NextResponse.json({ error: resultado.erro }, { status: resultado.status });
    }
    return NextResponse.json({ success: true });
  } catch (erro: any) {
    console.error('[users DELETE]', erro);
    return NextResponse.json({ error: 'Falha ao remover associação.' }, { status: 500 });
  }
}
