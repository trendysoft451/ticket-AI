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

const app = express();
app.use(cors());
app.use(express.json({ limit: "5mb" }));

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const publicDir = path.join(__dirname, "public");
app.use(express.static(publicDir));

const upload = multer({ dest: "uploads/" });
const execFileAsync = promisify(execFile);

/** Config */
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";
const OPENAI_MODEL = "gpt-4o-mini"; 

let runtimeConfig = {
  baseUrl: process.env.CNX_BASE_URL || "",
  identifiant: process.env.CNX_IDENTIFIANT || "",
  motdepasse: process.env.CNX_MOTDEPASSE || "",
  codeDossier: process.env.CNX_CODE_DOSSIER || ""
};

/** Helpers */
const required = (v, label) => { if (!v) throw new Error(`Manquant: ${label}`); return v; };
const toNumber = (v) => {
  if (!v) return 0;
  const n = parseFloat(String(v).replace(',', '.').replace(/[^0-9.]/g, ''));
  return isNaN(n) ? 0 : n;
};

/** TVA & Comptes */
const VAT_MAP = {
  "20": { code: "TN", compte: "44566200", charge: "60631000" },
  "10": { code: "TI", compte: "44566100", charge: "62511000" },
  "5.5": { code: "TR", compte: "44566000", charge: "60630000" },
  "0": { code: "", compte: "", charge: "62510000" }
};

/** OpenAI Extraction */
async function extractData(imagePath, mimetype) {
  const imgBuf = await fs.readFile(imagePath);
  const base64 = imgBuf.toString("base64");

  const body = {
    model: OPENAI_MODEL,
    messages: [{
      role: "user",
      content: [
        { type: "text", text: "Extrait du ticket: date_document (YYYY-MM-DD), montant_ttc, montant_ht, montant_tva, raison_sociale. Réponse en JSON pur." },
        { type: "image_url", image_url: { url: `data:${mimetype};base64,${base64}` } }
      ]
    }],
    response_format: { type: "json_object" }
  };

  const resp = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { "Authorization": `Bearer ${OPENAI_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  const res = await resp.json();
  return JSON.parse(res.choices[0].message.content);
}

/** CNX Logic */
async function cnxAuth() {
  const { baseUrl, identifiant, motdepasse } = runtimeConfig;
  const r = await fetch(`${baseUrl}/v1/authentification`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ identifiant, motdepasse })
  });
  const data = await r.json();
  return data.UUID || data.data?.UUID;
}

/** Routes */
app.get("/", (req, res) => res.sendFile(path.join(publicDir, "index.html")));

app.get("/api/admin/public", (req, res) => res.json({ codeDossier: runtimeConfig.codeDossier }));

app.post("/api/admin/config", (req, res) => {
  runtimeConfig = { ...runtimeConfig, ...req.body };
  res.json({ ok: true });
});

app.post("/api/ged/upload", upload.single("pdf"), async (req, res) => {
  let tempPath = req.file.path;
  let ocrPath = tempPath;
  try {
    const isPdf = req.file.mimetype === "application/pdf";
    if (isPdf) {
      const outBase = path.join("uploads", crypto.randomUUID());
      await execFileAsync("pdftoppm", ["-f", "1", "-l", "1", "-png", tempPath, outBase]);
      ocrPath = `${outBase}-1.png`;
    }

    const data = await extractData(ocrPath, isPdf ? "image/png" : req.file.mimetype);
    
    // Simulation ID GED (remplacer par votre appel cnxUploadGedDocument réel)
    const gedId = "GED_" + crypto.randomBytes(4).toString("hex");

    res.json({ ok: true, gedId, extraction: data });
  } catch (e) {
    res.status(500).json({ error: e.message });
  } finally {
    await fs.unlink(tempPath).catch(() => {});
    if (ocrPath !== tempPath) await fs.unlink(ocrPath).catch(() => {});
  }
});

app.post("/api/receipts/submit", async (req, res) => {
  try {
    const meta = JSON.parse(req.body.meta);
    // Ici: Logique de construction du payload buildEcriturePayload et cnxPostEcriture
    res.json({ ok: true, message: "Écritures envoyées" });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

app.listen(process.env.PORT || 3000);
