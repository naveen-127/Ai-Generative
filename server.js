const express = require("express");
const axios = require("axios");
const cors = require("cors");
const { MongoClient, ObjectId } = require("mongodb");
const path = require("path");
require("dotenv").config();

const app = express();
const PORT = process.env.PORT || 3000;

// ✅ CORS configuration
const allowedOrigins = [
  "https://majestic-frangollo-031fed.netlify.app",
  "https://classy-kulfi-cddfef.netlify.app",
  "http://localhost:5173",
  "http://localhost:5174",
  "https://padmasini7-frontend.netlify.app",
  "https://ai-generative-rhk1.onrender.com",
  "https://ai-generative-1.onrender.com"
];

app.use(cors({
  origin: function (origin, callback) {
    if (!origin) return callback(null, true);
    if (allowedOrigins.indexOf(origin) === -1) return callback(new Error('CORS policy violation'), false);
    return callback(null, true);
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With']
}));

app.options('*', cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));
app.use(express.static(path.join(__dirname, "public")));

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

// ✅ MongoDB connection
const MONGO_URI = process.env.MONGO_URI;
if (!MONGO_URI) {
  console.error("❌ Missing MONGO_URI in .env");
  process.exit(1);
}

const client = new MongoClient(MONGO_URI);

async function connectDB() {
  try {
    await client.connect();
    console.log("✅ Connected to MongoDB");
  } catch (err) {
    console.error("❌ MongoDB connection error:", err);
    process.exit(1);
  }
}

connectDB();

// ✅ Helper to get DB
function getDB(dbname = "professional") {
  return client.db(dbname);
}

// ✅ D-ID API key
if (!process.env.DID_API_KEY) {
  console.error("❌ Missing DID_API_KEY in .env");
  process.exit(1);
}
const DID_API_KEY = `Basic ${Buffer.from(process.env.DID_API_KEY).toString("base64")}`;

// ✅ Generate AI video
app.post("/generate-and-upload", async (req, res) => {
  try {
    const { subtopic, description } = req.body;
    if (!subtopic || !description || description.trim().length < 3) {
      return res.status(400).json({ error: "Description must be at least 3 characters." });
    }

    console.log("🎬 Generating AI video for:", subtopic);

    const didResponse = await axios.post(
      "https://api.d-id.com/talks",
      { script: { type: "text", input: description, subtitles: "false" }, presenter_id: "amy-jcwqj4g" },
      { headers: { Authorization: DID_API_KEY, "Content-Type": "application/json" }, timeout: 120000 }
    );

    const talkId = didResponse.data.id;
    let status = "notDone";
    let videoUrl = "";
    const startTime = Date.now();
    const maxWaitTime = 10 * 60 * 1000;

    while (status !== "done" && (Date.now() - startTime) < maxWaitTime) {
      const poll = await axios.get(`https://api.d-id.com/talks/${talkId}`, { headers: { Authorization: DID_API_KEY }, timeout: 30000 });
      status = poll.data.status;
      if (status === "done") { videoUrl = poll.data.result_url; break; }
      else if (status === "failed") throw new Error("D-ID video generation failed");
      await new Promise(r => setTimeout(r, 3000));
    }

    if (status !== "done") throw new Error("Video generation timeout");

    res.json({ firebase_video_url: videoUrl, message: "AI video generated successfully" });
  } catch (err) {
    console.error("❌ D-ID API Error:", err.response?.data || err.message || err);
    res.status(500).json({ error: err.response?.data?.details || err.response?.data?.error || err.message || "Video generation failed" });
  }
});

// ✅ Recursive update helper for nested units
function updateNestedUnit(units, subtopicId, aiVideoUrl) {
  if (!units || units.length === 0) return false;
  for (const unit of units) {
    if (unit._id === subtopicId || unit.id === subtopicId) {
      unit.aiVideoUrl = aiVideoUrl;
      unit.updatedAt = new Date();
      return true;
    }
    if (unit.units && unit.units.length > 0) {
      if (updateNestedUnit(unit.units, subtopicId, aiVideoUrl)) return true;
    }
  }
  return false;
}

// ✅ Update Subtopic AI Video URL
app.put("/api/updateSubtopicVideo", async (req, res) => {
  try {
    const { subtopicId, aiVideoUrl, dbname = "professional", subjectName } = req.body;
    if (!subtopicId || !aiVideoUrl) return res.status(400).json({ error: "Missing subtopicId or aiVideoUrl" });

    const dbConn = getDB(dbname);
    const targetCollections = subjectName ? [subjectName] : await dbConn.listCollections().toArray().then(cols => cols.map(c => c.name));

    let updated = false, updatedCollection = null;

    for (const collectionName of targetCollections) {
      const collection = dbConn.collection(collectionName);
      const docs = await collection.find({}).toArray();

      for (const doc of docs) {
        // Update main document
        if (doc._id.toString() === subtopicId || doc.id === subtopicId) {
          doc.aiVideoUrl = aiVideoUrl;
          doc.updatedAt = new Date();
          await collection.replaceOne({ _id: doc._id }, doc);
          updated = true;
          updatedCollection = collectionName;
          break;
        }

        // Update nested units recursively
        if (doc.units && doc.units.length > 0) {
          if (updateNestedUnit(doc.units, subtopicId, aiVideoUrl)) {
            await collection.replaceOne({ _id: doc._id }, doc);
            updated = true;
            updatedCollection = collectionName;
            break;
          }
        }
      }
      if (updated) break;
    }

    if (!updated) {
      return res.status(404).json({ error: "Subtopic not found in any collection", subtopicId });
    }

    res.json({ status: "ok", message: "AI video URL updated successfully", collection: updatedCollection });
  } catch (err) {
    console.error("❌ Error updating subtopic:", err);
    res.status(500).json({ error: "Failed to update subtopic: " + err.message });
  }
});

// ✅ Debug endpoint
app.get("/api/debug-subtopic/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const { dbname = "professional", subjectName } = req.query;
    const dbConn = getDB(dbname);
    const collections = subjectName ? [subjectName] : await dbConn.listCollections().toArray().then(cols => cols.map(c => c.name));

    let found = false, result = {};

    for (const collectionName of collections) {
      const collection = dbConn.collection(collectionName);
      const doc = await collection.findOne({ "units._id": id }) || await collection.findOne({ "units.id": id }) || await collection.findOne({ _id: new ObjectId(id) }).catch(()=>null) || await collection.findOne({ _id: id });
      if (doc) { found = true; result = { collection: collectionName, document: doc }; break; }
    }

    res.json({ found, subtopicId: id, result });
  } catch (err) {
    console.error("❌ Debug error:", err);
    res.status(500).json({ error: err.message });
  }
});

// ✅ Health check
app.get("/health", (req, res) => res.json({ status: "OK", service: "Node.js AI Video Backend", timestamp: new Date().toISOString() }));

app.listen(PORT, "0.0.0.0", () => {
  console.log(`✅ Node.js Server running on http://0.0.0.0:${PORT}`);
  console.log(`✅ Spring Boot MongoDB structure supported`);
});
