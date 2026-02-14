import express from "express";
import path from "path";
import { fileURLToPath } from "url";
import dotenv from "dotenv";

// Import backend
import { getSession } from "./start.js";

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

// __dirname en module ES
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Middleware pour JSON
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Servir les fichiers statiques depuis la racine
app.use(express.static(__dirname));
// Endpoint pour envoyer un message
app.post("/send", async (req, res) => {
  try {
    const { number, message } = req.body;
    if (!number) return res.json({ success: false, error: "Numéro manquant" });

    const session = getSession(number);
    if (!session || !session.sock || !session.connected) {
      return res.json({ success: false, error: "Session non connectée" });
    }

    const jid = number.replace(/[^0-9]/g, "") + "@s.whatsapp.net";
    await session.sock.sendMessage(jid, { text: message || "Bug test" });

    return res.json({ success: true });
  } catch (err) {
    console.error(err);
    return res.json({ success: false, error: "Erreur serveur" });
  }
});

// Route principale
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

app.listen(PORT, () => {
  console.log(`🌐 Serveur lancé sur http://localhost:${PORT}`);
});
