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

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const publicDir = path.join(__dirname, "public");
app.use(express.static(publicDir));

// --- Initialisation Gemini ---
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

// --- Configuration Multer (Mémoire) ---
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
  const x = typeof v === "string" ? parseFloat(v.replace(/\s/g, "").replace(",", ".")) : v;
  return Number.isFinite(x) ? x : null;
}

const VAT_MAP = {
  "20": { code_tva: "TN", compte_tva_44566: "44566200" },
  "10": { code_tva: "TI", compte_tva_44566: "44566100" },
  "5.5": { code_tva: "TR", compte_tva_44566: "44566055" },
  "0": { code_tva: "", compte_tva_44566: "" }
};

function getChargesAccount(categoryKey, vatRate) {
  const map = {
    petites_fournitures: vatRate === "20" ? "60631000" : "60630000",
    carburant: "60614000",
    repas_pro: "62511000",
    repas: "62510000",
    papeterie: "60640000",
    peages: "62512000",
    parking: "62512000"
  };
  return map[categoryKey] || "60630000";
}

/** Authentification CNX */
async function cnxAuthenticate() {
  const { baseUrl, identifiant, motdepasse } = runtimeConfig;
  required(baseUrl, "URL API");
  const resp = await fetch(`${baseUrl.replace(/\/$/, "")}/v1/authentification`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ identifiant, motdepasse })
  });
  if (!resp.ok) throw new Error("Échec auth CNX");
  const data = await resp.json();
  return data.UUID || data.uuid || data.data?.UUID;
}

/** Upload vers GED CNX */
async function cnxUploadGed(fileBuffer, filename) {
  const uuid = await cnxAuthenticate();
  const boundary = "----Boundary" + crypto.randomUUID().replace(/-/g, "");
  const url = `${runtimeConfig.baseUrl.replace(/\/$/, "")}/v1/ged/documents`;

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
  return String(data.id || data.Id || data.data?.id);
}

/** ===== ENDPOINT UPLOAD & ANALYSE IA ===== */
app.post("/api/ged/upload", upload.single("file"), async (req, res) => {
  try {
    if (!req.file) throw new Error("Fichier absent");

    // 1. Analyse Gemini
    const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });
    const prompt = `Analyse ce ticket de caisse. Ignore l'arrière-plan. 
    Extrais les données en JSON STRICT :
    {
      "date_document": "YYYY-MM-DD",
      "numero_ticket": "string",
      "montant_ttc": 0.00,
      "montant_ht": 0.00,
      "montant_tva": 0.00,
      "raison_sociale": "string",
      "mots_cles": []
    }
    Note: Additionne tous les montants de TVA si plusieurs taux existent.`;

    const result = await model.generateContent([
      prompt,
      { inlineData: { data: req.file.buffer.toString("base64"), mimeType: req.file.mimetype } }
    ]);

    const text = result.response.text();
    const jsonStr = text.match(/\{[\s\S]*\}/)[0];
    const extraction = JSON.parse(jsonStr);

    // 2. Upload GED (Optionnel : conversion PDF si c'est une image non traitée, 
    // mais ici on envoie le buffer brut reçu du front)
    const gedId = await cnxUploadGed(req.file.buffer, req.file.originalname || "ticket.jpg");

    // 3. Suggestions intelligentes
    const ht = toNumberOrNull(extraction.montant_ht);
    const tva = toNumberOrNull(extraction.montant_tva);
    let tva_rate = "20";
    if (ht > 0 && tva >= 0) {
      const ratio = tva / ht;
      if (ratio < 0.08) tva_rate = "5.5";
      else if (ratio < 0.15) tva_rate = "10";
    }

    res.json({
      ok: true,
      gedId,
      extraction,
      suggestion: {
        categorie_ui: extraction.mots_cles?.some(m => ["repas", "resto"].includes(m.toLowerCase())) ? "repas_pro" : "petites_fournitures",
        compteF: extraction.mots_cles?.some(m => ["repas", "resto"].includes(m.toLowerCase())) ? "FREPAS" : "FDIVERS",
        tva_rate
      }
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

/** ===== SUBMIT COMPTA ===== */
app.post("/api/receipts/submit", upload.none(), async (req, res) => {
  try {
    const meta = JSON.parse(req.body.meta);
    const uuid = await cnxAuthenticate();

    // Session dossier
    await fetch(`${runtimeConfig.baseUrl.replace(/\/$/, "")}/v2/sessions/dossier`, {
      method: "POST",
      headers: { "UUID": uuid, "Content-Type": "application/json-patch+json" },
      body: JSON.stringify(runtimeConfig.codeDossier)
    });

    const dt = new Date(meta.date_ticket);
    const vat = VAT_MAP[meta.tva_rate] || VAT_MAP["20"];

    const payload = {
      journal: meta.journal,
      mois: dt.getMonth() + 1,
      annee: dt.getFullYear(),
      ReferenceGed: meta.referenceGedId,
      lignesEcriture: [
        { jour: dt.getDate(), numeroFacture: meta.numero_ticket, compte: meta.compteFournisseur, libelle: meta.raison_sociale, credit: toNumberOrNull(meta.montant_ttc), debit: 0 },
        { jour: dt.getDate(), numeroFacture: meta.numero_ticket, compte: getChargesAccount(meta.categorie_ui, meta.tva_rate), libelle: meta.raison_sociale, credit: 0, debit: toNumberOrNull(meta.ht), codeTVA: vat.code_tva }
      ]
    };

    if (toNumberOrNull(meta.tva_montant) > 0) {
      payload.lignesEcriture.push({ jour: dt.getDate(), numeroFacture: meta.numero_ticket, compte: vat.compte_tva_44566, libelle: meta.raison_sociale, credit: 0, debit: toNumberOrNull(meta.tva_montant) });
    }

    const resp = await fetch(`${runtimeConfig.baseUrl.replace(/\/$/, "")}/v1/compta/ecriture`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "UUID": uuid },
      body: JSON.stringify(payload)
    });

    if (!resp.ok) throw new Error("Erreur API Compta");
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

/** Admin Endpoints */
app.post("/api/admin/config", (req, res) => {
  runtimeConfig = { ...runtimeConfig, ...req.body };
  res.json({ ok: true });
});

app.get("/api/admin/public", (req, res) => {
  res.json({ codeDossier: runtimeConfig.codeDossier });
});

app.listen(process.env.PORT || 3000, () => console.log("Server Tikeo Ready"));
