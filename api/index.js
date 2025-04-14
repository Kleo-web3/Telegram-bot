require('dotenv').config();
const { Telegraf } = require('telegraf');
const fs = require('fs');

const bot = new Telegraf(process.env.BOT_TOKEN || '8138895960:AAG-ddoocpdxJiLpZM6onrEC9u1qlp_lDPs');
const ENTRY_GROUP_ID = '-4621558441';
const GROUP_A_ID = '-1002044118311';
const MAIN_GROUP_ID = '-1002288817447';
const ADMIN_CHAT_ID = '5147724876';
const LOG_FILE = 'verifications.log';
const WELCOME_TIMEOUT = 60000;
const RATE_LIMIT_MS = 60000;
const rateLimitMap = new Map();
let verificationCount = 0;

async function isAdmin(userId) {
  try {
    const member = await bot.telegram.getChatMember(ENTRY_GROUP_ID, userId);
    return ['administrator', 'creator'].includes(member.status);
  } catch (error) {
    console.error('Error checking admin status:', error);
    return false;
  }
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    return res.status(200).json({ status: 'Listening for bot events' });
  }

  try {
    await bot.handleUpdate(req.body, res);
  } catch (error) {
    console.error('Error handling update:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
};

bot.on('new_chat_members', async (ctx) => {
  if (ctx.chat.id.toString() === ENTRY_GROUP_ID) {
    try {
      const groupALink = await bot.telegram.exportChatInviteLink(GROUP_A_ID);
      const message = await ctx.reply(
        `Welcome buddy! To join the educational group, please join the sisters channel and group first:\n` +
        `1. Group A: ${groupALink}\n` +
        `Then type /verify here.\n` +
        `*This message will be deleted in 1 minute.*`
      );
      setTimeout(async () => {
        try {
          await ctx.telegram.deleteMessage(ctx.chat.id, message.message_id);
          console.log(`Deleted welcome message ${message.message_id}`);
        } catch (error) {
          console.error('Error deleting welcome message:', error);
        }
      }, WELCOME_TIMEOUT);
    } catch (error) {
      console.error('Error generating invite link:', error);
      await ctx.reply('Error generating invite link. Please contact an admin.');
    }
  }
});

bot.on('text', async (ctx) => {
  if (ctx.chat.id.toString() === ENTRY_GROUP_ID) {
    const userId = ctx.from.id;
    const username = ctx.from.username ? `@${ctx.from.username}` : userId;
    const message = ctx.message.text;

    if (!(await isAdmin(userId)) && message !== '/verify') {
      try {
        await ctx.deleteMessage();
        const logMessage = `${new Date().toISOString()} - Non-Admin Message: User ${username} (ID: ${userId}) message "${message}" deleted\n`;
        fs.appendFileSync(LOG_FILE, logMessage, 'utf8');
      } catch (error) {
        console.error('Error deleting non-admin message:', error);
        const logMessage = `${new Date().toISOString()} - Error: Failed to delete message from ${username} (ID: ${userId}) - ${error.message}\n`;
        fs.appendFileSync(LOG_FILE, logMessage, 'utf8');
      }
    }
  }
});

bot.command('verify', async (ctx) => {
  if (ctx.chat.id.toString() !== ENTRY_GROUP_ID) {
    return ctx.reply('Please use /verify in the entry group.');
  }

  const userId = ctx.from.id;
  const username = ctx.from.username ? `@${ctx.from.username}` : userId;
  const now = Date.now();

  const lastAttempt = rateLimitMap.get(userId) || 0;
  if (now - lastAttempt < RATE_LIMIT_MS) {
    const secondsLeft = Math.ceil((RATE_LIMIT_MS - (now - lastAttempt)) / 1000);
    return ctx.reply(`Please wait ${secondsLeft} seconds before trying /verify again.`);
  }

  rateLimitMap.set(userId, now);

  try {
    const groupAMember = await bot.telegram.getChatMember(GROUP_A_ID, userId);
    const isInGroupA = ['member', 'administrator', 'creator'].includes(groupAMember.status);

    if (isInGroupA) {
      const inviteLink = await bot.telegram.exportChatInviteLink(MAIN_GROUP_ID);
      if (!inviteLink) throw new Error('Generated link is empty');
      const successMessage = await ctx.reply(
        `Success! Join here: ${inviteLink}\n*This message will be deleted in 1 minute.*`
      );
      verificationCount++;

      setTimeout(async () => {
        try {
          await ctx.telegram.deleteMessage(ctx.chat.id, successMessage.message_id);
          console.log(`Deleted success message ${successMessage.message_id}`);
        } catch (error) {
          console.error('Error deleting success message:', error);
        }
      }, WELCOME_TIMEOUT);

      let attempts = 0;
      const maxAttempts = 3;
      const retryDelay = 5000;
      while (attempts < maxAttempts) {
        try {
          const mainGroupMember = await bot.telegram.getChatMember(MAIN_GROUP_ID, userId);
          const isInMainGroup = ['member', 'administrator', 'creator'].includes(mainGroupMember.status);
          if (isInMainGroup) {
            await bot.telegram.kickChatMember(ENTRY_GROUP_ID, userId);
            const logMessage = `${new Date().toISOString()} - Success: User ${username} (ID: ${userId}) verified, joined main group, and removed from entry group\n`;
            fs.appendFileSync(LOG_FILE, logMessage, 'utf8');
            await bot.telegram.sendMessage(ADMIN_CHAT_ID, `User ${username} (ID: ${userId}) verified and moved to main group.`);
            break;
          }
        } catch (joinError) {
          console.error(`Attempt ${attempts + 1} failed to check main group membership:`, joinError);
        }
        attempts++;
        if (attempts < maxAttempts) {
          await new Promise(resolve => setTimeout(resolve, retryDelay));
        } else {
          const logMessage = `${new Date().toISOString()} - Warning: User ${username} (ID: ${userId}) verified but not removed (not in main group after retries)\n`;
          fs.appendFileSync(LOG_FILE, logMessage, 'utf8');
        }
      }
    } else {
      await ctx.reply('Please join Group A first, then try /verify again.');
      const logMessage = `${new Date().toISOString()} - Failed: User ${username} (ID: ${userId}) not in Group A\n`;
      fs.appendFileSync(LOG_FILE, logMessage, 'utf8');
    }
  } catch (error) {
    console.error('Verification error:', error);
    await ctx.reply('Something went wrong. Please try again or contact an admin.');
    const logMessage = `${new Date().toISOString()} - Error: User ${username} (ID: ${userId}) - ${error.message}\n`;
    fs.appendFileSync(LOG_FILE, logMessage, 'utf8');
  }
});

bot.command('stats', async (ctx) => {
  if (ctx.chat.id.toString() !== ENTRY_GROUP_ID) {
    return ctx.reply('Please use /stats in the entry group.');
  }
  const userId = ctx.from.id;
  if (await isAdmin(userId)) {
    await ctx.reply(`Total successful verifications: ${verificationCount}`);
  } else {
    await ctx.reply('Only admins can use /stats.');
  }
});