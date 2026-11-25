import { config } from '../config.js';
import { addReferral, getPoints, getRanking } from '../db/referrals.js';
import { rankingEmbed } from '../lib/embeds.js';

// Marcador no rodapé pra reencontrar a mensagem do ranking e editá-la (em vez de repostar).
const RANKING_TAG = 'ranking-indicacoes';

// Responde e apaga a resposta depois de alguns segundos pra não poluir o canal.
async function tempReply(message, content, ms = 10_000) {
  const reply = await message
    .reply({ content, allowedMentions: { repliedUser: false } })
    .catch(() => null);
  if (reply) setTimeout(() => reply.delete().catch(() => {}), ms);
}

// Atualiza (ou cria) a mensagem fixa do ranking no canal de ranking.
export async function refreshRanking(client) {
  const channelId = config.discord.referralRankingChannelId;
  if (!channelId) return;
  const channel = await client.channels.fetch(channelId).catch(() => null);
  if (!channel?.isTextBased()) return;

  const rows = await getRanking(10);
  const embed = rankingEmbed(rows).setFooter({ text: `${config.brand.name} • ${RANKING_TAG}` });

  const recent = await channel.messages.fetch({ limit: 30 }).catch(() => null);
  const existing = recent?.find(
    (m) => m.author.id === client.user.id && m.embeds[0]?.footer?.text?.endsWith(RANKING_TAG),
  );
  if (existing) await existing.edit({ embeds: [embed] });
  else await channel.send({ embeds: [embed] });
}

// Mensagem no canal de indicação: o primeiro @ que não seja o próprio autor ganha 1 ponto.
export async function handleReferralMessage(message) {
  if (message.author.bot || !message.guild) return;
  if (message.channelId !== config.discord.referralChannelId) return;

  // Lê as menções do texto (e não de message.mentions) pra ignorar o ping automático de "responder".
  const ids = [...message.content.matchAll(/<@!?(\d+)>/g)].map((m) => m[1]);
  if (!ids.length) {
    return tempReply(message, '❗ Marque (@) quem te indicou para ele(a) ganhar o ponto.');
  }

  const referrerId = ids.find((id) => id !== message.author.id);
  if (!referrerId) return tempReply(message, '🚫 Você não pode indicar a si mesmo(a).');

  const member = await message.guild.members.fetch(referrerId).catch(() => null);
  if (!member || member.user.bot) {
    return tempReply(message, '🚫 Marque um membro do servidor (não vale bot).');
  }

  const result = await addReferral({
    referrerId,
    referredId: message.author.id,
    messageId: message.id,
  });
  if (!result.ok) {
    return tempReply(
      message,
      '⚠️ Você já registrou quem te indicou. Cada pessoa só pode indicar uma vez.',
    );
  }

  await message.react('✅').catch(() => {});
  const points = await getPoints(referrerId);
  await message
    .reply({
      content: `🎉 <@${referrerId}> ganhou **+1 ponto** por indicar <@${message.author.id}>! Total: **${points}**`,
      allowedMentions: { users: [referrerId], repliedUser: false },
    })
    .catch(() => {});

  await refreshRanking(message.client).catch((e) => console.error('Falha ao atualizar ranking:', e));
}
