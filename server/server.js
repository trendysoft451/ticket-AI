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
app.use(express.json({ limit: "2mb" }));

/**
 * ✅ FIX Render/ESM : servir correctement /server/public
 */
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const publicDir = path.join(__dirname, "public");

app.use(express.static(publicDir));
app.get("/", (req, res) => res.sendFile(path.join(publicDir, "index.html")));

const upload = multer({ dest: "uploads/" });
const execFileAsync = promisify(execFile);

const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";
const OPENAI_URL = "https://api.openai.com/v1/responses";
const OPENAI_MODEL = "gpt-4.1-mini";

/** Config CNX (env > mémoire) */
let runtimeConfig = {
  baseUrl: process.env.CNX_BASE_URL || "",
  identifiant: process.env.CNX_IDENTIFIANT || "",
  motdepasse: process.env.CNX_MOTDEPASSE || ""
};

function req(v, label) {
  if (v === null || v === undefined || String(v).trim() === "") {
    throw new Error(`Champ obligatoire manquant : ${label}`);
  }
  return v;
}

function toNumberOrNull(v) {
  if (v == null || v === "") return null;
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "string") {
    const x = parseFloat(v.replace(/\s/g, "").replace(",", "."));
    return Number.isFinite(x) ? x : null;
  }
  return null;
}

function round2(x) {
  return Math.round((x + Number.EPSILON) * 100) / 100;
}

function isoDateOnly(d) {
  const dt = new Date(d);
  if (!Number.isFinite(dt.getTime())) throw new Error("Date invalide");
  const yyyy = dt.getFullYear();
  const mm = String(dt.getMonth() + 1).padStart(2, "0");
  const dd = String(dt.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

/** ===== Mapping TVA / comptes ===== */
const VAT = {
  "20": { code_tva: "TN", compte_tva_44566: "44566200" },
  "10": { code_tva: "TI", compte_tva_44566: "44566100" },
  "0": { code_tva: "", compte_tva_44566: "" }
};

function chargesAccount(categoryKey, vatRate) {
  switch (categoryKey) {
    case "petites_fournitures":
      if (vatRate === "20") return "60631000";
      if (vatRate === "10") return "60630000";
      return "";
    case "carburant":
      return vatRate === "20" ? "60614000" : "";
    case "repas_pro":
      return vatRate === "10" ? "62511000" : "";
    case "repas":
      return vatRate === "0" ? "62510000" : "";
    case "papeterie":
      return vatRate === "20" ? "60640000" : "";
    case "peages":
      return vatRate === "20" ? "62512000" : "";
    case "parking":
      return vatRate === "20" ? "62512000" : "";
    default:
      return "";
  }
}

/** ===== Catégorie suggérée depuis keywords OCR ===== */
function suggestCategoryFromText(text) {
  const t = (text || "").toLowerCase();
  const hasAny = (arr) => arr.some((k) => t.includes(k));

  if (hasAny(["repas", "restaurant", "café", "cafe", "brasserie", "bistrot", "menu"])) {
    return { categorie_ui: "repas_pro", journal_ttc: "FREPAS", tva_rate: "10" };
  }
  if (hasAny(["carburant", "gasoil", "gazole", "go", "super", "sp", "essence", "station-service"])) {
    return { categorie_ui: "carburant", journal_ttc: "FCARBU", tva_rate: "20" };
  }
  if (hasAny(["parking", "stationnement", "park"])) {
    return { categorie_ui: "parking", journal_ttc: "FPARKING", tva_rate: "20" };
  }
  if (hasAny(["peage", "péage", "asf", "escota", "aprr", "sanef"])) {
    return { categorie_ui: "peages", journal_ttc: "FPEAGE", tva_rate: "20" };
  }
  return { categorie_ui: null, journal_ttc: "FDIVERS", tva_rate: null };
}

function guessVatRateFromAmounts(ht, tva) {
  if (typeof ht !== "number" || !Number.isFinite(ht) || ht <= 0) return null;
  if (typeof tva !== "number" || !Number.isFinite(tva) || tva < 0) return null;
  const r = tva / ht;
  if (Math.abs(r - 0.2) < 0.03) return "20";
  if (Math.abs(r - 0.1) < 0.02) return "10";
  if (tva === 0) return "0";
  return null;
}

/** Convert PDF first page to PNG using pdftoppm (poppler-utils) */
async function pdfFirstPageToPng(pdfPath) {
  const outBase = path.join("uploads", crypto.randomUUID());
  await execFileAsync("pdftoppm", ["-f", "1", "-l", "1", "-png", pdfPath, outBase]);
  return `${outBase}-1.png`;
}

async function openaiExtractFromImage(dataUrl) {
  if (!OPENAI_API_KEY) throw new Error("OPENAI_API_KEY manquante (env)");

  const prompt = `
Tu extrais les infos d'un ticket/facture.
Renvoie STRICTEMENT un JSON valide (pas de texte autour) :
{
  "date_document": "AAAA-MM-JJ",
  "numero_ticket": "string",
  "montant_ttc": 123.45,
  "montant_ht": 100.00,
  "montant_tva": 23.45,
  "raison_sociale": "Nom visible sur le ticket",
  "mots_cles": ["repas","restaurant","parking","peage","gasoil","super","sp","stationnement"]
}
Règles:
- nombres en décimal (point).
- si absent -> null.
- "mots_cles" : 0 à 10 mots courts réellement présents sur le ticket.`.trim();

  const body = {
    model: OPENAI_MODEL,
    input: [
      {
        role: "user",
        content: [
          { type: "input_text", text: prompt },
          { type: "input_image", image_url: dataUrl }
        ]
      }
    ]
  };

  const resp = await fetch(OPENAI_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(body)
  });

  if (!resp.ok) throw new Error(`OpenAI error (${resp.status}): ${await resp.text()}`);

  const json = await resp.json();
  const raw =
    json.output_text ??
    json.output?.[0]?.content?.find((c) => c.type === "output_text")?.text ??
    json.output?.[0]?.content?.[0]?.text ??
    null;

  if (!raw) throw new Error("OpenAI: pas de texte exploitable");
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error(`OpenAI: JSON invalide: ${raw}`);
  }
}

/** ===== CNX API calls (auth + upload GED) ===== */
let cachedUuid = { value: "", at: 0 };

function getConfig() {
  return {
    baseUrl: runtimeConfig.baseUrl || process.env.CNX_BASE_URL || "",
    identifiant: runtimeConfig.identifiant || process.env.CNX_IDENTIFIANT || "",
    motdepasse: runtimeConfig.motdepasse || process.env.CNX_MOTDEPASSE || ""
  };
}

async function cnxAuthenticate() {
  const { baseUrl, identifiant, motdepasse } = getConfig();
  req(baseUrl, "CNX_BASE_URL");
  req(identifiant, "CNX_IDENTIFIANT");
  req(motdepasse, "CNX_MOTDEPASSE");

  if (cachedUuid.value && Date.now() - cachedUuid.at < 10 * 60 * 1000) return cachedUuid.value;

  const url = `${baseUrl.replace(/\/$/, "")}/v1/authentification`;

  const resp = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ identifiant, motdepasse })
  });

  const text = await resp.text();
  if (!resp.ok) throw new Error(`Authentification CNX (${resp.status}): ${text}`);

  let out;
  try {
    out = JSON.parse(text);
  } catch {
    out = { raw: text };
  }

  const uuid = out?.UUID || out?.uuid || out?.data?.UUID || out?.data?.uuid || "";
  if (!uuid) throw new Error(`UUID introuvable dans la réponse auth: ${text}`);

  cachedUuid = { value: String(uuid), at: Date.now() };
  return cachedUuid.value;
}

/**
 * ✅ IMPORTANT : champ plan GED = idArboGed
 */
async function cnxUploadGedDocument({ filePath, filename, arboId = 945 }) {
  const { baseUrl } = getConfig();
  const uuid = await cnxAuthenticate();

  const url = `${baseUrl.replace(/\/$/, "")}/v1/ged/documents`;

  const boundary = "----WebKitFormBoundary" + crypto.randomUUID().replace(/-/g, "");
  const fileBuf = await fs.readFile(filePath);

  const parts = [];

  // ✅ Champ exact attendu
  parts.push(
    Buffer.from(
      `--${boundary}\r\n` +
        `Content-Disposition: form-data; name="idArboGed"\r\n\r\n` +
        `${String(arboId)}\r\n`
    )
  );

  parts.push(
    Buffer.from(
      `--${boundary}\r\n` +
        `Content-Disposition: form-data; name="file"; filename="${filename}"\r\n` +
        `Content-Type: application/pdf\r\n\r\n`
    )
  );
  parts.push(fileBuf);
  parts.push(Buffer.from(`\r\n--${boundary}--\r\n`));

  const body = Buffer.concat(parts);

  const resp = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": `multipart/form-data; boundary=${boundary}`,
      UUID: uuid
    },
    body
  });

  const text = await resp.text();
  if (!resp.ok) throw new Error(`Upload GED (${resp.status}): ${text}`);

  let out;
  try {
    out = JSON.parse(text);
  } catch {
    out = { raw: text };
  }

  const id = out?.Id || out?.id || out?.data?.Id || out?.data?.id || "";
  if (!id) throw new Error(`Id GED introuvable dans la réponse upload: ${text}`);

  return String(id);
}

/** Génère le payload Écritures (3 lignes) */
function buildEcriturePayload({
  journal,
  referenceGedId,
  dateTicketISO,
  numeroTicket,
  compteFournisseur,
  raisonSociale,
  compteCharges,
  codeTVA,
  compteTVA44566,
  ttc,
  ht,
  tva,
  numeroPiece = "001"
}) {
  const dt = new Date(dateTicketISO);
  if (!Number.isFinite(dt.getTime())) throw new Error("dateTicketISO invalide");

  const annee = dt.getFullYear();
  const mois = dt.getMonth() + 1;
  const jour = dt.getDate();

  const lignes = [
    {
      jour,
      numeroPiece,
      numeroFacture: String(numeroTicket),
      compte: String(compteFournisseur),
      libelle: String(raisonSociale),
      credit: round2(ttc),
      debit: 0,
      modeReglement: ""
    },
    {
      jour,
      numeroPiece,
      numeroFacture: String(numeroTicket),
      compte: String(compteCharges),
      libelle: String(raisonSociale),
      credit: 0,
      debit: round2(ht),
      ...(codeTVA ? { codeTVA: String(codeTVA) } : {})
    }
  ];

  if (typeof tva === "number" && Number.isFinite(tva) && tva > 0) {
    if (!compteTVA44566) throw new Error("compteTVA44566 manquant");
    lignes.push({
      jour,
      numeroPiece,
      numeroFacture: String(numeroTicket),
      compte: String(compteTVA44566),
      libelle: String(raisonSociale),
      credit: 0,
      debit: round2(tva)
    });
  }

  return {
    journal: String(journal),
    mois,
    annee,
    ReferenceGed: String(referenceGedId),
    lignesEcriture: lignes
  };
}

/** Admin config endpoint */
app.post("/api/admin/config", (req, res) => {
  try {
    const { baseUrl, identifiant, motdepasse } = req.body || {};
    runtimeConfig.baseUrl = String(baseUrl || "").trim();
    runtimeConfig.identifiant = String(identifiant || "").trim();
    runtimeConfig.motdepasse = String(motdepasse || "").trim();
    cachedUuid = { value: "", at: 0 };
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ error: String(e.message || e) });
  }
});

/** Upload PDF -> GED + OCR */
app.post("/api/ged/upload", upload.single("pdf"), async (req, res) => {
  let pdfPath = null;
  let pngPath = null;

  try {
    if (!req.file) throw new Error("Aucun PDF");
    pdfPath = req.file.path;

    const gedId = await cnxUploadGedDocument({
      filePath: pdfPath,
      filename: req.file.originalname || "ticket.pdf",
      arboId: 945
    });

    pngPath = await pdfFirstPageToPng(pdfPath);
    const pngB64 = await fs.readFile(pngPath, { encoding: "base64" });
    const extraction = await openaiExtractFromImage(`data:image/png;base64,${pngB64}`);

    const date_document = extraction.date_document || null;
    const numero_ticket = extraction.numero_ticket || null;
    const raison_sociale = extraction.raison_sociale || null;

    const montant_ttc = toNumberOrNull(extraction.montant_ttc);
    const montant_ht = toNumberOrNull(extraction.montant_ht);
    const montant_tva = toNumberOrNull(extraction.montant_tva);

    const mots_cles = Array.isArray(extraction.mots_cles) ? extraction.mots_cles.map(String) : [];

    const suggestionBase = suggestCategoryFromText([raison_sociale, ...mots_cles].join(" "));
    const guessed = guessVatRateFromAmounts(montant_ht, montant_tva);

    const suggestion = { ...suggestionBase, tva_rate: guessed || suggestionBase.tva_rate };

    res.json({
      ok: true,
      gedId,
      extraction: {
        date_document,
        numero_ticket,
        raison_sociale,
        montant_ttc,
        montant_ht,
        montant_tva,
        mots_cles
      },
      suggestion
    });
  } catch (e) {
    res.status(400).json({ error: String(e.message || e) });
  } finally {
    if (pdfPath) await fs.unlink(pdfPath).catch(() => {});
    if (pngPath) await fs.unlink(pngPath).catch(() => {});
  }
});

/** Build Écritures JSON */
app.post("/api/receipts/process", upload.none(), async (req, res) => {
  try {
    const meta = JSON.parse(req.body.meta || "{}");

    const journal = req(meta.journal, "journal");
    const referenceGedId = req(meta.referenceGedId, "referenceGedId");
    const compteFournisseur = req(meta.compteFournisseur, "compteFournisseur (F...)");

    const categorie_ui = req(meta.categorie_ui, "categorie_ui");
    const tva_rate = req(meta.tva_rate, "tva_rate (20/10/0)");

    const charges = chargesAccount(categorie_ui, tva_rate);
    if (!charges) throw new Error("Combinaison catégorie/TVA invalide");

    const vat = VAT[tva_rate];
    if (!vat) throw new Error("tva_rate invalide (20/10/0)");

    const date_ticket = req(meta.date_ticket ? isoDateOnly(meta.date_ticket) : null, "date_ticket");
    const numero_ticket = req(meta.numero_ticket || null, "numero_ticket");
    const raison_sociale = req(meta.raison_sociale || null, "raison_sociale");

    const ttc = req(toNumberOrNull(meta.montant_ttc), "montant_ttc");
    const ht = req(toNumberOrNull(meta.ht), "ht");

    let tva = toNumberOrNull(meta.tva_montant);
    if (tva == null && typeof ttc === "number" && typeof ht === "number") {
      const computedTva = ttc - ht;
      if (Number.isFinite(computedTva) && computedTva >= 0) tva = computedTva;
    }

    const ecrituresPayload = buildEcriturePayload({
      journal,
      referenceGedId,
      dateTicketISO: date_ticket,
      numeroTicket: numero_ticket,
      compteFournisseur,
      raisonSociale: raison_sociale,
      compteCharges: charges,
      codeTVA: vat.code_tva,
      compteTVA44566: vat.compte_tva_44566,
      ttc: Number(ttc),
      ht: Number(ht),
      tva: tva != null ? Number(tva) : 0
    });

    res.json({ ok: true, ecritures: ecrituresPayload });
  } catch (e) {
    res.status(400).json({ error: String(e.message || e) });
  }
});

app.listen(process.env.PORT || 3000, () => console.log("API running"));
