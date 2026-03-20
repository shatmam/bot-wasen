require("dotenv").config();
const express = require("express");
const { google } = require("googleapis");
const cors = require("cors");

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static("public"));

const PORT = process.env.PORT || 3000;

// 🔑 Google Auth
const auth = new google.auth.GoogleAuth({
  credentials: JSON.parse(process.env.GOOGLE_CREDENTIALS),
  scopes: ["https://www.googleapis.com/auth/spreadsheets"],
});

const sheets = google.sheets({ version: "v4", auth });
const SPREADSHEET_ID = process.env.SPREADSHEET_ID;

// 📥 Obtener clientes
app.get("/clientes", async (req, res) => {
  try {
    const response = await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
      range: "Hoja1!A2:G",
    });

    const rows = response.data.values || [];

    const clientes = rows.map((row, i) => ({
      id: i,
      correo: row[0],
      whatsapp: row[1],
      revendedor: row[2],
      fecha_inicio: row[3],
      fecha_fin: row[4],
      dias: parseInt(row[5]) || 0,
      ganancia: parseFloat(row[6]) || 0,
    }));

    res.json(clientes);
  } catch (error) {
    console.log(error);
    res.status(500).send("Error leyendo datos");
  }
});

// 🔄 Renovar (sumar días a fecha_fin)
app.post("/renovar", async (req, res) => {
  try {
    const { id, diasExtra } = req.body;

    const response = await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
      range: "Hoja1!A2:G",
    });

    const rows = response.data.values;

    let fechaFin = new Date(rows[id][4]);
    fechaFin.setDate(fechaFin.getDate() + diasExtra);

    const nuevaFecha = fechaFin.toISOString().split("T")[0];

    await sheets.spreadsheets.values.update({
      spreadsheetId: SPREADSHEET_ID,
      range: `Hoja1!E${id + 2}`,
      valueInputOption: "RAW",
      requestBody: {
        values: [[nuevaFecha]],
      },
    });

    res.send("Renovado correctamente");
  } catch (error) {
    console.log(error);
    res.status(500).send("Error al renovar");
  }
});

app.listen(PORT, () => {
  console.log("Servidor corriendo en puerto " + PORT);
});
