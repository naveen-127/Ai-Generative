const express = require("express");
const axios = require("axios");
const cors = require("cors");
const { MongoClient, ObjectId } = require("mongodb");
const path = require("path");
const fs = require("fs");
const { S3Client, PutObjectCommand } = require("@aws-sdk/client-s3");
require("dotenv").config();

const app = express();
const PORT = process.env.PORT || 3000;

// ✅ AWS S3 Configuration
const s3Client = new S3Client({
    region: process.env.AWS_REGION || 'us-east-1',
    credentials: {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID,
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY
    }
});

const S3_BUCKET_NAME = process.env.S3_BUCKET_NAME || 'trilokinnovations';
const S3_FOLDER_PATH = 'subtopics/ai_videourl/';

// ✅ CORS configuration
const allowedOrigins = [
    "http://3.91.243.188:3000",
    "http://localhost:3000",
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
        res.header('Access-Control-Allow-Headers', 'Content-Type', 'Authorization', 'X-Requested-With', 'Accept, Origin');
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
        "v2_public_rian_red_jacket_lobby@Lnoj8R5x9r": "en-GB-RyanNeural"
    };
    return voiceMap[presenter_id] || "en-US-JennyNeural";
}

// ✅ AWS S3 Upload Function
async function uploadToS3(videoUrl, filename) {
    try {
        console.log("☁️ Uploading to AWS S3...");
        console.log("📁 Bucket:", S3_BUCKET_NAME);
        console.log("📁 Folder:", S3_FOLDER_PATH);
        console.log("📄 Filename:", filename);
        console.log("📥 Source URL:", videoUrl);

        // Download video from D-ID
        const response = await axios({
            method: 'GET',
            url: videoUrl,
            responseType: 'arraybuffer',
            timeout: 120000,
        });

        console.log("✅ Video downloaded for S3, size:", response.data.length, "bytes");

        // Upload to S3
        const command = new PutObjectCommand({
            Bucket: S3_BUCKET_NAME,
            Key: `${S3_FOLDER_PATH}${filename}`,
            Body: response.data,
            ContentType: 'video/mp4',
            ACL: 'public-read'
        });

        const result = await s3Client.send(command);
        console.log("✅ S3 Upload successful");

        // Return public URL
        const publicUrl = `https://${S3_BUCKET_NAME}.s3.${process.env.AWS_REGION || 'us-east-1'}.amazonaws.com/${S3_FOLDER_PATH}${filename}`;
        return publicUrl;
    } catch (error) {
        console.error("❌ S3 Upload failed:", error);
        throw error;
    }
}

// ✅ NEW ENDPOINT: Upload to S3 and Save to DB (called when clicking "Save Lesson")
app.post("/api/upload-to-s3-and-save", async (req, res) => {
    try {
        const { 
            videoUrl, 
            subtopic, 
            subtopicId, 
            parentId, 
            rootId, 
            dbname = "professional", 
            subjectName 
        } = req.body;

        console.log("💾 SAVE LESSON: Uploading to S3 and saving to DB");
        console.log("📝 Subtopic:", subtopic);
        console.log("🆔 Subtopic ID:", subtopicId);
        console.log("🎬 Video URL:", videoUrl);

        if (!videoUrl || !subtopicId) {
            return res.status(400).json({
                error: "Missing videoUrl or subtopicId"
            });
        }

        // Generate unique filename for S3
        const timestamp = Date.now();
        const safeSubtopicName = subtopic.replace(/[^a-zA-Z0-9]/g, '_').substring(0, 50);
        const filename = `video_${safeSubtopicName}_${timestamp}.mp4`;

        console.log("📄 S3 Filename:", filename);
        console.log("📁 S3 Path:", S3_FOLDER_PATH + filename);

        // Upload to AWS S3
        const s3Url = await uploadToS3(videoUrl, filename);

        console.log("✅ Video uploaded to S3:", s3Url);

        // Save S3 URL to database using your existing recursive update
        const dbConn = getDB(dbname);
        const targetCollections = subjectName ? [subjectName] : await dbConn.listCollections().toArray().then(cols => cols.map(c => c.name));

        let updated = false;
        let updateLocation = "not_found";

        for (const collectionName of targetCollections) {
            const collection = dbConn.collection(collectionName);
            
            // Try to update main subtopic directly
            const directStrategies = [
                { query: { "_id": subtopicId }, updateField: "aiVideoUrl" },
                { query: { "id": subtopicId }, updateField: "aiVideoUrl" }
            ];

            try {
                directStrategies.push({
                    query: { "_id": new ObjectId(subtopicId) },
                    updateField: "aiVideoUrl"
                });
            } catch (e) {
                console.log(`⚠️ Cannot convert ${subtopicId} to ObjectId: ${e.message}`);
            }

            for (const strategy of directStrategies) {
                try {
                    console.log(`🔍 Trying to save S3 URL: ${JSON.stringify(strategy.query)}`);
                    const result = await collection.updateOne(
                        strategy.query,
                        {
                            $set: {
                                [strategy.updateField]: s3Url,
                                updatedAt: new Date(),
                                videoStorage: "aws_s3",
                                s3Path: `${S3_FOLDER_PATH}${filename}`
                            }
                        }
                    );

                    if (result.matchedCount > 0) {
                        updated = true;
                        updateLocation = `main_subtopic_${strategy.query._id ? 'objectid' : 'string'}`;
                        console.log(`✅ S3 URL saved to database: ${updateLocation}`);
                        break;
                    }
                } catch (e) {
                    console.log(`⚠️ Database save strategy failed: ${e.message}`);
                }
            }

            if (updated) break;

            // If main subtopic not found, use recursive update
            if (!updated) {
                console.log("🔄 Using recursive update for S3 URL...");
                const documents = await collection.find({
                    $or: [
                        { "units": { $exists: true } },
                        { "children": { $exists: true } },
                        { "subtopics": { $exists: true } }
                    ]
                }).toArray();

                for (const doc of documents) {
                    if (doc.units && Array.isArray(doc.units)) {
                        const unitsCopy = JSON.parse(JSON.stringify(doc.units));
                        const foundInUnits = updateNestedSubtopicRecursive(unitsCopy, subtopicId, s3Url);

                        if (foundInUnits) {
                            await collection.updateOne(
                                { _id: doc._id },
                                { $set: { units: unitsCopy } }
                            );
                            updated = true;
                            updateLocation = "nested_units";
                            break;
                        }
                    }
                    if (updated) break;
                }
            }

            if (updated) break;
        }

        if (updated) {
            res.json({
                success: true,
                message: "Video uploaded to AWS S3 and saved to database",
                s3_url: s3Url,
                filename: filename,
                update_location: updateLocation,
                stored_in: "aws_s3",
                bucket: S3_BUCKET_NAME,
                s3_path: `${S3_FOLDER_PATH}${filename}`
            });
        } else {
            res.status(404).json({
                error: "Subtopic not found in database",
                s3_url: s3Url // Still return S3 URL even if DB save failed
            });
        }

    } catch (error) {
        console.error("❌ S3 Upload and Save failed:", error);
        res.status(500).json({
            error: "Failed to upload to S3 and save to database: " + error.message
        });
    }
});

// ✅ MODIFIED: D-ID Clips API - Returns D-ID URL immediately for preview
app.post("/generate-and-upload", async (req, res) => {
    const MAX_POLLS = 60;
    
    try {
        const { subtopic, description, questions = [], presenter_id = "v2_public_anita@Os4oKCBIgZ" } = req.body;

        console.log("🎬 GENERATE VIDEO: Creating D-ID video");
        console.log("📝 Subtopic:", subtopic);

        const selectedVoice = getVoiceForPresenter(presenter_id);
        
        let cleanScript = description;
        cleanScript = cleanScript.replace(/<break time="(\d+)s"\/>/g, (match, time) => {
            return `... [${time} second pause] ...`;
        });
        cleanScript = cleanScript.replace(/<[^>]*>/g, '');

        const requestPayload = {
            presenter_id: presenter_id,
            script: {
                type: "text",
                provider: {
                    type: "microsoft",
                    voice_id: selectedVoice
                },
                input: cleanScript,
                ssml: false
            },
            background: { color: "#f0f8ff" },
            config: {
                result_format: "mp4",
                width: 1280,
                height: 720
            }
        };

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
            pollCount++;

            const poll = await axios.get(`https://api.d-id.com/clips/${clipId}`, {
                headers: { Authorization: DID_API_KEY },
            });

            status = poll.data.status;
            console.log(`📊 Poll ${pollCount}/${MAX_POLLS}:`, status);

            if (status === "done") {
                videoUrl = poll.data.result_url;
                console.log("✅ D-ID Video generation completed!");
                break;
            } else if (status === "error") {
                throw new Error("Clip generation failed: " + (poll.data.error?.message || "Unknown error"));
            }
        }

        if (status !== "done") {
            throw new Error("Clip generation timeout after " + pollCount + " polls");
        }

        // ✅ RETURN D-ID URL IMMEDIATELY (NO S3 UPLOAD HERE - only when saving)
        res.json({
            firebase_video_url: videoUrl, // D-ID URL for immediate preview
            did_video_url: videoUrl,
            message: `AI video generated successfully with ${questions.length} questions`,
            questionsIncluded: questions.length,
            presenter_used: presenter_id,
            voice_used: selectedVoice,
            stored_temporarily: true, // Indicate it's temporary D-ID storage
            note: "Video will be uploaded to AWS S3 when you click 'Save Lesson'"
        });

    } catch (err) {
        console.error("❌ Video generation failed:", err);
        res.status(500).json({
            error: err.message,
            details: err.response?.data
        });
    }
});

// ✅ IMPROVED: Recursive update that also updates main subtopics
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

            // ✅ FIXED: FIRST try to update MAIN subtopic directly
            console.log("🔍 FIRST: Trying to update MAIN subtopic directly...");
            const directStrategies = [
                { query: { "_id": subtopicId }, updateField: "aiVideoUrl" },
                { query: { "id": subtopicId }, updateField: "aiVideoUrl" }
            ];

            try {
                directStrategies.push({
                    query: { "_id": new ObjectId(subtopicId) },
                    updateField: "aiVideoUrl"
                });
            } catch (e) {
                console.log(`⚠️ Cannot convert ${subtopicId} to ObjectId: ${e.message}`);
            }

            for (const strategy of directStrategies) {
                try {
                    console.log(`🔍 Trying direct main subtopic update: ${JSON.stringify(strategy.query)}`);
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
                        updateLocation = `main_subtopic_${strategy.query._id ? 'objectid' : 'string'}`;
                        updatedCollection = collectionName;
                        console.log(`✅ Updated MAIN subtopic directly: ${updateLocation}, matched: ${result.matchedCount}`);
                        break;
                    }
                } catch (e) {
                    console.log(`⚠️ Direct main subtopic strategy failed: ${e.message}`);
                }
            }

            if (updated) break;

            // ✅ SECOND: If main subtopic not found, search in nested structures
            console.log("🔍 SECOND: Searching in nested structures...");
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
        service: "Node.js AI Video Backend with AWS S3 Storage",
        endpoints: [
            "POST /generate-and-upload",
            "POST /api/upload-to-s3-and-save",
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
        features: "AI Video Generation with AWS S3 Storage",
        timestamp: new Date().toISOString()
    });
});

// ✅ Create assets directory on startup
function ensureAssetsDirectory() {
    const assetsDir = path.join(__dirname, 'assets', 'ai_video');
    if (!fs.existsSync(assetsDir)) {
        fs.mkdirSync(assetsDir, { recursive: true });
        console.log("📁 Created assets directory:", assetsDir);
    } else {
        console.log("✅ Assets directory exists:", assetsDir);
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
            "POST /api/upload-to-s3-and-save",
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
    console.log(`☁️ AWS S3 Storage Enabled: Videos will be saved to ${S3_BUCKET_NAME}/${S3_FOLDER_PATH}`);
    console.log(`✅ Available Endpoints:`);
    console.log(`   POST /generate-and-upload`);
    console.log(`   POST /api/upload-to-s3-and-save`);
    console.log(`   PUT /api/updateSubtopicVideo`);
    console.log(`   PUT /api/updateSubtopicVideoRecursive`);
    console.log(`   GET /api/debug-subtopic/:id`);
    console.log(`   GET /health`);
    console.log(`   GET /api/test`);
});
