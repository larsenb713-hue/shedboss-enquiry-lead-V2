/* =====================================================================
   SHED BOSS — ENQUIRY / LEAD APP
   ---------------------------------------------------------------------
   VERSION: v2
   DATE:    2026-04-25
   NOTES:   Rewrite of v1 (3,809 lines → 3,203 lines).
            Added autosave draft, tap-to-call/email, Cmd+S save,
            relative dates, declarative Airtable field mapper.
            Same Airtable schema and localStorage keys as v1.
   ---------------------------------------------------------------------
   Single-file React app for capturing shed enquiries.
   Saves locally to device storage AND syncs to an Airtable base.

   ARCHITECTURE (top to bottom):
     1. Constants & domain model      — keys, colours, default lead
     2. Storage helpers               — wraps browser localStorage
     3. Utilities                     — clipboard, share, download, dates
     4. Airtable client               — rate-limited fetch wrapper
     5. Field mapper                  — lead <-> Airtable record
     6. Sync helpers                  — merge local + remote records
     7. Export builders               — JSON / CSV / printable summary
     8. UI primitives                 — Button, Input, Label, etc.
     9. Brand bits                    — Logo, badges, toast
    10. Modal shells                  — generic Modal + ConfirmModal
    11. Feature modals                — Settings / Import / Export
    12. Dashboard                     — list + filters
    13. Lead form                     — the big form
    14. Root component                — orchestrates everything
   ===================================================================== */

import React, { useState, useEffect, useMemo, useRef, useCallback } from "react";
import {
  Plus, Search, Download, FileText, Trash2, Edit3, ArrowLeft, Save, X,
  MapPin, User, Ruler, Hammer, CheckCircle2, FileJson, FileSpreadsheet,
  Printer, Upload, Sparkles, Copy, Share2, AlertCircle, AlertTriangle,
  MoreVertical, Loader2, Settings, Cloud, CloudOff, RefreshCw, Eye, EyeOff,
  Wifi, WifiOff, RotateCcw, Folder, ExternalLink,
} from "lucide-react";

/* =====================================================================
   1. CONSTANTS & DOMAIN MODEL
   ===================================================================== */

const COLORS = {
  red: "#C8102E",
  redDark: "#9E0A22",
  charcoal: "#1A1A1A",
  charcoalLight: "#2B2B2B",
  steel: "#546E7A",
  steelLight: "#90A4AE",
  offWhite: "#F5F4F2",
  paper: "#FAFAF8",
  border: "#E4E2DE",
  green: "#2E7D32",
  amber: "#B45309",
  amberBg: "#FEF3C7",
};

const APP_NAME = "Shed Boss Enquiry/Lead";

const LEAD_KEY = "shedboss:enquiry-lead:lead:";
const INDEX_KEY = "shedboss:enquiry-lead:index";
const CONFIG_KEY = "shedboss:enquiry-lead:config";
const DRAFT_KEY = "shedboss:enquiry-lead:draft:";

const AIRTABLE_BASE_URL = "https://api.airtable.com/v0";
const AIRTABLE_RATE_LIMIT_MS = 220;          // Stay under Airtable's 5 req/s/base limit.
const DEFAULT_BASE_ID = "appE9kDl2kCBJ5tY8";
const DEFAULT_TABLE_NAME = "Leads";

const MARKETING_SOURCES = [
  "TV Advertisement",
  "Yellow Pages / Local Directory",
  "Internet",
  "Drive By",
  "Repeat Business",
  "Other",
];

const WORK_SCOPE = ["Kit", "Slab", "Erect", "Footings", "Delivery", "Council"];

const DEFAULT_MATERIALS = [
  { id: "m1",  description: "Roof Sheets",         size: "",            qty: "", material: "Colorbond" },
  { id: "m2",  description: "Wall Sheets",         size: "",            qty: "", material: "Colorbond" },
  { id: "m3",  description: "Guttering",           size: "",            qty: "", material: "" },
  { id: "m4",  description: "Dividing Walls",      size: "",            qty: "", material: "" },
  { id: "m5",  description: "PA Door",             size: "2040 x 840",  qty: "", material: "" },
  { id: "m6",  description: "Windows / Screens",   size: "790 x 1274",  qty: "", material: "" },
  { id: "m7",  description: "Windows / Screens",   size: "790 x 1500",  qty: "", material: "" },
  { id: "m8",  description: "Roller Door 1",       size: "H x W",       qty: "", material: "" },
  { id: "m9",  description: "Roller Door 2",       size: "H x W",       qty: "", material: "" },
  { id: "m10", description: "Roller Door 3",       size: "H x W",       qty: "", material: "" },
  { id: "m11", description: "Glass Door / Screens",size: "",            qty: "", material: "" },
  { id: "m12", description: "Roller Door Motor",   size: "",            qty: "", material: "" },
  { id: "m13", description: "Insulation Roof",     size: "",            qty: "", material: "" },
  { id: "m14", description: "Insulation Walls",    size: "",            qty: "", material: "" },
  { id: "m15", description: "Vermin Flashing",     size: "",            qty: "", material: "" },
  { id: "m16", description: "Ventilators",         size: "",            qty: "", material: "" },
];

const cloneDefaults = () => structuredClone(DEFAULT_MATERIALS);

const newId = () =>
  `lead_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

const emptyLead = () => ({
  id: newId(),
  status: "New",
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  date: new Date().toISOString().slice(0, 10),
  quoteNo: "",
  quotePreparedBy: "",
  clientName: "",
  phone: "",
  mobile: "",
  email: "",
  siteAddress: "",
  postalAddress: "",
  postalAsAbove: true,
  propertyOwner: "",
  sendQuoteBy: "",
  structureType: "Shed",
  length: "",
  width: "",
  height: "",
  design: "",
  purpose: "",
  timeFrame: "",
  marketingSource: "",
  marketingOther: "",
  access: "",
  level: "",
  power: "",
  water: "",
  sewerSeptic: "",
  sheetsRoof: "",
  sheetsWalls: "",
  overheadPower: false,
  trees: false,
  stormwater: false,
  boundaryNotes: "",
  notes: "",
  fullBuildQuote: false,
  kitOnlyQuote: false,
  workScope: [],
  materials: cloneDefaults(),
  airtableRecordId: null,
  driveFolderUrl: "",       // bridge to Google Drive folder; populated by app at v4, manual entry allowed before then
  syncStatus: "local",      // 'local' | 'syncing' | 'synced' | 'error'
  syncError: null,
  lastSyncAt: null,
});

/* Make a stored/imported lead conform to the current schema. */
function normaliseLead(data) {
  const base = emptyLead();
  const out = { ...base, ...data };
  if (!out.id) out.id = base.id;
  if (!Array.isArray(out.materials) || out.materials.length === 0) {
    out.materials = cloneDefaults();
  } else {
    out.materials = out.materials.map((m, i) => ({
      id: m.id || `m_import_${Date.now()}_${i}`,
      description: m.description || "",
      size: m.size || "",
      qty: m.qty || "",
      material: m.material || "",
    }));
  }
  if (!Array.isArray(out.workScope)) out.workScope = [];
  if (!out.createdAt) out.createdAt = new Date().toISOString();
  out.updatedAt = new Date().toISOString();
  out.airtableRecordId = out.airtableRecordId ?? null;
  out.driveFolderUrl = out.driveFolderUrl ?? "";
  out.syncStatus = out.syncStatus || "local";
  out.syncError = out.syncError ?? null;
  out.lastSyncAt = out.lastSyncAt ?? null;
  return out;
}

function validateLead(lead) {
  const errors = [];
  if (!lead.clientName?.trim()) errors.push("Client Name is required.");
  if (lead.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(lead.email.trim())) {
    errors.push("Email address looks invalid.");
  }
  return errors;
}

/* =====================================================================
   2. STORAGE HELPERS — wrap browser localStorage with try/catch
   ===================================================================== */

async function safeGet(key) {
  try {
    if (typeof localStorage === "undefined") {
      return { ok: false, error: "storage unavailable" };
    }
    const value = localStorage.getItem(key);
    return { ok: true, value };
  } catch (e) {
    return { ok: false, error: e?.message || "get failed" };
  }
}

async function safeSet(key, value) {
  try {
    if (typeof localStorage === "undefined") {
      return { ok: false, error: "storage unavailable" };
    }
    localStorage.setItem(key, value);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e?.message || "set failed" };
  }
}

async function safeDelete(key) {
  try {
    if (typeof localStorage === "undefined") {
      return { ok: false, error: "storage unavailable" };
    }
    localStorage.removeItem(key);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e?.message || "delete failed" };
  }
}

/* =====================================================================
   3. UTILITIES
   ===================================================================== */

async function copyToClipboard(text) {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return { ok: true };
    }
  } catch {}
  // Fallback for older browsers.
  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.focus();
    ta.select();
    const ok = document.execCommand("copy");
    document.body.removeChild(ta);
    return { ok };
  } catch (e) {
    return { ok: false, error: e?.message || "copy failed" };
  }
}

async function shareContent(text, filename, mimeType = "text/plain") {
  // Prefer file share, fall back to text share, fall back to clipboard.
  try {
    if (typeof File !== "undefined" && navigator.canShare) {
      const file = new File([text], filename, { type: mimeType });
      if (navigator.canShare({ files: [file] })) {
        await navigator.share({ files: [file], title: filename });
        return { ok: true, method: "share-file" };
      }
    }
  } catch (e) {
    if (e?.name === "AbortError") return { ok: true, method: "cancelled" };
  }
  try {
    if (navigator.share) {
      await navigator.share({ title: filename, text });
      return { ok: true, method: "share-text" };
    }
  } catch (e) {
    if (e?.name === "AbortError") return { ok: true, method: "cancelled" };
  }
  const r = await copyToClipboard(text);
  return { ok: r.ok, method: "clipboard", error: r.error };
}

function downloadFile(text, filename, mimeType = "text/plain") {
  try {
    const blob = new Blob([text], { type: mimeType });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e?.message || "download failed" };
  }
}

function isLikelyDesktop() {
  if (typeof navigator === "undefined") return false;
  const ua = navigator.userAgent || "";
  const isMobileUA = /Mobi|Android|iPhone|iPad|iPod/i.test(ua);
  const hasTouch = "ontouchstart" in window || (navigator.maxTouchPoints || 0) > 1;
  return !isMobileUA && !hasTouch;
}

/* Friendly relative date for dashboard list. */
function formatRelativeDate(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  const now = new Date();
  const startOfDay = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const days = Math.round((startOfDay(now) - startOfDay(d)) / 86400000);
  if (days === 0) return "Today";
  if (days === 1) return "Yesterday";
  if (days > 1 && days < 7) return `${days}d ago`;
  // Older — show ISO date.
  return iso.length > 10 ? iso.slice(0, 10) : iso;
}

/* =====================================================================
   4. AIRTABLE CLIENT — rate-limited, error-friendly
   ===================================================================== */

class RateLimiter {
  constructor(minInterval) {
    this.minInterval = minInterval;
    this.last = 0;
    this.chain = Promise.resolve();
  }
  run(fn) {
    const next = this.chain.then(async () => {
      const wait = Math.max(0, this.minInterval - (Date.now() - this.last));
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      this.last = Date.now();
      return fn();
    });
    this.chain = next.catch(() => {}); // keep chain alive on error
    return next;
  }
}

const airtableLimiter = new RateLimiter(AIRTABLE_RATE_LIMIT_MS);

function airtableUrl(baseId, tableName, recordId) {
  const base = `${AIRTABLE_BASE_URL}/${baseId}/${encodeURIComponent(tableName)}`;
  return recordId ? `${base}/${recordId}` : base;
}

async function airtableRequest({ baseId, tableName, pat, method = "GET", recordId, body, query }) {
  if (!baseId || !pat || !tableName) {
    const e = new Error("Airtable not configured");
    e.status = 0;
    throw e;
  }
  const url = airtableUrl(baseId, tableName, recordId) + (query ? `?${query}` : "");
  return airtableLimiter.run(async () => {
    let res;
    try {
      res = await fetch(url, {
        method,
        headers: {
          Authorization: `Bearer ${pat}`,
          "Content-Type": "application/json",
        },
        body: body ? JSON.stringify(body) : undefined,
      });
    } catch (e) {
      const err = new Error(e?.message || "Network request failed");
      err.status = 0;
      err.network = true;
      throw err;
    }
    if (!res.ok) {
      let details = "";
      try {
        const data = await res.json();
        details = data?.error?.message || data?.error?.type || (typeof data?.error === "string" ? data.error : "");
      } catch {}
      const err = new Error(details ? `HTTP ${res.status} — ${details}` : `HTTP ${res.status}`);
      err.status = res.status;
      throw err;
    }
    if (res.status === 204) return null;
    try { return await res.json(); } catch { return null; }
  });
}

const airtable = {
  async testConnection(config) {
    await airtableRequest({ ...config, query: "maxRecords=1" });
    return true;
  },

  async listRecords(config) {
    const records = [];
    let offset;
    let pages = 0;
    const MAX_PAGES = 50;             // hard cap → 5,000 records
    do {
      const params = new URLSearchParams({ pageSize: "100" });
      if (offset) params.set("offset", offset);
      const data = await airtableRequest({ ...config, query: params.toString() });
      if (Array.isArray(data?.records)) records.push(...data.records);
      offset = data?.offset;
      pages += 1;
      if (pages >= MAX_PAGES) {
        console.warn(`Airtable list hit ${MAX_PAGES}-page cap; stopping.`);
        break;
      }
    } while (offset);
    return records;
  },

  createRecord: (config, fields) =>
    airtableRequest({ ...config, method: "POST", body: { fields, typecast: true } }),

  updateRecord: (config, recordId, fields) =>
    airtableRequest({ ...config, method: "PATCH", recordId, body: { fields, typecast: true } }),

  deleteRecord: (config, recordId) =>
    airtableRequest({ ...config, method: "DELETE", recordId }),
};

function friendlyAirtableError(err) {
  if (!err) return "Unknown error";
  if (err.network) return "Network error — offline or blocked";
  if (err.status === 401) return "Unauthorised — check Personal Access Token";
  if (err.status === 403) return "Forbidden — token lacks access to this base";
  if (err.status === 404) return "Not found — check Base ID and Table name";
  if (err.status === 422) return `Invalid data — ${err.message.replace(/^HTTP 422\s*—\s*/, "")}`;
  if (err.status === 429) return "Rate limited — retry in a moment";
  if (err.status >= 500) return "Airtable server error — retry in a moment";
  return err.message || "Request failed";
}

const isConfigured = (cfg) => !!(cfg?.baseId && cfg?.pat && cfg?.tableName);

/* =====================================================================
   5. FIELD MAPPER — declarative, easier to maintain than 60 lines of if/else
   ---------------------------------------------------------------------
   Each row: [leadKey, airtableFieldName, type, defaultOnRead]
   Types:
     'text'   — always send empty-string-or-value, defaults to ''
     'select' — single-select; OMITTED on write if empty, defaults to ''
     'bool'   — checkbox; always send !!value
     'multi'  — multi-select array; always send array
     'date'   — YYYY-MM-DD string
   ===================================================================== */

const FIELD_MAP = [
  // [leadKey,           airtableField,        type,     readDefault]
  ["status",             "Status",             "select", "New"],
  ["sendQuoteBy",        "Send Quote By",      "select", ""],
  ["propertyOwner",      "Property Owner",     "select", ""],
  ["structureType",      "Structure Type",     "select", "Shed"],
  ["design",             "Design",             "select", ""],
  ["marketingSource",    "Marketing Source",   "select", ""],
  ["sheetsRoof",         "Sheets Roof",        "select", ""],
  ["sheetsWalls",        "Sheets Walls",       "select", ""],
  ["date",               "Date",               "date",   () => new Date().toISOString().slice(0, 10)],
  ["quoteNo",            "Quote No",           "text",   ""],
  ["quotePreparedBy",    "Quote Prepared By",  "text",   ""],
  ["phone",              "Phone",              "text",   ""],
  ["mobile",             "Mobile",             "text",   ""],
  ["email",              "Email",              "text",   ""],
  ["siteAddress",        "Site Address",       "text",   ""],
  ["postalAddress",      "Postal Address",     "text",   ""],
  ["length",             "Length",             "text",   ""],
  ["width",              "Width",              "text",   ""],
  ["height",             "Height",             "text",   ""],
  ["timeFrame",          "Time Frame",         "text",   ""],
  ["purpose",            "Purpose",            "text",   ""],
  ["marketingOther",     "Marketing Other",    "text",   ""],
  ["access",             "Access",             "text",   ""],
  ["level",              "Level",              "text",   ""],
  ["power",              "Power",              "text",   ""],
  ["water",              "Water",              "text",   ""],
  ["sewerSeptic",        "Sewer Septic",       "text",   ""],
  ["boundaryNotes",      "Boundary Notes",     "text",   ""],
  ["notes",              "Notes",              "text",   ""],
  ["driveFolderUrl",     "Drive Folder URL",   "text",   ""],
  ["postalAsAbove",      "Postal As Above",    "bool",   false],
  ["overheadPower",      "Overhead Power",     "bool",   false],
  ["trees",              "Trees",              "bool",   false],
  ["stormwater",         "Stormwater",         "bool",   false],
  ["fullBuildQuote",     "Full Build Quote",   "bool",   false],
  ["kitOnlyQuote",       "Kit Only Quote",     "bool",   false],
  ["workScope",          "Work Scope",         "multi",  []],
];

function toAirtable(lead) {
  const fields = {
    Name: lead.clientName || "",            // primary field
    "ShedBoss ID": lead.id,                 // bridge key for reconciliation
  };
  for (const [key, name, type] of FIELD_MAP) {
    const value = lead[key];
    if (type === "select") {
      if (value) fields[name] = value;     // omit empty single-selects (Airtable rejects "")
    } else if (type === "bool") {
      fields[name] = !!value;
    } else if (type === "multi") {
      fields[name] = Array.isArray(value) ? value : [];
    } else {
      fields[name] = value || "";
    }
  }
  fields["Materials JSON"] = JSON.stringify(lead.materials || []);
  // Created At / Updated At are auto fields in Airtable — never send.
  return fields;
}

function fromAirtable(record) {
  const f = record.fields || {};
  const lead = {
    id: f["ShedBoss ID"] || `lead_at_${record.id}`,
    airtableRecordId: record.id,
    clientName: f["Name"] || "",
    createdAt: f["Created At"] || new Date().toISOString(),
    updatedAt: f["Updated At"] || new Date().toISOString(),
    syncStatus: "synced",
    syncError: null,
    lastSyncAt: new Date().toISOString(),
  };
  for (const [key, name, type, def] of FIELD_MAP) {
    const value = f[name];
    if (type === "bool") {
      lead[key] = !!value;
    } else if (type === "multi") {
      lead[key] = Array.isArray(value) ? value : [];
    } else {
      lead[key] = value || (typeof def === "function" ? def() : def);
    }
  }
  // Materials — parse JSON blob, fall back to defaults on bad data.
  let materials = cloneDefaults();
  if (f["Materials JSON"]) {
    try {
      const parsed = JSON.parse(f["Materials JSON"]);
      if (Array.isArray(parsed) && parsed.length > 0) {
        materials = parsed.map((m, i) => ({
          id: m.id || `m_at_${record.id}_${i}`,
          description: m.description || "",
          size: m.size || "",
          qty: m.qty || "",
          material: m.material || "",
        }));
      }
    } catch (e) {
      console.warn("Materials JSON parse failed for record", record.id, e);
    }
  }
  lead.materials = materials;
  return lead;
}

/* =====================================================================
   6. SYNC — merge local + remote on initial load
   ===================================================================== */

function mergeLocalAndRemote(localLeads, remoteLeads) {
  const remoteByAtId = new Map();
  const remoteByShedId = new Map();
  for (const r of remoteLeads) {
    if (r.airtableRecordId) remoteByAtId.set(r.airtableRecordId, r);
    if (r.id) remoteByShedId.set(r.id, r);
  }
  const usedRemoteIds = new Set();
  const merged = [];

  for (const local of localLeads) {
    let remote = null;
    if (local.airtableRecordId && remoteByAtId.has(local.airtableRecordId)) {
      remote = remoteByAtId.get(local.airtableRecordId);
    } else if (remoteByShedId.has(local.id)) {
      remote = remoteByShedId.get(local.id);
    }

    if (remote) {
      usedRemoteIds.add(remote.airtableRecordId);
      if (local.syncStatus === "synced") {
        // Remote is authoritative for already-synced records.
        merged.push({ ...remote, id: local.id });
      } else {
        // Unsynced local changes — keep local, capture the now-known Airtable id.
        merged.push({ ...local, airtableRecordId: remote.airtableRecordId });
      }
    } else {
      if (local.syncStatus === "synced" && local.airtableRecordId) {
        // Was synced but remote is gone → deleted externally.
        merged.push({
          ...local,
          airtableRecordId: null,
          syncStatus: "error",
          syncError: "Remote record no longer exists in Airtable",
        });
      } else {
        merged.push(local);
      }
    }
  }
  // Records present remotely but not locally — pull them in.
  for (const remote of remoteLeads) {
    if (!usedRemoteIds.has(remote.airtableRecordId)) merged.push(remote);
  }
  return merged;
}

/* =====================================================================
   7. EXPORT BUILDERS
   ===================================================================== */

const buildLeadJSON = (lead) => JSON.stringify(lead, null, 2);

function buildLeadCSV(lead) {
  const rows = [
    ["Field", "Value"],
    ["Date", lead.date],
    ["Quote No", lead.quoteNo],
    ["Quote Prepared By", lead.quotePreparedBy],
    ["Status", lead.status],
    ["Client Name", lead.clientName],
    ["Phone", lead.phone],
    ["Mobile", lead.mobile],
    ["Email", lead.email],
    ["Site Address", lead.siteAddress],
    ["Postal Address", lead.postalAsAbove ? "As site address" : lead.postalAddress],
    ["Property Owner", lead.propertyOwner],
    ["Send Quote By", lead.sendQuoteBy],
    ["Structure Type", lead.structureType],
    ["Length", lead.length],
    ["Width", lead.width],
    ["Height", lead.height],
    ["Design", lead.design],
    ["Purpose", lead.purpose],
    ["Time Frame", lead.timeFrame],
    ["Marketing Source",
      lead.marketingSource === "Other" ? `Other: ${lead.marketingOther}` : lead.marketingSource],
    ["Access", lead.access],
    ["Level", lead.level],
    ["Power", lead.power],
    ["Water", lead.water],
    ["Sewer / Septic", lead.sewerSeptic],
    ["Sheets Roof", lead.sheetsRoof],
    ["Sheets Walls", lead.sheetsWalls],
    ["Overhead Power", lead.overheadPower ? "Yes" : "No"],
    ["Trees", lead.trees ? "Yes" : "No"],
    ["Stormwater", lead.stormwater ? "Yes" : "No"],
    ["Boundary Notes", lead.boundaryNotes],
    ["Notes", lead.notes],
    ["Full Build Quote", lead.fullBuildQuote ? "Yes" : "No"],
    ["Kit Only Quote", lead.kitOnlyQuote ? "Yes" : "No"],
    ["Work Scope", (lead.workScope || []).join("; ")],
    ["Drive Folder URL", lead.driveFolderUrl || ""],
    [],
    ["Materials"],
    ["Description", "Size", "Qty", "Colorbond / Zinc"],
    ...(lead.materials || []).map((m) => [m.description, m.size, m.qty, m.material]),
  ];
  return rows
    .map((r) => r.map((c) => `"${String(c ?? "").replace(/"/g, '""')}"`).join(","))
    .join("\n");
}

function buildLeadSummary(lead) {
  const dash = (s) => s || "—";
  const hazards = [
    lead.overheadPower && "Overhead Power",
    lead.trees && "Trees",
    lead.stormwater && "Stormwater",
  ].filter(Boolean);
  const lines = [
    "SHED BOSS — QUALIFICATION LEAD",
    "=".repeat(40),
    `Date: ${lead.date}    Quote #: ${dash(lead.quoteNo)}`,
    `Prepared by: ${dash(lead.quotePreparedBy)}`,
    `Status: ${lead.status}`,
    "",
    "CLIENT",
    "-".repeat(40),
    `Name: ${dash(lead.clientName)}`,
    `Phone: ${dash(lead.phone)}   Mobile: ${dash(lead.mobile)}`,
    `Email: ${dash(lead.email)}`,
    `Site: ${dash(lead.siteAddress)}`,
    `Postal: ${lead.postalAsAbove ? "(same as site)" : dash(lead.postalAddress)}`,
    `Property owner: ${dash(lead.propertyOwner)}    Send quote by: ${dash(lead.sendQuoteBy)}`,
    "",
    "SHED DETAILS",
    "-".repeat(40),
    `Type: ${lead.structureType}   Size: ${dash(lead.length)} × ${dash(lead.width)} × ${dash(lead.height)}`,
    `Design: ${dash(lead.design)}`,
    `Purpose: ${dash(lead.purpose)}`,
    `Time frame: ${dash(lead.timeFrame)}`,
    `Heard about us: ${lead.marketingSource === "Other"
      ? `Other — ${lead.marketingOther}`
      : dash(lead.marketingSource)}`,
    "",
    "SITE",
    "-".repeat(40),
    `Access: ${dash(lead.access)}`,
    `Level: ${dash(lead.level)}`,
    `Power: ${dash(lead.power)}    Water: ${dash(lead.water)}`,
    `Sewer/Septic: ${dash(lead.sewerSeptic)}`,
    `Sheets — Roof: ${dash(lead.sheetsRoof)}    Walls: ${dash(lead.sheetsWalls)}`,
    `Hazards: ${hazards.length ? hazards.join(", ") : "none"}`,
  ];
  if (lead.boundaryNotes) lines.push(`Boundary notes: ${lead.boundaryNotes}`);
  lines.push("");
  if (lead.notes) {
    lines.push("NOTES", "-".repeat(40), lead.notes, "");
  }
  lines.push(
    "QUOTE TYPE",
    "-".repeat(40),
    `Full build: ${lead.fullBuildQuote ? "Yes" : "No"}    Kit only: ${lead.kitOnlyQuote ? "Yes" : "No"}`,
    `Work scope: ${(lead.workScope || []).join(", ") || "—"}`,
    "",
    "MATERIALS",
    "-".repeat(40),
  );
  for (const m of lead.materials || []) {
    if (m.description || m.qty || m.size || m.material) {
      lines.push(`${dash(m.description)}  |  ${dash(m.size)}  |  Qty: ${dash(m.qty)}  |  ${dash(m.material)}`);
    }
  }
  if (lead.driveFolderUrl) {
    lines.push("", "DOCUMENTS", "-".repeat(40), `Drive folder: ${lead.driveFolderUrl}`);
  }
  return lines.join("\n");
}

/* =====================================================================
   8. UI PRIMITIVES
   ===================================================================== */

const Label = ({ children, required, className = "" }) => (
  <label
    className={`block text-[11px] font-semibold tracking-[0.12em] uppercase mb-1.5 ${className}`}
    style={{ color: COLORS.charcoalLight, fontFamily: "'IBM Plex Sans', sans-serif" }}
  >
    {children}
    {required && <span style={{ color: COLORS.red }}> *</span>}
  </label>
);

const inputBase = {
  width: "100%",
  padding: "10px 12px",
  fontSize: "14px",
  fontFamily: "'IBM Plex Sans', sans-serif",
  border: `1px solid ${COLORS.border}`,
  borderRadius: "2px",
  background: "#fff",
  color: COLORS.charcoal,
  transition: "border-color 0.15s, box-shadow 0.15s",
  outline: "none",
  boxSizing: "border-box",
};

/* Shared focus styling used by Input/Textarea/Select. */
const focusRing = (e) => {
  e.target.style.borderColor = COLORS.red;
  e.target.style.boxShadow = `0 0 0 3px ${COLORS.red}15`;
};
const blurRing = (e) => {
  e.target.style.borderColor = COLORS.border;
  e.target.style.boxShadow = "none";
};

const Input = ({ style, invalid, ...props }) => (
  <input
    style={{
      ...inputBase,
      ...(invalid ? { borderColor: COLORS.red, boxShadow: `0 0 0 3px ${COLORS.red}15` } : {}),
      ...style,
    }}
    onFocus={focusRing}
    onBlur={(e) => { if (!invalid) blurRing(e); }}
    {...props}
  />
);

const Textarea = ({ style, ...props }) => (
  <textarea
    style={{ ...inputBase, minHeight: "80px", resize: "vertical", ...style }}
    onFocus={focusRing}
    onBlur={blurRing}
    {...props}
  />
);

const Select = ({ style, children, ...props }) => (
  <select
    style={{ ...inputBase, cursor: "pointer", ...style }}
    onFocus={focusRing}
    onBlur={blurRing}
    {...props}
  >
    {children}
  </select>
);

const Checkbox = ({ checked, onChange, label }) => (
  <label
    className="flex items-center gap-2.5 cursor-pointer select-none"
    style={{ fontFamily: "'IBM Plex Sans', sans-serif", fontSize: "14px", minWidth: 0 }}
  >
    <span
      className="inline-flex items-center justify-center"
      style={{
        width: "18px",
        height: "18px",
        border: `1.5px solid ${checked ? COLORS.red : COLORS.steelLight}`,
        background: checked ? COLORS.red : "#fff",
        transition: "all 0.15s",
        flexShrink: 0,
      }}
    >
      {checked && (
        <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
          <path d="M2 6L5 9L10 3" stroke="#fff" strokeWidth="2" strokeLinecap="square" />
        </svg>
      )}
    </span>
    <input type="checkbox" checked={checked} onChange={onChange} className="sr-only" />
    <span style={{ color: COLORS.charcoal }}>{label}</span>
  </label>
);

const Radio = ({ checked, onChange, label, name }) => (
  <label
    className="flex items-center gap-2.5 cursor-pointer select-none"
    style={{ fontFamily: "'IBM Plex Sans', sans-serif", fontSize: "14px", minWidth: 0 }}
  >
    <span
      style={{
        width: "18px",
        height: "18px",
        borderRadius: "50%",
        border: `1.5px solid ${checked ? COLORS.red : COLORS.steelLight}`,
        background: "#fff",
        position: "relative",
        flexShrink: 0,
      }}
    >
      {checked && (
        <span style={{ position: "absolute", inset: "3px", borderRadius: "50%", background: COLORS.red }} />
      )}
    </span>
    <input type="radio" name={name} checked={checked} onChange={onChange} className="sr-only" />
    <span style={{ color: COLORS.charcoal }}>{label}</span>
  </label>
);

const BUTTON_VARIANTS = {
  primary: { background: COLORS.red, color: "#fff", border: `1px solid ${COLORS.red}` },
  dark:    { background: COLORS.charcoal, color: "#fff", border: `1px solid ${COLORS.charcoal}` },
  outline: { background: "#fff", color: COLORS.charcoal, border: `1px solid ${COLORS.border}` },
  ghost:   { background: "transparent", color: COLORS.charcoal, border: "1px solid transparent" },
  danger:  { background: "#fff", color: COLORS.red, border: `1px solid ${COLORS.red}` },
};

const Button = ({ variant = "primary", children, style, disabled, ...props }) => (
  <button
    disabled={disabled}
    style={{
      display: "inline-flex",
      alignItems: "center",
      gap: "8px",
      padding: "10px 16px",
      fontSize: "13px",
      fontWeight: 600,
      letterSpacing: "0.05em",
      textTransform: "uppercase",
      fontFamily: "'IBM Plex Sans', sans-serif",
      cursor: disabled ? "not-allowed" : "pointer",
      transition: "all 0.15s",
      borderRadius: "2px",
      whiteSpace: "nowrap",
      opacity: disabled ? 0.55 : 1,
      ...BUTTON_VARIANTS[variant],
      ...style,
    }}
    {...props}
  >
    {children}
  </button>
);

const SectionHeader = ({ icon: Icon, title, subtitle }) => (
  <div className="flex items-center gap-3 pb-3 mb-5" style={{ borderBottom: `2px solid ${COLORS.charcoal}` }}>
    <div
      style={{
        width: "36px",
        height: "36px",
        background: COLORS.charcoal,
        color: COLORS.red,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        flexShrink: 0,
      }}
    >
      <Icon size={18} />
    </div>
    <div style={{ minWidth: 0 }}>
      <h2
        style={{
          fontFamily: "'Oswald', sans-serif",
          fontSize: "20px",
          fontWeight: 600,
          letterSpacing: "0.04em",
          textTransform: "uppercase",
          color: COLORS.charcoal,
          lineHeight: 1,
        }}
      >
        {title}
      </h2>
      {subtitle && (
        <p style={{
          fontFamily: "'IBM Plex Sans', sans-serif",
          fontSize: "12px",
          color: COLORS.steel,
          marginTop: "4px",
        }}>
          {subtitle}
        </p>
      )}
    </div>
  </div>
);

/* =====================================================================
   9. BRAND BITS
   ===================================================================== */

const ShedBossLogo = ({ size = 36 }) => (
  <div className="flex items-center gap-3" style={{ minWidth: 0 }}>
    <svg width={size} height={size} viewBox="0 0 40 40" fill="none" style={{ flexShrink: 0 }}>
      <path d="M20 4 L36 32 L4 32 Z" fill={COLORS.charcoal} />
      <path d="M20 14 L28 28 L12 28 Z" fill={COLORS.red} />
    </svg>
    <div className="flex flex-col leading-none" style={{ minWidth: 0 }}>
      <span style={{
        fontFamily: "'Oswald', sans-serif",
        fontWeight: 700,
        fontSize: size * 0.55,
        letterSpacing: "0.02em",
        color: COLORS.charcoal,
        whiteSpace: "nowrap",
      }}>
        SHED<span style={{ color: COLORS.red }}>BOSS</span>
      </span>
      <span style={{
        fontFamily: "'Oswald', sans-serif",
        fontSize: size * 0.22,
        letterSpacing: "0.3em",
        color: COLORS.steel,
        marginTop: "2px",
        whiteSpace: "nowrap",
      }}>
        BUILT STRONG · BUILT RIGHT
      </span>
    </div>
  </div>
);

function Toast({ toast }) {
  if (!toast) return null;
  const bg =
    toast.type === "error"   ? COLORS.red :
    toast.type === "warn"    ? COLORS.amber :
    toast.type === "success" ? COLORS.green :
                               COLORS.charcoal;
  const Icon =
    toast.type === "error"   ? AlertCircle :
    toast.type === "success" ? CheckCircle2 :
    toast.type === "warn"    ? AlertTriangle : null;
  return (
    <div
      style={{
        position: "fixed",
        bottom: "24px",
        left: "50%",
        transform: "translateX(-50%)",
        background: bg,
        color: "#fff",
        padding: "12px 20px",
        fontFamily: "'IBM Plex Sans', sans-serif",
        fontSize: "13px",
        fontWeight: 500,
        zIndex: 200,
        maxWidth: "90vw",
        display: "flex",
        alignItems: "center",
        gap: "8px",
        boxShadow: "0 6px 24px rgba(0,0,0,0.25)",
      }}
    >
      {Icon && <Icon size={16} />}
      {toast.msg}
    </div>
  );
}

const StatusBadge = ({ status }) => {
  const map = {
    New:    { bg: `${COLORS.red}15`,             fg: COLORS.red },
    Quoted: { bg: `${COLORS.steel}20`,           fg: COLORS.steel },
    Won:    { bg: `${COLORS.green}15`,           fg: COLORS.green },
    Lost:   { bg: `${COLORS.charcoalLight}20`,   fg: COLORS.charcoalLight },
  };
  const s = map[status] || map.New;
  return (
    <span style={{
      display: "inline-block",
      padding: "4px 10px",
      background: s.bg,
      color: s.fg,
      fontFamily: "'Oswald', sans-serif",
      fontSize: "11px",
      letterSpacing: "0.1em",
      textTransform: "uppercase",
      fontWeight: 500,
      whiteSpace: "nowrap",
    }}>
      {status}
    </span>
  );
};

function SyncBadge({ status, error, compact }) {
  const configs = {
    synced:  { icon: Cloud,          color: COLORS.green,      label: "Synced" },
    syncing: { icon: RefreshCw,      color: COLORS.steel,      label: "Syncing", spinning: true },
    error:   { icon: AlertTriangle,  color: COLORS.red,        label: "Sync error" },
    local:   { icon: CloudOff,       color: COLORS.steelLight, label: "Local only" },
  };
  const cfg = configs[status] || configs.local;
  const Icon = cfg.icon;
  return (
    <span
      title={error ? `${cfg.label}: ${error}` : cfg.label}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: "4px",
        fontSize: compact ? "10px" : "11px",
        color: cfg.color,
        fontFamily: "'Oswald', sans-serif",
        letterSpacing: "0.08em",
        textTransform: "uppercase",
        fontWeight: 500,
        whiteSpace: "nowrap",
      }}
    >
      <Icon size={compact ? 11 : 13} className={cfg.spinning ? "animate-spin" : ""} />
      {!compact && cfg.label}
    </span>
  );
}

function SyncStatusChip({ config, syncSummary, onOpenSettings, onSyncAll }) {
  const chipStyle = (bg, border, color) => ({
    display: "inline-flex",
    alignItems: "center",
    gap: "6px",
    padding: "8px 12px",
    background: bg,
    border: `1px solid ${border}`,
    color,
    fontFamily: "'Oswald', sans-serif",
    fontSize: "11px",
    letterSpacing: "0.1em",
    textTransform: "uppercase",
    fontWeight: 500,
    borderRadius: "2px",
  });

  if (!isConfigured(config)) {
    return (
      <button
        onClick={onOpenSettings}
        style={{ ...chipStyle(`${COLORS.amber}15`, `${COLORS.amber}40`, COLORS.amber), cursor: "pointer" }}
        title="Connect to Airtable"
      >
        <WifiOff size={13} /> Local only
      </button>
    );
  }
  if (syncSummary.syncing > 0) {
    return (
      <span style={chipStyle(`${COLORS.steel}15`, `${COLORS.steel}40`, COLORS.steel)}>
        <RefreshCw size={13} className="animate-spin" /> Syncing {syncSummary.syncing}…
      </span>
    );
  }
  if (syncSummary.errors > 0) {
    return (
      <button
        onClick={onSyncAll}
        style={{ ...chipStyle(`${COLORS.red}15`, `${COLORS.red}40`, COLORS.red), cursor: "pointer", fontWeight: 600 }}
        title="Retry failed syncs"
      >
        <AlertTriangle size={13} /> {syncSummary.errors} error{syncSummary.errors === 1 ? "" : "s"} · Retry
      </button>
    );
  }
  return (
    <span
      style={chipStyle(`${COLORS.green}12`, `${COLORS.green}40`, COLORS.green)}
      title="All leads synced to Airtable"
    >
      <Wifi size={13} /> Synced
    </span>
  );
}

/* =====================================================================
   10. MODAL SHELLS
   ===================================================================== */

function Modal({ title, icon: Icon, onClose, children, maxWidth = "640px" }) {
  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(26, 26, 26, 0.6)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 100,
        padding: "16px",
      }}
      onClick={onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: "#fff",
          width: "100%",
          maxWidth,
          maxHeight: "90vh",
          overflow: "auto",
          borderTop: `4px solid ${COLORS.red}`,
        }}
      >
        <div className="flex items-center justify-between" style={{ padding: "16px 20px", borderBottom: `1px solid ${COLORS.border}` }}>
          <div className="flex items-center gap-2">
            {Icon && <Icon size={18} style={{ color: COLORS.red }} />}
            <h3 style={{
              fontFamily: "'Oswald', sans-serif",
              fontSize: "18px",
              letterSpacing: "0.04em",
              textTransform: "uppercase",
              color: COLORS.charcoal,
            }}>
              {title}
            </h3>
          </div>
          <button
            onClick={onClose}
            style={{ background: "transparent", border: "none", cursor: "pointer", color: COLORS.steel, padding: "4px" }}
            aria-label="Close"
          >
            <X size={20} />
          </button>
        </div>
        <div style={{ padding: "20px" }}>{children}</div>
      </div>
    </div>
  );
}

function ConfirmModal({ title, message, confirmLabel = "Confirm", cancelLabel = "Cancel", destructive, onConfirm, onCancel }) {
  return (
    <Modal title={title} icon={AlertTriangle} onClose={onCancel} maxWidth="460px">
      <p style={{
        fontFamily: "'IBM Plex Sans', sans-serif",
        fontSize: "14px",
        color: COLORS.charcoalLight,
        lineHeight: 1.5,
        marginBottom: "20px",
      }}>
        {message}
      </p>
      <div className="flex justify-end gap-2 flex-wrap">
        <Button variant="outline" onClick={onCancel}>{cancelLabel}</Button>
        <Button variant={destructive ? "danger" : "primary"} onClick={onConfirm}>{confirmLabel}</Button>
      </div>
    </Modal>
  );
}

/* =====================================================================
   11. FEATURE MODALS
   ===================================================================== */

function ImportModal({ onClose, onImport, notify }) {
  const [text, setText] = useState("");
  const [error, setError] = useState("");
  const fileRef = useRef(null);

  const handleFile = async (file) => {
    try {
      setText(await file.text());
      setError("");
    } catch {
      setError("Could not read file.");
    }
  };

  const handleImport = () => {
    setError("");
    if (!text.trim()) {
      setError("Paste JSON data or choose a file first.");
      return;
    }
    let parsed;
    try { parsed = JSON.parse(text); }
    catch (e) { setError("Invalid JSON: " + e.message); return; }

    const leads = Array.isArray(parsed) ? parsed : [parsed];
    const successes = [];
    const failures = [];
    leads.forEach((raw, idx) => {
      try { successes.push(normaliseLead(raw)); }
      catch (e) { failures.push({ idx, reason: e?.message || "unknown error" }); }
    });
    if (successes.length === 0) {
      setError(`All ${leads.length} record(s) failed. First error: ${failures[0]?.reason}`);
      return;
    }
    onImport(successes);
    if (failures.length > 0) {
      notify(`Imported ${successes.length} of ${leads.length} — ${failures.length} failed`, "warn");
    } else {
      notify(`Imported ${successes.length} lead${successes.length === 1 ? "" : "s"}`, "success");
    }
  };

  return (
    <Modal title="Import Leads" icon={Upload} onClose={onClose}>
      <p style={{ fontFamily: "'IBM Plex Sans', sans-serif", fontSize: "13px", color: COLORS.steel, marginBottom: "14px", lineHeight: 1.5 }}>
        Paste JSON below or upload a <code style={{ background: COLORS.offWhite, padding: "1px 6px", fontFamily: "'IBM Plex Mono', monospace", fontSize: "12px" }}>.json</code> file.
        Works with a single lead or an array. Failed records are skipped.
      </p>
      <div className="flex gap-2 mb-3 flex-wrap">
        <Button variant="outline" onClick={() => fileRef.current?.click()}>
          <Upload size={14} /> Choose File
        </Button>
        <input
          ref={fileRef}
          type="file"
          accept="application/json,.json,text/plain"
          style={{ display: "none" }}
          onChange={(e) => e.target.files?.[0] && handleFile(e.target.files[0])}
        />
      </div>
      <Textarea
        value={text}
        onChange={(e) => { setText(e.target.value); setError(""); }}
        placeholder='{ "clientName": "Jody Rankine", "mobile": "0418 773 245", ... }'
        style={{ minHeight: "220px", fontFamily: "'IBM Plex Mono', monospace", fontSize: "12px", lineHeight: 1.5 }}
      />
      {error && (
        <div style={{
          marginTop: "12px",
          padding: "10px 12px",
          background: `${COLORS.red}10`,
          border: `1px solid ${COLORS.red}40`,
          color: COLORS.red,
          fontFamily: "'IBM Plex Sans', sans-serif",
          fontSize: "13px",
          borderRadius: "2px",
        }}>
          {error}
        </div>
      )}
      <div className="flex justify-end gap-2 mt-4 flex-wrap">
        <Button variant="outline" onClick={onClose}>Cancel</Button>
        <Button variant="primary" onClick={handleImport}><Sparkles size={14} /> Import</Button>
      </div>
    </Modal>
  );
}

function ExportModal({ title, content, filename, mimeType = "text/plain", onClose, notify }) {
  const [copied, setCopied] = useState(false);
  const taRef = useRef(null);
  const desktop = isLikelyDesktop();
  const canShare = typeof navigator !== "undefined" && !!navigator.share;

  const handleCopy = async () => {
    const r = await copyToClipboard(content);
    if (r.ok) {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
      notify("Copied to clipboard", "success");
    } else {
      taRef.current?.focus();
      taRef.current?.select();
      notify("Auto-copy blocked — long-press to select and copy", "warn");
    }
  };

  const handleShare = async () => {
    const r = await shareContent(content, filename, mimeType);
    if (r.method === "share-file") notify("Shared as file", "success");
    else if (r.method === "share-text") notify("Shared as text (file attachment not supported)", "warn");
    else if (r.method === "cancelled") return;
    else if (r.ok) {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
      notify("Copied to clipboard (share unavailable)", "success");
    } else notify("Share and copy both failed — select text manually", "error");
  };

  const handleDownload = () => {
    const r = downloadFile(content, filename, mimeType);
    notify(r.ok ? "File downloaded" : "Download failed — try Copy or Share", r.ok ? "success" : "error");
  };

  return (
    <Modal title={title} icon={Share2} onClose={onClose}>
      <p style={{ fontFamily: "'IBM Plex Sans', sans-serif", fontSize: "13px", color: COLORS.steel, marginBottom: "14px", lineHeight: 1.5 }}>
        {desktop
          ? "Download as a file, copy to clipboard, or select the text below manually."
          : "Copy to clipboard, share via the iOS share sheet, or select the text below manually."}
      </p>
      <div className="flex gap-2 mb-3 flex-wrap">
        {desktop && (
          <Button variant="primary" onClick={handleDownload}>
            <Download size={14} /> Download
          </Button>
        )}
        <Button variant={desktop ? "outline" : "primary"} onClick={handleCopy}>
          <Copy size={14} /> {copied ? "Copied!" : "Copy"}
        </Button>
        {canShare && (
          <Button variant="outline" onClick={handleShare}>
            <Share2 size={14} /> Share…
          </Button>
        )}
      </div>
      <textarea
        ref={taRef}
        readOnly
        value={content}
        onClick={(e) => e.target.select()}
        style={{
          ...inputBase,
          minHeight: "260px",
          fontFamily: "'IBM Plex Mono', monospace",
          fontSize: "12px",
          lineHeight: 1.5,
          background: COLORS.paper,
        }}
      />
      <div style={{
        marginTop: "10px",
        fontSize: "11px",
        color: COLORS.steel,
        fontFamily: "'IBM Plex Sans', sans-serif",
        letterSpacing: "0.05em",
      }}>
        FILE NAME: {filename}
      </div>
      <div className="flex justify-end mt-4">
        <Button variant="outline" onClick={onClose}>Close</Button>
      </div>
    </Modal>
  );
}

function SettingsModal({ initialConfig, onClose, onSave, onDisconnect, notify }) {
  const [baseId, setBaseId] = useState(initialConfig?.baseId || DEFAULT_BASE_ID);
  const [tableName, setTableName] = useState(initialConfig?.tableName || DEFAULT_TABLE_NAME);
  const [pat, setPat] = useState(initialConfig?.pat || "");
  const [showPat, setShowPat] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState(null);
  const [confirmDisconnect, setConfirmDisconnect] = useState(false);

  const connected = isConfigured(initialConfig);
  const canTest = baseId.trim() && tableName.trim() && pat.trim();

  const runTest = async () => {
    if (!canTest) return;
    setTesting(true);
    setTestResult(null);
    try {
      await airtable.testConnection({
        baseId: baseId.trim(),
        tableName: tableName.trim(),
        pat: pat.trim(),
      });
      setTestResult({ ok: true, message: "Connected successfully." });
    } catch (e) {
      setTestResult({ ok: false, message: friendlyAirtableError(e) });
    } finally {
      setTesting(false);
    }
  };

  const runSave = () => {
    if (!canTest) {
      notify("Base ID, Table name and PAT are all required.", "error");
      return;
    }
    onSave({ baseId: baseId.trim(), tableName: tableName.trim(), pat: pat.trim() });
  };

  const runDisconnect = () => {
    if (!confirmDisconnect) {
      setConfirmDisconnect(true);
      return;
    }
    onDisconnect();
  };

  return (
    <Modal title="Airtable Connection" icon={Settings} onClose={onClose}>
      <p style={{ fontFamily: "'IBM Plex Sans', sans-serif", fontSize: "13px", color: COLORS.steel, marginBottom: "18px", lineHeight: 1.5 }}>
        Dual-write sync: every saved lead is written to both this device and the Airtable base.
        Your Personal Access Token is stored on this device only.
      </p>

      <div style={{ marginBottom: "14px" }}>
        <Label>Base ID</Label>
        <Input
          value={baseId}
          onChange={(e) => { setBaseId(e.target.value); setTestResult(null); }}
          placeholder="app..."
          style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: "13px" }}
        />
      </div>
      <div style={{ marginBottom: "14px" }}>
        <Label>Table Name</Label>
        <Input
          value={tableName}
          onChange={(e) => { setTableName(e.target.value); setTestResult(null); }}
          placeholder="Leads"
        />
      </div>
      <div style={{ marginBottom: "14px" }}>
        <Label required>Personal Access Token</Label>
        <div style={{ position: "relative" }}>
          <Input
            type={showPat ? "text" : "password"}
            value={pat}
            onChange={(e) => { setPat(e.target.value); setTestResult(null); }}
            placeholder="pat..."
            style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: "13px", paddingRight: "44px" }}
          />
          <button
            onClick={() => setShowPat((v) => !v)}
            aria-label={showPat ? "Hide token" : "Show token"}
            style={{
              position: "absolute",
              right: "8px",
              top: "50%",
              transform: "translateY(-50%)",
              background: "transparent",
              border: "none",
              cursor: "pointer",
              color: COLORS.steel,
              padding: "4px",
            }}
          >
            {showPat ? <EyeOff size={16} /> : <Eye size={16} />}
          </button>
        </div>
        <p style={{ fontFamily: "'IBM Plex Sans', sans-serif", fontSize: "11px", color: COLORS.steel, marginTop: "6px", lineHeight: 1.4 }}>
          Generate at airtable.com → Builder hub → Personal access tokens. Required scopes:{" "}
          <code style={{ background: COLORS.offWhite, padding: "1px 4px", fontSize: "10px" }}>data.records:read</code>,{" "}
          <code style={{ background: COLORS.offWhite, padding: "1px 4px", fontSize: "10px" }}>data.records:write</code>.
          Add access to the ShedBoss base.
        </p>
      </div>

      <div className="flex gap-2 mb-3 flex-wrap items-center">
        <Button variant="outline" onClick={runTest} disabled={!canTest || testing}>
          {testing ? <Loader2 size={14} className="animate-spin" /> : <Wifi size={14} />}
          {testing ? "Testing…" : "Test Connection"}
        </Button>
      </div>

      {testResult && (
        <div style={{
          padding: "10px 12px",
          background: testResult.ok ? `${COLORS.green}12` : `${COLORS.red}10`,
          border: `1px solid ${testResult.ok ? COLORS.green : COLORS.red}40`,
          color: testResult.ok ? COLORS.green : COLORS.red,
          fontFamily: "'IBM Plex Sans', sans-serif",
          fontSize: "13px",
          borderRadius: "2px",
          display: "flex",
          alignItems: "center",
          gap: "6px",
          marginBottom: "14px",
        }}>
          {testResult.ok ? <CheckCircle2 size={14} /> : <AlertCircle size={14} />}
          {testResult.message}
        </div>
      )}

      <div className="flex justify-between items-center gap-2 flex-wrap mt-5">
        <div>
          {connected && (
            <Button variant={confirmDisconnect ? "danger" : "ghost"} onClick={runDisconnect}>
              {confirmDisconnect ? "Really disconnect?" : "Disconnect"}
            </Button>
          )}
        </div>
        <div className="flex gap-2 flex-wrap">
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button variant="primary" onClick={runSave} disabled={!canTest}>
            <Save size={14} /> Save
          </Button>
        </div>
      </div>
    </Modal>
  );
}

/* =====================================================================
   12. DASHBOARD
   ===================================================================== */

function MobileExportMenu({ open, onClose, onJSON, onCSV, onSummary }) {
  if (!open) return null;
  return (
    <div onClick={onClose} style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.3)", zIndex: 60 }}>
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          position: "absolute",
          top: "60px",
          right: "12px",
          background: "#fff",
          border: `1px solid ${COLORS.border}`,
          boxShadow: "0 8px 24px rgba(0,0,0,0.15)",
          minWidth: "200px",
        }}
      >
        {[
          { label: "JSON", icon: FileJson, action: onJSON },
          { label: "CSV", icon: FileSpreadsheet, action: onCSV },
          { label: "Summary", icon: Printer, action: onSummary },
        ].map((it) => (
          <button
            key={it.label}
            onClick={() => { it.action(); onClose(); }}
            style={{
              display: "flex",
              alignItems: "center",
              gap: "10px",
              width: "100%",
              padding: "12px 16px",
              background: "transparent",
              border: "none",
              borderBottom: `1px solid ${COLORS.border}`,
              cursor: "pointer",
              fontFamily: "'IBM Plex Sans', sans-serif",
              fontSize: "14px",
              color: COLORS.charcoal,
              textAlign: "left",
            }}
          >
            <it.icon size={16} style={{ color: COLORS.red }} />
            Export as {it.label}
          </button>
        ))}
      </div>
    </div>
  );
}

function Dashboard({
  leads, onNew, onOpen, onDelete, onExportAll, onImport,
  notify, requestConfirm, config, syncSummary, onOpenSettings, onSyncAll,
}) {
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("All");
  const [showImport, setShowImport] = useState(false);

  const filtered = useMemo(() => {
    let list = [...leads].sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));
    if (statusFilter !== "All") list = list.filter((l) => l.status === statusFilter);
    if (search.trim()) {
      const q = search.toLowerCase();
      list = list.filter((l) =>
        (l.clientName || "").toLowerCase().includes(q) ||
        (l.siteAddress || "").toLowerCase().includes(q) ||
        (l.email || "").toLowerCase().includes(q) ||
        (l.mobile || "").toLowerCase().includes(q) ||
        (l.quoteNo || "").toLowerCase().includes(q)
      );
    }
    return list;
  }, [leads, search, statusFilter]);

  const stats = useMemo(() => ({
    total:    leads.length,
    newCount: leads.filter((l) => l.status === "New").length,
    quoted:   leads.filter((l) => l.status === "Quoted").length,
    won:      leads.filter((l) => l.status === "Won").length,
  }), [leads]);

  const confirmDelete = (lead) => {
    requestConfirm({
      title: "Delete Lead",
      message: `Delete the lead for ${lead.clientName || "this client"}? This can't be undone locally.`,
      confirmLabel: "Delete",
      destructive: true,
      onConfirm: () => onDelete(lead.id),
    });
  };

  return (
    <div style={{ minHeight: "100vh", background: COLORS.paper }}>
      <div style={{ background: "#fff", borderBottom: `1px solid ${COLORS.border}`, padding: "16px 20px" }}>
        <div className="max-w-7xl mx-auto flex items-center justify-between gap-3 flex-wrap">
          <ShedBossLogo />
          <div className="flex gap-2 flex-wrap items-center">
            <SyncStatusChip
              config={config}
              syncSummary={syncSummary}
              onOpenSettings={onOpenSettings}
              onSyncAll={onSyncAll}
            />
            <button
              onClick={onOpenSettings}
              aria-label="Airtable settings"
              title="Airtable settings"
              style={{
                display: "inline-flex",
                alignItems: "center",
                justifyContent: "center",
                padding: "9px",
                background: "#fff",
                border: `1px solid ${COLORS.border}`,
                cursor: "pointer",
                color: COLORS.charcoal,
                borderRadius: "2px",
              }}
            >
              <Settings size={16} />
            </button>
            <Button variant="outline" onClick={() => setShowImport(true)}>
              <Upload size={14} /> Import
            </Button>
            <Button variant="outline" onClick={onExportAll}>
              <Share2 size={14} /> Export
            </Button>
            <Button variant="primary" onClick={onNew}>
              <Plus size={16} /> New
            </Button>
          </div>
        </div>
      </div>

      <div className="max-w-7xl mx-auto px-5 sm:px-8 pt-8 sm:pt-10 pb-6">
        <div style={{
          fontFamily: "'IBM Plex Sans', sans-serif",
          fontSize: "12px",
          letterSpacing: "0.2em",
          color: COLORS.steel,
          textTransform: "uppercase",
          marginBottom: "8px",
        }}>
          {APP_NAME}
        </div>
        <h1 style={{
          fontFamily: "'Oswald', sans-serif",
          fontSize: "clamp(32px, 6vw, 44px)",
          fontWeight: 600,
          letterSpacing: "0.02em",
          color: COLORS.charcoal,
          lineHeight: 1,
          textTransform: "uppercase",
        }}>
          Enquiry <span style={{ color: COLORS.red }}>Dashboard</span>
        </h1>
      </div>

      <div className="max-w-7xl mx-auto px-5 sm:px-8 mb-6">
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          {[
            { label: "Total Leads", value: stats.total,    accent: COLORS.charcoal },
            { label: "New",         value: stats.newCount, accent: COLORS.red },
            { label: "Quoted",      value: stats.quoted,   accent: COLORS.steel },
            { label: "Won",         value: stats.won,      accent: COLORS.green },
          ].map((s, i) => (
            <div key={i} style={{
              background: "#fff",
              padding: "18px",
              border: `1px solid ${COLORS.border}`,
              borderLeft: `4px solid ${s.accent}`,
            }}>
              <div style={{
                fontFamily: "'IBM Plex Sans', sans-serif",
                fontSize: "11px",
                letterSpacing: "0.15em",
                color: COLORS.steel,
                textTransform: "uppercase",
              }}>
                {s.label}
              </div>
              <div style={{
                fontFamily: "'Oswald', sans-serif",
                fontSize: "32px",
                fontWeight: 600,
                color: COLORS.charcoal,
                marginTop: "4px",
                lineHeight: 1,
              }}>
                {s.value}
              </div>
            </div>
          ))}
        </div>
      </div>

      <div className="max-w-7xl mx-auto px-5 sm:px-8 mb-4">
        <div className="flex gap-2 flex-col sm:flex-row">
          <div style={{ position: "relative", flex: 1 }}>
            <Search size={16} style={{ position: "absolute", left: "12px", top: "50%", transform: "translateY(-50%)", color: COLORS.steel }} />
            <Input
              placeholder="Search name, address, email, phone, quote #..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              style={{ paddingLeft: "38px" }}
            />
          </div>
          <Select
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value)}
            style={{ width: "100%", maxWidth: "200px" }}
          >
            <option value="All">All Statuses</option>
            <option value="New">New</option>
            <option value="Quoted">Quoted</option>
            <option value="Won">Won</option>
            <option value="Lost">Lost</option>
          </Select>
        </div>
      </div>

      <div className="max-w-7xl mx-auto px-5 sm:px-8 pb-16">
        <div style={{ background: "#fff", border: `1px solid ${COLORS.border}` }}>
          {filtered.length === 0 ? (
            <div style={{ padding: "60px 20px", textAlign: "center", color: COLORS.steel, fontFamily: "'IBM Plex Sans', sans-serif" }}>
              <FileText size={48} style={{ margin: "0 auto 16px", color: COLORS.steelLight }} />
              <div style={{ fontSize: "16px", fontWeight: 500, color: COLORS.charcoal }}>
                {leads.length === 0 ? "No leads yet" : "No matches"}
              </div>
              <div style={{ fontSize: "14px", marginTop: "6px" }}>
                {leads.length === 0
                  ? "Tap 'New' or 'Import' to get started."
                  : "Try a different search or filter."}
              </div>
            </div>
          ) : (
            <>
              {/* Mobile card list */}
              <div className="block md:hidden">
                {filtered.map((lead) => (
                  <div
                    key={lead.id}
                    onClick={() => onOpen(lead.id)}
                    style={{ padding: "14px 16px", borderBottom: `1px solid ${COLORS.border}`, cursor: "pointer" }}
                  >
                    <div className="flex justify-between items-start gap-2">
                      <div style={{ minWidth: 0, flex: 1 }}>
                        <div style={{ fontFamily: "'IBM Plex Sans', sans-serif", fontWeight: 600, fontSize: "15px", color: COLORS.charcoal }}>
                          {lead.clientName || "Unnamed lead"}
                        </div>
                        {lead.siteAddress && (
                          <div style={{ fontSize: "13px", color: COLORS.steel, marginTop: "2px", fontFamily: "'IBM Plex Sans', sans-serif" }}>
                            {lead.siteAddress}
                          </div>
                        )}
                        {(lead.mobile || lead.email) && (
                          <div className="flex flex-wrap gap-x-3 gap-y-1" style={{ marginTop: "4px", fontSize: "12px", fontFamily: "'IBM Plex Sans', sans-serif" }}>
                            {lead.mobile && (
                              <a
                                href={`tel:${lead.mobile.replace(/\s+/g, "")}`}
                                onClick={(e) => e.stopPropagation()}
                                style={{ color: COLORS.red, textDecoration: "none", fontWeight: 500 }}
                              >
                                {lead.mobile}
                              </a>
                            )}
                            {lead.email && (
                              <a
                                href={`mailto:${lead.email}`}
                                onClick={(e) => e.stopPropagation()}
                                style={{ color: COLORS.red, textDecoration: "none", fontWeight: 500 }}
                              >
                                {lead.email}
                              </a>
                            )}
                          </div>
                        )}
                        <div className="flex items-center gap-2 flex-wrap" style={{ marginTop: "6px", fontSize: "12px", color: COLORS.steel, fontFamily: "'IBM Plex Sans', sans-serif" }}>
                          <span>{lead.structureType}</span>
                          {(lead.length || lead.width) && (
                            <span>· {lead.length}×{lead.width}{lead.height ? `×${lead.height}` : ""}</span>
                          )}
                          <span>· {formatRelativeDate(lead.date)}</span>
                        </div>
                      </div>
                      <div className="flex flex-col items-end gap-2" style={{ flexShrink: 0 }}>
                        <StatusBadge status={lead.status} />
                        <SyncBadge status={lead.syncStatus} error={lead.syncError} compact />
                        <button
                          onClick={(e) => { e.stopPropagation(); confirmDelete(lead); }}
                          style={{
                            padding: "6px",
                            background: "transparent",
                            border: `1px solid ${COLORS.border}`,
                            cursor: "pointer",
                            color: COLORS.red,
                          }}
                          aria-label="Delete lead"
                        >
                          <Trash2 size={14} />
                        </button>
                      </div>
                    </div>
                  </div>
                ))}
              </div>

              {/* Desktop table */}
              <div className="hidden md:block" style={{ overflowX: "auto" }}>
                <table style={{ width: "100%", borderCollapse: "collapse" }}>
                  <thead>
                    <tr style={{ background: COLORS.charcoal }}>
                      {["Client", "Site Address", "Structure", "Quote #", "Date", "Status", ""].map((h) => (
                        <th key={h} style={{
                          padding: "14px 16px",
                          textAlign: "left",
                          fontFamily: "'Oswald', sans-serif",
                          fontSize: "12px",
                          fontWeight: 500,
                          letterSpacing: "0.12em",
                          textTransform: "uppercase",
                          color: "#fff",
                        }}>
                          {h}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {filtered.map((lead, idx) => (
                      <tr
                        key={lead.id}
                        style={{
                          borderBottom: `1px solid ${COLORS.border}`,
                          background: idx % 2 === 0 ? "#fff" : COLORS.paper,
                          cursor: "pointer",
                        }}
                        onClick={() => onOpen(lead.id)}
                      >
                        <td style={{ padding: "14px 16px", fontFamily: "'IBM Plex Sans', sans-serif", fontWeight: 600, color: COLORS.charcoal }}>
                          {lead.clientName || "—"}
                          {lead.mobile && (
                            <a
                              href={`tel:${lead.mobile.replace(/\s+/g, "")}`}
                              onClick={(e) => e.stopPropagation()}
                              style={{ display: "block", fontSize: "12px", color: COLORS.red, fontWeight: 400, textDecoration: "none", marginTop: "2px" }}
                            >
                              {lead.mobile}
                            </a>
                          )}
                        </td>
                        <td style={{ padding: "14px 16px", fontSize: "14px", color: COLORS.charcoalLight }}>
                          {lead.siteAddress || "—"}
                        </td>
                        <td style={{ padding: "14px 16px", fontSize: "14px", color: COLORS.charcoalLight }}>
                          {lead.structureType}
                          {(lead.length || lead.width) && (
                            <div style={{ fontSize: "12px", color: COLORS.steel }}>
                              {lead.length}×{lead.width}{lead.height && `×${lead.height}`}
                            </div>
                          )}
                        </td>
                        <td style={{ padding: "14px 16px", fontFamily: "'IBM Plex Mono', monospace", fontSize: "13px", color: COLORS.charcoalLight }}>
                          {lead.quoteNo || "—"}
                        </td>
                        <td style={{ padding: "14px 16px", fontSize: "13px", color: COLORS.steel }}>
                          {formatRelativeDate(lead.date)}
                        </td>
                        <td style={{ padding: "14px 16px" }}>
                          <div className="flex flex-col gap-1 items-start">
                            <StatusBadge status={lead.status} />
                            <SyncBadge status={lead.syncStatus} error={lead.syncError} compact />
                          </div>
                        </td>
                        <td style={{ padding: "14px 16px" }} onClick={(e) => e.stopPropagation()}>
                          <div className="flex gap-1">
                            <button
                              onClick={() => onOpen(lead.id)}
                              style={{ padding: "6px", background: "transparent", border: `1px solid ${COLORS.border}`, cursor: "pointer", color: COLORS.charcoal }}
                              aria-label="Edit lead"
                            >
                              <Edit3 size={14} />
                            </button>
                            <button
                              onClick={() => confirmDelete(lead)}
                              style={{ padding: "6px", background: "transparent", border: `1px solid ${COLORS.border}`, cursor: "pointer", color: COLORS.red }}
                              aria-label="Delete lead"
                            >
                              <Trash2 size={14} />
                            </button>
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </div>
      </div>

      <div style={{
        borderTop: `1px solid ${COLORS.border}`,
        padding: "20px",
        textAlign: "center",
        fontFamily: "'IBM Plex Sans', sans-serif",
        fontSize: "11px",
        letterSpacing: "0.15em",
        color: COLORS.steel,
        textTransform: "uppercase",
      }}>
        {APP_NAME}
      </div>

      {showImport && (
        <ImportModal
          onClose={() => setShowImport(false)}
          onImport={(leads) => { onImport(leads); setShowImport(false); }}
          notify={notify}
        />
      )}
    </div>
  );
}

/* =====================================================================
   13. LEAD FORM
   ===================================================================== */

function LeadForm({ initial, onSave, onCancel, onDelete, notify, requestConfirm, saving }) {
  const [lead, setLead] = useState(initial);
  const [exportView, setExportView] = useState(null);
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [fieldErrors, setFieldErrors] = useState([]);
  const [dirty, setDirty] = useState(false);
  const [draftPrompt, setDraftPrompt] = useState(null);  // {savedAt, draft}
  const [driveUrlEditing, setDriveUrlEditing] = useState(false);
  const [driveUrlInput, setDriveUrlInput] = useState("");

  /* Update one field. */
  const up = (k, v) => {
    setLead((p) => ({ ...p, [k]: v }));
    setDirty(true);
    if (fieldErrors.length) setFieldErrors([]);
  };

  const toggleWorkScope = (item) => {
    setLead((p) => ({
      ...p,
      workScope: p.workScope.includes(item)
        ? p.workScope.filter((i) => i !== item)
        : [...p.workScope, item],
    }));
    setDirty(true);
  };

  const updateMaterial = (id, key, val) => {
    setLead((p) => ({
      ...p,
      materials: p.materials.map((m) => (m.id === id ? { ...m, [key]: val } : m)),
    }));
    setDirty(true);
  };

  const addMaterial = () => {
    setLead((p) => ({
      ...p,
      materials: [
        ...p.materials,
        { id: `m_${Date.now()}`, description: "", size: "", qty: "", material: "" },
      ],
    }));
    setDirty(true);
  };

  const removeMaterial = (id) => {
    setLead((p) => ({ ...p, materials: p.materials.filter((m) => m.id !== id) }));
    setDirty(true);
  };

  /* --- Draft check on mount --- */
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const r = await safeGet(DRAFT_KEY + initial.id);
      if (cancelled || !r.ok || !r.value) return;
      try {
        const draft = JSON.parse(r.value);
        const draftTime = draft._draftSavedAt ? new Date(draft._draftSavedAt).getTime() : 0;
        const initialTime = initial.updatedAt ? new Date(initial.updatedAt).getTime() : 0;
        if (draftTime > initialTime) {
          setDraftPrompt({ savedAt: draft._draftSavedAt, draft });
        } else {
          // Stale draft — clear it.
          await safeDelete(DRAFT_KEY + initial.id);
        }
      } catch {
        await safeDelete(DRAFT_KEY + initial.id);
      }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initial.id]);

  /* --- Autosave draft on change (debounced 800ms) --- */
  useEffect(() => {
    if (!dirty) return;
    const t = setTimeout(() => {
      const draft = { ...lead, _draftSavedAt: new Date().toISOString() };
      safeSet(DRAFT_KEY + lead.id, JSON.stringify(draft));
    }, 800);
    return () => clearTimeout(t);
  }, [lead, dirty]);

  const restoreDraft = () => {
    setLead(draftPrompt.draft);
    setDirty(true);
    setDraftPrompt(null);
    notify("Draft restored", "success");
  };

  const discardDraft = async () => {
    await safeDelete(DRAFT_KEY + initial.id);
    setDraftPrompt(null);
    notify("Draft discarded", "info");
  };

  const handleSave = useCallback(() => {
    const errors = validateLead(lead);
    if (errors.length) {
      setFieldErrors(errors);
      notify(errors[0], "error");
      window.scrollTo({ top: 0, behavior: "smooth" });
      return;
    }
    const updated = { ...lead, updatedAt: new Date().toISOString() };
    setLead(updated);
    setDirty(false);
    // Clear draft on successful save.
    safeDelete(DRAFT_KEY + updated.id);
    onSave(updated);
  }, [lead, notify, onSave]);

  /* --- Cmd/Ctrl+S to save --- */
  useEffect(() => {
    const onKey = (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "s") {
        e.preventDefault();
        handleSave();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [handleSave]);

  const handleCancel = () => {
    if (!dirty) { onCancel(); return; }
    requestConfirm({
      title: "Discard Changes?",
      message: "You have unsaved changes. Leave without saving? Your draft will be kept and offered for restore next time.",
      confirmLabel: "Discard",
      destructive: true,
      onConfirm: onCancel,
    });
  };

  const handleDeleteClick = () => {
    requestConfirm({
      title: "Delete Lead",
      message: "Delete this lead permanently? This can't be undone locally.",
      confirmLabel: "Delete",
      destructive: true,
      onConfirm: onDelete,
    });
  };

  /* Drive Folder URL — manual override for emergencies before v4 Drive integration.
     Validates the URL is a Google Drive folder before accepting. */
  const validateDriveUrl = (url) => {
    const trimmed = (url || "").trim();
    if (!trimmed) return { ok: true, value: "" };  // allow clearing
    if (!trimmed.startsWith("https://drive.google.com/")) {
      return { ok: false, error: "URL must start with https://drive.google.com/" };
    }
    if (!trimmed.includes("/folders/")) {
      return { ok: false, error: "Expected a Drive folder URL (must contain /folders/)" };
    }
    return { ok: true, value: trimmed };
  };

  const handleDriveUrlEdit = () => {
    setDriveUrlInput(lead.driveFolderUrl || "");
    setDriveUrlEditing(true);
  };

  const handleDriveUrlSave = () => {
    const result = validateDriveUrl(driveUrlInput);
    if (!result.ok) {
      notify(result.error, "error");
      return;
    }
    up("driveFolderUrl", result.value);
    setDriveUrlEditing(false);
    notify(result.value ? "Drive folder URL saved" : "Drive folder URL cleared", "success");
  };

  const handleDriveUrlCancel = () => {
    setDriveUrlEditing(false);
    setDriveUrlInput("");
  };

  const nameSafe = (lead.clientName || "lead").replace(/[^a-z0-9]+/gi, "-").toLowerCase();

  const openJSON = () => setExportView({
    title: "Export JSON",
    content: buildLeadJSON(lead),
    filename: `shedboss-lead-enquiry-${nameSafe}.json`,
    mimeType: "application/json",
  });
  const openCSV = () => setExportView({
    title: "Export CSV",
    content: buildLeadCSV(lead),
    filename: `shedboss-lead-enquiry-${nameSafe}.csv`,
    mimeType: "text/csv",
  });
  const openSummary = () => setExportView({
    title: "Printable Summary",
    content: buildLeadSummary(lead),
    filename: `shedboss-lead-enquiry-${nameSafe}.txt`,
    mimeType: "text/plain",
  });

  const clientNameInvalid = fieldErrors.some((e) => e.toLowerCase().includes("client name"));
  const emailInvalid = fieldErrors.some((e) => e.toLowerCase().includes("email"));

  return (
    <div style={{ minHeight: "100vh", background: COLORS.paper }}>
      {/* Sticky toolbar */}
      <div style={{
        background: "#fff",
        borderBottom: `1px solid ${COLORS.border}`,
        padding: "12px 16px",
        position: "sticky",
        top: 0,
        zIndex: 50,
      }}>
        <div className="max-w-6xl mx-auto flex items-center justify-between gap-3 flex-wrap">
          <div className="flex items-center gap-3">
            <button
              onClick={handleCancel}
              style={{
                display: "flex",
                alignItems: "center",
                gap: "6px",
                padding: "8px 12px",
                background: "transparent",
                border: `1px solid ${COLORS.border}`,
                cursor: "pointer",
                fontFamily: "'IBM Plex Sans', sans-serif",
                fontSize: "13px",
                color: COLORS.charcoal,
              }}
            >
              <ArrowLeft size={14} /> Back
            </button>
            <div className="hidden sm:block">
              <ShedBossLogo size={30} />
            </div>
            {dirty && (
              <span style={{
                fontFamily: "'IBM Plex Sans', sans-serif",
                fontSize: "11px",
                color: COLORS.amber,
                letterSpacing: "0.1em",
                textTransform: "uppercase",
                fontWeight: 600,
              }}>
                • Unsaved
              </span>
            )}
            <SyncBadge status={lead.syncStatus} error={lead.syncError} />
          </div>

          {/* Desktop toolbar */}
          <div className="hidden md:flex gap-2 flex-wrap items-center">
            <Button variant="outline" onClick={openCSV} style={{ padding: "8px 12px" }}>
              <FileSpreadsheet size={14} /> CSV
            </Button>
            <Button variant="outline" onClick={openJSON} style={{ padding: "8px 12px" }}>
              <FileJson size={14} /> JSON
            </Button>
            <Button variant="outline" onClick={openSummary} style={{ padding: "8px 12px" }}>
              <Printer size={14} /> Summary
            </Button>
            {onDelete && (
              <Button variant="danger" style={{ padding: "8px 12px" }} onClick={handleDeleteClick}>
                <Trash2 size={14} />
              </Button>
            )}
            <Button variant="primary" onClick={handleSave} disabled={saving} style={{ padding: "8px 14px" }}>
              {saving ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />}
              {saving ? "Saving…" : "Save"}
            </Button>
          </div>

          {/* Mobile toolbar */}
          <div className="flex md:hidden gap-2 items-center">
            <button
              onClick={() => setMobileMenuOpen((v) => !v)}
              style={{ padding: "8px 10px", background: "#fff", border: `1px solid ${COLORS.border}`, cursor: "pointer", color: COLORS.charcoal }}
              aria-label="Export menu"
            >
              <MoreVertical size={16} />
            </button>
            {onDelete && (
              <Button variant="danger" style={{ padding: "8px 10px" }} onClick={handleDeleteClick}>
                <Trash2 size={14} />
              </Button>
            )}
            <Button variant="primary" onClick={handleSave} disabled={saving} style={{ padding: "8px 12px" }}>
              {saving ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />}
              {saving ? "…" : "Save"}
            </Button>
          </div>
        </div>
      </div>

      <MobileExportMenu
        open={mobileMenuOpen}
        onClose={() => setMobileMenuOpen(false)}
        onJSON={openJSON}
        onCSV={openCSV}
        onSummary={openSummary}
      />

      <div className="max-w-6xl mx-auto px-4 sm:px-8 py-6 sm:py-8">
        {/* Banner */}
        <div style={{ background: COLORS.charcoal, padding: "20px 24px", marginBottom: "24px", position: "relative", overflow: "hidden" }}>
          <div style={{
            position: "absolute",
            right: "-40px",
            top: "-40px",
            width: "160px",
            height: "160px",
            background: COLORS.red,
            transform: "rotate(45deg)",
            opacity: 0.15,
          }} />
          <div style={{ position: "relative", zIndex: 1 }}>
            <div style={{
              fontFamily: "'IBM Plex Sans', sans-serif",
              fontSize: "11px",
              letterSpacing: "0.25em",
              color: COLORS.red,
              textTransform: "uppercase",
              marginBottom: "6px",
            }}>
              {APP_NAME}
            </div>
            <h1 style={{
              fontFamily: "'Oswald', sans-serif",
              fontSize: "clamp(22px, 5vw, 32px)",
              fontWeight: 600,
              color: "#fff",
              letterSpacing: "0.04em",
              textTransform: "uppercase",
              lineHeight: 1.1,
            }}>
              Qualification Lead Sheet
            </h1>
            <p style={{
              fontFamily: "'IBM Plex Sans', sans-serif",
              fontSize: "13px",
              color: COLORS.steelLight,
              marginTop: "8px",
              fontStyle: "italic",
              lineHeight: 1.4,
            }}>
              Thank you for your call, just so I can help you best would it be OK if I asked you a couple of questions?
            </p>
          </div>
        </div>

        {/* Draft restore banner */}
        {draftPrompt && (
          <div style={{
            background: `${COLORS.amber}15`,
            border: `1px solid ${COLORS.amber}40`,
            borderLeft: `4px solid ${COLORS.amber}`,
            padding: "12px 14px",
            marginBottom: "20px",
          }}>
            <div className="flex items-center justify-between gap-3 flex-wrap">
              <div className="flex items-center gap-2" style={{
                fontFamily: "'IBM Plex Sans', sans-serif",
                fontSize: "13px",
                color: COLORS.charcoal,
              }}>
                <RotateCcw size={14} style={{ color: COLORS.amber }} />
                Unsaved draft from {formatRelativeDate(draftPrompt.savedAt)} —
                <strong style={{ color: COLORS.amber }}>restore?</strong>
              </div>
              <div className="flex gap-2">
                <Button variant="outline" onClick={discardDraft} style={{ padding: "6px 10px", fontSize: "12px" }}>
                  Discard
                </Button>
                <Button variant="primary" onClick={restoreDraft} style={{ padding: "6px 10px", fontSize: "12px" }}>
                  Restore
                </Button>
              </div>
            </div>
          </div>
        )}

        {/* Validation errors */}
        {fieldErrors.length > 0 && (
          <div style={{
            background: `${COLORS.red}10`,
            border: `1px solid ${COLORS.red}40`,
            padding: "12px 14px",
            marginBottom: "20px",
            borderLeft: `4px solid ${COLORS.red}`,
          }}>
            <div style={{
              fontFamily: "'IBM Plex Sans', sans-serif",
              fontSize: "13px",
              fontWeight: 600,
              color: COLORS.red,
              marginBottom: "4px",
              display: "flex",
              alignItems: "center",
              gap: "6px",
            }}>
              <AlertCircle size={14} /> Please fix before saving:
            </div>
            <ul style={{
              margin: 0,
              paddingLeft: "22px",
              fontFamily: "'IBM Plex Sans', sans-serif",
              fontSize: "13px",
              color: COLORS.charcoal,
            }}>
              {fieldErrors.map((e, i) => <li key={i}>{e}</li>)}
            </ul>
          </div>
        )}

        {/* Quote header row */}
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 mb-6">
          <div>
            <Label>Date</Label>
            <Input type="date" value={lead.date} onChange={(e) => up("date", e.target.value)} />
          </div>
          <div>
            <Label>Quote Prepared By</Label>
            <Input
              value={lead.quotePreparedBy}
              onChange={(e) => up("quotePreparedBy", e.target.value)}
              placeholder="Staff member"
            />
          </div>
          <div>
            <Label>Quote No</Label>
            <Input
              value={lead.quoteNo}
              onChange={(e) => up("quoteNo", e.target.value)}
              placeholder="e.g. Q-2026-0142"
            />
          </div>
        </div>

        {/* Client Details */}
        <SectionHeader icon={User} title="Client Details" subtitle="Contact & property information" />
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mb-4">
          <div className="sm:col-span-2">
            <Label required>Client Name/s</Label>
            <Input
              value={lead.clientName}
              onChange={(e) => up("clientName", e.target.value)}
              placeholder="Full name(s)"
              invalid={clientNameInvalid}
            />
          </div>
          <div>
            <Label>Phone</Label>
            <Input value={lead.phone} onChange={(e) => up("phone", e.target.value)} />
          </div>
          <div>
            <Label>Mobile</Label>
            <Input value={lead.mobile} onChange={(e) => up("mobile", e.target.value)} />
          </div>
          <div className="sm:col-span-2">
            <Label>Email</Label>
            <Input
              type="email"
              value={lead.email}
              onChange={(e) => up("email", e.target.value)}
              invalid={emailInvalid}
            />
          </div>
          <div className="sm:col-span-2">
            <Label>Site Address</Label>
            <Input
              value={lead.siteAddress}
              onChange={(e) => up("siteAddress", e.target.value)}
              placeholder="Where the shed is being built"
            />
          </div>
          <div className="sm:col-span-2">
            <div className="flex items-center justify-between mb-1.5 flex-wrap gap-2">
              <Label className="mb-0">Postal Address</Label>
              <Checkbox
                checked={lead.postalAsAbove}
                onChange={(e) => up("postalAsAbove", e.target.checked)}
                label="Same as site address"
              />
            </div>
            <Input
              value={lead.postalAsAbove ? "" : lead.postalAddress}
              onChange={(e) => up("postalAddress", e.target.value)}
              disabled={lead.postalAsAbove}
              placeholder={lead.postalAsAbove ? "— same as site address —" : ""}
              style={lead.postalAsAbove ? { background: COLORS.offWhite } : {}}
            />
          </div>
          <div>
            <Label>Property Owner</Label>
            <div className="flex gap-4 pt-2">
              <Radio name="owner" checked={lead.propertyOwner === "Yes"} onChange={() => up("propertyOwner", "Yes")} label="Yes" />
              <Radio name="owner" checked={lead.propertyOwner === "No"}  onChange={() => up("propertyOwner", "No")}  label="No" />
            </div>
          </div>
          <div>
            <Label>Send Quote By</Label>
            <div className="flex gap-4 pt-2">
              <Radio name="send" checked={lead.sendQuoteBy === "Email"} onChange={() => up("sendQuoteBy", "Email")} label="Email" />
              <Radio name="send" checked={lead.sendQuoteBy === "Post"}  onChange={() => up("sendQuoteBy", "Post")}  label="Post" />
            </div>
          </div>
        </div>

        {/* Shed Details */}
        <div className="mt-10">
          <SectionHeader icon={Ruler} title="Shed Details" subtitle="Size, design, and purpose" />
          <div className="mb-4">
            <Label>Structure Type</Label>
            <Select value={lead.structureType} onChange={(e) => up("structureType", e.target.value)}>
              <option>Shed</option>
              <option>Carport</option>
              <option>Awning</option>
              <option>Shed & Awning</option>
              <option>Garage</option>
              <option>Workshop</option>
              <option>Barn</option>
              <option>Patio</option>
              <option>Commercial</option>
              <option>Other</option>
            </Select>
          </div>
          <div className="grid grid-cols-3 gap-3 mb-4">
            <div>
              <Label>Length</Label>
              <Input value={lead.length} onChange={(e) => up("length", e.target.value)} placeholder="12m" />
            </div>
            <div>
              <Label>Width</Label>
              <Input value={lead.width} onChange={(e) => up("width", e.target.value)} placeholder="7m" />
            </div>
            <div>
              <Label>Height</Label>
              <Input value={lead.height} onChange={(e) => up("height", e.target.value)} placeholder="3m" />
            </div>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mb-4">
            <div>
              <Label>Design (Roof Type)</Label>
              <div className="flex gap-4 pt-2 flex-wrap">
                <Radio name="design" checked={lead.design === "Gable Roof"}    onChange={() => up("design", "Gable Roof")}    label="Gable Roof" />
                <Radio name="design" checked={lead.design === "Skillion Roof"} onChange={() => up("design", "Skillion Roof")} label="Skillion Roof" />
              </div>
            </div>
            <div>
              <Label>Time Frame</Label>
              <Input
                value={lead.timeFrame}
                onChange={(e) => up("timeFrame", e.target.value)}
                placeholder="When do they want it completed?"
              />
            </div>
          </div>
          <div className="mb-4">
            <Label>Purpose</Label>
            <Textarea
              value={lead.purpose}
              onChange={(e) => up("purpose", e.target.value)}
              placeholder="What will they be using the shed/carport/awning for?"
            />
          </div>
          <div className="mb-4">
            <Label>How Did They Hear About Us?</Label>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3 mt-2">
              {MARKETING_SOURCES.map((src) => (
                <Radio
                  key={src}
                  name="marketing"
                  checked={lead.marketingSource === src}
                  onChange={() => up("marketingSource", src)}
                  label={src}
                />
              ))}
            </div>
            {lead.marketingSource === "Other" && (
              <Input
                value={lead.marketingOther}
                onChange={(e) => up("marketingOther", e.target.value)}
                placeholder="Please specify..."
                style={{ marginTop: "10px" }}
              />
            )}
          </div>
        </div>

        {/* Site Details */}
        <div className="mt-10">
          <SectionHeader icon={MapPin} title="Site Details" subtitle="Access, utilities, constraints" />
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mb-4">
            <div><Label>Access</Label><Input value={lead.access} onChange={(e) => up("access", e.target.value)} /></div>
            <div><Label>Level</Label><Input value={lead.level} onChange={(e) => up("level", e.target.value)} /></div>
            <div><Label>Power</Label><Input value={lead.power} onChange={(e) => up("power", e.target.value)} /></div>
            <div><Label>Water</Label><Input value={lead.water} onChange={(e) => up("water", e.target.value)} /></div>
            <div><Label>Sewer / Septic</Label><Input value={lead.sewerSeptic} onChange={(e) => up("sewerSeptic", e.target.value)} /></div>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mb-4">
            <div>
              <Label>Sheets — Roof</Label>
              <div className="flex gap-4 pt-2 flex-wrap">
                <Radio name="sheetsRoof" checked={lead.sheetsRoof === "Monoclad"}   onChange={() => up("sheetsRoof", "Monoclad")}   label="Monoclad" />
                <Radio name="sheetsRoof" checked={lead.sheetsRoof === "Corrugated"} onChange={() => up("sheetsRoof", "Corrugated")} label="Corrugated" />
              </div>
            </div>
            <div>
              <Label>Sheets — Walls</Label>
              <div className="flex gap-4 pt-2 flex-wrap">
                <Radio name="sheetsWalls" checked={lead.sheetsWalls === "Monoclad"}   onChange={() => up("sheetsWalls", "Monoclad")}   label="Monoclad" />
                <Radio name="sheetsWalls" checked={lead.sheetsWalls === "Corrugated"} onChange={() => up("sheetsWalls", "Corrugated")} label="Corrugated" />
              </div>
            </div>
          </div>
          <div className="mb-4">
            <Label>Site Hazards / Features</Label>
            <div className="flex flex-wrap gap-x-6 gap-y-2 pt-2">
              <Checkbox checked={lead.overheadPower} onChange={(e) => up("overheadPower", e.target.checked)} label="Overhead Power" />
              <Checkbox checked={lead.trees}         onChange={(e) => up("trees", e.target.checked)}         label="Trees" />
              <Checkbox checked={lead.stormwater}    onChange={(e) => up("stormwater", e.target.checked)}    label="Stormwater" />
            </div>
          </div>
          <div>
            <Label>Boundary Issues / Notes</Label>
            <Textarea value={lead.boundaryNotes} onChange={(e) => up("boundaryNotes", e.target.value)} />
          </div>
        </div>

        {/* Notes */}
        <div className="mt-10">
          <SectionHeader icon={FileText} title="Notes" />
          <Textarea
            value={lead.notes}
            onChange={(e) => up("notes", e.target.value)}
            placeholder="Additional info, appointment details, client requests..."
            style={{ minHeight: "120px" }}
          />
        </div>

        {/* Quote Type & Scope */}
        <div className="mt-10">
          <SectionHeader icon={Hammer} title="Quote Type & Scope" />
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 mb-4">
            <div>
              <Label>Quote Type</Label>
              <div className="flex flex-col gap-2 pt-2">
                <Checkbox checked={lead.fullBuildQuote} onChange={(e) => up("fullBuildQuote", e.target.checked)} label="Full Build Quote" />
                <Checkbox checked={lead.kitOnlyQuote}   onChange={(e) => up("kitOnlyQuote", e.target.checked)}   label="Kit Only Quote" />
              </div>
            </div>
            <div>
              <Label>Work Scope (select all that apply)</Label>
              <div className="grid grid-cols-2 gap-2 pt-2">
                {WORK_SCOPE.map((item) => (
                  <Checkbox
                    key={item}
                    checked={lead.workScope.includes(item)}
                    onChange={() => toggleWorkScope(item)}
                    label={item}
                  />
                ))}
              </div>
            </div>
          </div>
        </div>

        {/* Materials */}
        <div className="mt-10">
          <SectionHeader icon={Ruler} title="Materials & Specifications" subtitle="Add or remove items as required" />
          <div style={{ background: "#fff", border: `1px solid ${COLORS.border}`, overflowX: "auto" }}>
            <table style={{ width: "100%", minWidth: "520px", borderCollapse: "collapse" }}>
              <thead>
                <tr style={{ background: COLORS.charcoal }}>
                  {["Description", "Size", "Qty", "Colorbond / Zinc", ""].map((h, i) => (
                    <th key={i} style={{
                      padding: "10px 12px",
                      textAlign: "left",
                      fontFamily: "'Oswald', sans-serif",
                      fontSize: "11px",
                      fontWeight: 500,
                      letterSpacing: "0.1em",
                      textTransform: "uppercase",
                      color: "#fff",
                      width: i === 4 ? "40px" : i === 2 ? "70px" : i === 1 ? "140px" : "auto",
                    }}>
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {lead.materials.map((m, idx) => (
                  <tr key={m.id} style={{
                    borderBottom: `1px solid ${COLORS.border}`,
                    background: idx % 2 === 0 ? "#fff" : COLORS.paper,
                  }}>
                    <td style={{ padding: "6px 8px" }}>
                      <input
                        value={m.description}
                        onChange={(e) => updateMaterial(m.id, "description", e.target.value)}
                        style={{
                          width: "100%",
                          border: "none",
                          background: "transparent",
                          padding: "6px 4px",
                          fontSize: "14px",
                          fontFamily: "'IBM Plex Sans', sans-serif",
                          color: COLORS.charcoal,
                          outline: "none",
                        }}
                      />
                    </td>
                    <td style={{ padding: "6px 8px" }}>
                      <input
                        value={m.size}
                        onChange={(e) => updateMaterial(m.id, "size", e.target.value)}
                        placeholder="—"
                        style={{
                          width: "100%",
                          border: "none",
                          background: "transparent",
                          padding: "6px 4px",
                          fontSize: "13px",
                          fontFamily: "'IBM Plex Mono', monospace",
                          color: COLORS.charcoalLight,
                          outline: "none",
                        }}
                      />
                    </td>
                    <td style={{ padding: "6px 8px" }}>
                      <input
                        value={m.qty}
                        onChange={(e) => updateMaterial(m.id, "qty", e.target.value)}
                        placeholder="—"
                        style={{
                          width: "100%",
                          border: "none",
                          background: "transparent",
                          padding: "6px 4px",
                          fontSize: "14px",
                          textAlign: "center",
                          fontFamily: "'IBM Plex Sans', sans-serif",
                          color: COLORS.charcoal,
                          outline: "none",
                        }}
                      />
                    </td>
                    <td style={{ padding: "6px 8px" }}>
                      <select
                        value={m.material}
                        onChange={(e) => updateMaterial(m.id, "material", e.target.value)}
                        style={{
                          width: "100%",
                          border: "none",
                          background: "transparent",
                          padding: "6px 4px",
                          fontSize: "14px",
                          fontFamily: "'IBM Plex Sans', sans-serif",
                          color: COLORS.charcoal,
                          outline: "none",
                          cursor: "pointer",
                        }}
                      >
                        <option value="">—</option>
                        <option>Colorbond</option>
                        <option>Zinc</option>
                      </select>
                    </td>
                    <td style={{ padding: "6px 8px" }}>
                      <button
                        onClick={() => removeMaterial(m.id)}
                        title="Remove row"
                        style={{ background: "transparent", border: "none", cursor: "pointer", color: COLORS.steelLight, padding: "4px" }}
                      >
                        <X size={14} />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div style={{ padding: "10px 12px", background: "#fff", borderTop: `1px solid ${COLORS.border}` }}>
              <button
                onClick={addMaterial}
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: "6px",
                  background: "transparent",
                  border: `1px dashed ${COLORS.steelLight}`,
                  padding: "8px 14px",
                  fontSize: "12px",
                  fontFamily: "'IBM Plex Sans', sans-serif",
                  fontWeight: 600,
                  letterSpacing: "0.08em",
                  textTransform: "uppercase",
                  color: COLORS.steel,
                  cursor: "pointer",
                }}
              >
                <Plus size={14} /> Add Material Row
              </button>
            </div>
          </div>
        </div>

        {/* Status */}
        <div className="mt-10">
          <SectionHeader icon={CheckCircle2} title="Lead Status" />
          <div className="flex flex-wrap gap-x-6 gap-y-3">
            {["New", "Quoted", "Won", "Lost"].map((s) => (
              <Radio key={s} name="status" checked={lead.status === s} onChange={() => up("status", s)} label={s} />
            ))}
          </div>
        </div>

        {/* Drive Folder */}
        <div className="mt-10">
          <SectionHeader
            icon={Folder}
            title="Drive Folder"
            subtitle="Bridge to the client's Google Drive folder. Auto-populated by app from v4 onwards."
          />
          {driveUrlEditing ? (
            <div className="space-y-3">
              <Label>Drive Folder URL</Label>
              <Input
                type="url"
                value={driveUrlInput}
                onChange={(e) => setDriveUrlInput(e.target.value)}
                placeholder="https://drive.google.com/drive/folders/..."
                autoFocus
              />
              <div
                style={{
                  fontFamily: "'IBM Plex Sans', sans-serif",
                  fontSize: 12,
                  color: COLORS.steel,
                  lineHeight: 1.5,
                }}
              >
                Manual override — paste only a Google Drive <strong>folder</strong> URL. Leave blank to clear.
              </div>
              <div className="flex gap-2">
                <Button variant="primary" onClick={handleDriveUrlSave}>
                  <Save size={14} /> Save URL
                </Button>
                <Button variant="outline" onClick={handleDriveUrlCancel}>Cancel</Button>
              </div>
            </div>
          ) : (
            <div className="space-y-3">
              {lead.driveFolderUrl ? (
                <div className="flex items-center gap-2 flex-wrap">
                  <a
                    href={lead.driveFolderUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    style={{
                      fontFamily: "'IBM Plex Mono', monospace",
                      fontSize: 13,
                      color: COLORS.red,
                      textDecoration: "underline",
                      wordBreak: "break-all",
                      display: "inline-flex",
                      alignItems: "center",
                      gap: 6,
                    }}
                  >
                    <ExternalLink size={14} />
                    {lead.driveFolderUrl}
                  </a>
                </div>
              ) : (
                <div
                  style={{
                    fontFamily: "'IBM Plex Sans', sans-serif",
                    fontSize: 13,
                    color: COLORS.steel,
                    fontStyle: "italic",
                  }}
                >
                  Not yet created — will appear when a Drive folder is linked to this lead.
                </div>
              )}
              <div>
                <Button variant="ghost" onClick={handleDriveUrlEdit}>
                  <Edit3 size={14} /> {lead.driveFolderUrl ? "Edit manually" : "Enter manually"}
                </Button>
              </div>
            </div>
          )}
        </div>

        {/* Bottom save bar */}
        <div className="mt-12 flex justify-end gap-2 flex-wrap">
          <Button variant="outline" onClick={handleCancel}>Cancel</Button>
          <Button variant="primary" onClick={handleSave} disabled={saving}>
            {saving ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />}
            {saving ? "Saving…" : "Save Lead"}
          </Button>
        </div>
      </div>

      {exportView && (
        <ExportModal
          title={exportView.title}
          content={exportView.content}
          filename={exportView.filename}
          mimeType={exportView.mimeType}
          onClose={() => setExportView(null)}
          notify={notify}
        />
      )}
    </div>
  );
}

/* =====================================================================
   14. ROOT COMPONENT
   ===================================================================== */

export default function ShedBossEnquiryLead() {
  const [view, setView] = useState("dashboard");
  const [leads, setLeads] = useState([]);
  const [activeLead, setActiveLead] = useState(null);
  const [loading, setLoading] = useState(true);
  const [toast, setToast] = useState(null);
  const [exportAllView, setExportAllView] = useState(null);
  const [storageAvailable, setStorageAvailable] = useState(true);
  const [confirmState, setConfirmState] = useState(null);
  const [saving, setSaving] = useState(false);
  const [config, setConfig] = useState(null);
  const [showSettings, setShowSettings] = useState(false);
  const [syncingAll, setSyncingAll] = useState(false);

  const toastTimeoutRef = useRef(null);
  // Refs let async handlers see latest state without re-binding.
  const leadsRef = useRef(leads);
  const configRef = useRef(config);
  useEffect(() => { leadsRef.current = leads; }, [leads]);
  useEffect(() => { configRef.current = config; }, [config]);

  const notify = useCallback((msg, type = "info") => {
    const id = Date.now() + Math.random();
    setToast({ msg, type, id });
    if (toastTimeoutRef.current) clearTimeout(toastTimeoutRef.current);
    toastTimeoutRef.current = setTimeout(() => {
      setToast((t) => (t && t.id === id ? null : t));
    }, 2800);
  }, []);

  const requestConfirm = (cfg) => setConfirmState(cfg);
  const handleConfirm = () => {
    confirmState?.onConfirm?.();
    setConfirmState(null);
  };
  const handleCancelConfirm = () => {
    confirmState?.onCancel?.();
    setConfirmState(null);
  };

  /* Sync summary derived from leads. */
  const syncSummary = useMemo(() => {
    const sum = { total: leads.length, synced: 0, syncing: 0, error: 0, local: 0, errors: 0 };
    for (const l of leads) {
      const s = l.syncStatus || "local";
      sum[s] = (sum[s] || 0) + 1;
    }
    sum.errors = sum.error || 0;
    return sum;
  }, [leads]);

  /* --- Persistence helpers --- */
  const persistIndex = async (newLeads) => {
    const r = await safeSet(INDEX_KEY, JSON.stringify(newLeads.map((l) => l.id)));
    if (!r.ok) setStorageAvailable(false);
  };
  const persistLead = async (lead) => {
    const r = await safeSet(LEAD_KEY + lead.id, JSON.stringify(lead));
    if (!r.ok) setStorageAvailable(false);
    return r.ok;
  };

  /* --- Mount: load config → load local → optionally pull Airtable & merge --- */
  useEffect(() => {
    (async () => {
      // Config
      let loadedConfig = null;
      const cfgResult = await safeGet(CONFIG_KEY);
      if (cfgResult.ok && cfgResult.value) {
        try { loadedConfig = JSON.parse(cfgResult.value); }
        catch { console.warn("Corrupt config — ignoring"); }
      }
      setConfig(loadedConfig);

      // Local leads
      const idxResult = await safeGet(INDEX_KEY);
      if (!idxResult.ok) {
        setStorageAvailable(false);
        setLoading(false);
        return;
      }
      const ids = idxResult.value ? JSON.parse(idxResult.value) : [];
      const localLeads = [];
      for (const id of ids) {
        const r = await safeGet(LEAD_KEY + id);
        if (r.ok && r.value) {
          try { localLeads.push(normaliseLead(JSON.parse(r.value))); }
          catch {}
        }
      }

      // Pull remote and merge if configured
      if (isConfigured(loadedConfig)) {
        try {
          const records = await airtable.listRecords(loadedConfig);
          const remoteLeads = records.map(fromAirtable);
          const merged = mergeLocalAndRemote(localLeads, remoteLeads);
          setLeads(merged);
          await persistIndex(merged);
          for (const m of merged) await persistLead(m);
        } catch (e) {
          console.error("Initial Airtable load failed", e);
          setLeads(localLeads);
          notify(`Couldn't fetch from Airtable: ${friendlyAirtableError(e)}`, "error");
        }
      } else {
        setLeads(localLeads);
      }
      setLoading(false);
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /* --- Settings save / disconnect --- */
  const handleConfigSave = async (newConfig) => {
    const r = await safeSet(CONFIG_KEY, JSON.stringify(newConfig));
    if (!r.ok) {
      notify("Could not persist config to device storage", "error");
      return;
    }
    setConfig(newConfig);
    setShowSettings(false);
    notify("Connected to Airtable", "success");

    try {
      const records = await airtable.listRecords(newConfig);
      const remoteLeads = records.map(fromAirtable);
      const merged = mergeLocalAndRemote(leadsRef.current, remoteLeads);
      setLeads(merged);
      await persistIndex(merged);
      for (const m of merged) await persistLead(m);
      notify(`Merged ${remoteLeads.length} record${remoteLeads.length === 1 ? "" : "s"} from Airtable`, "success");
    } catch (e) {
      notify(`Initial fetch failed: ${friendlyAirtableError(e)}`, "error");
    }
  };

  const handleDisconnect = async () => {
    await safeDelete(CONFIG_KEY);
    setConfig(null);
    setShowSettings(false);
    const newLeads = leadsRef.current.map((l) =>
      l.syncStatus === "synced"
        ? { ...l, syncStatus: "local", syncError: null, lastSyncAt: null }
        : l
    );
    setLeads(newLeads);
    for (const l of newLeads) await persistLead(l);
    notify("Disconnected from Airtable. Leads remain on this device.", "info");
  };

  /* --- Airtable write helper --- */
  const writeToAirtable = async (lead, cfg) => {
    const fields = toAirtable(lead);
    const result = lead.airtableRecordId
      ? await airtable.updateRecord(cfg, lead.airtableRecordId, fields)
      : await airtable.createRecord(cfg, fields);
    return {
      ...lead,
      airtableRecordId: result.id || lead.airtableRecordId,
      syncStatus: "synced",
      syncError: null,
      lastSyncAt: new Date().toISOString(),
    };
  };

  /* --- Handlers --- */
  const handleNew = () => {
    setActiveLead(emptyLead());
    setView("form");
  };

  const handleOpen = (id) => {
    const l = leadsRef.current.find((x) => x.id === id);
    if (l) {
      setActiveLead(l);
      setView("form");
    }
  };

  const handleSaveLead = async (updated) => {
    setSaving(true);
    const existing = leadsRef.current.find((l) => l.id === updated.id);
    const cfg = configRef.current;
    const willSync = isConfigured(cfg);

    // Optimistic local write first.
    const optimistic = {
      ...updated,
      syncStatus: willSync ? "syncing" : "local",
      syncError: null,
    };
    const stateAfterOptimistic = existing
      ? leadsRef.current.map((l) => (l.id === optimistic.id ? optimistic : l))
      : [...leadsRef.current, optimistic];
    setLeads(stateAfterOptimistic);
    setActiveLead(optimistic);

    const localOk = await persistLead(optimistic);
    if (!existing) await persistIndex(stateAfterOptimistic);
    if (!localOk) notify("Saved in session only (device storage unavailable)", "warn");

    // Then Airtable.
    let finalLead = optimistic;
    if (willSync) {
      try {
        finalLead = await writeToAirtable(optimistic, cfg);
      } catch (e) {
        finalLead = { ...optimistic, syncStatus: "error", syncError: friendlyAirtableError(e) };
        notify(`Airtable sync failed: ${finalLead.syncError}`, "error");
      }
    }

    const finalState = leadsRef.current.map((l) => (l.id === finalLead.id ? finalLead : l));
    setLeads(finalState);
    setActiveLead(finalLead);
    await persistLead(finalLead);
    setSaving(false);

    if (finalLead.syncStatus === "synced") notify(existing ? "Saved & synced" : "Created & synced", "success");
    else if (finalLead.syncStatus === "local") notify(existing ? "Saved locally" : "Created locally", "success");
  };

  const handleDeleteLead = async (id) => {
    const lead = leadsRef.current.find((l) => l.id === id);
    const cfg = configRef.current;

    // Try Airtable first; if that fails, keep locally so user can retry.
    if (lead?.airtableRecordId && isConfigured(cfg)) {
      try {
        await airtable.deleteRecord(cfg, lead.airtableRecordId);
      } catch (e) {
        const msg = friendlyAirtableError(e);
        const newLeads = leadsRef.current.map((l) =>
          l.id === id ? { ...l, syncStatus: "error", syncError: `Delete failed: ${msg}` } : l
        );
        setLeads(newLeads);
        const updatedLead = newLeads.find((l) => l.id === id);
        if (updatedLead) await persistLead(updatedLead);
        notify(`Airtable delete failed: ${msg}. Lead kept locally — retry later.`, "error");
        return;
      }
    }

    const newLeads = leadsRef.current.filter((l) => l.id !== id);
    setLeads(newLeads);
    if (activeLead?.id === id) {
      setActiveLead(null);
      setView("dashboard");
    }
    await safeDelete(LEAD_KEY + id);
    await safeDelete(DRAFT_KEY + id);   // clean up any orphan draft
    await persistIndex(newLeads);
    notify("Lead deleted", "info");
  };

  const handleSyncAll = async () => {
    const cfg = configRef.current;
    if (!isConfigured(cfg)) { notify("Connect to Airtable first", "warn"); return; }
    const needsSync = leadsRef.current.filter(
      (l) => l.syncStatus === "error" || l.syncStatus === "local"
    );
    if (needsSync.length === 0) { notify("Nothing to sync", "info"); return; }

    setSyncingAll(true);
    notify(`Syncing ${needsSync.length} lead${needsSync.length === 1 ? "" : "s"}…`, "info");

    let okCount = 0;
    let failCount = 0;

    for (const lead of needsSync) {
      const working = { ...lead, syncStatus: "syncing", syncError: null };
      setLeads((prev) => prev.map((l) => (l.id === working.id ? working : l)));
      await persistLead(working);
      try {
        const synced = await writeToAirtable(working, cfg);
        setLeads((prev) => prev.map((l) => (l.id === synced.id ? synced : l)));
        await persistLead(synced);
        okCount += 1;
      } catch (e) {
        const errored = { ...working, syncStatus: "error", syncError: friendlyAirtableError(e) };
        setLeads((prev) => prev.map((l) => (l.id === errored.id ? errored : l)));
        await persistLead(errored);
        failCount += 1;
      }
    }

    setSyncingAll(false);
    notify(
      failCount === 0
        ? `Synced ${okCount} lead${okCount === 1 ? "" : "s"}`
        : `Synced ${okCount}, ${failCount} failed`,
      failCount === 0 ? "success" : "warn"
    );
  };

  const handleImport = async (imported) => {
    const newLeads = [...leadsRef.current];
    for (const lead of imported) {
      if (newLeads.some((l) => l.id === lead.id)) lead.id = newId();
      // Imports start as 'local'. Don't preserve airtableRecordId across bases.
      lead.airtableRecordId = null;
      lead.syncStatus = "local";
      lead.syncError = null;
      lead.lastSyncAt = null;
      newLeads.push(lead);
      await persistLead(lead);
    }
    setLeads(newLeads);
    await persistIndex(newLeads);
    if (imported.length === 1) {
      setActiveLead(imported[0]);
      setView("form");
    }
  };

  const handleExportAll = () => {
    if (leads.length === 0) {
      notify("No leads to export", "warn");
      return;
    }
    setExportAllView({
      title: `Export All Leads (${leads.length})`,
      content: JSON.stringify(leads, null, 2),
      filename: `shedboss-lead-enquiry-all-${new Date().toISOString().slice(0, 10)}.json`,
      mimeType: "application/json",
    });
  };

  if (loading) {
    return (
      <div style={{
        minHeight: "100vh",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: COLORS.paper,
        fontFamily: "'Oswald', sans-serif",
        color: COLORS.steel,
        letterSpacing: "0.2em",
        fontSize: "14px",
        textTransform: "uppercase",
        flexDirection: "column",
        gap: "16px",
      }}>
        <Loader2 size={28} className="animate-spin" style={{ color: COLORS.red }} />
        Loading…
      </div>
    );
  }

  return (
    <>
      <link
        rel="stylesheet"
        href="https://fonts.googleapis.com/css2?family=Oswald:wght@400;500;600;700&family=IBM+Plex+Sans:wght@400;500;600;700&family=IBM+Plex+Mono:wght@400;500&display=swap"
      />
      <div style={{ fontFamily: "'IBM Plex Sans', sans-serif" }}>
        {!storageAvailable && (
          <div style={{
            background: COLORS.amberBg,
            color: COLORS.amber,
            padding: "8px 16px",
            fontFamily: "'IBM Plex Sans', sans-serif",
            fontSize: "12px",
            textAlign: "center",
            borderBottom: "1px solid #FCD34D",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            gap: "6px",
          }}>
            <AlertTriangle size={14} /> Device storage unavailable — leads kept in this session only. Export regularly to back up.
          </div>
        )}

        {view === "dashboard" && (
          <Dashboard
            leads={leads}
            onNew={handleNew}
            onOpen={handleOpen}
            onDelete={handleDeleteLead}
            onExportAll={handleExportAll}
            onImport={handleImport}
            notify={notify}
            requestConfirm={requestConfirm}
            config={config}
            syncSummary={syncSummary}
            onOpenSettings={() => setShowSettings(true)}
            onSyncAll={handleSyncAll}
          />
        )}
        {view === "form" && activeLead && (
          <LeadForm
            initial={activeLead}
            onSave={handleSaveLead}
            onCancel={() => setView("dashboard")}
            onDelete={
              leads.some((l) => l.id === activeLead.id)
                ? () => handleDeleteLead(activeLead.id)
                : null
            }
            notify={notify}
            requestConfirm={requestConfirm}
            saving={saving || syncingAll}
          />
        )}

        {showSettings && (
          <SettingsModal
            initialConfig={config}
            onClose={() => setShowSettings(false)}
            onSave={handleConfigSave}
            onDisconnect={handleDisconnect}
            notify={notify}
          />
        )}

        {exportAllView && (
          <ExportModal
            title={exportAllView.title}
            content={exportAllView.content}
            filename={exportAllView.filename}
            mimeType={exportAllView.mimeType}
            onClose={() => setExportAllView(null)}
            notify={notify}
          />
        )}

        {confirmState && (
          <ConfirmModal
            title={confirmState.title}
            message={confirmState.message}
            confirmLabel={confirmState.confirmLabel}
            cancelLabel={confirmState.cancelLabel}
            destructive={confirmState.destructive}
            onConfirm={handleConfirm}
            onCancel={handleCancelConfirm}
          />
        )}

        <Toast toast={toast} />
      </div>
    </>
  );
}
