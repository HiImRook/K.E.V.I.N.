const { Client, GatewayIntentBits, SlashCommandBuilder, ModalBuilder, TextInputBuilder, TextInputStyle, ActionRowBuilder } = require('discord.js')
const fetch = require('node-fetch')
require('dotenv').config()

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
})

const guildConfigs = new Map()
const userBalances = new Map()
const userRateLimits = new Map()
const withdrawalRateLimits = new Map()

const RATE_LIMIT_WINDOW = 60 * 1000
const RATE_LIMIT_MAX = 3
const WITHDRAWAL_RATE_LIMIT_WINDOW = 300 * 1000
const BACKUP_INTERVAL = 3 * 60 * 60 * 1000

function checkRateLimit(userId) {
  const now = Date.now()
  const userLimits = userRateLimits.get(userId) || []

  const validLimits = userLimits.filter(timestamp => now - timestamp < RATE_LIMIT_WINDOW)

  if (validLimits.length >= RATE_LIMIT_MAX) {
    return false
  }

  validLimits.push(now)
  userRateLimits.set(userId, validLimits)
  return true
}

function checkWithdrawalRateLimit(userId) {
  const now = Date.now()
  const lastWithdrawal = withdrawalRateLimits.get(userId) || 0

  if (now - lastWithdrawal < WITHDRAWAL_RATE_LIMIT_WINDOW) {
    return false
  }

  withdrawalRateLimits.set(userId, now)
  return true
}

function getUserBalance(userId) {
  return userBalances.get(userId) || 0
}

function addToBalance(userId, amount) {
  const currentBalance = getUserBalance(userId)
  userBalances.set(userId, currentBalance + amount)
}

function setUserBalance(userId, amount) {
  userBalances.set(userId, amount)
}

async function dumpBalances() {
  try {
    for (const [guildId, config] of guildConfigs) {
      if (!config.backupChannelId) continue

      const channel = await client.channels.fetch(config.backupChannelId)
      if (!channel) continue

      if (userBalances.size === 0) {
        await channel.send('📊 **Balance Backup** - No user balances to report.')
        continue
      }

      let balanceReport = '📊 **Balance Backup**\n'
      for (const [userId, balance] of userBalances) {
        if (balance > 0) {
          balanceReport += `<@${userId}>: ${balance.toFixed(4)} ADA\n`
        }
      }

      if (balanceReport === '📊 **Balance Backup**\n') {
        balanceReport += 'No user balances above 0 ADA.'
      }

      await channel.send(balanceReport)
    }
  } catch (error) {
    console.error('Balance dump error:', error)
  }
}

const setupCommand = new SlashCommandBuilder()
  .setName('setup')
  .setDescription('Setup reward bot configuration')
  .addChannelOption(option =>
    option.setName('monitor_channel')
      .setDescription('Channel to monitor for engagement logs')
      .setRequired(true))
  .addNumberOption(option =>
    option.setName('min_withdrawal')
      .setDescription('Minimum ADA required for withdrawal')
      .setRequired(true))
  .addNumberOption(option =>
    option.setName('dust_amount')
      .setDescription('ADA amount per engagement (default: 0.0001)')
      .setRequired(false))
  .addChannelOption(option =>
    option.setName('backup_channel')
      .setDescription('Channel for balance backups (4 times daily)')
      .setRequired(false))

const balanceCommand = new SlashCommandBuilder()
  .setName('balance')
  .setDescription('Check your accumulated ADA balance')

const withdrawCommand = new SlashCommandBuilder()
  .setName('withdraw')
  .setDescription('Withdraw your accumulated ADA')

const setBalanceCommand = new SlashCommandBuilder()
  .setName('setbalance')
  .setDescription('Set user balance (Admin only)')
  .addUserOption(option =>
    option.setName('user')
      .setDescription('User to set balance for')
      .setRequired(true))
  .addNumberOption(option =>
    option.setName('amount')
      .setDescription('ADA amount to set')
      .setRequired(true))

const restoreCommand = new SlashCommandBuilder()
  .setName('restore')
  .setDescription('Restore balances from any channel (Admin only)')
  .addChannelOption(option =>
    option.setName('restore_channel')
      .setDescription('Channel containing balance data')
      .setRequired(true))

const bonusCommand = new SlashCommandBuilder()
  .setName('bonus')
  .setDescription('Start bonus multiplier event (Admin only)')
  .addNumberOption(option =>
    option.setName('multiplier')
      .setDescription('Multiplier x')
      .setRequired(true))
  .addRoleOption(option =>
    option.setName('role')
      .setDescription('Role to notify about the bonus event')
      .setRequired(true))

const endBonusCommand = new SlashCommandBuilder()
  .setName('endbonus')
  .setDescription('End bonus multiplier event (Admin only)')
  .addRoleOption(option =>
    option.setName('role')
      .setDescription('Role to notify that the bonus event has ended')
      .setRequired(true))

client.once('ready', async () => {
  try {
    console.log(`Logged in as ${client.user.tag}`)
    await client.application.commands.set([setupCommand, balanceCommand, withdrawCommand, setBalanceCommand, restoreCommand, bonusCommand, endBonusCommand])
    console.log('Slash commands registered')

    client.user.setPresence({
      activities: [{ name: 'ADA rewards', type: 'WATCHING' }],
      status: 'online'
    })

    setInterval(dumpBalances, BACKUP_INTERVAL)
  } catch (error) {
    console.error('Ready event error:', error)
  }
})

client.on('messageCreate', async (message) => {
  try {
    const guildConfig = guildConfigs.get(message.guildId)
    if (!guildConfig || message.channelId !== guildConfig.monitorChannelId) return

    const engagementMatch = message.content.match(/👀 <@(\d+)> viewed:/)
    if (engagementMatch) {
      const userId = engagementMatch[1]
      const bonusMultiplier = guildConfig.bonusMultiplier || 1.0
      const rewardAmount = guildConfig.dustAmount * bonusMultiplier
      addToBalance(userId, rewardAmount)
      console.log(`Added ${rewardAmount} ADA to user ${userId}`)
    }
  } catch (error) {
    console.error('Message tracking error:', error)
  }
})

client.on('interactionCreate', async (interaction) => {
  try {
    if (interaction.isCommand()) {

    if (interaction.commandName === 'setup') {
      if (!interaction.member.permissions.has('Administrator')) {
        await interaction.reply({
          content: '❌ Only administrators can use this command.',
          ephemeral: true
        })
        return
      }

      const monitorChannel = interaction.options.getChannel('monitor_channel')
      const minWithdrawal = interaction.options.getNumber('min_withdrawal')
      const dustAmount = interaction.options.getNumber('dust_amount') || 0.0001
      const backupChannel = interaction.options.getChannel('backup_channel')

      const config = {
        monitorChannelId: monitorChannel.id,
        dustAmount: dustAmount,
        minWithdrawal: minWithdrawal,
        backupChannelId: backupChannel ? backupChannel.id : null,
        bonusMultiplier: 1.0,
        guildId: interaction.guildId
      }

      guildConfigs.set(interaction.guildId, config)

      let responseText = `✅ Reward bot setup complete!\n`
      responseText += `**Monitor Channel:** <#${monitorChannel.id}>\n`
      responseText += `**Dust Amount:** ${dustAmount} ADA\n`
      responseText += `**Min Withdrawal:** ${minWithdrawal} ADA`

      if (backupChannel) {
        responseText += `\n**Backup Channel:** <#${backupChannel.id}>`
      }

      await interaction.reply({ content: responseText, ephemeral: true })
    }

    if (interaction.commandName === 'balance') {
      if (!checkRateLimit(interaction.user.id)) {
        await interaction.reply({
          content: '⏰ Rate limit exceeded. Please wait before checking balance again.',
          ephemeral: true
        })
        return
      }

      const balance = getUserBalance(interaction.user.id)
      await interaction.reply({
        content: `You have ${balance.toFixed(4)} ADA`,
        ephemeral: true
      })
    }

    if (interaction.commandName === 'withdraw') {
      if (!checkWithdrawalRateLimit(interaction.user.id)) {
        await interaction.reply({
          content: '⏰ Withdrawal rate limit exceeded. Please wait 5 minutes between withdrawal attempts.',
          ephemeral: true
        })
        return
      }

      const guildConfig = guildConfigs.get(interaction.guildId)
      if (!guildConfig) {
        await interaction.reply({
          content: '❌ Reward bot not configured. Ask an admin to run /setup first.',
          ephemeral: true
        })
        return
      }

      const currentBalance = getUserBalance(interaction.user.id)
      if (currentBalance < guildConfig.minWithdrawal) {
        await interaction.reply({
          content: `❌ Insufficient balance. You need at least ${guildConfig.minWithdrawal} ADA to withdraw. Current balance: ${currentBalance.toFixed(4)} ADA`,
          ephemeral: true
        })
        return
      }

      const modal = new ModalBuilder()
        .setCustomId('withdraw_modal')
        .setTitle('Withdraw ADA')

      const addressInput = new TextInputBuilder()
        .setCustomId('address')
        .setLabel('Cardano Address')
        .setStyle(TextInputStyle.Short)
        .setRequired(true)

      const amountInput = new TextInputBuilder()
        .setCustomId('amount')
        .setLabel('ADA')
        .setStyle(TextInputStyle.Short)
        .setRequired(true)

      const firstRow = new ActionRowBuilder().addComponents(addressInput)
      const secondRow = new ActionRowBuilder().addComponents(amountInput)

      modal.addComponents(firstRow, secondRow)
      await interaction.showModal(modal)
    }

    if (interaction.commandName === 'setbalance') {
      if (!interaction.member.permissions.has('Administrator')) {
        await interaction.reply({
          content: '❌ Only administrators can use this command.',
          ephemeral: true
        })
        return
      }

      const user = interaction.options.getUser('user')
      const amount = interaction.options.getNumber('amount')

      setUserBalance(user.id, amount)

      await interaction.reply({
        content: `✅ Set balance for <@${user.id}> to **${amount.toFixed(4)} ADA**`,
        ephemeral: true
      })
    }

    if (interaction.commandName === 'restore') {
      if (!interaction.member.permissions.has('Administrator')) {
        await interaction.reply({
          content: '❌ Only administrators can use this command.',
          ephemeral: true
        })
        return
      }

      const selectedChannel = interaction.options.getChannel('restore_channel')
      if (!selectedChannel) {
        await interaction.reply({
          content: '❌ Invalid channel selected.',
          ephemeral: true
        })
        return
      }

      try {
        const channel = await client.channels.fetch(selectedChannel.id)
        if (!channel) {
          await interaction.reply({
            content: '❌ Channel not found.',
            ephemeral: true
          })
          return
        }

        const messages = await channel.messages.fetch({ limit: 50 })
        const balanceMessage = messages.find(msg => msg.content.includes('📊') && msg.content.includes('Balance Backup'))

        if (!balanceMessage) {
          await interaction.reply({
            content: '❌ No balance data found in selected channel.',
            ephemeral: true
          })
          return
        }

        let restoredCount = 0
        let totalAmount = 0

        const userMatches = balanceMessage.content.matchAll(/<@(\d+)>: ([\d.]+) ADA/g)
        for (const match of userMatches) {
          const userId = match[1]
          const amount = parseFloat(match[2])

          addToBalance(userId, amount)
          restoredCount++
          totalAmount += amount
          console.log(`Restored ${amount} ADA to user ${userId}`)
        }

        await interaction.reply({
          content: `✅ Restored balances for ${restoredCount} users with total ${totalAmount.toFixed(4)} ADA from <#${selectedChannel.id}>`,
          ephemeral: true
        })

      } catch (error) {
        console.error('Restore error:', error)
        await interaction.reply({
          content: '❌ Error restoring balances. Check logs.',
          ephemeral: true
        })
      }
    }

    if (interaction.commandName === 'bonus') {
      if (!interaction.member.permissions.has('Administrator')) {
        await interaction.reply({
          content: '❌ Only administrators can use this command.',
          ephemeral: true
        })
        return
      }

      const guildConfig = guildConfigs.get(interaction.guildId)
      if (!guildConfig) {
        await interaction.reply({
          content: '❌ Reward bot not configured. Run /setup first.',
          ephemeral: true
        })
        return
      }

      const multiplier = interaction.options.getNumber('multiplier')
      const role = interaction.options.getRole('role')
      
      guildConfig.bonusMultiplier = multiplier
      guildConfigs.set(interaction.guildId, guildConfig)

      await interaction.reply({
        content: `🎉 <@&${role.id}> **BONUS EVENT STARTED!** All engagement rewards are now **${multiplier}x** the normal amount! 🥳`,
        ephemeral: false
      })
    }

    if (interaction.commandName === 'endbonus') {
      if (!interaction.member.permissions.has('Administrator')) {
        await interaction.reply({
          content: '❌ Only administrators can use this command.',
          ephemeral: true
        })
        return
      }

      const guildConfig = guildConfigs.get(interaction.guildId)
      if (!guildConfig) {
        await interaction.reply({
          content: '❌ Reward bot not configured. Run /setup first.',
          ephemeral: true
        })
        return
      }

      const role = interaction.options.getRole('role')
      
      guildConfig.bonusMultiplier = 1.0
      guildConfigs.set(interaction.guildId, guildConfig)

      await interaction.reply({
        content: `📢 <@&${role.id}> **Bonus event has ended.** Engagement rewards are back to normal amounts. 🤷‍♂️`,
        ephemeral: false
      })
    }

    }

    if (interaction.isModalSubmit() && interaction.customId === 'withdraw_modal') {
      const address = interaction.fields.getTextInputValue('address')
      const requestedAmount = parseFloat(interaction.fields.getTextInputValue('amount'))

      const guildConfig = guildConfigs.get(interaction.guildId)
      const currentBalance = getUserBalance(interaction.user.id)

      if (isNaN(requestedAmount) || requestedAmount <= 0) {
        await interaction.reply({
          content: '❌ Invalid amount. Please enter a valid number greater than 0.',
          ephemeral: true
        })
        return
      }

      if (requestedAmount > currentBalance) {
        await interaction.reply({
          content: `❌ You only have ${currentBalance.toFixed(4)} ADA!`,
          ephemeral: true
        })
        return
      }

      if (!address.startsWith('addr1')) {
        await interaction.reply({
          content: '❌ Invalid Cardano address. Address must start with "addr1".',
          ephemeral: true
        })
        return
      }

      await interaction.deferReply({ ephemeral: true })

      try {
        const response = await fetch(`http://${process.env.API_HOST}:${process.env.API_PORT}/withdraw`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${process.env.API_SECRET_KEY}`
          },
          body: JSON.stringify({
            userId: interaction.user.id,
            address: address,
            requestedAmount: requestedAmount,
            currentBalance: currentBalance
          })
        })

        const result = await response.json()

        if (!response.ok) {
          await interaction.editReply({
            content: `❌ ${result.error || 'Withdrawal failed'}`,
            ephemeral: true
          })
          return
        }

        const newBalance = currentBalance - result.actualWithdrawal
        setUserBalance(interaction.user.id, newBalance)

        await interaction.editReply({
          content: `✅ **Withdrawal Successful!**\n**Amount:** ${result.actualWithdrawal.toFixed(4)} ADA\n**To:** ${address}\n**Transaction:** ${result.txHash}\n**New Balance:** ${newBalance.toFixed(4)} ADA`,
          ephemeral: true
        })

      } catch (error) {
        console.error('Withdrawal API error:', error)
        await interaction.editReply({
          content: '❌ Withdrawal service temporarily unavailable. Please try again later.',
          ephemeral: true
        })
      }
    }

  } catch (error) {
    console.error('Interaction error:', error)
    if (!interaction.replied && !interaction.deferred) {
      await interaction.reply({
        content: 'An error occurred while processing your request.',
        ephemeral: true
      })
    }
  }
})

const TOKEN = process.env.DISCORD_TOKEN
try {
  client.login(TOKEN)
} catch (error) {
  console.error('Login error:', error)
}