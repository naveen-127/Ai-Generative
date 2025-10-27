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
    if (allowedOrigins.indexOf(origin) === -1) {
      return callback(new Error('CORS policy violation'), false);
    }
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

// ✅ Helper function to get database connection
function getDB(dbname = "professional") {
  return client.db(dbname);
}

// ✅ D-ID API key
if (!process.env.DID_API_KEY) {
  console.error("❌ Missing DID_API_KEY in .env");
  process.exit(1);
}
const DID_API_KEY = `Basic ${Buffer.from(process.env.DID_API_KEY).toString("base64")}`;

// ✅ Recursive helper function to update nested subtopics
function updateNestedSubtopicRecursive(subtopics, targetId, aiVideoUrl) {
    for (let i = 0; i < subtopics.length; i++) {
        const subtopic = subtopics[i];
        
        // Check if current subtopic matches target (support multiple ID fields)
        if (subtopic._id === targetId || subtopic.id === targetId) {
            // Update the matching subtopic
            subtopic.aiVideoUrl = aiVideoUrl;
            subtopic.updatedAt = new Date();
            return true;
        }
        
        // Recursively search in children arrays
        const childArrays = ['children', 'units', 'subtopics'];
        for (const arrayName of childArrays) {
            if (subtopic[arrayName] && Array.isArray(subtopic[arrayName])) {
                const found = updateNestedSubtopicRecursive(subtopic[arrayName], targetId, aiVideoUrl);
                if (found) return true;
            }
        }
    }
    return false;
}

// ✅ NEW: Recursive update endpoint in Node.js
app.put("/api/updateSubtopicVideoRecursive", async (req, res) => {
    try {
        const { subtopicId, parentId, aiVideoUrl, dbname = "professional", subjectName } = req.body;

        console.log("🔄 Recursive update for subtopic:", { subtopicId, parentId, aiVideoUrl, dbname, subjectName });

        if (!subtopicId || !aiVideoUrl) {
            return res.status(400).json({
                error: "Missing subtopicId or aiVideoUrl"
            });
        }

        const dbConn = getDB(dbname);
        const targetCollections = subjectName ? [subjectName] : await dbConn.listCollections().toArray().then(cols => cols.map(c => c.name));

        let updated = false;
        let updateLocation = "not_found";
        let updatedCollection = "unknown";

        for (const collectionName of targetCollections) {
            const collection = dbConn.collection(collectionName);
            console.log(`🔍 Recursive search in collection: ${collectionName}`);

            // Get all documents that might contain nested structures
            const documents = await collection.find({
                $or: [
                    { "units": { $exists: true } },
                    { "children": { $exists: true } },
                    { "subtopics": { $exists: true } }
                ]
            }).toArray();

            for (const doc of documents) {
                // Check and update in units array
                if (doc.units && Array.isArray(doc.units)) {
                    const unitsCopy = JSON.parse(JSON.stringify(doc.units));
                    const foundInUnits = updateNestedSubtopicRecursive(unitsCopy, subtopicId, aiVideoUrl);
                    
                    if (foundInUnits) {
                        await collection.updateOne(
                            { _id: doc._id },
                            { $set: { units: unitsCopy } }
                        );
                        updated = true;
                        updateLocation = "nested_units";
                        updatedCollection = collectionName;
                        console.log(`✅ Updated in nested units of ${collectionName}`);
                        break;
                    }
                }

                // Check and update in children array
                if (!updated && doc.children && Array.isArray(doc.children)) {
                    const childrenCopy = JSON.parse(JSON.stringify(doc.children));
                    const foundInChildren = updateNestedSubtopicRecursive(childrenCopy, subtopicId, aiVideoUrl);
                    
                    if (foundInChildren) {
                        await collection.updateOne(
                            { _id: doc._id },
                            { $set: { children: childrenCopy } }
                        );
                        updated = true;
                        updateLocation = "nested_children";
                        updatedCollection = collectionName;
                        console.log(`✅ Updated in nested children of ${collectionName}`);
                        break;
                    }
                }

                // Check and update in subtopics array
                if (!updated && doc.subtopics && Array.isArray(doc.subtopics)) {
                    const subtopicsCopy = JSON.parse(JSON.stringify(doc.subtopics));
                    const foundInSubtopics = updateNestedSubtopicRecursive(subtopicsCopy, subtopicId, aiVideoUrl);
                    
                    if (foundInSubtopics) {
                        await collection.updateOne(
                            { _id: doc._id },
                            { $set: { subtopics: subtopicsCopy } }
                        );
                        updated = true;
                        updateLocation = "nested_subtopics";
                        updatedCollection = collectionName;
                        console.log(`✅ Updated in nested subtopics of ${collectionName}`);
                        break;
                    }
                }
            }

            if (updated) break;
        }

        // Fallback: Try direct update if recursive search didn't find it
        if (!updated) {
            console.log("🔄 Recursive search failed, trying direct update...");
            for (const collectionName of targetCollections) {
                const collection = dbConn.collection(collectionName);
                
                // Try all direct update strategies
                const strategies = [
                    { field: "units._id", query: { "units._id": subtopicId } },
                    { field: "units.id", query: { "units.id": subtopicId } },
                    { field: "_id", query: { "_id": subtopicId } },
                    { field: "_id ObjectId", query: { "_id": new ObjectId(subtopicId) } }
                ];

                for (const strategy of strategies) {
                    try {
                        const result = await collection.updateOne(
                            strategy.query,
                            { $set: { 
                                [strategy.field.includes("units") ? "units.$.aiVideoUrl" : "aiVideoUrl"]: aiVideoUrl,
                                updatedAt: new Date()
                            }}
                        );

                        if (result.matchedCount > 0) {
                            updated = true;
                            updateLocation = `direct_${strategy.field}`;
                            updatedCollection = collectionName;
                            console.log(`✅ Updated using direct strategy: ${strategy.field}`);
                            break;
                        }
                    } catch (e) {
                        console.log(`⚠️ Direct strategy ${strategy.field} failed: ${e.message}`);
                    }
                }
                if (updated) break;
            }
        }

        res.json({
            status: "ok",
            updated: updated,
            location: updateLocation,
            collection: updatedCollection,
            recursive: true,
            message: updated ? "AI video URL saved recursively" : "Subtopic not found in any nested structure"
        });

    } catch (err) {
        console.error("❌ Recursive update error:", err);
        res.status(500).json({ error: "Recursive update failed: " + err.message });
    }
});

// ✅ Keep your existing endpoints for backward compatibility
app.post("/generate-and-upload", async (req, res) => {
    try {
        const { subtopic, description } = req.body;

        if (!subtopic || !description || description.trim().length < 3) {
            return res.status(400).json({
                error: "Description must be at least 3 characters for AI video generation."
            });
        }

        console.log("🎬 Starting AI video generation for:", subtopic);

        const didResponse = await axios.post(
            "https://api.d-id.com/talks",
            {
                script: { type: "text", input: description, subtitles: "false" },
                presenter_id: "amy-jcwqj4g",
            },
            {
                headers: { Authorization: DID_API_KEY, "Content-Type": "application/json" },
                timeout: 120000,
            }
        );

        const talkId = didResponse.data.id;
        let videoUrl = "";
        let status = "notDone";

        console.log("⏳ Polling for video status, talkId:", talkId);

        const startTime = Date.now();
        const maxWaitTime = 10 * 60 * 1000;

        while (status !== "done" && (Date.now() - startTime) < maxWaitTime) {
            const poll = await axios.get(`https://api.d-id.com/talks/${talkId}`, {
                headers: { Authorization: DID_API_KEY },
                timeout: 30000,
            });

            status = poll.data.status;
            console.log("📊 Video status:", status);

            if (status === "done") {
                videoUrl = poll.data.result_url;
                console.log("✅ D-ID Video ready:", videoUrl);
                break;
            } else if (status === "failed") {
                throw new Error("D-ID video generation failed");
            } else {
                await new Promise(r => setTimeout(r, 3000));
            }
        }

        if (status !== "done") {
            throw new Error("Video generation timeout");
        }

        res.json({
            firebase_video_url: videoUrl,
            message: "AI video generated successfully"
        });
    } catch (err) {
        console.error("❌ D-ID API Error:", err.response?.data || err.message || err);
        res.status(500).json({
            error: err.response?.data?.details || err.response?.data?.error || err.message || "Video generation failed"
        });
    }
});

// ✅ Keep your existing update endpoint
app.put("/api/updateSubtopicVideo", async (req, res) => {
    try {
        const { subtopicId, parentId, aiVideoUrl, dbname = "professional", subjectName } = req.body;

        console.log("🔄 Updating subtopic AI video:", { subtopicId, parentId, aiVideoUrl, dbname, subjectName });

        if (!subtopicId || !aiVideoUrl) {
            return res.status(400).json({
                error: "Missing subtopicId or aiVideoUrl"
            });
        }

        const dbConn = getDB(dbname);
        let result;
        let updateLocation = "unknown";
        let updatedCollection = "unknown";
        let updateField = "unknown";

        const targetCollections = subjectName ? [subjectName] : await dbConn.listCollections().toArray().then(cols => cols.map(c => c.name));

        console.log(`🔍 Searching in collections: ${targetCollections.join(', ')}`);

        for (const collectionName of targetCollections) {
            const collection = dbConn.collection(collectionName);
            console.log(`🔍 Attempting update in collection: ${collectionName}`);

            // Try multiple update strategies
            const strategies = [
                {
                    name: "nested_unit_ObjectId",
                    query: { "units._id": new ObjectId(subtopicId) },
                    update: { $set: { "units.$.aiVideoUrl": aiVideoUrl, "units.$.updatedAt": new Date() } },
                    condition: () => true
                },
                {
                    name: "nested_unit_string",
                    query: { "units._id": subtopicId },
                    update: { $set: { "units.$.aiVideoUrl": aiVideoUrl, "units.$.updatedAt": new Date() } },
                    condition: () => true
                },
                {
                    name: "nested_unit_id",
                    query: { "units.id": subtopicId },
                    update: { $set: { "units.$.aiVideoUrl": aiVideoUrl, "units.$.updatedAt": new Date() } },
                    condition: () => true
                },
                {
                    name: "main_document_ObjectId",
                    query: { _id: new ObjectId(subtopicId) },
                    update: { $set: { aiVideoUrl: aiVideoUrl, updatedAt: new Date() } },
                    condition: () => true
                },
                {
                    name: "main_document_string",
                    query: { _id: subtopicId },
                    update: { $set: { aiVideoUrl: aiVideoUrl, updatedAt: new Date() } },
                    condition: () => true
                }
            ];

            for (const strategy of strategies) {
                try {
                    if (strategy.condition()) {
                        result = await collection.updateOne(strategy.query, strategy.update);
                        
                        if (result.matchedCount > 0) {
                            updateLocation = strategy.name;
                            updatedCollection = collectionName;
                            updateField = strategy.name;
                            console.log(`✅ Updated using ${strategy.name} in ${collectionName}`);
                            break;
                        }
                    }
                } catch (e) {
                    console.log(`⚠️ Strategy ${strategy.name} failed: ${e.message}`);
                }
            }

            if (result && result.matchedCount > 0) break;
        }

        if (!result || result.matchedCount === 0) {
            return res.status(404).json({
                error: "Subtopic not found",
                subtopicId: subtopicId,
                suggestion: "Try using the recursive update endpoint for nested subtopics"
            });
        }

        res.json({
            status: "ok",
            updated: result.modifiedCount,
            matched: result.matchedCount,
            location: updateLocation,
            collection: updatedCollection,
            message: "AI video URL saved successfully"
        });

    } catch (err) {
        console.error("❌ Error updating subtopic:", err);
        res.status(500).json({ error: "Failed to update subtopic: " + err.message });
    }
});

// ✅ Keep your existing debug and health endpoints
app.get("/api/debug-subtopic/:id", async (req, res) => {
    // ... keep existing implementation
    res.json({ message: "Debug endpoint - implement as needed" });
});

app.get("/api/debug-subtopic-all/:id", async (req, res) => {
    // ... keep existing implementation
    res.json({ message: "Debug all endpoint - implement as needed" });
});

app.get("/health", (req, res) => {
    res.json({
        status: "OK",
        timestamp: new Date().toISOString(),
        service: "Node.js AI Video Backend with Recursive Updates"
    });
});

app.get("/api/test", (req, res) => {
    res.json({
        message: "Node.js backend is working!",
        features: "AI Video Generation with Recursive Subtopic Updates"
    });
});

// ✅ Start server
app.listen(PORT, "0.0.0.0", () => {
    console.log(`✅ Node.js Server running on http://0.0.0.0:${PORT}`);
    console.log(`✅ Recursive AI Video Storage Enabled`);
    console.log(`✅ Configured for Spring Boot MongoDB structure`);
});
