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

// ✅ Increase server timeouts
app.use((req, res, next) => {
    req.setTimeout(300000);
    res.setTimeout(300000);
    next();
});

// ✅ AWS S3 Configuration
const s3Client = new S3Client({
    region: process.env.AWS_REGION || 'ap-south-1',
    credentials: {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID,
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY
    }
});

const S3_BUCKET_NAME = process.env.S3_BUCKET_NAME || 'trilokinnovations-test-admin';
const S3_FOLDER_PATH = 'subtopics/';

// ✅ CORS configuration
const allowedOrigins = [
    "https://d3ty37mf4sf9cz.cloudfront.net",
    "http://100.31.100.74:3000",
    "http://localhost:3000",
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
        if (!origin || allowedOrigins.includes(origin)) {
            return callback(null, true);
        }
        console.log("❌ CORS Blocked:", origin);
        return callback(new Error(`CORS policy violation`), false);
    },
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With', 'Accept', 'Origin']
}));

app.options('*', cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));
app.use(express.static(path.join(__dirname, "public")));
app.use("/assets", express.static(path.join(__dirname, "assets")));

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

// ✅ Update nested subtopic in units array
async function updateNestedSubtopicInUnits(collection, subtopicId, videoUrl) {
    console.log(`\n🔍 [DB UPDATE] Searching for subtopicId: ${subtopicId} in collection: ${collection.collectionName}`);
    
    try {
        const queryStrategies = [
            { "units._id": subtopicId },
            { "units._id": subtopicId.toString() },
            { "units.id": subtopicId },
            { "_id": subtopicId },
        ];

        let parentDoc = null;
        let strategyUsed = "";

        for (const query of queryStrategies) {
            console.log(`   🔍 Trying query: ${JSON.stringify(query)}`);
            parentDoc = await collection.findOne(query);
            if (parentDoc) {
                strategyUsed = JSON.stringify(query);
                console.log(`   ✅ Found with strategy: ${strategyUsed}`);
                break;
            }
        }

        if (!parentDoc) {
            console.log(`   ❌ No document found for subtopicId: ${subtopicId}`);
            return { updated: false, message: "No parent document found" };
        }

        // Check if this is a main document
        if (parentDoc._id.toString() === subtopicId || parentDoc._id === subtopicId) {
            console.log(`   📝 This appears to be a MAIN document`);
            const result = await collection.updateOne(
                { "_id": parentDoc._id },
                {
                    $set: {
                        aiVideoUrl: videoUrl,
                        updatedAt: new Date(),
                        videoStorage: videoUrl.includes('amazonaws.com') ? "aws_s3" : "d_id",
                        s3Path: videoUrl.includes('amazonaws.com') ? videoUrl.split('.com/')[1] : null
                    }
                }
            );
            
            if (result.matchedCount > 0) {
                console.log(`   ✅ Updated MAIN document. Matched: ${result.matchedCount}, Modified: ${result.modifiedCount}`);
                return { 
                    updated: true, 
                    location: "main_document",
                    matchedCount: result.matchedCount,
                    modifiedCount: result.modifiedCount,
                    parentId: parentDoc._id,
                    collectionName: collection.collectionName
                };
            }
        }

        // If it's in units array
        if (parentDoc.units && Array.isArray(parentDoc.units)) {
            console.log(`   🔧 Updating in units array using positional operator...`);
            const result = await collection.updateOne(
                { 
                    "_id": parentDoc._id,
                    "units._id": subtopicId
                },
                {
                    $set: {
                        "units.$.aiVideoUrl": videoUrl,
                        "units.$.updatedAt": new Date(),
                        "units.$.videoStorage": videoUrl.includes('amazonaws.com') ? "aws_s3" : "d_id",
                        "units.$.s3Path": videoUrl.includes('amazonaws.com') ? videoUrl.split('.com/')[1] : null
                    }
                }
            );
            
            console.log(`   📊 Update result - Matched: ${result.matchedCount}, Modified: ${result.modifiedCount}`);
            
            if (result.matchedCount > 0) {
                return { 
                    updated: true, 
                    location: "nested_units_array",
                    matchedCount: result.matchedCount,
                    modifiedCount: result.modifiedCount,
                    parentId: parentDoc._id,
                    collectionName: collection.collectionName
                };
            }
        }
        
        return { updated: false, message: "Could not update document" };
        
    } catch (error) {
        console.error(`   ❌ Error updating: ${error.message}`);
        return { updated: false, message: error.message };
    }
}

// ✅ AWS S3 Upload Function - FIXED: Returns immediately with job ID
async function uploadToS3(videoUrl, filename) {
    try {
        console.log("\n☁️ [S3 UPLOAD] Starting S3 upload...");
        
        // Download video from D-ID
        console.log(`   📥 Downloading from D-ID: ${videoUrl}`);
        const response = await axios({
            method: 'GET',
            url: videoUrl,
            responseType: 'arraybuffer',
            timeout: 120000,
        });

        console.log(`   ✅ Video downloaded, size: ${response.data.length} bytes`);

        // Upload to S3
        const key = `${S3_FOLDER_PATH}${filename}`;
        console.log(`   🔑 S3 Key: ${key}`);
        
        const command = new PutObjectCommand({
            Bucket: S3_BUCKET_NAME,
            Key: key,
            Body: response.data,
            ContentType: 'video/mp4',
            ACL: 'public-read'
        });

        await s3Client.send(command);
        console.log(`   ✅ Upload to S3 successful`);

        // Return S3 URL
        const region = process.env.AWS_REGION || 'ap-south-1';
        const s3Url = `https://${S3_BUCKET_NAME}.s3.${region}.amazonaws.com/${key}`;
        console.log(`   🔗 S3 Public URL: ${s3Url}`);

        return s3Url;
    } catch (error) {
        console.error(`   ❌ S3 upload failed: ${error.message}`);
        throw error;
    }
}

// ✅ Dynamic voice selection
function getVoiceForPresenter(presenter_id) {
    const voiceMap = {
        "v2_public_anita@Os4oKCBIgZ": "en-IN-NeerjaNeural",
        "v2_public_lucas@vngv2djh6d": "en-US-GuyNeural",
        "v2_public_rian_red_jacket_lobby@Lnoj8R5x9r": "en-GB-RyanNeural"
    };
    return voiceMap[presenter_id] || "en-US-JennyNeural";
}

// ✅ Job status tracking - IMPORTANT: Store in memory
const jobStatus = new Map();

// ✅ FIXED: Video generation endpoint - Returns immediately
app.post("/generate-and-upload", async (req, res) => {
    try {
        const {
            subtopic,
            description,
            questions = [],
            presenter_id = "v2_public_anita@Os4oKCBIgZ",
            subtopicId,
            parentId,
            rootId,
            dbname = "professional",
            subjectName
        } = req.body;

        console.log("\n🎬 [VIDEO GENERATION] Starting video generation:");
        console.log(`   📝 Subtopic: ${subtopic}`);
        console.log(`   🎯 Subtopic ID: ${subtopicId}`);

        const jobId = Date.now().toString();

        // Store initial job status
        jobStatus.set(jobId, {
            status: 'processing',
            subtopic: subtopic,
            startedAt: new Date(),
            questions: questions.length,
            presenter: presenter_id,
            subtopicId: subtopicId,
            dbname: dbname,
            subjectName: subjectName,
            parentId: parentId,
            rootId: rootId
        });

        // Return immediate response - THIS IS KEY!
        res.json({
            status: "processing",
            message: "AI video generation started",
            job_id: jobId,
            subtopic: subtopic,
            note: "Use /api/job-status/:jobId to check progress"
        });

        // Process in background - non-blocking
        setTimeout(() => {
            processVideoJob(jobId, {
                subtopic,
                description,
                questions,
                presenter_id,
                subtopicId,
                parentId,
                rootId,
                dbname,
                subjectName
            });
        }, 100);

    } catch (err) {
        console.error("❌ Error starting video generation:", err);
        res.status(500).json({ error: "Failed to start video generation: " + err.message });
    }
});

// ✅ FIXED: Background video processing - Optimized and non-blocking
async function processVideoJob(jobId, { subtopic, description, questions, presenter_id, subtopicId, parentId, rootId, dbname, subjectName }) {
    const MAX_POLLS = 120; // Increased to 10 minutes max

    try {
        console.log(`\n🔄 [JOB ${jobId}] Processing video for: ${subtopic}`);

        const selectedVoice = getVoiceForPresenter(presenter_id);

        let cleanScript = description;
        cleanScript = cleanScript.replace(/<[^>]*>/g, '');

        if (questions.length > 0) {
            cleanScript += "\n\nNow, let me ask you some questions to test your understanding. ";
            cleanScript += "After each question, I'll pause so you can say your answer out loud, and then I'll tell you if you're correct.\n\n";

            questions.forEach((q, index) => {
                cleanScript += `Question ${index + 1}: ${q.question} `;
                cleanScript += `... [5 second pause] ... `;
                cleanScript += `The correct answer is: ${q.answer}. `;

                if (index === questions.length - 1) {
                    cleanScript += `Great job answering all the questions! `;
                } else {
                    cleanScript += `Let's try the next question. `;
                }
            });
            cleanScript += "Excellent work! You've completed all the practice questions.";
        }

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

        // Update job status
        jobStatus.set(jobId, {
            ...jobStatus.get(jobId),
            progress: 'Calling D-ID API...'
        });

        console.log("⏳ Calling D-ID API...");
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
        console.log(`⏳ Clip created with ID: ${clipId}`);

        // Update job status
        jobStatus.set(jobId, {
            ...jobStatus.get(jobId),
            progress: 'Video rendering...',
            clipId: clipId
        });

        let status = clipResponse.data.status;
        let videoUrl = "";
        let pollCount = 0;

        // Poll for D-ID completion
        while (status !== "done" && status !== "error" && pollCount < MAX_POLLS) {
            await new Promise(r => setTimeout(r, 5000)); // Increased to 5 seconds
            pollCount++;

            try {
                const poll = await axios.get(`https://api.d-id.com/clips/${clipId}`, {
                    headers: { Authorization: DID_API_KEY },
                    timeout: 30000,
                });

                status = poll.data.status;
                console.log(`📊 Poll ${pollCount}/${MAX_POLLS}: ${status}`);

                // Update job status
                jobStatus.set(jobId, {
                    ...jobStatus.get(jobId),
                    progress: `D-ID processing... (${pollCount}/${MAX_POLLS})`,
                    currentStatus: status
                });

                if (status === "done") {
                    videoUrl = poll.data.result_url;
                    console.log(`✅ D-ID Video generated: ${videoUrl}`);

                    // Start S3 upload in background
                    uploadToS3AndSave(jobId, videoUrl, {
                        subtopic,
                        subtopicId,
                        parentId,
                        rootId,
                        dbname,
                        subjectName
                    });
                    
                    break;

                } else if (status === "error") {
                    throw new Error("D-ID clip generation failed: " + (poll.data.error?.message || "Unknown error"));
                }
            } catch (pollError) {
                console.warn(`⚠️ Poll ${pollCount} failed:`, pollError.message);
            }
        }

        if (status !== "done") {
            throw new Error(`D-ID video generation timeout after ${pollCount} polls`);
        }

    } catch (error) {
        console.error("❌ Video generation failed:", error);
        jobStatus.set(jobId, {
            ...jobStatus.get(jobId),
            status: 'failed',
            error: error.message,
            failedAt: new Date()
        });
    }
}

// ✅ NEW: Separate function for S3 upload and database save
async function uploadToS3AndSave(jobId, dIdVideoUrl, { subtopic, subtopicId, parentId, rootId, dbname, subjectName }) {
    try {
        console.log(`\n☁️ [JOB ${jobId}] Starting S3 upload and save...`);
        
        // Update job status
        jobStatus.set(jobId, {
            ...jobStatus.get(jobId),
            progress: 'Uploading to AWS S3...',
            dIdVideoUrl: dIdVideoUrl
        });

        try {
            // Generate unique filename
            const timestamp = Date.now();
            const safeSubtopicName = subtopic.replace(/[^a-zA-Z0-9]/g, '_').substring(0, 50);
            const filename = `ai_video_${safeSubtopicName}_${timestamp}.mp4`;

            console.log(`📄 Uploading to S3 with filename: ${filename}`);

            // Upload to AWS S3
            const s3Url = await uploadToS3(dIdVideoUrl, filename);
            console.log(`✅ S3 Upload successful: ${s3Url}`);

            // Update job status
            jobStatus.set(jobId, {
                ...jobStatus.get(jobId),
                progress: 'Saving to database...',
                s3Url: s3Url
            });

            // ✅ Save S3 URL to database
            if (s3Url && subtopicId) {
                console.log("\n💾 Saving S3 URL to database...");
                
                const dbConn = getDB(dbname);
                let targetCollections;
                
                if (subjectName) {
                    targetCollections = [subjectName];
                    console.log(`🔍 Using specific collection: ${subjectName}`);
                } else {
                    const collections = await dbConn.listCollections().toArray();
                    targetCollections = collections.map(c => c.name);
                    console.log(`🔍 Searching in collections: ${targetCollections.join(', ')}`);
                }

                let updated = false;
                let updateLocation = "not_found";
                let updatedCollection = "unknown";

                for (const collectionName of targetCollections) {
                    console.log(`\n🔍 Processing collection: ${collectionName}`);
                    const collection = dbConn.collection(collectionName);

                    const updateResult = await updateNestedSubtopicInUnits(collection, subtopicId, s3Url);
                    if (updateResult.updated) {
                        updated = true;
                        updateLocation = updateResult.location;
                        updatedCollection = collectionName;
                        console.log(`✅ SUCCESS in ${collectionName} at ${updateLocation}`);
                        break;
                    } else {
                        console.log(`   ❌ Not found in ${collectionName}`);
                    }
                }

                if (updated) {
                    console.log(`\n🎉 S3 URL saved to database in ${updatedCollection} at ${updateLocation}`);
                    
                    jobStatus.set(jobId, {
                        status: 'completed',
                        subtopic: subtopic,
                        videoUrl: s3Url,
                        s3Url: s3Url,
                        dIdUrl: dIdVideoUrl,
                        completedAt: new Date(),
                        storedIn: 'aws_s3',
                        databaseUpdated: true,
                        updateLocation: updateLocation,
                        collection: updatedCollection,
                        message: 'Video generated, uploaded to S3, and saved to database successfully'
                    });

                    console.log("✅ PROCESS COMPLETE!");
                } else {
                    console.log("\n⚠️ COULD NOT SAVE TO DATABASE!");
                    
                    jobStatus.set(jobId, {
                        status: 'completed',
                        subtopic: subtopic,
                        videoUrl: s3Url,
                        s3Url: s3Url,
                        dIdUrl: dIdVideoUrl,
                        completedAt: new Date(),
                        storedIn: 'aws_s3',
                        databaseUpdated: false,
                        note: 'Subtopic not found in database',
                        s3UrlForManualSave: s3Url,
                        subtopicIdForManualSave: subtopicId
                    });
                }
            }
        } catch (uploadError) {
            console.error("❌ S3 upload failed:", uploadError);
            
            // Fall back to D-ID URL
            console.log("🔄 Falling back to D-ID URL");
            
            jobStatus.set(jobId, {
                status: 'completed',
                subtopic: subtopic,
                videoUrl: dIdVideoUrl,
                completedAt: new Date(),
                storedIn: 'd_id',
                databaseUpdated: false,
                error: 'S3 upload failed, using D-ID URL',
                dIdUrl: dIdVideoUrl
            });
        }

    } catch (error) {
        console.error(`❌ S3 upload and save failed for job ${jobId}:`, error);
        jobStatus.set(jobId, {
            ...jobStatus.get(jobId),
            status: 'failed',
            error: 'S3 upload and save failed: ' + error.message,
            failedAt: new Date()
        });
    }
}

// ✅ Job Status Endpoint
app.get("/api/job-status/:jobId", (req, res) => {
    try {
        const { jobId } = req.params;
        const status = jobStatus.get(jobId);

        if (!status) {
            return res.status(404).json({
                error: "Job not found",
                jobId: jobId
            });
        }

        // Clean up old jobs (older than 1 hour)
        if (status.status === 'completed' || status.status === 'failed') {
            const oneHourAgo = Date.now() - 3600000;
            if (status.completedAt && new Date(status.completedAt).getTime() < oneHourAgo) {
                jobStatus.delete(jobId);
            }
        }

        res.json(status);
    } catch (error) {
        console.error("❌ Job status check failed:", error);
        res.status(500).json({ error: "Failed to check job status" });
    }
});

// ✅ Manual save endpoint
app.post("/api/upload-to-s3-and-save", async (req, res) => {
    console.log("\n📤 [MANUAL SAVE] Manual save request");
    
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

        console.log("📝 Manual save details:", { 
            subtopicId, 
            subtopic,
            videoUrl: videoUrl ? `${videoUrl.substring(0, 50)}...` : 'None'
        });

        if (!videoUrl || !subtopicId) {
            return res.status(400).json({
                success: false,
                error: "Missing videoUrl or subtopicId"
            });
        }

        // Save to database
        const dbConn = getDB(dbname);
        let targetCollections;
        
        if (subjectName) {
            targetCollections = [subjectName];
            console.log(`🔍 Using specific collection: ${subjectName}`);
        } else {
            const collections = await dbConn.listCollections().toArray();
            targetCollections = collections.map(c => c.name);
            console.log(`🔍 Searching in ALL collections: ${targetCollections.join(', ')}`);
        }

        let updated = false;
        let updateLocation = "not_found";
        let updatedCollection = "unknown";

        for (const collectionName of targetCollections) {
            console.log(`\n🔍 Processing collection: ${collectionName}`);
            const collection = dbConn.collection(collectionName);

            const updateResult = await updateNestedSubtopicInUnits(collection, subtopicId, videoUrl);
            if (updateResult.updated) {
                updated = true;
                updateLocation = updateResult.location;
                updatedCollection = collectionName;
                console.log(`✅ SUCCESS in ${collectionName}`);
                break;
            }
        }

        console.log(`\n📊 Manual save result: ${updated ? 'SUCCESS' : 'FAILED'}`);

        if (updated) {
            res.json({
                success: true,
                s3_url: videoUrl,
                stored_in: "database",
                database_updated: true,
                location: updateLocation,
                collection: updatedCollection,
                message: `Video URL saved to database successfully in ${updatedCollection}`
            });
        } else {
            res.json({
                success: false,
                s3_url: videoUrl,
                stored_in: "s3_only",
                database_updated: false,
                location: updateLocation,
                collection: "none",
                message: "Video URL NOT saved to database - subtopic not found"
            });
        }

    } catch (error) {
        console.error("❌ Manual save failed:", error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// ✅ DEBUG: List all collections
app.get("/api/debug-collections", async (req, res) => {
    try {
        const { dbname = "professional" } = req.query;
        const dbConn = getDB(dbname);
        const collections = await dbConn.listCollections().toArray();
        
        res.json({
            database: dbname,
            collections: collections.map(c => c.name),
            count: collections.length
        });
    } catch (error) {
        console.error("❌ Error listing collections:", error);
        res.status(500).json({ error: error.message });
    }
});

// ✅ DEBUG: Search for subtopic
app.get("/api/debug-subtopic/:subtopicId", async (req, res) => {
    try {
        const { subtopicId } = req.params;
        const { dbname = "professional" } = req.query;

        console.log(`🔍 Debug find subtopic: ${subtopicId}`);

        const dbConn = getDB(dbname);
        const collections = await dbConn.listCollections().toArray();
        
        let foundDoc = null;
        let foundCollection = "";
        
        for (const coll of collections) {
            const collection = dbConn.collection(coll.name);
            const doc = await collection.findOne({
                $or: [
                    { "_id": subtopicId },
                    { "units._id": subtopicId },
                    { "id": subtopicId }
                ]
            });
            
            if (doc) {
                foundDoc = doc;
                foundCollection = coll.name;
                break;
            }
        }
        
        res.json({
            found: !!foundDoc,
            collection: foundCollection,
            subtopic: foundDoc
        });

    } catch (err) {
        console.error("❌ Debug find error:", err);
        res.status(500).json({ error: err.message });
    }
});

// ✅ Health check
app.get("/health", (req, res) => {
    res.json({
        status: "OK",
        timestamp: new Date().toISOString(),
        service: "AI Video Generator with S3 Storage",
        activeJobs: jobStatus.size,
        endpoints: [
            "POST /generate-and-upload",
            "GET /api/job-status/:jobId",
            "POST /api/upload-to-s3-and-save",
            "GET /health"
        ]
    });
});

// ✅ Create assets directory
function ensureAssetsDirectory() {
    const assetsDir = path.join(__dirname, 'assets', 'ai_video');
    if (!fs.existsSync(assetsDir)) {
        fs.mkdirSync(assetsDir, { recursive: true });
        console.log("📁 Created assets directory:", assetsDir);
    }
}

// ✅ Start server
ensureAssetsDirectory();
app.listen(PORT, "0.0.0.0", () => {
    console.log(`\n✅ Server running on http://0.0.0.0:${PORT}`);
    console.log(`☁️ AWS S3 Configuration:`);
    console.log(`   Bucket: ${S3_BUCKET_NAME}`);
    console.log(`   Folder: ${S3_FOLDER_PATH}`);
    console.log(`\n✅ Available Endpoints:`);
    console.log(`   POST /generate-and-upload`);
    console.log(`   GET /api/job-status/:jobId`);
    console.log(`   POST /api/upload-to-s3-and-save`);
    console.log(`   GET /health`);
});
