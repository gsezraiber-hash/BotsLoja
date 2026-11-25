import { supabase } from '../lib/supabase.js';

// Registra uma indicação. Retorna { ok: true } ou { ok: false, reason: 'already' }
// se `referredId` já indicou alguém antes (unique no banco, à prova de corrida).
export async function addReferral({ referrerId, referredId, messageId }) {
  const { error } = await supabase
    .from('referrals')
    .insert({ referrer_id: referrerId, referred_id: referredId, message_id: messageId });
  if (error) {
    if (error.code === '23505') return { ok: false, reason: 'already' };
    throw error;
  }
  return { ok: true };
}

// Top indicadores: desempate por quem chegou na pontuação primeiro.
export async function getRanking(limit = 10) {
  const { data, error } = await supabase
    .from('referral_ranking')
    .select('*')
    .order('points', { ascending: false })
    .order('first_at', { ascending: true })
    .limit(limit);
  if (error) throw error;
  return data;
}

export async function getPoints(userId) {
  const { count, error } = await supabase
    .from('referrals')
    .select('id', { count: 'exact', head: true })
    .eq('referrer_id', userId);
  if (error) throw error;
  return count || 0;
}
