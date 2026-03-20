require("dotenv").config();
const express = require("express");
const cors = require("cors");

const {
  getDashboard,
  renovarFila
} = require("./sheets");

const app = express();

app.use(cors());
app.use(express.json());
app.use(express.static("public"));

const PORT = process.env.PORT || 3000;

// 🔥 TEST
app.get("/", (req, res) => {
  res.send("SERVER FUNCIONANDO 🔥");
});

// 📊 DASHBOARD (LEE TODO)
app.get("/clientes", async (req, res) => {
  try {
    const data = await getDashboard();
    res.json(data.rows);
  } catch (err) {
    console.log("ERROR:", err.message);
    res.status(500).send(err.message);
  }
});

// 🔄 RENOVAR
app.post("/renovar", async (req, res) => {
  try {
    const { row, dias } = req.body;

    const result = await renovarFila(row, dias);

    res.json(result);
  } catch (err) {
    console.log("ERROR:", err.message);
    res.status(500).send(err.message);
  }
});

app.listen(PORT, () => {
  console.log("Servidor corriendo en puerto " + PORT);
});
