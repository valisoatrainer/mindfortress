/**
 * MIND FORTRESS — Module Backend d'Analytique SQL & Corrélations Cognitives (SQLite Natif / Turso)
 */

const ValisoaAnalytics = require("../vendor/ValisoaAnalytics");

/**
 * Exécute les requêtes SQL d'agrégation et de corrélation directement sur le moteur SQLite / libSQL :
 * - Fatigue (1–5) × Taux de réussite & Temps moyen
 * - Sommeil × Taux de réussite
 * - Émotion × Temps moyen & Taux de réussite
 * - Distribution des notes FSRS (1..4) et stabilité moyenne
 */
async function querySqlAnalytics(client, userId = 1) {
  const uid = Number(userId) || 1;
  const [fatigueSqlRes, sleepSqlRes, emotionSqlRes, fsrsSqlRes] = await Promise.all([
    client.execute({
      sql: `
      SELECT
        cj.fatigue AS fatigue,
        COUNT(*) AS sessions_count,
        ROUND(AVG(CASE WHEN l.id IS NOT NULL THEN l.success ELSE 1 END) * 100.0, 1) AS success_rate_pct,
        ROUND(AVG(COALESCE(l.time_sec, 45)), 1) AS avg_time_sec
      FROM contextual_journal cj
      LEFT JOIN logs l ON cj.log_id = l.id AND l.user_id = ?
      WHERE cj.user_id = ?
      GROUP BY cj.fatigue
      ORDER BY cj.fatigue ASC
    `,
      args: [uid, uid]
    }),
    client.execute({
      sql: `
      SELECT
        cj.sommeil AS sommeil,
        COUNT(*) AS sessions_count,
        ROUND(AVG(CASE WHEN l.id IS NOT NULL THEN l.success ELSE 1 END) * 100.0, 1) AS success_rate_pct,
        ROUND(AVG(COALESCE(l.time_sec, 45)), 1) AS avg_time_sec
      FROM contextual_journal cj
      LEFT JOIN logs l ON cj.log_id = l.id AND l.user_id = ?
      WHERE cj.user_id = ?
      GROUP BY cj.sommeil
      ORDER BY sessions_count DESC
    `,
      args: [uid, uid]
    }),
    client.execute({
      sql: `
      SELECT
        emotion,
        COUNT(*) AS sessions_count,
        ROUND(AVG(success) * 100.0, 1) AS success_rate_pct,
        ROUND(AVG(time_sec), 1) AS avg_time_sec,
        SUM(xp) AS total_xp
      FROM logs
      WHERE user_id = ?
      GROUP BY emotion
      ORDER BY sessions_count DESC
    `,
      args: [uid]
    }),
    client.execute({
      sql: `
      SELECT
        rating,
        COUNT(*) AS reviews_count,
        ROUND(AVG(stability), 2) AS avg_stability,
        ROUND(AVG(difficulty), 2) AS avg_difficulty,
        ROUND(AVG(solve_time_sec), 1) AS avg_solve_time_sec
      FROM fsrs_review_logs
      WHERE user_id = ?
      GROUP BY rating
      ORDER BY rating ASC
    `,
      args: [uid]
    })
  ]);

  return {
    sqlFatigueBySuccess: fatigueSqlRes.rows || [],
    sqlSleepBySuccess: sleepSqlRes.rows || [],
    sqlEmotionByTime: emotionSqlRes.rows || [],
    sqlFsrsByRating: fsrsSqlRes.rows || []
  };
}

module.exports = {
  ...ValisoaAnalytics,
  querySqlAnalytics
};
