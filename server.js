import express from "express";
import path from "path";
import { fileURLToPath } from "url";
import dotenv from "dotenv";

// Import backend
import "./start.js";

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

// Route principale
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

app.listen(PORT, () => {
  console.log(`🌐 Serveur lancé sur http://localhost:${PORT}`);
});
