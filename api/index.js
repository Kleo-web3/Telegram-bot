const dotenv = require('dotenv');
const path = require('path');
const fs = require('fs');
const { Telegraf } = require('telegraf');

// Look for .env in the project root (one folder up)
const envPath = path.resolve(__dirname, '..', '.env');
console.log('Looking for .env at:', envPath);

// Check if .env exists
if (!fs.existsSync(envPath)) {
  console.error('Error: .env file not found at:', envPath);
  process.exit(1);
}

// Show .env content
try {
  console.log('.env content:', fs.readFileSync(envPath, 'utf8').trim());
} catch (err) {
  console.error('Error reading .env:', err);
  process.exit(1);
}

// Load .env
const result = dotenv.config({ path: envPath });
if (result.error) {
  console.error('Error loading .env:', result.error);
  process.exit(1);
}
console.log('Loaded .env successfully');

// Check BOT_TOKEN
console.log('BOT_TOKEN:', process.env.BOT_TOKEN ? 'Set' : 'Not set');

// Make sure BOT_TOKEN is set
if (!process.env.BOT_TOKEN) {
  console.error('Error: BOT_TOKEN is not set in .env file');
  process.exit(1);
}

const bot = new Telegraf(process.env.BOT_TOKEN);
const ENTRY_GROUP_ID = '-4621558441';
const GROUP_A_ID = '-1002044118311';
const MAIN_GROUP_ID = '-1002288817447';
const ADMIN_CHAT_ID = '5147724876';
const LOG_FILE = 'verifications.log';
const WELCOME_TIMEOUT = 60000;
const RATE_LIMIT_MS = 60000;
const rateLimitMap = new Map();
let verificationCount = 0;

// Helper function to delay execution (for retries)
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

// Check if user is an admin
async function isAdmin(userId, chatId) {
  try {
    const member = await bot.telegram.getChatMember(chatId, userId);
    return ['administrator', 'creator'].includes(member.status);
  } catch (error) {
    console.error(`Error checking admin status for user ${userId} in chat ${chatId}:`, error.message);
    return false;
  }
}

// Check bot's own permissions
async function checkBotPermissions() {
  try {
    const botId = (await bot.telegram.getMe()).id;
    const botMember = await bot.telegram.getChatMember(ENTRY_GROUP_ID, botId);
    const requiredPermissions = [
      'can_send_messages',
      'can_delete_messages',
      'can_invite_users',
      'can_restrict_members'
    ];
    const missingPermissions = requiredPermissions.filter(perm => !botMember[perm]);
    if (missingPermissions.length > 0) {
      console.error(`Bot lacks permissions in entry group: ${missingPermissions.join(', ')}`);
      await bot.telegram.sendMessage(ADMIN_CHAT_ID, `Bot lacks permissions in entry group: ${missingPermissions.join(', ')}`);
    } else {
      console.log('Bot has all required permissions in entry group');
    }
  } catch (error) {
    console.error('Error checking bot permissions:', error.message);
    await bot.telegram.sendMessage(ADMIN_CHAT_ID, `Error checking bot permissions: ${error.message}`);
  }
}

// Serverless function for Vercel
module.exports = async (req, res) => {
  console.log('Received request:', req.method, req.body);
  if (req.method === 'GET') {
    return res.status(200).json({ status: 'Bot is running' });
  }
  if (req.method !== 'POST') {
    return res.status(200).json({ status: 'Listening for bot events' });
  }
  try {
    await bot.handleUpdate(req.body, res);
    console.log('Update handled successfully');
  } catch (error) {
    console.error('Error handling update:', error.message);
    return res.status(500).json({ error: 'Internal server error' });
  }
};

// Handle new chat members
bot.on('new_chat_members', async (ctx) => {
  console.log(`New member joined: Chat ID ${ctx.chat.id}, User ID ${ctx.from.id}, Username: @${ctx.from.username || 'Unknown'}`);
  if (ctx.chat.id.toString() !== ENTRY_GROUP_ID) {
    console.log(`Ignoring new member event in non-entry group: ${ctx.chat.id}`);
    return;
  }

  // Ignore events triggered by bots
  if (ctx.from.is_bot) {
    console.log(`Ignoring new member event from bot: ${ctx.from.id}`);
    return;
  }

  try {
    const groupALink = await bot.telegram.exportChatInviteLink(GROUP_A_ID);
    const message = await ctx.reply(
      `Welcome buddy! To join the educational group, please join the sister group first:\n` +
      `1. Group A: ${groupALink}\n` +
      `Then type /verify here.\n` +
      `*This message will be deleted in 1 minute.*`
    );
    console.log(`Sent welcome message: ${message.message_id}`);
    setTimeout(async () => {
      try {
        await ctx.telegram.deleteMessage(ctx.chat.id, message.message_id);
        console.log(`Deleted welcome message ${message.message_id}`);
      } catch (error) {
        console.error(`Error deleting welcome message ${message.message_id}:`, error.message);
      }
    }, WELCOME_TIMEOUT);
  } catch (error) {
    console.error('Error generating invite link:', error.message);
    await ctx.reply('Error generating invite link. Please contact an admin.');
    await bot.telegram.sendMessage(ADMIN_CHAT_ID, `Error generating Group A invite link for user ${ctx.from.id}: ${error.message}`);
  }
});

// Handle /verify command
bot.command('verify', async (ctx) => {
  console.log(`Verify command from User ID ${ctx.from.id}, Username: @${ctx.from.username || 'Unknown'} in chat ${ctx.chat.id}`);
  if (ctx.chat.id.toString() !== ENTRY_GROUP_ID) {
    return ctx.reply('Please use /verify in the entry group.');
  }

  const userId = ctx.from.id;
  const username = ctx.from.username ? `@${ctx.from.username}` : userId;
  const now = Date.now();

  // Rate limiting
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
      if (!inviteLink) throw new Error('Generated main group link is empty');
      const successMessage = await ctx.reply(
        `Success! Join here: ${inviteLink}\n*This message will be deleted in 1 minute.*`
      );
      verificationCount++;

      // Delete the /verify command message
      try {
        await ctx.deleteMessage();
        console.log(`Deleted /verify command message ${ctx.message.message_id}`);
      } catch (error) {
        console.error(`Error deleting /verify command message ${ctx.message.message_id}:`, error.message);
      }

      setTimeout(async () => {
        try {
          await ctx.telegram.deleteMessage(ctx.chat.id, successMessage.message_id);
          console.log(`Deleted success message ${successMessage.message_id}`);
        } catch (error) {
          console.error(`Error deleting success message ${result.message_id}:`, error.message);
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
            await bot.telegram.banChatMember(ENTRY_GROUP_ID, userId);
            const logMessage = `${new Date().toISOString()} - Success: User ${username} (ID: ${userId}) verified, joined main group, and removed from entry group\n`;
            console.log(logMessage);
            fs.appendFileSync(LOG_FILE, logMessage, 'utf8');
            await bot.telegram.sendMessage(ADMIN_CHAT_ID, `User ${username} (ID: ${userId}) verified and moved to main group.`);
            break;
          }
        } catch (joinError) {
          console.error(`Attempt ${attempts + 1} failed to check main group membership for user ${userId}:`, joinError.message);
        }
        attempts++;
        if (attempts < maxAttempts) {
          await delay(retryDelay);
        } else {
          const logMessage = `${new Date().toISOString()} - Warning: User ${username} (ID: ${userId}) verified but not removed (not in main group after retries)\n`;
          console.log(logMessage);
          fs.appendFileSync(LOG_FILE, logMessage, 'utf8');
        }
      }
    } else {
      await ctx.reply('Please join Group A first, then try /verify again.');
      const logMessage = `${new Date().toISOString()} - Failed: User ${username} (ID: ${userId}) not in Group A\n`;
      console.log(logMessage);
      fs.appendFileSync(LOG_FILE, logMessage, 'utf8');
    }
  } catch (error) {
    console.error(`Verification error for user ${username} (ID: ${userId}):`, error.message);
    await ctx.reply('Something went wrong. Please try again or contact an admin.');
    const logMessage = `${new Date().toISOString()} - Error: User ${username} (ID: ${userId}) - ${error.message}\n`;
    console.log(logMessage);
    fs.appendFileSync(LOG_FILE, logMessage, 'utf8');
    await bot.telegram.sendMessage(ADMIN_CHAT_ID, `Verification error for user ${username} (ID: ${userId}): ${error.message}`);
  }
});

// Handle text messages (delete non-admin, non-command messages)
bot.on('text', async (ctx) => {
  console.log(`Received text in chat ${ctx.chat.id}: ${ctx.message.text}, User ID: ${ctx.from.id}, Username: @${ctx.from.username || 'Unknown'}`);
  if (ctx.chat.id.toString() === ENTRY_GROUP_ID) {
    const userId = ctx.from.id;
    const username = ctx.from.username ? `@${ctx.from.username}` : userId;
    const message = ctx.message.text;

    // Skip if message is from a bot
    if (ctx.from.is_bot) {
      console.log(`Ignoring message from bot: ${ctx.from.id}`);
      return;
    }

    // Skip commands
    if (message.startsWith('/')) {
      console.log(`Skipping command: ${message} from User ${username} (ID: ${userId})`);
      return;
    }

    // Delete non-admin, non-command text messages
    if (!(await isAdmin(userId, ctx.chat.id))) {
      try {
        await ctx.deleteMessage();
        const logMessage = `${new Date().toISOString()} - Non-Admin Message: User ${username} (ID: ${userId}) message "${message}" deleted\n`;
        console.log(logMessage);
        fs.appendFileSync(LOG_FILE, logMessage, 'utf8');
      } catch (error) {
        console.error(`Error deleting non-admin message from ${username} (ID: ${userId}):`, error.message);
        const logMessage = `${new Date().toISOString()} - Error: Failed to delete message from ${username} (ID: ${userId}) - ${error.message}\n`;
        console.log(logMessage);
        fs.appendFileSync(LOG_FILE, logMessage, 'utf8');
      }
    }
  }
});

// Handle /stats command
bot.command('stats', async (ctx) => {
  console.log(`Stats command from User ID ${ctx.from.id}, Username: @${ctx.from.username || 'Unknown'} in chat ${ctx.chat.id}`);
  if (ctx.chat.id.toString() !== ENTRY_GROUP_ID) {
    return ctx.reply('Please use /stats in the entry group.');
  }
  const userId = ctx.from.id;
  if (await isAdmin(userId, ctx.chat.id)) {
    await ctx.reply(`Total successful verifications: ${verificationCount}`);
  } else {
    await ctx.reply('Only admins can use /stats.');
  }
});

// Check bot permissions on startup
console.log('Checking bot permissions...');
checkBotPermissions();

// Start bot with webhook for Vercel
console.log('Setting up webhook for Vercel...');
bot.launch({
  webhook: {
    domain: process.env.VERCEL_URL || 'https://your-vercel-app.vercel.app',
    path: '/api',
  },
}).catch((error) => {
  console.error('Failed to start bot:', error.message);
  bot.telegram.sendMessage(ADMIN_CHAT_ID, `Failed to start bot: ${error.message}`);
});

// Handle process termination
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));