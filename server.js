const express = require("express");
const axios = require("axios");
const cors = require("cors");
const { MongoClient, ObjectId } = require("mongodb");
const path = require("path");
const fs = require("fs");
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

// ✅ Enhanced CORS middleware
app.use(cors({
    origin: function (origin, callback) {
        if (!origin) return callback(null, true);
        if (allowedOrigins.includes(origin)) {
            console.log("✅ CORS Allowed:", origin);
            return callback(null, true);
        } else {
            console.log("❌ CORS Blocked:", origin);
            return callback(new Error(`CORS policy violation: ${origin} not allowed`), false);
        }
    },
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With', 'Accept', 'Origin'],
    exposedHeaders: ['Content-Length', 'Content-Type'],
    preflightContinue: false,
    optionsSuccessStatus: 204,
    maxAge: 86400
}));

app.options('*', cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));
app.use(express.static(path.join(__dirname, "public")));

// ✅ Serve static files from assets directory
app.use("/assets", express.static(path.join(__dirname, "assets")));

app.use((req, res, next) => {
    const origin = req.headers.origin;
    if (origin && allowedOrigins.includes(origin)) {
        res.header('Access-Control-Allow-Origin', origin);
        res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
        res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Requested-With, Accept, Origin');
        res.header('Access-Control-Allow-Credentials', 'true');
    }
    if (req.method === 'OPTIONS') {
        return res.status(200).end();
    }
    next();
});

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

function getDB(dbname = "professional") {
    return client.db(dbname);
}

// ✅ Clean script for D-ID API (remove SSML and format properly)
function cleanScriptForDID(script) {
    // Remove SSML tags and clean up the script
    let cleaned = script
        .replace(/<break\s+time="\d+s"\/>/g, '') // Remove SSML break tags
        .replace(/\\n/g, '\n') // Convert escaped newlines to actual newlines
        .replace(/\n+/g, '\n') // Remove multiple consecutive newlines
        .trim();
    
    console.log("📝 Cleaned script for D-ID:", cleaned);
    return cleaned;
}

// ✅ REAL D-ID Video Generation Function
async function generateDIDVideo(script, presenter_id, subtopicName) {
    try {
        console.log("🎬 Starting REAL D-ID video generation...");
        
        // D-ID API configuration
        const DID_API_KEY = process.env.DID_API_KEY;
        if (!DID_API_KEY) {
            throw new Error("D-ID API key not found in environment variables");
        }

        // Create unique filename
        const timestamp = Date.now();
        const safeSubtopicName = subtopicName.replace(/[^a-zA-Z0-9]/g, '_').substring(0, 50);
        const filename = `did_${safeSubtopicName}_${timestamp}.mp4`;
        const outputPath = path.join(__dirname, 'assets', 'ai_video', filename);
        
        // Ensure directory exists
        const assetsDir = path.join(__dirname, 'assets', 'ai_video');
        if (!fs.existsSync(assetsDir)) {
            fs.mkdirSync(assetsDir, { recursive: true });
        }

        // Clean the script for D-ID API
        const cleanedScript = cleanScriptForDID(script);

        // D-ID API request payload - CORRECT FORMAT
        const payload = {
            script: {
                type: "text",
                input: cleanedScript,
                provider: {
                    type: "microsoft",
                    voice_id: "en-IN-NeerjaNeural" // Default voice, will be overridden by presenter
                }
            },
            config: {
                fluent: true,
                pad_audio: 0.0,
                result_format: "mp4"
            },
            source_url: `https://clips-presenters.d-id.com/v2/anita/Os4oKCBIgZ/yTLykkbYHr/thumbnail.png` // Default, will be overridden
        };

        // Set presenter-specific configuration
        if (presenter_id === "v2_public_anita@Os4oKCBIgZ") {
            payload.source_url = "https://clips-presenters.d-id.com/v2/anita/Os4oKCBIgZ/yTLykkbYHr/thumbnail.png";
            payload.script.provider.voice_id = "en-IN-NeerjaNeural";
        } else if (presenter_id === "v2_public_lucas@vngv2djh6d") {
            payload.source_url = "https://clips-presenters.d-id.com/v2/lucas/vngv2djh6d/vz7n_w_05r/thumbnail.png";
            payload.script.provider.voice_id = "en-US-GuyNeural";
        }

        console.log("📤 Sending request to D-ID API...");
        console.log("🎭 Presenter:", presenter_id);
        console.log("📝 Script length:", cleanedScript.length);
        
        // Make API call to D-ID - CORRECT ENDPOINT AND HEADERS
        const response = await axios.post('https://api.d-id.com/talks', payload, {
            headers: {
                'Authorization': `Bearer ${DID_API_KEY}`, // ✅ FIXED: Use Bearer token, not Basic auth
                'Content-Type': 'application/json'
            },
            timeout: 300000 // 5 minutes timeout
        });

        console.log("✅ D-ID API response received:", response.data);

        const talkId = response.data.id;
        console.log("🆔 Talk ID:", talkId);

        // Poll for completion
        let videoUrl = null;
        let attempts = 0;
        const maxAttempts = 60; // 5 minutes max (5 seconds * 60)

        while (attempts < maxAttempts) {
            attempts++;
            await new Promise(resolve => setTimeout(resolve, 5000)); // Wait 5 seconds

            const statusResponse = await axios.get(`https://api.d-id.com/talks/${talkId}`, {
                headers: {
                    'Authorization': `Bearer ${DID_API_KEY}`
                }
            });

            console.log(`🔄 Polling attempt ${attempts}:`, statusResponse.data.status);

            if (statusResponse.data.status === 'done') {
                videoUrl = statusResponse.data.result_url;
                console.log("✅ Video generation completed:", videoUrl);
                break;
            } else if (statusResponse.data.status === 'error') {
                throw new Error(`D-ID generation failed: ${JSON.stringify(statusResponse.data.error)}`);
            }
        }

        if (!videoUrl) {
            throw new Error("Video generation timeout - took too long to complete");
        }

        // Download the video
        console.log("📥 Downloading video from D-ID...");
        const videoResponse = await axios({
            method: 'GET',
            url: videoUrl,
            responseType: 'stream',
            timeout: 60000 // 60 seconds for download
        });

        // Save video to local file
        const writer = fs.createWriteStream(outputPath);
        videoResponse.data.pipe(writer);

        return new Promise((resolve, reject) => {
            writer.on('finish', () => {
                console.log("✅ Video saved locally:", outputPath);
                resolve({
                    localPath: `/assets/ai_video/${filename}`,
                    didUrl: videoUrl,
                    filename: filename
                });
            });
            writer.on('error', (error) => {
                console.error("❌ Error saving video file:", error);
                reject(error);
            });
        });

    } catch (error) {
        console.error("❌ D-ID video generation failed:", error.response?.data || error.message);
        
        // Provide more detailed error information
        if (error.response) {
            console.error("📊 D-ID API Error Details:", {
                status: error.response.status,
                data: error.response.data,
                headers: error.response.headers
            });
        }
        
        throw error;
    }
}

// ✅ Recursive helper function to update nested subtopics
function updateNestedSubtopicRecursive(subtopics, targetId, aiVideoUrl) {
    for (let i = 0; i < subtopics.length; i++) {
        const subtopic = subtopics[i];
        if (subtopic._id === targetId || subtopic.id === targetId) {
            subtopic.aiVideoUrl = aiVideoUrl;
            subtopic.updatedAt = new Date();
            return true;
        }
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

// ✅ REAL D-ID Video Generation Endpoint
app.post("/generate-and-upload", async (req, res) => {
    try {
        const { subtopic, description, questions = [], presenter_id = "v2_public_anita@Os4oKCBIgZ" } = req.body;

        console.log("🎬 REAL: Generating D-ID video for:", subtopic);
        console.log("🎭 Using presenter:", presenter_id);
        console.log("📝 Description length:", description.length);
        console.log("❓ Questions count:", questions.length);

        // Generate REAL D-ID video
        const videoResult = await generateDIDVideo(description, presenter_id, subtopic);

        res.json({
            firebase_video_url: videoResult.localPath,
            did_video_url: videoResult.didUrl,
            message: `REAL D-ID video generated with ${questions.length} questions`,
            questionsIncluded: questions.length,
            presenter_used: presenter_id,
            stored_locally: true,
            mock: false,
            file_created: true,
            filename: videoResult.filename
        });

    } catch (err) {
        console.error("❌ D-ID video generation error:", err);
        
        // Check if it's a credit issue or validation error
        if (err.response) {
            const status = err.response.status;
            const errorData = err.response.data;
            
            if (status === 402) {
                return res.status(402).json({
                    error: "D-ID credits exhausted",
                    details: "Please add more credits to your D-ID account"
                });
            } else if (status === 400) {
                return res.status(400).json({
                    error: "D-ID API validation error",
                    details: errorData.description || "Invalid request format",
                    validation_errors: errorData.details
                });
            } else if (status === 401) {
                return res.status(401).json({
                    error: "D-ID API authentication failed",
                    details: "Check your D-ID API key"
                });
            }
        }
        
        res.status(500).json({
            error: "D-ID video generation failed: " + err.message,
            details: "Check D-ID API key, credits, and request format"
        });
    }
});

// ✅ ALL YOUR EXISTING ENDPOINTS REMAIN EXACTLY THE SAME
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

        console.log(`🔍 Starting recursive search in collections: ${targetCollections.join(', ')}`);

        for (const collectionName of targetCollections) {
            const collection = dbConn.collection(collectionName);
            console.log(`🔍 Recursive search in collection: ${collectionName}`);

            const documents = await collection.find({
                $or: [
                    { "units": { $exists: true } },
                    { "children": { $exists: true } },
                    { "subtopics": { $exists: true } }
                ]
            }).toArray();

            console.log(`📄 Found ${documents.length} documents with nested structures in ${collectionName}`);

            for (const doc of documents) {
                if (doc.units && Array.isArray(doc.units)) {
                    const unitsCopy = JSON.parse(JSON.stringify(doc.units));
                    const foundInUnits = updateNestedSubtopicRecursive(unitsCopy, subtopicId, aiVideoUrl);

                    if (foundInUnits) {
                        const updateResult = await collection.updateOne(
                            { _id: doc._id },
                            { $set: { units: unitsCopy } }
                        );
                        updated = true;
                        updateLocation = "nested_units";
                        updatedCollection = collectionName;
                        console.log(`✅ Updated in nested units of ${collectionName}, document: ${doc._id}`);
                        break;
                    }
                }

                if (updated) break;

                if (doc.children && Array.isArray(doc.children)) {
                    const childrenCopy = JSON.parse(JSON.stringify(doc.children));
                    const foundInChildren = updateNestedSubtopicRecursive(childrenCopy, subtopicId, aiVideoUrl);

                    if (foundInChildren) {
                        const updateResult = await collection.updateOne(
                            { _id: doc._id },
                            { $set: { children: childrenCopy } }
                        );
                        updated = true;
                        updateLocation = "nested_children";
                        updatedCollection = collectionName;
                        console.log(`✅ Updated in nested children of ${collectionName}, document: ${doc._id}`);
                        break;
                    }
                }

                if (updated) break;

                if (doc.subtopics && Array.isArray(doc.subtopics)) {
                    const subtopicsCopy = JSON.parse(JSON.stringify(doc.subtopics));
                    const foundInSubtopics = updateNestedSubtopicRecursive(subtopicsCopy, subtopicId, aiVideoUrl);

                    if (foundInSubtopics) {
                        const updateResult = await collection.updateOne(
                            { _id: doc._id },
                            { $set: { subtopics: subtopicsCopy } }
                        );
                        updated = true;
                        updateLocation = "nested_subtopics";
                        updatedCollection = collectionName;
                        console.log(`✅ Updated in nested subtopics of ${collectionName}, document: ${doc._id}`);
                        break;
                    }
                }

                if (updated) break;
            }

            if (updated) break;
        }

        if (!updated) {
            console.log("🔄 Recursive search failed, trying direct update...");
            for (const collectionName of targetCollections) {
                const collection = dbConn.collection(collectionName);

                const strategies = [
                    { field: "units._id", query: { "units._id": subtopicId }, updateField: "units.$.aiVideoUrl" },
                    { field: "units.id", query: { "units.id": subtopicId }, updateField: "units.$.aiVideoUrl" },
                    { field: "_id", query: { "_id": subtopicId }, updateField: "aiVideoUrl" }
                ];

                try {
                    strategies.push({
                        field: "_id ObjectId",
                        query: { "_id": new ObjectId(subtopicId) },
                        updateField: "aiVideoUrl"
                    });
                } catch (e) {
                    console.log(`⚠️ Cannot convert ${subtopicId} to ObjectId: ${e.message}`);
                }

                for (const strategy of strategies) {
                    try {
                        console.log(`🔍 Trying direct strategy: ${strategy.field}`);
                        const result = await collection.updateOne(
                            strategy.query,
                            {
                                $set: {
                                    [strategy.updateField]: aiVideoUrl,
                                    updatedAt: new Date()
                                }
                            }
                        );

                        if (result.matchedCount > 0) {
                            updated = true;
                            updateLocation = `direct_${strategy.field}`;
                            updatedCollection = collectionName;
                            console.log(`✅ Updated using direct strategy: ${strategy.field}, matched: ${result.matchedCount}`);
                            break;
                        }
                    } catch (e) {
                        console.log(`⚠️ Direct strategy ${strategy.field} failed: ${e.message}`);
                    }
                }
                if (updated) break;
            }
        }

        const response = {
            status: "ok",
            updated: updated,
            location: updateLocation,
            collection: updatedCollection,
            recursive: true,
            message: updated ? "AI video URL saved recursively" : "Subtopic not found in any nested structure"
        };

        console.log("📤 Sending response:", response);
        res.json(response);

    } catch (err) {
        console.error("❌ Recursive update error:", err);
        res.status(500).json({
            error: "Recursive update failed: " + err.message,
            details: "Check server logs for more information"
        });
    }
});

// ✅ Original update endpoint for backward compatibility
app.put("/api/updateSubtopicVideo", async (req, res) => {
    try {
        const { subtopicId, parentId, aiVideoUrl, dbname = "professional", subjectName } = req.body;

        console.log("🔄 Original update for subtopic:", { subtopicId, parentId, aiVideoUrl, dbname, subjectName });

        if (!subtopicId || !aiVideoUrl) {
            return res.status(400).json({
                error: "Missing subtopicId or aiVideoUrl"
            });
        }

        const dbConn = getDB(dbname);
        let result;
        let updateLocation = "unknown";
        let updatedCollection = "unknown";

        const targetCollections = subjectName ? [subjectName] : await dbConn.listCollections().toArray().then(cols => cols.map(c => c.name));

        console.log(`🔍 Searching in collections: ${targetCollections.join(', ')}`);

        for (const collectionName of targetCollections) {
            const collection = dbConn.collection(collectionName);
            console.log(`🔍 Attempting update in collection: ${collectionName}`);

            const strategies = [
                {
                    name: "nested_unit_string",
                    query: { "units._id": subtopicId },
                    update: { $set: { "units.$.aiVideoUrl": aiVideoUrl, "units.$.updatedAt": new Date() } }
                },
                {
                    name: "nested_unit_id",
                    query: { "units.id": subtopicId },
                    update: { $set: { "units.$.aiVideoUrl": aiVideoUrl, "units.$.updatedAt": new Date() } }
                },
                {
                    name: "main_document_string",
                    query: { _id: subtopicId },
                    update: { $set: { aiVideoUrl: aiVideoUrl, updatedAt: new Date() } }
                }
            ];

            try {
                strategies.push(
                    {
                        name: "nested_unit_ObjectId",
                        query: { "units._id": new ObjectId(subtopicId) },
                        update: { $set: { "units.$.aiVideoUrl": aiVideoUrl, "units.$.updatedAt": new Date() } }
                    },
                    {
                        name: "main_document_ObjectId",
                        query: { _id: new ObjectId(subtopicId) },
                        update: { $set: { aiVideoUrl: aiVideoUrl, updatedAt: new Date() } }
                    }
                );
            } catch (e) {
                console.log(`⚠️ Cannot use ObjectId for ${subtopicId}: ${e.message}`);
            }

            for (const strategy of strategies) {
                try {
                    console.log(`🔍 Trying strategy: ${strategy.name}`);
                    result = await collection.updateOne(strategy.query, strategy.update);

                    if (result.matchedCount > 0) {
                        updateLocation = strategy.name;
                        updatedCollection = collectionName;
                        console.log(`✅ Updated using ${strategy.name} in ${collectionName}`);
                        break;
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

// ✅ Debug endpoints
app.get("/api/debug-subtopic/:id", async (req, res) => {
    try {
        const { id } = req.params;
        const { dbname = "professional", subjectName } = req.query;

        console.log("🔍 Debugging subtopic:", id);

        const dbConn = getDB(dbname);
        const collections = subjectName ? [subjectName] : await dbConn.listCollections().toArray().then(cols => cols.map(c => c.name));

        let found = false;
        let location = "not_found";
        let collectionFound = "";

        for (const collectionName of collections) {
            const collection = dbConn.collection(collectionName);

            const strategies = [
                { query: { "units._id": id }, location: "nested_units_id" },
                { query: { "units.id": id }, location: "nested_units_string" },
                { query: { "_id": id }, location: "main_document_string" },
                { query: { "_id": new ObjectId(id) }, location: "main_document_objectid" }
            ];

            for (const strategy of strategies) {
                try {
                    const doc = await collection.findOne(strategy.query);
                    if (doc) {
                        found = true;
                        location = strategy.location;
                        collectionFound = collectionName;
                        break;
                    }
                } catch (e) {
                }
            }

            if (found) break;
        }

        res.json({
            found: found,
            location: location,
            collection: collectionFound,
            subtopicId: id
        });

    } catch (err) {
        console.error("❌ Debug error:", err);
        res.status(500).json({ error: err.message });
    }
});

// ✅ Health check endpoint
app.get("/health", (req, res) => {
    res.json({
        status: "OK",
        timestamp: new Date().toISOString(),
        service: "Node.js AI Video Backend with REAL D-ID Video Generation",
        endpoints: [
            "POST /generate-and-upload",
            "PUT /api/updateSubtopicVideo",
            "PUT /api/updateSubtopicVideoRecursive",
            "GET /api/debug-subtopic/:id",
            "GET /health"
        ]
    });
});

// ✅ Test endpoint
app.get("/api/test", (req, res) => {
    res.json({
        message: "Node.js backend is working!",
        features: "REAL D-ID Video Generation with Local Video Storage",
        timestamp: new Date().toISOString()
    });
});

// ✅ Create assets directory on startup
function ensureAssetsDirectory() {
    const assetsDir = path.join(__dirname, 'assets', 'ai_video');
    if (!fs.existsSync(assetsDir)) {
        fs.mkdirSync(assetsDir, { recursive: true });
        console.log("📁 Created assets directory:", assetsDir);
    }
}

// ✅ Catch-all for undefined routes
app.use("*", (req, res) => {
    res.status(404).json({
        error: "Endpoint not found",
        path: req.originalUrl,
        method: req.method,
        availableEndpoints: [
            "POST /generate-and-upload",
            "PUT /api/updateSubtopicVideo",
            "PUT /api/updateSubtopicVideoRecursive",
            "GET /api/debug-subtopic/:id",
            "GET /health",
            "GET /api/test"
        ]
    });
});

// ✅ Start server
ensureAssetsDirectory();
app.listen(PORT, "0.0.0.0", () => {
    console.log(`✅ Node.js Server running on http://0.0.0.0:${PORT}`);
    console.log(`✅ REAL D-ID Video Generation Enabled`);
    console.log(`✅ Videos will be saved to: /assets/ai_video/`);
    console.log(`✅ Available Endpoints:`);
    console.log(`   POST /generate-and-upload (REAL D-ID)`);
    console.log(`   PUT /api/updateSubtopicVideo`);
    console.log(`   PUT /api/updateSubtopicVideoRecursive`);
    console.log(`   GET /api/debug-subtopic/:id`);
    console.log(`   GET /health`);
    console.log(`   GET /api/test`);
});
