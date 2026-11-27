import {
  ChannelType,
  PermissionFlagsBits,
  MessageFlags,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
} from 'discord.js';
import { config } from '../config.js';
import { getOrCreateOrder, getOpenOrderByChannel, updateOrder } from '../db/orders.js';
import { getSellerByDiscordId } from '../db/sellers.js';
import { isStaff } from '../lib/permissions.js';
import { brandEmbed } from '../lib/embeds.js';
import { refreshCartMessage } from '../lib/cartView.js';
import { createTranscriptAttachment } from '../lib/transcript.js';

const eph = { flags: MessageFlags.Ephemeral };

export const TICKET_IDS = {
  open: 'open_ticket',
  close: 'close_ticket',
  claim: 'claim_ticket',
  notify: 'notify_ticket_dm',
  delivered: 'delivered_ticket',
  reopen: 'reopen_ticket',
};

// Acha o ticket aberto do usuário, ou null.
function findUserTicket(guild, userId) {
  return guild.channels.cache.find(
    (c) => c.type === ChannelType.GuildText && c.topic === `ticket:${userId}`,
  );
}

// Monta o nome do canal a partir do status e do nome de quem abriu o ticket.
// Ex.: ("pendente", "Ana Clara") -> "pendente-ana-clara".
// (O Discord só aceita letras minúsculas, números e hífens em canais de texto.)
function ticketChannelName(status, ownerName) {
  const slug = String(ownerName || 'cliente')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'cliente';
  return `${status}-${slug}`.slice(0, 90);
}

// Nome exibido de quem abriu o ticket (apelido no servidor > nome global > usuário).
function ownerDisplayName(member, user) {
  return member?.displayName || user?.globalName || user?.username;
}

// Cria o ticket individual do usuário (ou retorna o existente).
// Posta a mensagem inicial de atendimento + o carrinho. Reutilizável pelo botão
// "Abrir ticket" e pelo "Comprar".
export async function getOrCreateTicketChannel(interaction) {
  const guild = interaction.guild;

  const existing = findUserTicket(guild, interaction.user.id);
  if (existing) return existing;

  const channel = await guild.channels.create({
    name: ticketChannelName('pendente', ownerDisplayName(interaction.member, interaction.user)),
    type: ChannelType.GuildText,
    parent: config.discord.ticketCategoryId || undefined,
    topic: `ticket:${interaction.user.id}`,
    permissionOverwrites: [
      { id: guild.roles.everyone.id, deny: [PermissionFlagsBits.ViewChannel] },
      {
        id: interaction.user.id,
        allow: [
          PermissionFlagsBits.ViewChannel,
          PermissionFlagsBits.SendMessages,
          PermissionFlagsBits.ReadMessageHistory,
          PermissionFlagsBits.AttachFiles,
        ],
      },
      {
        id: config.discord.staffRoleId,
        allow: [
          PermissionFlagsBits.ViewChannel,
          PermissionFlagsBits.SendMessages,
          PermissionFlagsBits.ReadMessageHistory,
          PermissionFlagsBits.AttachFiles,
        ],
      },
    ],
  });

  const welcome = brandEmbed({ banner: !config.ticketImageUrl })
    .setTitle('🎫 Atendimento aberto')
    .setDescription(
      [
        `Olá <@${interaction.user.id}>! Bem-vindo ao seu atendimento. 👋`,
        '',
        '**Pra começar, conta pra gente os detalhes do que você quer:**',
        '• Referências / imagens do ped (pode anexar aqui)',
        '• Cores, texturas, detalhes específicos',
        '• Compatibilidade desejada (MP / SP)',
        '• Qualquer observação importante',
        '',
        'A equipe vai te responder por aqui. Quando fechar os detalhes e o valor, ' +
          'use o menu abaixo pra montar o pedido e gerar o Pix.',
      ].join('\n'),
    );
  if (config.ticketImageUrl) welcome.setImage(config.ticketImageUrl);

  const closeRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(TICKET_IDS.claim)
      .setLabel('Assumir atendimento')
      .setStyle(ButtonStyle.Success)
      .setEmoji('🙋'),
    new ButtonBuilder()
      .setCustomId(TICKET_IDS.notify)
      .setLabel('Avisar na DM')
      .setStyle(ButtonStyle.Primary)
      .setEmoji('🔔'),
    new ButtonBuilder()
      .setCustomId(TICKET_IDS.delivered)
      .setLabel('Entregue')
      .setStyle(ButtonStyle.Success)
      .setEmoji('📦'),
    new ButtonBuilder()
      .setCustomId(TICKET_IDS.close)
      .setLabel('Fechar ticket')
      .setStyle(ButtonStyle.Secondary)
      .setEmoji('🔒'),
  );

  await channel.send({
    content: `<@${interaction.user.id}> <@&${config.discord.staffRoleId}>`,
    embeds: [welcome],
    components: [closeRow],
  });

  // Cria o pedido e renderiza o carrinho já no ticket.
  const order = await getOrCreateOrder({
    discordUserId: interaction.user.id,
    channelId: channel.id,
  });

  await refreshCartMessage(channel, order);

  return channel;
}

// Botão "Abrir ticket" no painel público.
export async function handleOpenTicket(interaction) {
  await interaction.deferReply(eph);
  const existing = findUserTicket(interaction.guild, interaction.user.id);
  const channel = await getOrCreateTicketChannel(interaction);
  await interaction.editReply(
    existing ? `Você já tem um atendimento aberto: ${channel}` : `Atendimento aberto: ${channel}`,
  );
}

// Botão "Assumir atendimento" — a sócia que clicar passa a ser a recebedora do Pix
// deste pedido (grava claimed_by). Só a equipe cadastrada como vendedora pode assumir.
export async function handleClaim(interaction) {
  if (!isStaff(interaction.member)) {
    return interaction.reply({ content: '⛔ Apenas a equipe pode assumir o atendimento.', ...eph });
  }
  await interaction.deferReply(eph);

  const seller = await getSellerByDiscordId(interaction.user.id);
  if (!seller) {
    return interaction.editReply(
      '⚠️ Você ainda não está cadastrada como vendedora (sem chave Pix). ' +
        'Peça pra incluírem seu Pix na tabela `sellers` antes de assumir.',
    );
  }

  const order = await getOpenOrderByChannel(interaction.channelId);
  if (!order) return interaction.editReply('Nenhum pedido aberto neste ticket.');

  if (order.claimed_by && order.claimed_by !== interaction.user.id) {
    return interaction.editReply(`Este atendimento já foi assumido por <@${order.claimed_by}>.`);
  }

  await updateOrder(order.id, { claimed_by: interaction.user.id });
  await disableClaimButton(interaction.message, seller.name);

  await interaction.channel.send(
    `🙋 <@${interaction.user.id}> assumiu este atendimento.`,
  );
  await interaction.editReply('Você assumiu o atendimento. ✅ Pode gerar o Pix normalmente.');
}

// Botão "Avisar na DM" — manda uma DM ao dono do ticket avisando que foi respondido.
export async function handleNotifyDm(interaction) {
  if (!isStaff(interaction.member)) {
    return interaction.reply({ content: '⛔ Apenas a equipe pode usar este botão.', ...eph });
  }
  await interaction.deferReply(eph);

  const ownerId = ticketOwnerId(interaction.channel);
  if (!ownerId) return interaction.editReply('Não consegui identificar o dono deste ticket.');

  try {
    const user = await interaction.client.users.fetch(ownerId);
    const embed = brandEmbed({ banner: false })
      .setTitle('🔔 Seu atendimento foi respondido')
      .setDescription(
        `Você recebeu uma resposta no seu ticket em **${interaction.guild.name}**.\n` +
          `Acesse ${interaction.channel} para continuar.`,
      );
    await user.send({ embeds: [embed] });
    await interaction.editReply(`✅ <@${ownerId}> foi avisado(a) por DM.`);
  } catch {
    await interaction.editReply(
      '⚠️ Não consegui enviar DM — o usuário provavelmente fechou as mensagens diretas. ' +
        'Mencione ele no ticket.',
    );
  }
}

// Botão "Entregue" — move o ticket para a categoria de entregues e troca o
// prefixo do nome de "pendente-" para "entregue-".
export async function handleDelivered(interaction) {
  if (!isStaff(interaction.member)) {
    return interaction.reply({ content: '⛔ Apenas a equipe pode usar este botão.', ...eph });
  }
  await interaction.deferReply(eph);

  const channel = interaction.channel;
  if (channel.parentId === config.discord.deliveredCategoryId) {
    return interaction.editReply('Este ticket já está marcado como entregue.');
  }

  try {
    // lockPermissions: false mantém as permissões do ticket (cliente + equipe).
    await channel.setParent(config.discord.deliveredCategoryId, { lockPermissions: false });
  } catch (err) {
    console.error('Falha ao mover ticket para entregues:', err);
    return interaction.editReply(
      '⚠️ Não consegui mover o ticket. Confira se a categoria existe, se não está cheia (50 canais) ' +
        'e se o bot tem permissão de Gerenciar Canais.',
    );
  }

  // Sem await: o Discord limita renomear a 2x a cada 10 min por canal, e o
  // discord.js ficaria esperando o limite liberar em vez de responder.
  renameStatus(channel, 'pendente', 'entregue');

  const ownerId = ticketOwnerId(channel);
  const panel = brandEmbed({ banner: false })
    .setTitle('📦 Pedido entregue!')
    .setDescription(
      [
        `Seu pedido foi marcado como **entregue** por <@${interaction.user.id}>. Obrigado pela preferência! 💛`,
        '',
        'Quer encomendar mais alguma coisa? É só clicar no botão abaixo que a gente ' +
          'reabre o seu atendimento por aqui mesmo.',
      ].join('\n'),
    );
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(TICKET_IDS.reopen)
      .setLabel('Fazer novo pedido')
      .setStyle(ButtonStyle.Success)
      .setEmoji('🛒'),
  );
  await channel.send({
    content: ownerId ? `<@${ownerId}>` : undefined,
    embeds: [panel],
    components: [row],
  });
  await interaction.editReply('✅ Ticket movido para a categoria de entregues.');
}

// Botão "Fazer novo pedido" (painel pós-entrega) — volta o ticket para a categoria
// de tickets, renomeia para "pendente-..." e abre um carrinho novo.
export async function handleReopen(interaction) {
  const channel = interaction.channel;
  const ownerId = ticketOwnerId(channel);
  if (interaction.user.id !== ownerId && !isStaff(interaction.member)) {
    return interaction.reply({ content: '⛔ Apenas o dono do ticket pode fazer um novo pedido aqui.', ...eph });
  }
  await interaction.deferReply(eph);

  if (config.discord.ticketCategoryId && channel.parentId !== config.discord.ticketCategoryId) {
    try {
      await channel.setParent(config.discord.ticketCategoryId, { lockPermissions: false });
    } catch (err) {
      console.error('Falha ao mover ticket de volta para a categoria de tickets:', err);
      return interaction.editReply('⚠️ Não consegui reabrir o ticket agora. Chame a equipe por aqui.');
    }
  }
  renameStatus(channel, 'entregue', 'pendente');

  // Desativa o botão do painel para não abrir dois pedidos.
  await interaction.message
    .edit({
      components: [
        new ActionRowBuilder().addComponents(
          ButtonBuilder.from(interaction.message.components[0].components[0])
            .setDisabled(true)
            .setLabel('Novo pedido aberto'),
        ),
      ],
    })
    .catch(() => {});

  const order = await getOrCreateOrder({ discordUserId: ownerId || interaction.user.id, channelId: channel.id });
  await channel.send(
    `🛒 <@${interaction.user.id}> quer fazer um **novo pedido**! <@&${config.discord.staffRoleId}>\n` +
      'Conta pra gente os detalhes e use o menu abaixo pra montar o pedido.',
  );
  await refreshCartMessage(channel, order);

  await interaction.editReply('✅ Atendimento reaberto! Seu novo carrinho está logo abaixo.');
}

// Troca o prefixo de status do nome do canal (ex.: "entregue-ana" -> "pendente-ana").
function renameStatus(channel, from, to) {
  const newName = channel.name.replace(new RegExp(`^${from}-`), `${to}-`);
  if (newName !== channel.name) channel.setName(newName).catch(() => {});
}

// Desabilita o botão "Assumir" e mostra quem assumiu (mantém o "Fechar ticket").
async function disableClaimButton(message, sellerName) {
  if (!message?.components?.length) return;
  const rows = message.components.map((row) => {
    const r = ActionRowBuilder.from(row);
    r.components.forEach((c) => {
      if (c.data?.custom_id === TICKET_IDS.claim) {
        c.setDisabled(true).setLabel(`Assumido por ${sellerName}`.slice(0, 80));
      }
    });
    return r;
  });
  await message.edit({ components: rows }).catch(() => {});
}

// Extrai o ID do dono do ticket a partir do topic ("ticket:<userId>").
function ticketOwnerId(channel) {
  const m = /^ticket:(\d+)$/.exec(channel.topic || '');
  return m ? m[1] : null;
}

// Gera a transcrição HTML do ticket e posta no canal de logs. Não lança erro:
// se algo falhar, o fechamento segue normalmente (só loga no console).
async function saveTranscript(channel, closedBy) {
  if (!config.discord.transcriptChannelId) return;
  try {
    const logChannel = await channel.guild.channels
      .fetch(config.discord.transcriptChannelId)
      .catch(() => null);
    if (!logChannel) return;

    const { file, count } = await createTranscriptAttachment(channel);
    const ownerId = ticketOwnerId(channel);

    const embed = brandEmbed({ banner: false })
      .setTitle('📄 Transcrição de ticket')
      .addFields(
        { name: 'Canal', value: `#${channel.name}`, inline: true },
        { name: 'Cliente', value: ownerId ? `<@${ownerId}>` : '—', inline: true },
        { name: 'Fechado por', value: `<@${closedBy.id}>`, inline: true },
        { name: 'Mensagens', value: String(count), inline: true },
      )
      .setTimestamp();

    await logChannel.send({ embeds: [embed], files: [file] });
  } catch (err) {
    console.error('Falha ao gerar transcrição do ticket:', err);
  }
}

// Botão "Fechar ticket".
export async function handleCloseTicket(interaction) {
  await interaction.reply({ content: 'Gerando transcrição e fechando o ticket em 5s…', ...eph });
  await saveTranscript(interaction.channel, interaction.user);
  setTimeout(() => interaction.channel.delete().catch(() => {}), 5000);
}
