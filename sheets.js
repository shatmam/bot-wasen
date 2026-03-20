const fs = require("fs");
const { google } = require("googleapis");

const SHEET_ID = process.env.SHEET_ID;
const TAB = process.env.SHEET_TAB || "Clientes";
const CREDENTIALS_PATH = process.env.CREDENTIALS_PATH || "./credentials.json";

// Si quieres forzar idioma de fórmula:
// SHEETS_LOCALE=es  (SI/HOY/ESBLANCO)
// SHEETS_LOCALE=en  (IF/TODAY/ISBLANK)
const FORCED_LOCALE = (process.env.SHEETS_LOCALE || "").toLowerCase().trim();

function norm(s) {
  return String(s ?? "")
    .toLowerCase()
    .trim()
    .replace(/\s+/g, " ")
    .replace(/[áàä]/g, "a")
    .replace(/[éèë]/g, "e")
    .replace(/[íìï]/g, "i")
    .replace(/[óòö]/g, "o")
    .replace(/[úùü]/g, "u");
}

function requireEnv() {
  if (!SHEET_ID) throw new Error("Falta SHEET_ID en las variables de entorno");
  
  // Modificado para Railway: Verifica variable O archivo
  if (!process.env.GOOGLE_CREDS_JSON && !fs.existsSync(CREDENTIALS_PATH)) {
    throw new Error(`No se encontró GOOGLE_CREDS_JSON ni el archivo ${CREDENTIALS_PATH}`);
  }
}

async function getClient() {
  requireEnv();
  
  let creds;
  // Prioridad Railway (Variable de entorno)
  if (process.env.GOOGLE_CREDS_JSON) {
    creds = JSON.parse(process.env.GOOGLE_CREDS_JSON);
  } 
  // Prioridad Local (Archivo credentials.json)
  else {
    creds = JSON.parse(fs.readFileSync(CREDENTIALS_PATH, "utf-8"));
  }

  const auth = new google.auth.GoogleAuth({
    credentials: creds,
    scopes: ["https://www.googleapis.com/auth/spreadsheets"]
  });
  
  return google.sheets({ version: "v4", auth });
}

function findHeaderRow(values) {
  const limit = Math.min(values.length, 120);
  for (let r = 0; r < limit; r++) {
    const row = (values[r] || []).map(norm);
    if (row.includes("nombre") && row.includes("telefono") && row.includes("servicio")) return r;
  }
  return -1;
}

function headerMap(headerRow) {
  const map = {};
  (headerRow || []).forEach((h, i) => {
    const k = norm(h);
    if (k) map[k] = i;
  });
  return map;
}

function colLetter(n) {
  let s = "";
  while (n > 0) {
    const m = (n - 1) % 26;
    s = String.fromCharCode(65 + m) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

function cellRef(colIdx, row) {
  return `${colLetter(colIdx)}${row}`;
}

// ✅ si está vacío => NaN (para que NO cuente como 0)
function parseDias(x) {
  const t = String(x ?? "").trim();
  if (!t) return NaN;
  const n = Number(t.replace(",", "."));
  return Number.isFinite(n) ? n : NaN;
}

// ✅ vencidos SOLO si días <= 0 Y ES número
function bucketByDias(d) {
  if (Number.isFinite(d) && d <= 0) return "vencidos";
  if (Number.isFinite(d) && d >= 1 && d <= 3) return "porvencer";
  return "activos";
}

function toISODateOnly(d) {
  return d.toISOString().slice(0, 10);
}

function today0() {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
}

function isDisponible(row) {
  return norm(row.nombre || "") === "disponible";
}

function parseDateFlexible(val) {
  if (val == null) return null;
  const s = String(val).trim();
  if (!s) return null;

  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (m) {
    const y = Number(m[1]), mo = Number(m[2]), d = Number(m[3]);
    const dt = new Date(y, mo - 1, d);
    if (!Number.isNaN(dt.getTime())) return dt;
  }

  m = s.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})$/);
  if (m) {
    const d = Number(m[1]), mo = Number(m[2]), y = Number(m[3]);
    const dt = new Date(y, mo - 1, d);
    if (!Number.isNaN(dt.getTime())) return dt;
  }

  const dt2 = new Date(s);
  if (!Number.isNaN(dt2.getTime())) return dt2;

  return null;
}

function detectLocaleFormula(headerRow) {
  if (FORCED_LOCALE === "en" || FORCED_LOCALE === "es") return FORCED_LOCALE;

  const h = (headerRow || []).map(x => String(x || "").toLowerCase()).join(" ");
  if (h.includes("fecha") || h.includes("días") || h.includes("contraseña")) return "es";
  return "es";
}

function diasFormula({ locale, venceCell }) {
  if (locale === "en") return `=IF(ISBLANK(${venceCell}),"",${venceCell}-TODAY())`;
  return `=SI(ESBLANCO(${venceCell});"";${venceCell}-HOY())`;
}

function mapCol(map, name) {
  const i = map[norm(name)];
  return (i == null) ? null : (i + 1);
}

function buildUpdatesForRow(map, rowNumber, fieldsObj) {
  const updates = [];
  for (const [headerName, value] of Object.entries(fieldsObj)) {
    const colIdx = mapCol(map, headerName);
    if (!colIdx) continue;
    updates.push({
      range: `${TAB}!${colLetter(colIdx)}${rowNumber}`,
      values: [[value]]
    });
  }
  return updates;
}

async function batchUpdate(updates) {
  const sheets = await getClient();
  await sheets.spreadsheets.values.batchUpdate({
    spreadsheetId: SHEET_ID,
    requestBody: { valueInputOption: "USER_ENTERED", data: updates }
  });
}

// ✅ NO compactar filas
async function readAll() {
  const sheets = await getClient();
  const range = `${TAB}!A:Z`;
  const resp = await sheets.spreadsheets.values.get({ spreadsheetId: SHEET_ID, range });

  const values = resp.data.values || [];
  if (!values.length) return { headerRowIndex: -1, header: [], map: {}, rows: [] };

  const headerRowIndex = findHeaderRow(values);
  if (headerRowIndex === -1) {
    throw new Error('No encuentro headers ("nombre", "telefono", "servicio") en las primeras filas.');
  }

  const header = values[headerRowIndex] || [];
  const map = headerMap(header);

  const idx = (name) => (map[norm(name)] ?? -1);
  const get = (row, name) => {
    const i = idx(name);
    return i >= 0 ? (row[i] ?? "") : "";
  };

  const rows = [];
  const rawData = values.slice(headerRowIndex + 1);

  rawData.forEach((r, i) => {
    const rowNumber = (headerRowIndex + 2) + i;

    const hasAny = (r || []).some(c => String(c ?? "").trim() !== "");
    if (!hasAny) return;

    const codigo = (r && r[0]) ? r[0] : "";
    const diasVal = get(r, "dias restantes");
    const d = parseDias(diasVal);
    const bucket = bucketByDias(d);

    rows.push({
      row: rowNumber,
      codigo,
      nombre: get(r, "nombre"),
      telefono: get(r, "telefono") || get(r, "teléfono"),
      servicio: get(r, "servicio"),
      correo: get(r, "correo"),
      contrasena: get(r, "contraseña") || get(r, "contrasena"),
      perfil: get(r, "perfil"),
      pin: get(r, "pin"),
      inicio: get(r, "fecha de inicio"),
      vencimiento: get(r, "fecha de vencimiento"),
      dias: diasVal,
      estado: get(r, "estado"),
      diasNum: d,
      bucket
    });
  });

  return { headerRowIndex, header, map, rows };
}

async function getDashboard() {
  const { rows } = await readAll();

  const counts = { vencidos: 0, porvencer: 0, activos: 0, total: rows.length };
  rows.forEach(r => counts[r.bucket]++);

  const availableByService = {};
  const availableByServiceProfile = {};
  let availableTotal = 0;

  rows.forEach(r => {
    if (isDisponible(r)) {
      availableTotal++;
      const svc = String(r.servicio || "OTROS").trim() || "OTROS";
      availableByService[svc] = (availableByService[svc] || 0) + 1;

      const p = String(r.perfil || "").trim() || "—";
      availableByServiceProfile[svc] = availableByServiceProfile[svc] || {};
      availableByServiceProfile[svc][p] = (availableByServiceProfile[svc][p] || 0) + 1;
    }
  });

  const order = { vencidos: 0, porvencer: 1, activos: 2 };
  rows.sort((a, b) => {
    if (order[a.bucket] !== order[b.bucket]) return order[a.bucket] - order[b.bucket];
    const da = Number.isFinite(a.diasNum) ? a.diasNum : 999999;
    const db = Number.isFinite(b.diasNum) ? b.diasNum : 999999;
    return da - db;
  });

  return { counts, rows, availableByService, availableByServiceProfile, availableTotal };
}

async function renovarFila(rowNumber, diasExtra) {
  const sheets = await getClient();
  const { map, header } = await readAll();
  const locale = detectLocaleFormula(header);

  const colVenceIdx = mapCol(map, "fecha de vencimiento");
  const colDiasIdx = mapCol(map, "dias restantes");
  if (!colVenceIdx) throw new Error('No existe columna "Fecha de vencimiento"');
  if (!colDiasIdx) throw new Error('No existe columna "Días restantes"');

  const colVence = colLetter(colVenceIdx);
  const colDias = colLetter(colDiasIdx);

  const getResp = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: `${TAB}!${colVence}${rowNumber}`
  });

  const raw = (getResp.data.values?.[0]?.[0]) ?? "";
  const base = parseDateFlexible(raw) || today0();
  const nueva = new Date(base.getTime() + Number(diasExtra) * 86400000);

  await sheets.spreadsheets.values.update({
    spreadsheetId: SHEET_ID,
    range: `${TAB}!${colVence}${rowNumber}`,
    valueInputOption: "USER_ENTERED",
    requestBody: { values: [[toISODateOnly(nueva)]] }
  });

  const venceCell = `${colVence}${rowNumber}`;
  const formula = diasFormula({ locale, venceCell });

  await sheets.spreadsheets.values.update({
    spreadsheetId: SHEET_ID,
    range: `${TAB}!${colDias}${rowNumber}`,
    valueInputOption: "USER_ENTERED",
    requestBody: { values: [[formula]] }
  });

  return { row: rowNumber, nuevaFecha: toISODateOnly(nueva) };
}

async function updateFila(rowNumber, fields) {
  const { map } = await readAll();

  const allowed = {
    nombre: ["nombre"],
    telefono: ["telefono", "teléfono"],
    servicio: ["servicio"],
    estado: ["estado"],
    correo: ["correo"],
    contrasena: ["contraseña", "contrasena"],
    perfil: ["perfil"],
    pin: ["pin"]
  };

  const updates = [];
  for (const [k, v] of Object.entries(fields)) {
    const headers = allowed[k];
    if (!headers) continue;

    for (const h of headers) {
      const colIdx = mapCol(map, h);
      if (!colIdx) continue;

      updates.push({
        range: `${TAB}!${colLetter(colIdx)}${rowNumber}`,
        values: [[v]]
      });
      break;
    }
  }

  if (!updates.length) return { updated: 0 };
  await batchUpdate(updates);
  return { updated: updates.length };
}

async function asignarEnFila({ rowNumber, nombre, telefono, dias = 30 }) {
  const { rows, map, header } = await readAll();
  const locale = detectLocaleFormula(header);

  const r = rows.find(x => Number(x.row) === Number(rowNumber));
  if (!r) throw new Error("No encuentro esa fila.");
  if (!isDisponible(r)) throw new Error("Esa cuenta no está disponible (Nombre debe ser 'Disponible').");

  const hoy = today0();
  const vence = new Date(hoy.getTime() + Number(dias) * 86400000);

  const colVenceIdx = mapCol(map, "fecha de vencimiento");
  if (!colVenceIdx) throw new Error('No existe columna "Fecha de vencimiento"');

  const venceCell = cellRef(colVenceIdx, r.row);
  const formulaDias = diasFormula({ locale, venceCell });

  const updates = buildUpdatesForRow(map, r.row, {
    "Nombre": nombre,
    "Telefono": telefono,
    "Teléfono": telefono,
    "Estado": "ACTIVO",
    "Fecha de inicio": toISODateOnly(hoy),
    "Fecha de vencimiento": toISODateOnly(vence),
    "Días restantes": formulaDias
  });

  await batchUpdate(updates);

  return {
    row: r.row,
    servicio: r.servicio,
    nombre,
    telefono,
    correo: r.correo,
    contrasena: r.contrasena,
    perfil: r.perfil,
    pin: r.pin,
    vence: toISODateOnly(vence)
  };
}

async function eliminarCliente(rowNumber) {
  const { map } = await readAll();

  const updates = buildUpdatesForRow(map, rowNumber, {
    "Nombre": "Disponible",
    "Telefono": "",
    "Teléfono": "",
    "Estado": "",
    "Fecha de inicio": "",
    "Fecha de vencimiento": "",
    "Días restantes": ""
  });

  await batchUpdate(updates);
  return { row: rowNumber, ok: true };
}

async function reasignarCuenta({ fromRow, toRow }) {
  const { rows, map } = await readAll();

  const src = rows.find(r => Number(r.row) === Number(fromRow));
  if (!src) throw new Error("No encuentro el cliente origen.");
  if (isDisponible(src)) throw new Error("El origen está en 'Disponible'.");

  const dest = rows.find(r => Number(r.row) === Number(toRow));
  if (!dest) throw new Error("No encuentro el destino.");
  if (!isDisponible(dest)) throw new Error("El destino no está en 'Disponible'.");
  if (norm(dest.servicio) !== norm(src.servicio)) throw new Error("El destino no es del mismo servicio.");

  const updatesDest = buildUpdatesForRow(map, dest.row, {
    "Nombre": src.nombre,
    "Telefono": src.telefono || "",
    "Teléfono": src.telefono || "",
    "Estado": src.estado || "ACTIVO",
    "Fecha de inicio": src.inicio || "",
    "Fecha de vencimiento": src.vencimiento || "",
    "Días restantes": src.dias || ""
  });

  const updatesSrc = buildUpdatesForRow(map, src.row, {
    "Nombre": "Disponible",
    "Telefono": "",
    "Teléfono": "",
    "Estado": "",
    "Fecha de inicio": "",
    "Fecha de vencimiento": "",
    "Días restantes": ""
  });

  await batchUpdate([...updatesDest, ...updatesSrc]);

  return {
    ok: true,
    fromRow: src.row,
    toRow: dest.row,
    servicio: dest.servicio,
    correo: dest.correo,
    contrasena: dest.contrasena,
    perfil: dest.perfil,
    pin: dest.pin,
    vence: src.vencimiento || ""
  };
}

module.exports = {
  getDashboard,
  renovarFila,
  updateFila,
  asignarEnFila,
  eliminarCliente,
  reasignarCuenta
};
