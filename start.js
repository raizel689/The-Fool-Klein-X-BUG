import express from "express";
import path from "path";
import { fileURLToPath } from "url";
import bodyParser from "body-parser";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import pino from "pino";
import chalk from "chalk";
import dotenv from "dotenv";
import readline from "readline";
import { execSync } from "child_process";
import { makeWASocket, useMultiFileAuthState, fetchLatestBaileysVersion, DisconnectReason } from "@whiskeysockets/baileys";
import { Boom } from "@hapi/boom";

import { xUi } from "./xUi.js";

// Configuration
dotenv.config();
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// État global
const sessions = new Map(); // Map<number, { sock: WASocket, connected: boolean, retryCount: number }>
const sessionsDir = path.join(process.cwd(), "sessions");
const MAX_RETRIES = 5;
const RETRY_DELAY = 5000; // 5 secondes

// Utilitaire pour question utilisateur
const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

const question = (query) => new Promise((resolve) => rl.question(query, resolve));

// Logger personnalisé
const logger = pino({
  level: "info",
  transport: {
    target: "pino-pretty",
    options: {
      colorize: true,
      ignore: "pid,hostname",
      translateTime: "HH:MM:ss"
    }
  }
});

/**
 * Nettoie le numéro de téléphone
 */
function cleanPhoneNumber(number) {
  return number.replace(/[^0-9]/g, "");
}

/**
 * Crée un nouveau socket WhatsApp pour un numéro
 */
async function createSocket(number, retryCount = 0) {
  const cleanNumber = cleanPhoneNumber(number);
  const sessionPath = path.join(sessionsDir, cleanNumber);
  
  try {
    const { state, saveCreds } = await useMultiFileAuthState(sessionPath);
    const { version } = await fetchLatestBaileysVersion();

    const sock = makeWASocket({
      version,
      printQRInTerminal: false,
      logger: pino({ level: "silent" }),
      auth: state,
      browser: ["Ubuntu", "Chrome", "20.0.04"],
      syncFullHistory: false,
      markOnlineOnConnect: false,
      generateHighQualityLinkPreview: false
    });

    // Gestionnaire de mise à jour de connexion
    sock.ev.on("connection.update", async (update) => {
      const { connection, lastDisconnect, qr } = update;
      
      if (qr) {
        console.log(chalk.yellow(`\n📱 QR Code pour ${cleanNumber}:`));
        console.log(qr);
      }

      if (connection === "open") {
        console.log(chalk.greenBright(`✅ Session ${cleanNumber} connectée avec succès`));
        const session = sessions.get(cleanNumber);
        if (session) {
          session.connected = true;
          session.retryCount = 0;
        }
        
        // Vérifier et exécuter bug si nécessaire
        try {
          await bug(sock, cleanNumber);
        } catch (error) {
          logger.error({ error, number: cleanNumber }, "Erreur lors de l'exécution de bug()");
        }
      }

      if (connection === "close") {
        const shouldReconnect = (lastDisconnect?.error instanceof Boom) 
          ? lastDisconnect.error.output.statusCode !== DisconnectReason.loggedOut
          : true;

        console.log(chalk.yellow(`⚠️ Session ${cleanNumber} déconnectée, reconnexion: ${shouldReconnect}`));

        const session = sessions.get(cleanNumber);
        if (session) {
          session.connected = false;
          
          if (shouldReconnect && (session.retryCount || 0) < MAX_RETRIES) {
            session.retryCount = (session.retryCount || 0) + 1;
            console.log(chalk.blue(`🔄 Tentative de reconnexion ${session.retryCount}/${MAX_RETRIES} pour ${cleanNumber} dans ${RETRY_DELAY/1000}s`));
            
            setTimeout(async () => {
              try {
                const newSock = await createSocket(cleanNumber, session.retryCount);
                sessions.set(cleanNumber, {
                  sock: newSock,
                  connected: false,
                  retryCount: session.retryCount
                });
              } catch (error) {
                logger.error({ error, number: cleanNumber }, "Échec de la reconnexion");
              }
            }, RETRY_DELAY);
          } else if (session.retryCount >= MAX_RETRIES) {
            console.log(chalk.red(`❌ Nombre maximum de tentatives atteint pour ${cleanNumber}`));
            sessions.delete(cleanNumber);
          }
        }
      }
    });

    // Sauvegarde des credentials
    sock.ev.on("creds.update", saveCreds);

    // Gestion des messages avec détection clic bouton
    sock.ev.on("messages.upsert", async ({ messages, type }) => {
      if (type === "notify") {
        for (const msg of messages) {
          if (!msg.message) continue;
          const from = msg.key.remoteJid;

          const button = msg.message?.buttonsResponseMessage?.selectedButtonId;
          if (button) {
            console.log(chalk.blue(`🔘 Bouton cliqué par ${from}: ${button}`));
            try {
              await xUi(sock, from); // ← Ici on envoie le bug via xUi
              console.log(chalk.green(`✅ xUi envoyé à ${from}`));
            } catch (error) {
              logger.error({ error, number: from }, "Erreur lors de l'envoi de xUi");
            }
          }
        }
      }
    });

    return sock;
  } catch (error) {
    logger.error({ error, number: cleanNumber }, "Erreur lors de la création du socket");
    throw error;
  }
}

/**
 * Démarre l'appairage pour un nouveau numéro
 */
export async function startPairing(phoneNumber = null) {
  try {
    if (!phoneNumber) {
      phoneNumber = await question(chalk.cyan.bold("📱 Entre ton numéro WhatsApp (ex: 2376XXXXXXXX): "));
    }
    
    const cleanNumber = cleanPhoneNumber(phoneNumber);
    console.log(chalk.blue(`\n🔄 Démarrage de l'appairage pour ${cleanNumber}...`));

    // Vérifier si la session existe déjà
    if (sessions.has(cleanNumber)) {
      console.log(chalk.yellow(`⚠️ Une session existe déjà pour ${cleanNumber}`));
      const { connected } = sessions.get(cleanNumber);
      if (connected) {
        console.log(chalk.green(`✅ Session ${cleanNumber} déjà connectée`));
        return sessions.get(cleanNumber).sock;
      }
    }

    // Créer le dossier de session s'il n'existe pas
    const sessionPath = path.join(sessionsDir, cleanNumber);
    
    // Initialiser l'état de la session
    const { state } = await useMultiFileAuthState(sessionPath);
    
    // Si l'appareil n'est pas enregistré, demander le code d'appairage
    if (!state.creds?.registered) {
      const { version } = await fetchLatestBaileysVersion();
      const tempSock = makeWASocket({
        version,
        auth: state,
        logger: pino({ level: "silent" })
      });

      try {
        const code = await tempSock.requestPairingCode(cleanNumber);
        console.log(chalk.greenBright("\n✅ Code d'appairage : ") + chalk.yellowBright.bold(code.match(/.{1,4}/g)?.join(" ") || code));
        console.log(chalk.gray("\n➡️ Entre ce code sur WhatsApp > Appareils connectés > Appairer un appareil."));
        
        // Attendre un peu que l'utilisateur entre le code
        await new Promise(resolve => setTimeout(resolve, 30000));
      } catch (error) {
        logger.error({ error, number: cleanNumber }, "Erreur lors de la demande de code");
        throw error;
      } finally {
        tempSock?.end();
      }
    }

    // Créer le socket principal
    const sock = await createSocket(cleanNumber);
    
    // Stocker dans la Map
    sessions.set(cleanNumber, {
      sock,
      connected: false,
      retryCount: 0
    });

    console.log(chalk.green(`✅ Session ${cleanNumber} initialisée avec succès`));
    return sock;
  } catch (error) {
    logger.error({ error }, "Erreur dans startPairing");
    throw error;
  }
}

/**
 * Récupère une session par numéro
 */
export function getSession(number) {
  const cleanNumber = cleanPhoneNumber(number);
  const session = sessions.get(cleanNumber);
  
  if (!session) {
    return null;
  }
  
  return {
    sock: session.sock,
    connected: session.connected,
    number: cleanNumber
  };
}

/**
 * Récupère toutes les sessions actives
 */
export function getAllSessions() {
  const sessionsList = [];
  
  for (const [number, session] of sessions.entries()) {
    sessionsList.push({
      number,
      connected: session.connected,
      retryCount: session.retryCount
    });
  }
  
  return sessionsList;
}

/**
 * Démarre toutes les sessions existantes
 */
export async function startAllSessions() {
  console.log(chalk.blue("🔄 Recherche des sessions existantes..."));
  
  try {
    // Lire le dossier des sessions
    const fs = await import("fs/promises");
    const files = await fs.readdir(sessionsDir).catch(() => []);
    
    const sessionDirs = files.filter(file => 
      file.match(/^[0-9]+$/) && // Uniquement les dossiers avec des chiffres
      !file.includes(".")
    );
    
    if (sessionDirs.length === 0) {
      console.log(chalk.yellow("⚠️ Aucune session existante trouvée"));
      return [];
    }

    console.log(chalk.blue(`📱 ${sessionDirs.length} session(s) trouvée(s), démarrage...`));
    
    const promises = sessionDirs.map(async (number) => {
      try {
        await startPairing(number);
      } catch (error) {
        logger.error({ error, number }, "Erreur lors du démarrage automatique");
      }
    });

    await Promise.allSettled(promises);
    console.log(chalk.green(`✅ ${sessions.size} session(s) active(s)`));
    
    return getAllSessions();
  } catch (error) {
    logger.error({ error }, "Erreur dans startAllSessions");
    throw error;
  }
}

/**
 * Ferme une session spécifique
 */
export async function closeSession(number) {
  const cleanNumber = cleanPhoneNumber(number);
  const session = sessions.get(cleanNumber);
  
  if (session?.sock) {
    try {
      await session.sock.logout();
      session.sock.end();
      sessions.delete(cleanNumber);
      console.log(chalk.yellow(`📴 Session ${cleanNumber} fermée`));
      return true;
    } catch (error) {
      logger.error({ error, number: cleanNumber }, "Erreur lors de la fermeture");
      return false;
    }
  }
  return false;
}

/**
 * Ferme toutes les sessions
 */
export async function closeAllSessions() {
  console.log(chalk.blue("🔄 Fermeture de toutes les sessions..."));
  
  const promises = [];
  for (const [number] of sessions.entries()) {
    promises.push(closeSession(number));
  }
  
  await Promise.allSettled(promises);
  console.log(chalk.green("✅ Toutes les sessions fermées"));
}

// Gestion de la fermeture propre
process.on("SIGINT", async () => {
  console.log(chalk.yellow("\n\n⚠️ Arrêt du programme..."));
  await closeAllSessions();
  rl.close();
  process.exit(0);
});

process.on("SIGTERM", async () => {
  console.log(chalk.yellow("\n\n⚠️ Arrêt du programme..."));
  await closeAllSessions();
  rl.close();
  process.exit(0);
});

// Export par défaut
export default {
  startPairing,
  getSession,
  getAllSessions,
  startAllSessions,
  closeSession,
  closeAllSessions,
  sessions
};
