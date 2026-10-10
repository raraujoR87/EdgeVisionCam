import type { PoolClient } from 'pg';
import { PLANOS, ehPlanoValido, type Plano } from './planos';

/**
 * Números do cliente. Todas as consultas rodam sob RLS (o chamador abre
 * `comUsuario`), então nenhuma cláusula de inquilino é necessária aqui.
 *
 * O filtro `organizationId` é só recorte de visualização para quem pertence a
 * mais de uma organização. Não é controle de acesso: a RLS já limitou o conjunto.
 */

export const AMOSTRA_MINIMA = 20;

export interface ParametrosBI {
  dias: number;
  organizationId: number | null;
}

export async function resumoBI(c: PoolClient, p: ParametrosBI) {
  const filtroOrg = p.organizationId ? 'AND e.organization_id = $2' : '';
  const params: unknown[] = p.organizationId ? [p.dias, p.organizationId] : [p.dias];

  const totais = await c.query(
    `SELECT COUNT(*)::int                                              AS total,
            COUNT(*) FILTER (WHERE e.verdict = 'SUSPEITO')::int        AS suspeitos,
            COUNT(*) FILTER (WHERE e.verdict = 'SEM_INDICIO')::int     AS sem_indicio,
            COUNT(*) FILTER (WHERE e.verdict = 'INCONCLUSIVO')::int    AS inconclusivos,
            COUNT(*) FILTER (WHERE e.status = 'FALHOU')::int           AS falhas,
            COUNT(*) FILTER (WHERE e.status = 'PENDENTE')::int         AS em_analise,
            COUNT(*) FILTER (WHERE e.human_verdict = 'PROCEDE')::int   AS procede,
            COUNT(*) FILTER (WHERE e.human_verdict = 'FALSO_ALARME')::int AS falso_alarme,
            COUNT(*) FILTER (WHERE e.verdict = 'SUSPEITO'
                              AND e.human_verdict IS NULL)::int        AS suspeitos_sem_revisao,
            AVG(e.confidence) FILTER (WHERE e.status = 'ANALISADO')::float AS confianca_media
       FROM events e
      WHERE e.occurred_at >= now() - make_interval(days => $1::int)
        ${filtroOrg}`,
    params,
  );
  const t = totais.rows[0];

  // Série por dia no fuso da loja. generate_series garante que dia sem evento
  // aparece como zero — a lacuna é o dado que mostra um equipamento caído.
  const serie = await c.query(
    `WITH dias AS (
       SELECT generate_series(
                (now() AT TIME ZONE 'America/Sao_Paulo')::date - ($1::int - 1),
                (now() AT TIME ZONE 'America/Sao_Paulo')::date, '1 day')::date AS dia
     ), janela AS (
       SELECT e.id, e.verdict, e.human_verdict,
              (e.occurred_at AT TIME ZONE 'America/Sao_Paulo')::date AS dia
         FROM events e
        WHERE e.occurred_at >= now() - make_interval(days => $1::int)
          ${filtroOrg}
     )
     SELECT d.dia,
            COUNT(j.id)::int                                            AS total,
            COUNT(j.id) FILTER (WHERE j.verdict = 'SUSPEITO')::int      AS suspeitos,
            COUNT(j.id) FILTER (WHERE j.human_verdict = 'PROCEDE')::int AS procede
       FROM dias d LEFT JOIN janela j ON j.dia = d.dia
      GROUP BY d.dia ORDER BY d.dia`,
    params,
  );

  const porCamera = await c.query(
    `SELECT cam.id, cam.name, s.name AS local,
            COUNT(e.id)::int                                            AS total,
            COUNT(e.id) FILTER (WHERE e.verdict = 'SUSPEITO')::int      AS suspeitos,
            COUNT(e.id) FILTER (WHERE e.human_verdict = 'PROCEDE')::int AS procede,
            COUNT(e.id) FILTER (WHERE e.human_verdict = 'FALSO_ALARME')::int AS falso_alarme
       FROM cameras cam
       JOIN sites s ON s.id = cam.site_id
       LEFT JOIN events e ON e.camera_id = cam.id
            AND e.occurred_at >= now() - make_interval(days => $1::int)
      WHERE TRUE ${p.organizationId ? 'AND cam.organization_id = $2' : ''}
      GROUP BY cam.id, s.name
      ORDER BY total DESC, cam.name
      LIMIT 10`,
    params,
  );

  const procede = t.procede as number;
  const falso = t.falso_alarme as number;
  const julgados = procede + falso;

  const cotas = await c.query(
    `SELECT o.id, o.name, o.plan,
            (SELECT COUNT(*)::int FROM events e
              WHERE e.organization_id = o.id
                AND e.received_at >= date_trunc('month', now())) AS eventos_mes,
            (SELECT COUNT(*)::int FROM cameras cam
              WHERE cam.organization_id = o.id) AS cameras
       FROM organizations o
      WHERE TRUE ${p.organizationId ? 'AND o.id = $1' : ''}
      ORDER BY o.name`,
    p.organizationId ? [p.organizationId] : [],
  );

  return {
    periodo_dias: p.dias,
    totais: t,
    serie: serie.rows,
    cameras: porCamera.rows,
    precisao: julgados > 0 ? procede / julgados : null,
    julgados,
    amostra_suficiente: julgados >= AMOSTRA_MINIMA,
    cotas: cotas.rows.map((o) => {
      const plano: Plano = ehPlanoValido(o.plan) ? o.plan : 'trial';
      return {
        organization_id: o.id,
        organizacao: o.name,
        plano,
        eventos_mes: o.eventos_mes,
        eventos_mes_limite: PLANOS[plano].eventos_mes,
        cameras: o.cameras,
        cameras_limite: PLANOS[plano].max_cameras,
      };
    }),
  };
}
