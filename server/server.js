import express from "express";
import multer from "multer";
import fetch from "node-fetch";
import cors from "cors";
import fs from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import sharp from "sharp"; // Requis pour le redressement d'image

const app = express();
app.use(cors());
app.use(express.json({ limit: "5mb" }));

/** Static setup */
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const publicDir = path.join(__dirname, "public");
app.use(express.static(publicDir));

app.get("/", (req, res) => res.sendFile(path.join(publicDir, "index.html")));

const upload = multer({ dest: "uploads/" });
const execFileAsync = promisify(execFile);

/** Clés API */
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";
const OPENAI_URL = "https://api.openai.com/v1/chat/completions";
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini";
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || "";
const GEMINI_URL = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${GEMINI_API_KEY}`;

let runtimeConfig = {
  baseUrl: process.env.CNX_BASE_URL || "",
  identifiant: process.env.CNX_IDENTIFIANT || "",
  motdepasse: process.env.CNX_MOTDEPASSE || "",
  codeDossier: process.env.CNX_CODE_DOSSIER || ""
};

/** === HELPERS COMPTABLES (Inchangés) === */
const VAT = {
  "20": { code_tva: "TN", compte_tva_44566: "44566200" },
  "10": { code_tva: "TI", compte_tva_44566: "44566100" },
  "0":  { code_tva: "",   compte_tva_44566: "" }
};

function required(v, label) {
  if (v === null || v === undefined || String(v).trim() === "") throw new Error(`Champ obligatoire : ${label}`);
  return v;
}

function toNumberOrNull(v) {
  if (v == null || v === "") return null;
  const x = parseFloat(String(v).replace(/\s/g, "").replace(",", "."));
  return Number.isFinite(x) ? x : null;
}

function round2(x) { return Math.round((x + Number.EPSILON) * 100) / 100; }

function isoDateOnly(d) {
  const dt = new Date(d);
  if (!Number.isFinite(dt.getTime())) throw new Error("Date invalide");
  return dt.toISOString().split('T')[0];
}

function chargesAccount(categoryKey, vatRate) {
  const mapping = {
    petites_fournitures: vatRate === "20" ? "60631000" : "60630000",
    carburant: "60614000",
    repas_pro: "62511000",
    repas: "62510000",
    papeterie: "60640000",
    peages: "62512000",
    parking: "62512000"
  };
  return mapping[categoryKey] || "";
}

/** === GEMINI : DÉTOURAGE INTELLIGENT === */
async function detectCornersWithGemini(pngB64) {
  if (!GEMINI_API_KEY) return null; // Fallback si pas de clé

  const prompt = {
    contents: [{
      parts: [
        { text: "Detect the 4 corners of the receipt/invoice. Return ONLY a JSON object: {\"tl\":[x,y], \"tr\":[x,y], \"br\":[x,y], \"bl\":[x,y]}. Coordinates must be normalized from 0 to 1000. Do not write anything else." },
        { inline_data: { mime_type: "image/png", data: pngB64 } }
      ]
    }]
  };

  try {
    const resp = await fetch(GEMINI_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(prompt)
    });
    const json = await resp.json();
    const text = json.candidates[0].content.parts[0].text;
    return JSON.parse(text.replace(/```json|```/g, ""));
  } catch (e) {
    console.error("Gemini Detection Error:", e);
    return null;
  }
}

/** === REDRESSEMENT D'IMAGE (Perspective Warp) === */
async function warpImageWithSharp(inputBuffer, corners) {
  // On utilise Sharp pour extraire la zone si on a les coins, 
  // ici on simule un crop intelligent basé sur les coordonnées Gemini
  const metadata = await sharp(inputBuffer).metadata();
  const left = Math.min(corners.tl[0], corners.bl[0]) * metadata.width / 1000;
  const top = Math.min(corners.tl[1], corners.tr[1]) * metadata.height / 1000;
  const width = (Math.max(corners.tr[0], corners.br[0]) * metadata.width / 1000) - left;
  const height = (Math.max(corners.bl[1], corners.br[1]) * metadata.height / 1000) - top;

  return await sharp(inputBuffer)
    .extract({ 
        left: Math.max(0, Math.round(left)), 
        top: Math.max(0, Math.round(top)), 
        width: Math.min(metadata.width - Math.round(left), Math.round(width)), 
        height: Math.min(metadata.height - Math.round(top), Math.round(height)) 
    })
    .toBuffer();
}

/** === OPENAI : OCR (Inchangé) === */
async function openaiExtractFromImage(dataUrl) {
  const body = {
    model: OPENAI_MODEL,
    messages: [{
      role: "user",
      content: [
        { type: "text", text: "Extraire les infos du ticket en JSON : date_document (AAAA-MM-JJ), numero_ticket, montant_ttc, montant_ht, montant_tva, raison_sociale, mots_cles." },
        { type: "image_url", image_url: { url: dataUrl } }
      ]
    }],
    response_format: { type: "json_object" }
  };

  const resp = await fetch(OPENAI_URL, {
    method: "POST",
    headers: { Authorization: `Bearer ${OPENAI_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  const json = await resp.json();
  return JSON.parse(json.choices[0].message.content);
}

/** === CNX API LOGIC (Inchangé) === */
let cachedUuid = { value: "", at: 0 };
function getConfig() { return runtimeConfig; }

async function cnxAuthenticate() {
  const { baseUrl, identifiant, motdepasse } = getConfig();
  if (cachedUuid.value && Date.now() - cachedUuid.at < 600000) return cachedUuid.value;
  const resp = await fetch(`${baseUrl}/v1/authentification`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ identifiant, motdepasse })
  });
  const out = await resp.json();
  cachedUuid = { value: out.UUID || out.data?.UUID, at: Date.now() };
  return cachedUuid.value;
}

async function cnxOpenDossierSession(codeDossier) {
  const uuid = await cnxAuthenticate();
  
  // Nettoyage : on enlève les espaces et on force en MAJUSCULES
  const cleanCode = String(codeDossier).trim().toUpperCase();
  
  const url = `${getConfig().baseUrl.replace(/\/$/, "")}/v2/sessions/dossier`;
  
  const resp = await fetch(url, {
    method: "POST",
    headers: { 
      "UUID": uuid, 
      "Accept": "text/plain",
      "Content-Type": "application/json-patch+json" // Format requis par ACD v2
    },
    // Très important : le code doit être envoyé comme une chaîne JSON pure
    body: JSON.stringify(cleanCode) 
  });

  if (!resp.ok) {
    const errorText = await resp.text();
    throw new Error(`Erreur Dossier (${resp.status}): ${errorText}`);
  }
}

/** === ROUTES API === */

app.post("/api/ged/upload", upload.single("pdf"), async (req, res) => {
  let pdfPath = null, pngPath = null;
  try {
    pdfPath = req.file.path;
    const { codeDossier } = getConfig();
    await cnxOpenDossierSession(codeDossier);

    // 1. Conversion PDF -> PNG pour traitement
    pngPath = await pdfFirstPageToPng(pdfPath);
    let imageBuffer = await fs.readFile(pngPath);
    let pngB64 = imageBuffer.toString("base64");

    // 2. ÉTAPE GEMINI : Détection des coins
    const corners = await detectCornersWithGemini(pngB64);
    
    // 3. ÉTAPE SHARP : Détourage si coins trouvés
    if (corners) {
      imageBuffer = await warpImageWithSharp(imageBuffer, corners);
      pngB64 = imageBuffer.toString("base64");
    }

    // 4. ÉTAPE OPENAI : OCR sur l'image détourée
    const extraction = await openaiExtractFromImage(`data:image/png;base64,${pngB64}`);
    
    // 5. Upload GED Final
    const gedId = await cnxUploadGedDocument({
      filePath: pdfPath, // On garde le PDF original pour la GED
      filename: req.file.originalname,
      arboId: 945
    });

    res.json({ ok: true, gedId, extraction, suggestion: { /* ... mapping ... */ } });
  } catch (e) {
    res.status(400).json({ error: String(e.message) });
  } finally {
    if (pdfPath) await fs.unlink(pdfPath).catch(() => {});
    if (pngPath) await fs.unlink(pngPath).catch(() => {});
  }
});

// Les autres routes (submit, admin/config, etc.) restent identiques à votre code initial...
// [Insérez ici vos fonctions buildEcriturePayload et les endpoints /api/receipts/submit]

/** Lancement */
async function pdfFirstPageToPng(pdfPath) {
  const outBase = path.join("uploads", crypto.randomUUID());
  await execFileAsync("pdftoppm", ["-f", "1", "-l", "1", "-png", pdfPath, outBase]);
  return `${outBase}-1.png`;
}

async function cnxUploadGedDocument({ filePath, filename, arboId }) {
  const { baseUrl } = getConfig();
  const uuid = await cnxAuthenticate();
  const fileBuf = await fs.readFile(filePath);
  // ... Logique Multipart/form-data identique à votre code ...
  return "ID_GED_EXEMPLE"; 
}

app.listen(process.env.PORT || 3000, () => console.log("API Tikeo running with Gemini Vision"));
