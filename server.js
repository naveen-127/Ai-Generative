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

// ✅ Dynamic voice selection based on presenter gender
function getVoiceForPresenter(presenter_id) {
    const voiceMap = {
        "v2_public_anita@Os4oKCBIgZ": "en-IN-NeerjaNeural",
        "v2_public_lucas@vngv2djh6d": "en-US-GuyNeural",
        // "v2_public_rian_red_jacket_lobby@Lnoj8R5x9r": "en-GB-RyanNeural"
    };
    return voiceMap[presenter_id] || "en-US-JennyNeural";
}

// ✅ Download video from D-ID and save to local assets
async function downloadAndSaveVideo(videoUrl, subtopicName) {
    try {
        console.log("📥 Downloading video from D-ID:", videoUrl);
        
        // Download video from D-ID
        const response = await axios({
            method: 'GET',
            url: videoUrl,
            responseType: 'stream',
            timeout: 120000
        });

        // Create assets directory if it doesn't exist
        const assetsDir = path.join(__dirname, 'assets', 'ai_videos');
        if (!fs.existsSync(assetsDir)) {
            fs.mkdirSync(assetsDir, { recursive: true });
            console.log("📁 Created assets directory:", assetsDir);
        }

        // Generate safe filename
        const timestamp = Date.now();
        const safeSubtopicName = subtopicName.replace(/[^a-zA-Z0-9]/g, '_').substring(0, 50);
        const filename = `${safeSubtopicName}_${timestamp}.mp4`;
        const filePath = path.join(assetsDir, filename);

        console.log("💾 Saving video to:", filePath);

        // Save the video file
        const writer = fs.createWriteStream(filePath);
        response.data.pipe(writer);

        return new Promise((resolve, reject) => {
            writer.on('finish', () => {
                const publicUrl = `/assets/ai_videos/${filename}`;
                console.log("✅ Video saved successfully:", publicUrl);
                resolve(publicUrl);
            });
            writer.on('error', (err) => {
                console.error("❌ Error saving video:", err);
                reject(new Error(`Failed to save video: ${err.message}`));
            });
        });

    } catch (error) {
        console.error("❌ Download failed:", error);
        throw new Error(`Video download failed: ${error.message}`);
    }
}

// ✅ MODIFIED: Generate, download, and save video locally
app.post("/generate-and-upload", async (req, res) => {
    const MAX_POLLS = 60;
    
    try {
        const { subtopic, description, questions = [], presenter_id = "v2_public_anita@Os4oKCBIgZ" } = req.body;

        console.log("🎬 Starting AI CLIPS generation for:", subtopic);
        console.log("🎭 Using presenter:", presenter_id);

        const selectedVoice = getVoiceForPresenter(presenter_id);
        console.log("🎤 Auto-selected voice:", selectedVoice);

        // ✅ FIXED: Remove SSML tags for Clips API compatibility
        let cleanScript = description;

        // Remove all SSML tags and replace with natural pauses in text
        cleanScript = cleanScript.replace(/<break time="(\d+)s"\/>/g, (match, time) => {
            return `... [${time} second pause] ...`;
        });

        // Remove any other HTML/SSML tags
        cleanScript = cleanScript.replace(/<[^>]*>/g, '');

        console.log("📝 Cleaned script (no SSML):", cleanScript);

        // ✅ FIXED: Use text format without SSML for Clips API
        const requestPayload = {
            presenter_id: presenter_id,
            script: {
                type: "text",  // ✅ Use text instead of ssml
                provider: {
                    type: "microsoft",
                    voice_id: selectedVoice
                },
                input: cleanScript,  // ✅ Use cleaned script without SSML
                ssml: false  // ✅ Explicitly disable SSML
            },
            background: {
                color: "#f0f8ff"
            },
            config: {
                result_format: "mp4",
                width: 1280,
                height: 720
            }
        };

        console.log("🚀 D-ID Request Payload:", JSON.stringify(requestPayload, null, 2));

        try {
            const clipResponse = await axios.post(
                "https://api.d-id.com/clips",
                requestPayload,
                {
                    headers: {
                        Authorization: DID_API_KEY,
                        "Content-Type": "application/json"
                    },
                    timeout: 120000,
                }
            );

            const clipId = clipResponse.data.id;
            console.log("⏳ Clip created with ID:", clipId);

            let status = clipResponse.data.status;
            let videoUrl = "";
            let pollCount = 0;

            while (status !== "done" && status !== "error" && pollCount < MAX_POLLS) {
                await new Promise(r => setTimeout(r, 3000));

                const poll = await axios.get(`https://api.d-id.com/clips/${clipId}`, {
                    headers: { Authorization: DID_API_KEY },
                });

                status = poll.data.status;
                pollCount++;
                console.log(`📊 Clip status (poll ${pollCount}):`, status);

                if (status === "done") {
                    videoUrl = poll.data.result_url;
                    console.log("✅ Clip ready:", videoUrl);
                    break;
                } else if (status === "error") {
                    console.error("❌ Clip generation failed:", poll.data);
                    
                    // ✅ SPECIAL HANDLING FOR RIAN PRESENTER
                    if (presenter_id === "v2_public_rian_red_jacket_lobby@Lnoj8R5x9r") {
                        throw new Error(`Rian presenter failed: ${poll.data.error?.message || "Presenter may be unavailable. Try Anita or Lucas."}`);
                    } else {
                        throw new Error("Clip generation failed: " + (poll.data.error?.message || "Unknown error"));
                    }
                }
            }

            if (status !== "done") {
                throw new Error("Clip generation timeout after " + pollCount + " polls");
            }

            // ✅ NEW: Download and save video to local assets
            console.log("🔄 Starting video download and local storage...");
            const localVideoUrl = await downloadAndSaveVideo(videoUrl, subtopic);

            res.json({
                firebase_video_url: localVideoUrl, // Now this is your local URL
                d_id_original_url: videoUrl, // Keep original for reference
                message: `AI clip generated and saved locally with ${questions.length} questions`,
                questionsIncluded: questions.length,
                presenter_used: presenter_id,
                voice_used: selectedVoice,
                stored_locally: true
            });

        } catch (apiError) {
            // ✅ SPECIAL HANDLING FOR RIAN PRESENTER - Fallback to Anita
            if (presenter_id === "v2_public_rian_red_jacket_lobby@Lnoj8R5x9r") {
                console.log("🔄 Rian presenter failed, trying fallback to Anita...");
                
                // Retry with Anita presenter
                const fallbackPayload = {
                    ...requestPayload,
                    presenter_id: "v2_public_anita@Os4oKCBIgZ",
                    script: {
                        ...requestPayload.script,
                        provider: {
                            type: "microsoft",
                            voice_id: "en-IN-NeerjaNeural"
                        }
                    }
                };

                console.log("🔄 Fallback attempt with Anita presenter");
                
                const fallbackResponse = await axios.post(
                    "https://api.d-id.com/clips",
                    fallbackPayload,
                    {
                        headers: {
                            Authorization: DID_API_KEY,
                            "Content-Type": "application/json"
                        },
                        timeout: 120000,
                    }
                );

                const fallbackClipId = fallbackResponse.data.id;
                console.log("⏳ Fallback clip created with ID:", fallbackClipId);

                let fallbackStatus = fallbackResponse.data.status;
                let fallbackVideoUrl = "";
                let fallbackPollCount = 0;

                // ✅ FIXED: Use MAX_POLLS instead of maxPolls
                while (fallbackStatus !== "done" && fallbackStatus !== "error" && fallbackPollCount < MAX_POLLS) {
                    await new Promise(r => setTimeout(r, 3000));

                    const poll = await axios.get(`https://api.d-id.com/clips/${fallbackClipId}`, {
                        headers: { Authorization: DID_API_KEY },
                    });

                    fallbackStatus = poll.data.status;
                    fallbackPollCount++;
                    console.log(`📊 Fallback clip status (poll ${fallbackPollCount}):`, fallbackStatus);

                    if (fallbackStatus === "done") {
                        fallbackVideoUrl = poll.data.result_url;
                        console.log("✅ Fallback clip ready:", fallbackVideoUrl);
                        break;
                    } else if (fallbackStatus === "error") {
                        throw new Error("Fallback clip generation also failed: " + (poll.data.error?.message || "Unknown error"));
                    }
                }

                if (fallbackStatus !== "done") {
                    throw new Error("Fallback clip generation timeout");
                }

                // ✅ Download and save fallback video too
                console.log("🔄 Downloading fallback video...");
                const localFallbackVideoUrl = await downloadAndSaveVideo(fallbackVideoUrl, subtopic);

                res.json({
                    firebase_video_url: localFallbackVideoUrl,
                    d_id_original_url: fallbackVideoUrl,
                    message: `AI clip generated successfully with ${questions.length} questions (used Anita as fallback since Rian was unavailable)`,
                    questionsIncluded: questions.length,
                    presenter_used: "v2_public_anita@Os4oKCBIgZ",
                    voice_used: "en-IN-NeerjaNeural",
                    original_presenter_failed: "v2_public_rian_red_jacket_lobby@Lnoj8R5x9r",
                    stored_locally: true
                });

            } else {
                // Re-throw error for other presenters
                throw apiError;
            }
        }

    } catch (err) {
        console.error("❌ D-ID Clips API Error:", {
            message: err.message,
            response: err.response?.data,
            status: err.response?.status
        });

        let errorMessage = "Clip generation failed";

        if (err.response?.data?.error) {
            errorMessage = err.response.data.error;
        } else if (err.response?.data?.message) {
            errorMessage = err.response.data.message;
        } else if (err.message) {
            errorMessage = err.message;
        }

        res.status(500).json({
            error: errorMessage,
            details: err.response?.data,
            statusCode: err.response?.status,
            presenter_issue: err.message.includes("Rian") ? "Rian presenter may be temporarily unavailable" : undefined
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
        service: "Node.js AI Video Backend with Local Video Storage",
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
        features: "AI Video Generation with Local Video Storage",
        timestamp: new Date().toISOString()
    });
});

// ✅ Create assets directory on startup
function ensureAssetsDirectory() {
    const assetsDir = path.join(__dirname, 'assets', 'ai_videos');
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
    console.log(`✅ Local Video Storage Enabled`);
    console.log(`✅ Videos will be saved to: /assets/ai_videos/`);
    console.log(`✅ Available Endpoints:`);
    console.log(`   POST /generate-and-upload`);
    console.log(`   PUT /api/updateSubtopicVideo`);
    console.log(`   PUT /api/updateSubtopicVideoRecursive`);
    console.log(`   GET /api/debug-subtopic/:id`);
    console.log(`   GET /health`);
    console.log(`   GET /api/test`);
});