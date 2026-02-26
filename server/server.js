import "dotenv/config";
import express from "express";
import multer from "multer";
import fetch from "node-fetch";
import cors from "cors";
import crypto from "node:crypto";
import { GoogleGenerativeAI } from "@google/generative-ai";

const app = express();
app.use(cors());
app.use(express.json({ limit: "5mb" }));

// Initialisation sécurisée
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const upload = multer({ storage: multer.memoryStorage() });

let runtimeConfig = {
  baseUrl: process.env.CNX_BASE_URL || "",
  codeDossier: process.env.CNX_CODE_DOSSIER || ""
};

app.post("/api/ged/upload", upload.single("file"), async (req, res) => {
  try {
    if (!req.file) throw new Error("Fichier absent");

    // Correction 404 : On utilise le nom court du modèle
    const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });

    const prompt = `Analyse ce ticket de caisse. 
    Ignore l'arrière-plan. Extrais les données en JSON :
    {
      "date_document": "YYYY-MM-DD",
      "numero_ticket": "string",
      "montant_ttc": 0.00,
      "montant_ht": 0.00,
      "montant_tva": 0.00,
      "raison_sociale": "string"
    }
    Note : Le ticket peut avoir plusieurs taux de TVA, additionne-les (ex: 0.15 + 0.68).`;

    const result = await model.generateContent([
      prompt,
      { inlineData: { data: req.file.buffer.toString("base64"), mimeType: req.file.mimetype } }
    ]);

    const text = result.response.text();
    // Nettoyage robuste du JSON renvoyé par l'IA
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error("L'IA n'a pas renvoyé un format valide");
    const extraction = JSON.parse(jsonMatch[0]);

    // Simuler l'ID GED pour l'exemple ou appeler votre fonction cnxUploadGed
    const gedId = "GED_" + crypto.randomUUID().substring(0, 8);

    res.json({
      ok: true,
      gedId,
      extraction,
      suggestion: {
        categorie_ui: "repas_pro", // Valeur par défaut pour Kayser
        tva_rate: "10" 
      }
    });
  } catch (e) {
    console.error("Erreur détaillée :", e);
    res.status(e.status || 500).json({ 
        error: e.message,
        tip: "Vérifiez que votre clé API Gemini est valide et que le modèle gemini-1.5-flash est disponible."
    });
  }
});

app.listen(process.env.PORT || 3000, () => console.log("Serveur prêt sur le port 3000"));
