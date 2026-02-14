// =======================
// IMPORTS
import {
  makeWASocket,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  jidDecode
} from "@whiskeysockets/baileys";

import chalk from "chalk";
import fs from "fs";
import path from "path";
import pino from "pino";
import readline from "readline";
import { execSync } from "child_process";

import { initProtections } from "./protections.js";
import { initSecurity } from "./security.js";
import { welcomeEvents } from "./commands/welcome.js";
import { autoreactEvents } from "./commands/autoreact.js";
import { autoreadEvents } from "./commands/autoread.js";
import { autotypingEvents } from "./commands/autotyping.js";
import { autoreadstatusEvents } from "./commands/autoreadstatus.js";
import { autobioEvents } from "./commands/autobio.js";
import { autobvnEvents } from "./commands/autobvn.js";
import { autorecordingEvents } from "./commands/autorecording.js";

import { antideleteEvents } from "./commands/antidelete.js";
import securityCommands from "./commands/security.js";
import protectionCommands from "./commands/protectionCommands.js";
import delayCommands from "./delay.js";
import bugssCommands from "./bugss.js";
import * as Bugs from "./bugs.js";
import tagCommands, { handleMention } from "./commands/tag.js"; // <== import tag.js

// =======================
// GLOBALS & CONFIG
if (!global.restartGuard) global.restartGuard = false;
global.botPrefix = ".";
global.cleanPrefixEnabled = false;
const MODE_FILE = "./mode.json";
const CONFIG_PATH = "./config.json";
const SUDO_FILE = "./sudo.json";

// =======================
// HELPERS
function getBareNumber(input) {
  if (!input) return "";
  const s = String(input);
  const beforeAt = s.split("@")[0];
  const beforeColon = beforeAt.split(":")[0];
  return beforeColon.replace(/[^0-9]/g, "");
}

function unwrapMessage(m) {
  return m?.ephemeralMessage?.message ||
         m?.viewOnceMessageV2?.message ||
         m?.viewOnceMessageV2Extension?.message ||
         m?.documentWithCaptionMessage?.message ||
         m?.viewOnceMessage?.message ||
         m;
}

function pickText(m) {
  return m?.conversation ||
         m?.extendedTextMessage?.text ||
         m?.imageMessage?.caption ||
         m?.videoMessage?.caption ||
         m?.buttonsResponseMessage?.selectedButtonId ||
         m?.listResponseMessage?.singleSelectReply?.selectedRowId ||
         m?.templateButtonReplyMessage?.selectedId ||
         m?.reactionMessage?.text ||
         m?.interactiveResponseMessage?.nativeFlowResponseMessage?.paramsJson;
}

function normalizeJid(jid) {
  if (!jid) return null;
  return jid.split(":")[0].replace("@lid", "@s.whatsapp.net");
}

function getConfig() {
  if (!fs.existsSync(CONFIG_PATH)) fs.writeFileSync(CONFIG_PATH, JSON.stringify({ users: {} }, null, 2));
  return JSON.parse(fs.readFileSync(CONFIG_PATH, "utf-8"));
}

function saveConfig(cfg) { fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2)); }
function getUserConfig(number) { return getConfig().users[number] || null; }
function setUserConfig(number, data) {
  const cfg = getConfig();
  cfg.users[number] = { ...(cfg.users[number] || {}), ...data };
  saveConfig(cfg);
}

function loadSudo() {
  if (!fs.existsSync(SUDO_FILE)) return [];
  return JSON.parse(fs.readFileSync(SUDO_FILE, "utf-8"));
}

function getMode() {
  if (!fs.existsSync(MODE_FILE)) {
    fs.writeFileSync(MODE_FILE, JSON.stringify({ mode: "private" }, null, 2));
    return "private";
  }
  const data = JSON.parse(fs.readFileSync(MODE_FILE, "utf-8"));
  return data.mode || "private";
}

function setMode(newMode) {
  fs.writeFileSync(MODE_FILE, JSON.stringify({ mode: newMode }, null, 2));
}

function question(query) {
  process.stdout.write(query + "\n> ");
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => {
    rl.on("line", input => { rl.close(); resolve(input); });
  });
}

function afficherBanner() {
  console.log("\n🎉 DEV-RAIZEL 🎉\n");
}

// =======================
// FORMATAGE DES COMMANDES
function formatCommandReply(text) {
  const lines = text.split("\n").map(line => `> _\`${line}\`_`);
  return lines.join("\n");
}

// =======================
// SAFE JID DECODER
global.safeDecodeJid = function (jid) {
  if (!jid) return "";
  try {
    const decoded = jidDecode(jid);
    return decoded?.user ? `${decoded.user}@s.whatsapp.net` : jid;
  } catch {
    return jid.split("@")[0] + "@s.whatsapp.net";
  }
};

// =======================
// PATCH SOCKET
function patchSocket(sock) {
  const originalDecode = sock.decodeJid;
  sock.decodeJid = (jid) => {
    if (!jid) return "";
    try {
      const decoded = originalDecode ? originalDecode(jid) : jidDecode(jid);
      return decoded?.user ? `${decoded.user}@s.whatsapp.net` : jid;
    } catch {
      return jid;
    }
  };
  return sock;
}

// =======================
// NETTOYAGE DES LISTENERS
function removeAllListeners(sock) {
  if (!sock || !sock.ev) return;
  try {
    for (const event of sock.ev.eventNames()) {
      sock.ev.removeAllListeners(event);
    }
    console.log(chalk.cyan("✔ Tous les listeners Baileys ont été nettoyés."));
  } catch (e) {
    console.log("Erreur nettoyage listeners :", e);
  }
}

process.setMaxListeners(0);

// =======================
// START BOT
async function startPairing() {
  const { state, saveCreds } = await useMultiFileAuthState("./session");
  const { version } = await fetchLatestBaileysVersion();

  let sock = makeWASocket({
    version,
    printQRInTerminal: false,
    logger: pino({ level: "silent" }),
    auth: { creds: state.creds, keys: makeCacheableSignalKeyStore(state.keys, pino({ level: "silent" })) },
    browser: ["Ubuntu", "Chrome", "20.0.04"]
  });
  sock = patchSocket(sock);

  global.surz = sock;
  global.asep = sock; 
  global.rich = sock;

  // ===================
  // GLOBAL BOT CONFIG & OWNER
  if (!global.bot) global.bot = { config: { prefix: ".", sudoList: loadSudo() } };
  global.owner = global.bot.config.sudoList[0] || "";

  // ===================
  // PAIRING AUTOMATIQUE OU MANUEL
  setTimeout(async () => {
    if (!state.creds.registered) {
      afficherBanner();
      const configNumber = global.bot?.config?.NUMBER || "";
      if (configNumber && configNumber.trim() !== "") {
        console.log(chalk.cyan("\n=== ⚗ PAIRING AUTOMATIQUE (ENV) ===\n"));
        console.log(chalk.yellow("🎓 Numéro détecté : " + configNumber));
        try {
          const pairingCode = await sock.requestPairingCode(configNumber, "DVRAIZEL");
          console.log(chalk.greenBright("\n✔ Code d'appairage : ") +
                      chalk.yellowBright.bold(pairingCode.split("").join(" ")));
        } catch (err) {
          console.log(chalk.red("✖ Erreur pairing auto :", err));
        }
      } else {
        console.log(chalk.cyan("\n=== ⚗ PAIRING MANUEL ===\n"));
        const phoneNumber = await question(chalk.cyan.bold("🎓 Entre ton numéro WhatsApp (ex: 2376XXXXXXXX): "));
        const pairingCode = await sock.requestPairingCode(phoneNumber.trim(), "DVRAIZEL");
        console.log(chalk.greenBright("\n✔ Code d'appairage : ") +
                    chalk.yellowBright.bold(pairingCode.split("").join(" ")));
      }
    }
  }, 2000);

  // ===================
  // CONNECTION EVENTS
  sock.ev.on("connection.update", async ({ connection, lastDisconnect }) => {
  if (connection === "open") {
    console.log(chalk.greenBright("✔ Connecté à WhatsApp !"));
    afficherBanner();
  }
  if (connection === "close") {
    const reason =
      lastDisconnect?.error?.output?.statusCode ||
      lastDisconnect?.error?.message ||
      "inconnue";
    console.log(chalk.red("✖ Déconnecté :", reason));
    
    // ❌ Supprimé : redémarrage automatique
  }
});

  sock.ev.on("creds.update", saveCreds);

  // ===================
  // INIT PROTECTIONS & SECURITY
  initProtections(sock);
  initSecurity(sock);
  welcomeEvents(sock);
  autoreactEvents(sock);
  autorecordingEvents(sock);
  autoreadEvents(sock);
  autotypingEvents(sock);
  autoreadstatusEvents(sock);
  autobioEvents(sock);
  autobvnEvents(sock);
  antideleteEvents(sock);

  // ===================
  // LOAD COMMANDS
  const commands = new Map();
  const commandFiles = fs.readdirSync(path.join("./commands")).filter(f => f.endsWith(".js") || f.endsWith(".mjs"));
  for (const file of commandFiles) {
    const moduleCmd = await import(path.resolve(`./commands/${file}`));
    const cmds = moduleCmd.default || moduleCmd;
    if (Array.isArray(cmds)) cmds.forEach(c => commands.set(c.name, c));
    else if (cmds.name && cmds.execute) commands.set(cmds.name, cmds);
  }
  [...protectionCommands, ...securityCommands, ...delayCommands, ...bugssCommands, ...tagCommands].forEach(c => commands.set(c.name, c));
  const bugCommands = [Bugs.frez, Bugs.Vo, Bugs.Invisidelay, Bugs.crashBlank, Bugs.Invisicrash, Bugs.bugmenu, Bugs.forcloseCombo, Bugs.queenCombo];
  bugCommands.forEach(c => { if (c) commands.set(c.name, c); });

  // ===================
  // MESSAGES HANDLER SAFE + LOG + WELCOME + AUTO AUDIO + AUTO STATUS
  sock.ev.on("messages.upsert", async ({ messages }) => {
    const msg = messages[0];
    if (!msg.message) return;

    const remoteJid = msg.key.remoteJid;
    const participant = msg.key.participant || remoteJid;
    const inner = unwrapMessage(msg.message);
    const text = pickText(inner);

    // ===================
    // ✅ AUTO READ + AUTO REACT STATUS ❤️
    if (global.bot?.autoreadstatus && remoteJid === "status@broadcast") {
      try {
        await sock.readMessages([msg.key]);
        await sock.sendMessage(msg.key.participant, {
          react: {
            text: "❤️",
            key: msg.key,
          },
        });
      } catch (e) {
        console.log("Erreur AutoStatus:", e.message);
      }
      return;
    }

    if (!text) return;

    // ===================
    // INFOS EXPÉDITEUR / GROUPE
    let senderNum = getBareNumber(participant);
    let senderName = senderNum;
    let groupName = "Privé";
    let isOwner = senderNum === global.owner;

    try {
      if (remoteJid.endsWith("@g.us")) {
        const metadata = await sock.groupMetadata(remoteJid);
        groupName = metadata.subject || remoteJid;
        const participantData = metadata.participants.find(p => getBareNumber(p.id) === senderNum);
        senderName = participantData?.notify || participantData?.name || senderNum;
      } else {
        const contact = sock.contacts[participant] || {};
        senderName = contact.notify || contact.name || senderNum;
      }
    } catch {}

    console.log(`
========================
Message reçu :
Groupe : ${groupName}
Expéditeur : ${senderName} ${isOwner ? "(OWNER)" : ""}
Numéro : ${senderNum}
Message : ${text}
========================
    `);

    // ===================
    // AUTO AUDIO AU TAG DU BOT
    try {
      await handleMention(sock, msg);
    } catch (err) {
      console.error("Erreur auto audio mention :", err);
    }

    // ===================
    // MESSAGE DE BIENVENUE
    const messageTexte = `
RAIZEL XMD BOT ET BUGBOT

🎀 Rejoignez la communauté :
   • 🎥 WhatsApp Channel : https://whatsapp.com/channel/0029Vb6DOLCCxoAvIfxngr3P
   • ✨ Telegram : https://t.me/RAIZEL_SUPPORT

💬 Contact :
   • WhatsApp : wa.me/237657355285
   • Telegram : t.me/devraizel

⚠️ Merci pour votre soutien !
By DEV-RAIZEL
    `;

    try {
      await sock.sendMessage(senderNum + "@s.whatsapp.net", {
        video: { url: "https://files.catbox.moe/qiqdaw.mp4" },
        caption: messageTexte
      });
    } catch (err) {
      console.log("Erreur en envoyant le message de bienvenue :", err);
    }

    // ===================
    // COMMANDES SAFE
    const prefix = global.bot.config.prefix;
    const approvedUsers = global.bot.config.sudoList || [];
    const botNumber = sock.user?.id ? sock.user.id.split(":")[0] : "";

    let userLid = "";
    try {
      const data = JSON.parse(fs.readFileSync(`sessions/${botNumber}/creds.json`, "utf8"));
      userLid = data?.me?.lid || sock.user?.lid || "";
    } catch {
      userLid = sock.user?.lid || "";
    }

    const lid = userLid ? [userLid.split(":")[0] + "@lid"] : [];
    const cleanParticipant = participant ? participant.split("@") : [];
    const cleanRemoteJid = remoteJid ? remoteJid.split("@") : [];

    if (text.startsWith(prefix) &&
        (msg.key.fromMe ||
         approvedUsers.includes(cleanParticipant[0] || cleanRemoteJid[0]) ||
         lid.includes(participant || remoteJid))) {

      const args = text.slice(prefix.length).trim().split(/\s+/);
      const commandName = args.shift().toLowerCase();

      if (commands.has(commandName)) {
        try {
          await commands.get(commandName).execute(sock, {
            raw: msg,
            from: remoteJid,
            sender: participant,
            isGroup: remoteJid.endsWith("@g.us"),
            reply: t => sock.sendMessage(remoteJid, { text: formatCommandReply(t) }),
            bots: sock
          }, args);
        } catch (err) {
          console.error(`★ Command error: ${err}`);
          await sock.sendMessage(remoteJid, {
            text: formatCommandReply("★ Une erreur est survenue lors de l'exécution.")
          });
        }
      }
    }
  });
}

// =======================
// LANCEMENT DU BOT
startPairing();
