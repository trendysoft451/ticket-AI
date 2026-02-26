import "dotenv/config";
import express from "express";
import multer from "multer";
import fetch from "node-fetch";
import cors from "cors";
import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { GoogleGenerativeAI } from "@google/generative-ai";

const app = express();
app.use(cors());
app.use(express.json({ limit: "5mb" }));

// --- CONFIGURATION DES CHEMINS (Correctif pour Render) ---
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
// Assurez-vous que votre index.html est dans un dossier nommé 'public'
const publicDir = path.join(__dirname, "public");

app.use(express.static(publicDir));

// Route racine pour éviter le "Cannot GET /"
app.get("/", (req, res) => {
  res.sendFile(path.join(publicDir, "index.html"));
});

// --- INITIALISATION GEMINI ---
// Note: Utilisez 'gemini-1.5-flash' pour éviter l'erreur 404
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const upload = multer({ storage: multer.memoryStorage() });

let runtimeConfig = {
  baseUrl: process.env.CNX_BASE_URL || "",
  identifiant: process.env.CNX_IDENTIFIANT || "",
  motdepasse: process.env.CNX_MOTDEPASSE || "",
  codeDossier: process.env.CNX_CODE_DOSSIER || ""
};

/** Utils */
function toNumberOrNull(v) {
  if (v == null || v === "") return null;
  const x = typeof v === "string" ? parseFloat(v.replace(/\s/g, "").replace(",", ".")) : v;
  return Number.isFinite(x) ? x : null;
}

/** ===== ENDPOINT UPLOAD & ANALYSE IA ===== */
app.post("/api/ged/upload", upload.single("file"), async (req, res) => {
  try {
    if (!req.file) throw new Error("Fichier absent");

    const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });

    const prompt = `Analyses ce ticket de caisse. 
    Ignore l'arrière-plan. Extrais les données en JSON :
    {
      "date_document": "YYYY-MM-DD",
      "numero_ticket": "string",
      "montant_ttc": 0.00,
      "montant_ht": 0.00,
      "montant_tva": 0.00,
      "raison_sociale": "string"
    }
    Note : Le ticket peut avoir plusieurs taux de TVA (ex: 20% et 5.5%), additionne-les tous.`;

    const result = await model.generateContent([
      prompt,
      { inlineData: { data: req.file.buffer.toString("base64"), mimeType: req.file.mimetype } }
    ]);

    const text = result.response.text();
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error("L'IA n'a pas renvoyé un format valide");
    const extraction = JSON.parse(jsonMatch[0]);

    // Génération d'un ID temporaire pour le front
    const gedId = "GED_" + crypto.randomUUID().substring(0, 8);

    res.json({
      ok: true,
      gedId,
      extraction,
      suggestion: {
        categorie_ui: "repas_pro",
        tva_rate: "10" 
      }
    });
  } catch (e) {
    console.error("Erreur Gemini:", e);
    res.status(500).json({ error: e.message });
  }
});

// --- ADMIN & PUBLIC CONFIG ---
app.get("/api/admin/public", (req, res) => {
  res.json({ codeDossier: runtimeConfig.codeDossier });
});

app.post("/api/admin/config", (req, res) => {
  runtimeConfig = { ...runtimeConfig, ...req.body };
  res.json({ ok: true });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Serveur Tikeo prêt sur le port ${PORT}`));
