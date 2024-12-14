// Required dependencies
const express = require("express");
const http = require("http");
const WebSocket = require("ws");
const cors = require("cors");
const { OpenAI } = require("openai");
const speech = require("@google-cloud/speech");
const multer = require("multer");
const { createClient } = require("@supabase/supabase-js");
const { PrismaClient } = require("@prisma/client");
const jwt = require("jsonwebtoken");

// Initialize Express app
const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static("public"));

// Initialize clients
const prisma = new PrismaClient();
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY,
);

const speechClient = new speech.SpeechClient({
  keyFilename: "path-to-your-google-credentials.json",
});

// JWT Configuration
const JWT_SECRET = process.env.JWT_SECRET;

// Authentication Middleware
const authenticateToken = (req, res, next) => {
  const authHeader = req.headers["authorization"];
  const token = authHeader && authHeader.split(" ")[1];

  if (!token) {
    return res.status(401).json({ error: "Authentication required" });
  }

  jwt.verify(token, JWT_SECRET, (err, user) => {
    if (err) {
      return res.status(403).json({ error: "Invalid token" });
    }
    req.user = user;
    next();
  });
};

// Authentication Routes
app.post("/api/auth/signup", async (req, res) => {
  try {
    const { email, password } = req.body;

    // Create user in Supabase
    const { data: authData, error: authError } = await supabase.auth.signUp({
      email,
      password,
    });

    if (authError) throw authError;

    // Create user in Prisma database
    const user = await prisma.user.create({
      data: {
        email,
        supabaseId: authData.user.id,
      },
    });

    const token = jwt.sign({ userId: user.id }, JWT_SECRET);
    res.status(201).json({ token, user });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.post("/api/auth/login", async (req, res) => {
  try {
    const { email, password } = req.body;

    // Authenticate with Supabase
    const { data: authData, error: authError } =
      await supabase.auth.signInWithPassword({
        email,
        password,
      });

    if (authError) throw authError;

    // Get user from Prisma
    const user = await prisma.user.findUnique({
      where: { email },
    });

    const token = jwt.sign({ userId: user.id }, JWT_SECRET);
    res.json({ token, user });
  } catch (error) {
    res.status(401).json({ error: "Authentication failed" });
  }
});

// Chatbot class with user authentication
class Chatbot {
  constructor() {
    this.conversations = new Map();
  }

  async processMessage(userId, message, type = "text") {
    try {
      // Verify user exists in database
      const user = await prisma.user.findUnique({
        where: { id: userId },
      });

      if (!user) {
        throw new Error("User not found");
      }

      let textContent = message;

      if (type === "voice") {
        textContent = await this.convertVoiceToText(message);
      }

      const history = this.conversations.get(userId) || [];
      const response = await this.generateAIResponse(textContent, history);

      // Store conversation in database
      await prisma.conversation.create({
        data: {
          userId,
          message: textContent,
          response,
          timestamp: new Date(),
        },
      });

      history.push({ role: "user", content: textContent });
      history.push({ role: "assistant", content: response });
      this.conversations.set(userId, history.slice(-10));

      return this.enhanceResponse(response);
    } catch (error) {
      console.error("Error processing message:", error);
      return { error: "Failed to process message" };
    }
  }

  // ... [previous convertVoiceToText and enhanceResponse methods remain the same]
}

// Initialize chatbot
const chatbot = new Chatbot();

// Protected WebSocket connection handling
wss.on("connection", (ws, req) => {
  console.log("New client connected");

  // Extract token from query string
  const url = new URL(req.url, "ws://localhost");
  const token = url.searchParams.get("token");

  let userId;
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    userId = decoded.userId;
  } catch (error) {
    ws.close(1008, "Invalid token");
    return;
  }

  ws.on("message", async (message) => {
    try {
      const data = JSON.parse(message);
      const response = await chatbot.processMessage(
        userId,
        data.content,
        data.type,
      );
      ws.send(JSON.stringify(response));
    } catch (error) {
      console.error("WebSocket message error:", error);
      ws.send(JSON.stringify({ error: "Message processing failed" }));
    }
  });

  ws.on("close", () => {
    console.log("Client disconnected");
  });
});

// Protected API Routes
app.get("/api/patients/:id", authenticateToken, async (req, res) => {
  try {
    const patient = await prisma.patient.findUnique({
      where: { id: parseInt(req.params.id) },
    });
    if (!patient) throw new Error("Patient not found");
    res.json(patient);
  } catch (error) {
    res.status(404).json({ error: error.message });
  }
});

app.post("/api/patients", authenticateToken, async (req, res) => {
  try {
    const patient = await prisma.patient.create({
      data: {
        ...req.body,
        userId: req.user.userId,
      },
    });
    res.status(201).json({ success: true, patient });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

// Voice upload handling with authentication
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
});

app.post(
  "/api/voice",
  authenticateToken,
  upload.single("audio"),
  async (req, res) => {
    try {
      if (!req.file) throw new Error("No audio file provided");
      const text = await chatbot.convertVoiceToText(req.file.buffer);
      res.json({ text });
    } catch (error) {
      res.status(400).json({ error: error.message });
    }
  },
);

// Start server
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
