import { conferirSenha, gerarHashDeSenha, gerarTokenAleatorio, hashDeToken, TAMANHO_MINIMO_SENHA } from './auth';
import { comServico, registrarAuditoria } from './tenant';

/**
 * Convites com token de uso único.
 *
 * Substitui a versão anterior, em que o administrador escolhia a senha do cliente.
 * Aqui quem define a senha é a própria pessoa, pelo link. O link vale 72 horas,
 * é de uso único e só existe o hash no banco.
 *
 * Não há envio de e-mail neste módulo: o administrador recebe o link e o entrega
 * por um canal de confiança. Envio automático é o próximo passo.
 */

export const VALIDADE_CONVITE_MS = 72 * 60 * 60 * 1000;

export type ErroDeConvite = { status: number; mensagem: string };

export async function aceitarConvite(params: {
  token: string;
  senha: string | null;
  ip: string | null;
  agora?: number;
}): Promise<
  | { ok: true; email: string; organizationId: number; contaNova: boolean }
  | { ok: false; erro: ErroDeConvite }
> {
  const agora = params.agora ?? Date.now();
  const hash = hashDeToken(params.token);

  return comServico(async (c) => {
    const r = await c.query(
      `SELECT id, organization_id, email, role, expires_at, accepted_at, revoked_at, invited_by
         FROM invites WHERE token_hash = $1 FOR UPDATE`,
      [hash],
    );
    if (!r.rowCount) return { ok: false, erro: { status: 404, mensagem: 'Convite não encontrado.' } };
    const convite = r.rows[0];
    if (convite.revoked_at) return { ok: false, erro: { status: 410, mensagem: 'Convite cancelado.' } };
    if (convite.accepted_at) return { ok: false, erro: { status: 410, mensagem: 'Convite já utilizado.' } };
    if (new Date(convite.expires_at).getTime() < agora) {
      return { ok: false, erro: { status: 410, mensagem: 'Convite expirado. Peça um novo ao administrador.' } };
    }

    const existente = await c.query(
      'SELECT id, password_hash FROM users WHERE email = $1',
      [convite.email],
    );

    let userId: number;
    let contaNova = false;
    if (existente.rowCount && existente.rows[0].password_hash) {
      // Conta já existe com senha: a pessoa prova que é dona da conta digitando-a.
      if (!params.senha || !conferirSenha(params.senha, existente.rows[0].password_hash)) {
        return { ok: false, erro: { status: 401, mensagem: 'Para aceitar, informe a senha da sua conta existente.' } };
      }
      userId = existente.rows[0].id;
    } else if (existente.rowCount) {
      // Conta criada sem senha (ex.: convite anterior não aceito): define agora.
      if (!params.senha || params.senha.length < TAMANHO_MINIMO_SENHA) {
        return { ok: false, erro: { status: 400, mensagem: `Defina uma senha de pelo menos ${TAMANHO_MINIMO_SENHA} caracteres.` } };
      }
      userId = existente.rows[0].id;
      await c.query('UPDATE users SET password_hash = $2 WHERE id = $1', [userId, gerarHashDeSenha(params.senha)]);
    } else {
      if (!params.senha || params.senha.length < TAMANHO_MINIMO_SENHA) {
        return { ok: false, erro: { status: 400, mensagem: `Defina uma senha de pelo menos ${TAMANHO_MINIMO_SENHA} caracteres.` } };
      }
      const novo = await c.query(
        'INSERT INTO users (email, password_hash) VALUES ($1, $2) RETURNING id',
        [convite.email, gerarHashDeSenha(params.senha)],
      );
      userId = novo.rows[0].id;
      contaNova = true;
    }

    const vinculo = await c.query(
      `INSERT INTO memberships (user_id, organization_id, role)
       VALUES ($1, $2, $3)
       ON CONFLICT (user_id, organization_id) DO NOTHING
       RETURNING id`,
      [userId, convite.organization_id, convite.role],
    );
    if (!vinculo.rowCount) {
      return { ok: false, erro: { status: 409, mensagem: 'Você já pertence a esta organização.' } };
    }

    await c.query('UPDATE invites SET accepted_at = now() WHERE id = $1', [convite.id]);
    await registrarAuditoria(c, {
      organizationId: convite.organization_id,
      actorUserId: userId,
      actorEmail: convite.email,
      action: 'convite.aceito',
      targetType: 'user',
      targetId: userId,
      detail: { role: convite.role, convidado_por: convite.invited_by, conta_nova: contaNova },
      ipAddress: params.ip,
    });

    return { ok: true, email: convite.email, organizationId: convite.organization_id, contaNova };
  });
}

export function gerarNovoToken(): { token: string; hash: string } {
  const token = gerarTokenAleatorio(32);
  return { token, hash: hashDeToken(token) };
}
