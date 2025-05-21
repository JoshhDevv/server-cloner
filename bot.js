require('dotenv').config();
const { Client, GatewayIntentBits, SlashCommandBuilder, REST, Routes, PermissionsBitField, WebhookClient, MessageFlags } = require('discord.js');

const TOKEN = process.env.BOT_TOKEN;
const CLIENT_ID = process.env.CLIENT_ID;

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildMembers
    ]
});

// Register commands
const commands = [
    new SlashCommandBuilder()
        .setName('backup')
        .setDescription('Create a backup of the current server structure')
        .setDMPermission(false),
    
    new SlashCommandBuilder()
        .setName('clone')
        .setDescription('Clone server structure to another server')
        .addStringOption(option =>
            option.setName('target_server_id')
            .setDescription('The ID of the target server')
            .setRequired(true)
        )
        .addBooleanOption(option =>
            option.setName('copy_messages')
            .setDescription('Copy last 10 messages per channel')
            .setRequired(false)
        )
        .addBooleanOption(option =>
            option.setName('clean_target')
            .setDescription('Delete all existing channels and roles in target server')
            .setRequired(false)
        )
        .setDMPermission(false)
].map(command => command.toJSON());

// Store backups
const serverBackups = new Map();

// Register commands with Discord
const rest = new REST({ version: '10' }).setToken(TOKEN);
client.once('ready', async () => {
    console.log(`Logged in as ${client.user.tag}`);
    
    try {
        console.log('Registering slash commands...');
        await rest.put(
            Routes.applicationCommands(CLIENT_ID),
            { body: commands }
        );
        console.log('Slash commands registered successfully.');
    } catch (error) {
        console.error('Error registering commands:', error);
    }
});

// Create an async function for the test
async function testWebhook(guild) {
  try {
    const testChannel = guild.channels.cache.first();
    if (testChannel && testChannel.isTextBased()) {
      console.log('Testing webhook creation...');
      const testWebhook = await testChannel.createWebhook({
        name: 'Test Webhook',
        avatar: 'https://i.imgur.com/AfFp7pu.png'
      });
      await testWebhook.send('Test message');
      console.log('Test webhook successful!');
      await testWebhook.delete();
    }
  } catch (error) {
    console.error('Webhook test failed:', error.message);
  }
}

// Add this helper function at the top of your file
async function safeReply(interaction, content, options = {}) {
    try {
        if (!interaction.replied && !interaction.deferred) {
            return await interaction.reply({ content, ephemeral: true, ...options });
        } else {
            return await interaction.followUp({ content, ephemeral: true, ...options });
        }
    } catch (error) {
        console.warn(`Failed to reply to interaction: ${error.message}`);
        // If the interaction is too old, we can't do anything about it
    }
}

// Handle commands
client.on('interactionCreate', async interaction => {
    if (!interaction.isChatInputCommand()) return;
    
    // Check for admin permissions
    if (!interaction.memberPermissions.has(PermissionsBitField.Flags.Administrator)) {
        await interaction.reply({ content: 'You need administrator permissions to use this command.', ephemeral: true });
        return;
    }

    try {
        const { commandName } = interaction;
        
        if (commandName === 'backup') {
            await handleBackup(interaction);
        } else if (commandName === 'clone') {
            await handleClone(interaction);
        }
    } catch (error) {
        console.error(error);
        try {
            const content = 'An error occurred while processing your command.';
            if (interaction.replied || interaction.deferred) {
                await interaction.followUp({ content, ephemeral: true });
            } else {
                await interaction.reply({ content, ephemeral: true });
            }
        } catch (e) {
            console.error('Error while sending error message:', e);
        }
    }
});

async function handleBackup(interaction) {
    await interaction.deferReply({ ephemeral: true });
    const guild = interaction.guild;
    
    // Create backup object
    const backup = {
        name: guild.name,
        icon: guild.iconURL(),
        categories: [],
        roles: [],
        messages: new Map() // Store messages by channel name
    };
    
    // Backup roles
    for (const [id, role] of guild.roles.cache.entries()) {
        // Skip @everyone role and managed roles (bot roles)
        if (role.name !== '@everyone' && !role.managed) {
            backup.roles.push({
                name: role.name,
                color: role.color,
                hoist: role.hoist,
                permissions: role.permissions.bitfield,
                mentionable: role.mentionable,
                position: role.position
            });
        }
    }
    
    // Get all categories
    const categories = guild.channels.cache.filter(c => c.type === 4);
    
    // Backup categories and channels
    for (const [id, category] of categories) {
        const categoryData = {
            name: category.name,
            channels: []
        };
        
        // Get channels in this category
        const channels = guild.channels.cache.filter(c => c.parentId === category.id);
        
        for (const [channelId, channel] of channels) {
            const channelData = {
                name: channel.name,
                type: channel.type,
                topic: channel.topic || ''
            };
            
            categoryData.channels.push(channelData);
            
            // Backup last 10 messages if text channel
            if (channel.isTextBased()) {
                try {
                    console.log(`Backing up messages from channel: ${channel.name}`);
                    const messages = await channel.messages.fetch({ limit: 10 });
                    const msgArray = [];
                    
                    messages.forEach(msg => {
                        console.log(`Backing up message from ${msg.author.username}`);
                        msgArray.push({
                            content: msg.content,
                            author: {
                                username: msg.author.username,
                                avatarURL: msg.author.displayAvatarURL({ format: 'png', size: 128 }),
                                bot: msg.author.bot,
                                id: msg.author.id
                            },
                            timestamp: msg.createdTimestamp,
                            attachments: Array.from(msg.attachments.values()).map(att => ({
                                url: att.url,
                                name: att.name
                            }))
                        });
                    });
                    
                    if (msgArray.length > 0) {
                        backup.messages.set(`${category.name}|${channel.name}`, msgArray);
                        console.log(`Backed up ${msgArray.length} messages from ${channel.name}`);
                    }
                } catch (error) {
                    console.error(`Failed to backup messages for channel ${channel.name}:`, error.message);
                }
            }
        }
        
        backup.categories.push(categoryData);
    }
    
    // Get channels without category
    const uncategorizedChannels = guild.channels.cache.filter(c => !c.parentId && c.type !== 4);
    
    if (uncategorizedChannels.size > 0) {
        const uncategorized = {
            name: 'Uncategorized',
            channels: []
        };
        
        for (const [id, channel] of uncategorizedChannels) {
            const channelData = {
                name: channel.name,
                type: channel.type,
                topic: channel.topic || ''
            };
            
            uncategorized.channels.push(channelData);
            
            // Backup last 10 messages if text channel
            if (channel.isTextBased()) {
                try {
                    const messages = await channel.messages.fetch({ limit: 10 });
                    const msgArray = [];
                    
                    messages.forEach(msg => {
                        msgArray.push({
                            content: msg.content,
                            author: {
                                username: msg.author.username,
                                avatarURL: msg.author.displayAvatarURL(),
                                bot: msg.author.bot,
                                id: msg.author.id
                            },
                            timestamp: msg.createdTimestamp
                        });
                    });
                    
                    backup.messages.set(`Uncategorized|${channel.name}`, msgArray);
                } catch (error) {
                    console.error(`Failed to backup messages for channel ${channel.name}:`, error);
                }
            }
        }
        
        backup.categories.push(uncategorized);
    }
    
    // Add this before the serverBackups.set line in handleBackup
    console.log(`Total messages backed up: ${Array.from(backup.messages.keys()).length}`);
    console.log(`Channels with messages: ${Array.from(backup.messages.keys()).join(', ')}`);
    
    // Store backup
    serverBackups.set(guild.id, backup);
    
    await interaction.editReply({ content: '✅ Server backup created! Use `/clone` to restore it to another server.' });
}

async function handleClone(interaction) {
    // Start with a defer to get the full 15 minute window
    await interaction.deferReply({ ephemeral: true });
    
    // Store the start time to track interaction lifetime
    const startTime = Date.now();
    const MAX_INTERACTION_LIFETIME = 14 * 60 * 1000; // 14 minutes in ms
    
    // Helper to check if interaction is still valid
    const isInteractionExpired = () => (Date.now() - startTime) > MAX_INTERACTION_LIFETIME;
    
    try {
        const sourceGuild = interaction.guild;
        const targetGuildId = interaction.options.getString('target_server_id');
        const copyMessages = interaction.options.getBoolean('copy_messages') || false;
        const cleanTarget = interaction.options.getBoolean('clean_target') || false;
        const targetGuild = client.guilds.cache.get(targetGuildId);
        
        if (!targetGuild) {
            await safeReply(interaction, 'The bot is not in the target server or the ID is invalid.');
            return;
        }
        
        // Check if bot has admin permissions in target guild
        const member = await targetGuild.members.fetch(client.user.id);
        if (!member.permissions.has(PermissionsBitField.Flags.Administrator)) {
            await interaction.editReply({ content: 'The bot needs Administrator permission in the target server.' });
            return;
        }
        
        // Check if a backup exists
        const backup = serverBackups.get(sourceGuild.id);
        if (!backup) {
            await interaction.editReply({ content: 'No backup found. Please create a backup first using `/backup`.' });
            return;
        }
        
        // Clean target server if requested
        if (cleanTarget) {
            if (!isInteractionExpired()) {
                try {
                    await interaction.editReply({ content: 'Cleaning target server... Deleting channels and roles...' });
                } catch (error) {
                    console.warn('Interaction expired, continuing silently.');
                }
            }
            
            try {
                // Delete channels one by one in sequence (safer than Promise.all)
                const allChannels = [...targetGuild.channels.cache.values()];
                console.log(`Found ${allChannels.length} channels to delete in target server`);
                
                // Sort channels to delete child channels first, then categories
                // This avoids errors with deleting categories that have channels in them
                const sortedChannels = allChannels.sort((a, b) => {
                    // Delete text/voice channels before categories
                    if (a.type === 4 && b.type !== 4) return 1;
                    if (a.type !== 4 && b.type === 4) return -1;
                    return 0;
                });
                
                // For channel deletion
                let deletedChannels = 0;
                const totalChannels = sortedChannels.length;

                for (const channel of sortedChannels) {
                    try {
                        await channel.delete('Server clone operation');
                        deletedChannels++;
                        
                        // Update progress every 5 channels
                        if (deletedChannels % 5 === 0 && !isInteractionExpired()) {
                            try {
                                await interaction.editReply({ 
                                    content: `Cleaning server... Deleted ${deletedChannels}/${totalChannels} channels...` 
                                });
                            } catch (error) {
                                console.warn('Interaction expired, continuing silently.');
                            }
                        }
                        
                        await new Promise(resolve => setTimeout(resolve, 300));
                    } catch (error) {
                        console.error(`Failed to delete channel: ${error.message}`);
                    }
                }
                
                // Delete roles one by one in sequence
                const rolesToDelete = targetGuild.roles.cache.filter(role => 
                    role.name !== '@everyone' && !role.managed);
                
                console.log(`Found ${rolesToDelete.size} roles to delete in target server`);
                
                // Sort roles by position (delete lower roles first to avoid hierarchy issues)
                const sortedRoles = [...rolesToDelete.values()].sort((a, b) => a.position - b.position);
                
                for (const role of sortedRoles) {
                    try {
                        console.log(`Attempting to delete role: ${role.name} (${role.id})`);
                        await role.delete('Server clone operation');
                        console.log(`Successfully deleted role: ${role.name} (${role.id})`);
                        // Add a small delay to prevent rate limiting
                        await new Promise(resolve => setTimeout(resolve, 300)); // Increased delay
                    } catch (error) {
                        console.error(`Failed to delete role ${role.name} (${role.id}): ${error.message}`);
                        // Continue with other roles even if one fails
                    }
                }
                
                if (!isInteractionExpired()) {
                    try {
                        await interaction.editReply({ content: 'Target server cleaned. Beginning cloning process...' });
                    } catch (error) {
                        console.warn('Interaction expired, continuing silently.');
                    }
                }
            } catch (error) {
                console.error('Error during server cleanup:', error);
                if (!isInteractionExpired()) {
                    try {
                        await interaction.editReply({ content: 'There was an issue cleaning the target server. Continuing with cloning...' });
                    } catch (error) {
                        console.warn('Interaction expired, continuing silently.');
                    }
                }
            }
        }
        
        // Clone the server
        if (!isInteractionExpired()) {
            try {
                await interaction.editReply({ content: 'Cloning server structure... This may take a while.' });
            } catch (error) {
                console.warn('Interaction expired, continuing silently.');
            }
        }
        
        // Create roles (in reverse to maintain hierarchy)
        const roleMap = new Map();
        const sortedRoles = [...backup.roles].sort((a, b) => a.position - b.position);
        
        for (const roleData of sortedRoles) {
            try {
                const role = await targetGuild.roles.create({
                    name: roleData.name,
                    color: roleData.color,
                    hoist: roleData.hoist,
                    permissions: BigInt(roleData.permissions),
                    mentionable: roleData.mentionable
                });
                roleMap.set(roleData.name, role.id);
            } catch (error) {
                console.error(`Failed to create role ${roleData.name}:`, error);
            }
        }
        
        // Track created channels for message copying
        const channelMap = new Map();
        
        // Create categories and channels
        for (const category of backup.categories) {
            try {
                let categoryChannel = null;
                
                // Create category if it's not "Uncategorized"
                if (category.name !== 'Uncategorized') {
                    categoryChannel = await targetGuild.channels.create({
                        name: category.name,
                        type: 4
                    });
                }
                
                // Create channels in this category
                for (const channelData of category.channels) {
                    try {
                        // When creating channels, ensure consistent key format
                        const newChannel = await targetGuild.channels.create({
                            name: channelData.name,
                            type: channelData.type,
                            topic: channelData.topic,
                            parent: categoryChannel ? categoryChannel.id : null
                        });
                        
                        // Make sure to use EXACTLY the same key format for both storing and retrieving
                        const channelKey = `${category.name}|${channelData.name}`;
                        channelMap.set(channelKey, newChannel);
                        console.log(`Added channel to map: ${channelKey}`);
                    } catch (error) {
                        console.error(`Failed to create channel ${channelData.name}:`, error);
                    }
                }
            } catch (error) {
                console.error(`Failed to create category ${category.name}:`, error);
            }
        }
        
        // Copy messages if requested
        if (copyMessages) {
            // Create a status channel for updates instead of using interaction
            let statusChannel;
            try {
                statusChannel = await targetGuild.channels.create({
                    name: 'clone-status',
                    type: 0, // Text channel
                    topic: 'Bot status messages for cloning operation'
                });
                await statusChannel.send('📋 Copying messages from source server...');
            } catch (error) {
                console.error('Failed to create status channel:', error.message);
                // Continue without status updates if channel creation fails
            }

            console.log('Copy messages option enabled');
            console.log(`Total channels with messages in backup: ${backup.messages.size}`);
            console.log(`Available channels in map: ${channelMap.size}`);
            
            // Log channel keys for debugging
            console.log(`Channel map keys: ${Array.from(channelMap.keys()).join(', ')}`);
            console.log(`Backup message keys: ${Array.from(backup.messages.keys()).join(', ')}`);
            
            let processedChannels = 0;
            const totalChannels = backup.messages.size;
            
            for (const [channelKey, messages] of backup.messages.entries()) {
                const targetChannel = channelMap.get(channelKey);
                
                if (targetChannel && targetChannel.isTextBased()) {
                    try {
                        console.log(`Creating webhook for channel: ${channelKey}`);
                        
                        // Create webhook for this channel
                        const webhook = await targetChannel.createWebhook({
                            name: 'Message Transfer',
                            avatar: 'https://i.imgur.com/AfFp7pu.png'
                        });
                        
                        // Post messages in reverse order (oldest first)
                        const messagesToSend = [...messages].reverse();
                        console.log(`Attempting to send ${messagesToSend.length} messages in ${channelKey}`);
                        
                        let sentCount = 0;
                        for (const msg of messagesToSend) {
                            try {
                                // Prepare embeds for attachments
                                const embeds = [];
                                if (msg.attachments && msg.attachments.length > 0) {
                                    for (const attachment of msg.attachments) {
                                        embeds.push({
                                            title: attachment.name || 'Attachment',
                                            url: attachment.url,
                                            image: { url: attachment.url }
                                        });
                                    }
                                }
                                
                                // Ensure avatar URL is valid
                                let avatarUrl = msg.author.avatarURL;
                                if (!avatarUrl || typeof avatarUrl !== 'string' || !avatarUrl.startsWith('http')) {
                                    avatarUrl = null;
                                }
                                
                                await webhook.send({
                                    content: msg.content || '*[Empty message]*',
                                    username: msg.author.username,
                                    avatarURL: avatarUrl,
                                    embeds: embeds.length > 0 ? embeds : undefined,
                                    allowedMentions: { parse: [] } // Prevent pings
                                });
                                
                                sentCount++;
                                // Add delay to prevent rate limiting
                                await new Promise(resolve => setTimeout(resolve, 300));
                            } catch (error) {
                                console.error(`Error sending webhook message: ${error.message}`);
                                
                                if (error.message.includes('rate limit')) {
                                    console.log('Rate limited, waiting longer...');
                                    await new Promise(resolve => setTimeout(resolve, 5000));
                                }
                            }
                        }
                        
                        console.log(`Sent ${sentCount}/${messagesToSend.length} messages in ${channelKey}`);
                        
                        // Delete webhook after use
                        await webhook.delete()
                            .then(() => console.log(`Deleted webhook for ${channelKey}`))
                            .catch(err => console.error(`Failed to delete webhook: ${err.message}`));
                        
                        // Update progress in status channel
                        processedChannels++;
                        if (statusChannel) {
                            try {
                                await statusChannel.send(
                                    `✅ Processed channel ${processedChannels}/${totalChannels}: ${channelKey} (${sentCount} messages)`
                                );
                            } catch (error) {
                                console.error('Failed to send status update:', error.message);
                            }
                        }
                        
                    } catch (error) {
                        console.error(`Failed to copy messages to channel ${channelKey}: ${error.message}`);
                        
                        if (statusChannel) {
                            try {
                                await statusChannel.send(
                                    `❌ Failed to process channel ${channelKey}: ${error.message}`
                                );
                            } catch (statusErr) {
                                console.error('Failed to send status update:', statusErr.message);
                            }
                        }
                    }
                } else {
                    console.log(`Target channel not found or not text-based for key: ${channelKey}`);
                    
                    if (statusChannel) {
                        try {
                            await statusChannel.send(
                                `⚠️ Skipped channel ${channelKey}: Channel not found or not text-based`
                            );
                        } catch (error) {
                            console.error('Failed to send status update:', error.message);
                        }
                    }
                }
            }
            
            // Final status update
            if (statusChannel) {
                try {
                    await statusChannel.send(
                        `🎉 Message copying complete! Processed ${processedChannels}/${totalChannels} channels.`
                    );
                } catch (error) {
                    console.error('Failed to send final status:', error.message);
                }
            }
        } // End of if (copyMessages)
        
        // Final success message
        if (!isInteractionExpired()) {
            try {
                await interaction.followUp({ 
                    content: '✅ Server structure cloned successfully!' + 
                            (copyMessages ? ' Last 10 messages from each channel have been copied.' : ''),
                    ephemeral: true 
                });
            } catch (error) {
                console.warn('Interaction expired, could not send completion message.');
                // Consider sending a DM to the user instead
                try {
                    await interaction.user.send('✅ Your server clone operation has completed successfully!');
                } catch (dmError) {
                    console.warn('Could not DM user with completion notice.');
                }
            }
        } else {
            // If interaction expired, try to DM the user
            try {
                await interaction.user.send('✅ Your server clone operation has completed successfully!');
            } catch (dmError) {
                console.warn('Could not DM user with completion notice.');
            }
        }
    } catch (error) {
        console.error('Clone error:', error);
        if (!isInteractionExpired()) {
            try {
                await interaction.followUp({ content: 'An error occurred during the clone process.', ephemeral: true });
            } catch (replyError) {
                console.warn('Could not send error message, interaction expired.');
            }
        }
    }
}

client.login(TOKEN);
