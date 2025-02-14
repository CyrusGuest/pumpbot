const cors = require("cors");
const express = require("express");
const morgan = require("morgan"); // Logging middleware
const wallets = require("./routes/wallets.js");
const tokens = require("./routes/tokens.js");
const auth = require("./routes/auth.js");
const { json } = require("body-parser");

const app = express();
app.use(
  cors({
    origin: "*",
    methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
    credentials: false,
  })
);

app.options("*", cors());
app.use(json());
app.use(morgan("dev"));
app.use("/wallets", wallets);
app.use("/tokens", tokens);
app.use("/auth", auth);

// ------------------------------------
// Start Server
// ------------------------------------
const PORT = process.env.PORT || 5050;
app.listen(PORT, () =>
  console.log(`Server running on http://localhost:${PORT}`)
);
