import express from "express";
import multer from "multer";
import fetch from "node-fetch";
import cors from "cors";
import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { GoogleGenerativeAI } from "@google/generative-ai";

const app = express();
app.use(cors());
app.use(express.json({ limit: "2mb" }));

// --- Configuration ESM ---
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const publicDir = path.join(__dirname, "public");
app.use(express.static(publicDir));

// --- Initialisation Gemini ---
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || "VOTRE_CLE_API_GOOGLE";
const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);

// --- Stockage Multer (Mémoire pour Gemini / Disque pour GED) ---
const storage = multer.memoryStorage();
const upload = multer({ storage });

let runtimeConfig = {
    baseUrl: process.env.CNX_BASE_URL || "",
    identifiant: process.env.CNX_IDENTIFIANT || "",
    motdepasse: process.env.CNX_MOTDEPASSE || "",
    codeDossier: process.env.CNX_CODE_DOSSIER || ""
};

/** Utils */
function required(v, label) {
    if (!v || String(v).trim() === "") throw new Error(`Champ manquant : ${label}`);
    return v;
}

function toNumberOrNull(v) {
    if (v == null || v === "") return null;
    const x = typeof v === "string" ? parseFloat(v.replace(",", ".")) : v;
    return Number.isFinite(x) ? x : null;
}

const VAT = {
    "20": { code_tva: "TN", compte_tva_44566: "44566200" },
    "10": { code_tva: "TI", compte_tva_44566: "44566100" },
    "0": { code_tva: "", compte_tva_44566: "" }
};

/** Mapping Comptes Charges */
function chargesAccount(categoryKey, vatRate) {
    const map = {
        petites_fournitures: vatRate === "20" ? "60631000" : "60630000",
        carburant: "60614000",
        repas_pro: "62511000",
        repas: "62510000",
        papeterie: "60640000",
        peages: "62512000",
        parking: "62512000"
    };
    return map[categoryKey] || "";
}

/** ===== Extraction Gemini ===== */
async function extractWithGemini(fileBuffer, mimeType) {
    const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });

    const prompt = `Analyses ce ticket de caisse. 
    Ignore l'arrière-plan, concentre-toi sur le ticket.
    Extrais les infos au format JSON STRICT :
    {
      "date_document": "YYYY-MM-DD",
      "numero_ticket": "string",
      "montant_ttc": 0.00,
      "montant_ht": 0.00,
      "montant_tva": 0.00,
      "raison_sociale": "string",
      "mots_cles": ["repas", "carburant", etc]
    }
    Note: Si plusieurs taux de TVA existent, additionne-les.`;

    const result = await model.generateContent([
        prompt,
        { inlineData: { data: fileBuffer.toString("base64"), mimeType } }
    ]);

    const response = await result.response;
    const text = response.text();
    const jsonStr = text.match(/\{[\s\S]*\}/)[0];
    return JSON.parse(jsonStr);
}

/** ===== CNX API Calls (Simplified) ===== */
async function cnxAuthenticate() {
    const { baseUrl, identifiant, motdepasse } = runtimeConfig;
    const resp = await fetch(`${baseUrl}/v1/authentification`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ identifiant, motdepasse })
    });
    const data = await resp.json();
    return data.UUID || data.uuid;
}

async function cnxUploadGed(fileBuffer, filename) {
    const uuid = await cnxAuthenticate();
    const boundary = "----Boundary" + crypto.randomUUID();
    const url = `${runtimeConfig.baseUrl}/v1/ged/documents`;

    const parts = [
        `--${boundary}\r\nContent-Disposition: form-data; name="idArboGed"\r\n\r\n945\r\n`,
        `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: application/pdf\r\n\r\n`,
        fileBuffer,
        `\r\n--${boundary}--\r\n`
    ];

    const resp = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": `multipart/form-data; boundary=${boundary}`, "UUID": uuid },
        body: Buffer.concat(parts.map(p => typeof p === 'string' ? Buffer.from(p) : p))
    });
    const data = await resp.json();
    return String(data.id || data.Id);
}

/** ===== MAIN ENDPOINT: UPLOAD & ANALYZE ===== */
app.post("/api/ged/upload", upload.single("file"), async (req, res) => {
    try {
        if (!req.file) throw new Error("Fichier manquant");

        // 1. Analyse IA avec Gemini
        const extraction = await extractWithGemini(req.file.buffer, req.file.mimetype);

        // 2. Upload vers la GED (nécessite un buffer)
        const gedId = await cnxUploadGed(req.file.buffer, req.file.originalname);

        // 3. Suggestions et calculs
        const ht = toNumberOrNull(extraction.montant_ht);
        const tva = toNumberOrNull(extraction.montant_tva);
        
        let tva_rate = "20"; // défaut
        if (ht && tva) {
            const ratio = tva / ht;
            if (ratio < 0.08) tva_rate = "5.5"; // Adaptation possible
            if (ratio > 0.08 && ratio < 0.15) tva_rate = "10";
        }

        res.json({
            ok: true,
            gedId,
            extraction,
            suggestion: {
                categorie_ui: extraction.mots_cles?.includes("repas") ? "repas_pro" : "petites_fournitures",
                compteF: extraction.mots_cles?.includes("repas") ? "FREPAS" : "FDIVERS",
                tva_rate
            }
        });
    } catch (e) {
        console.error(e);
        res.status(500).json({ error: String(e.message) });
    }
});

/** ===== SUBMIT TO COMPTA ===== */
app.post("/api/receipts/submit", async (req, res) => {
    try {
        const meta = req.body.meta ? JSON.parse(req.body.meta) : req.body;
        const uuid = await cnxAuthenticate();
        
        // Payload simplifié pour l'exemple
        const payload = {
            journal: meta.journal,
            mois: new Date(meta.date_ticket).getMonth() + 1,
            annee: new Date(meta.date_ticket).getFullYear(),
            ReferenceGed: meta.referenceGedId,
            lignesEcriture: [
                { jour: new Date(meta.date_ticket).getDate(), compte: meta.compteFournisseur, credit: meta.montant_ttc, libelle: meta.raison_sociale },
                { jour: new Date(meta.date_ticket).getDate(), compte: chargesAccount(meta.categorie_ui, meta.tva_rate), debit: meta.ht, libelle: meta.raison_sociale }
            ]
        };

        const resp = await fetch(`${runtimeConfig.baseUrl}/v1/compta/ecriture`, {
            method: "POST",
            headers: { "Content-Type": "application/json", "UUID": uuid },
            body: JSON.stringify(payload)
        });

        res.json({ ok: true, message: "Écritures envoyées" });
    } catch (e) {
        res.status(400).json({ error: e.message });
    }
});

// --- Admin ---
app.post("/api/admin/config", (req, res) => {
    runtimeConfig = { ...runtimeConfig, ...req.body };
    res.json({ ok: true });
});

app.get("/api/admin/public", (req, res) => {
    res.json({ codeDossier: runtimeConfig.codeDossier });
});

app.listen(process.env.PORT || 3000, () => console.log("Server IA & Compta running"));
