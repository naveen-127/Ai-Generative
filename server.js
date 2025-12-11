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
    req.setTimeout(300000); // 5 minutes
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

// ✅ HeyGen API Configuration
const HYGEN_API_KEY = process.env.HYGEN_API_KEY;
const HYGEN_API_URL = process.env.HYGEN_API_URL || 'https://api.heygen.com';

if (!HYGEN_API_KEY) {
    console.warn("⚠️ HYGEN_API_KEY not found in .env file. HeyGen API calls will fail.");
}

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

// ✅ Job status tracking (in-memory for now, can move to DB for persistence)
const jobStatus = new Map();

// ✅ FIXED: Simple Quick Response Endpoint
app.post("/generate-hygen-video", async (req, res) => {
    try {
        const {
            subtopic,
            description,
            questions = [],
            subtopicId,
            parentId,
            rootId,
            dbname = "professional",
            subjectName,
            avatar = "anna"
        } = req.body;

        console.log("\n🎬 [HEYGEN VIDEO GENERATION] Starting video generation:");
        console.log(`   📝 Subtopic: ${subtopic}`);
        console.log(`   🎯 Subtopic ID: ${subtopicId}`);
        console.log(`   📁 Database: ${dbname}`);

        // Generate job ID
        const jobId = `hygen_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

        // Store initial job status
        jobStatus.set(jobId, {
            status: 'queued',
            subtopic: subtopic,
            startedAt: new Date(),
            questions: questions.length,
            avatar: avatar,
            subtopicId: subtopicId,
            progress: 'Job queued for processing'
        });

        // IMMEDIATE RESPONSE - don't wait for processing
        res.json({
            success: true,
            status: "queued",
            message: "HeyGen AI video generation started in background",
            job_id: jobId,
            subtopic: subtopic,
            note: "Video will be processed in background. Use /api/job-status/:jobId to check progress.",
            estimated_time: "2-3 minutes"
        });

        // Start background processing ASYNCHRONOUSLY
        setTimeout(() => {
            processHygenVideoJob(jobId, {
                subtopic,
                description,
                questions,
                subtopicId,
                parentId,
                rootId,
                dbname,
                subjectName,
                avatar
            });
        }, 100);

    } catch (err) {
        console.error("❌ Error starting HeyGen video generation:", err);
        res.status(500).json({ 
            success: false,
            error: "Failed to start video generation: " + err.message 
        });
    }
});

// ✅ FIXED: Update nested subtopic in units array
async function updateNestedSubtopicInUnits(collection, subtopicId, videoUrl) {
    console.log(`\n🔍 [DB UPDATE] Searching for subtopicId: ${subtopicId}`);
    
    try {
        // Convert string to ObjectId if it's a valid ObjectId
        let objectId;
        try {
            objectId = new ObjectId(subtopicId);
        } catch {
            objectId = subtopicId;
        }

        const queryStrategies = [
            { "units._id": objectId },
            { "units._id": subtopicId },
            { "_id": objectId },
            { "_id": subtopicId },
            { "units.id": subtopicId }
        ];

        let parentDoc = null;
        for (const query of queryStrategies) {
            console.log(`   🔍 Trying query:`, query);
            parentDoc = await collection.findOne(query);
            if (parentDoc) {
                console.log(`   ✅ Found document`);
                break;
            }
        }

        if (!parentDoc) {
            console.log(`   ❌ No document found for subtopicId: ${subtopicId}`);
            return { updated: false, message: "No parent document found" };
        }

        // Check if this is a main document
        if (parentDoc._id.toString() === subtopicId || parentDoc._id.equals?.(objectId) || parentDoc._id === subtopicId) {
            console.log(`   📝 Updating MAIN document`);
            const result = await collection.updateOne(
                { "_id": parentDoc._id },
                {
                    $set: {
                        aiVideoUrl: videoUrl,
                        updatedAt: new Date(),
                        videoStorage: "aws_s3",
                        s3Path: videoUrl.includes('amazonaws.com') ? videoUrl.split('.com/')[1] : null
                    }
                }
            );
            
            if (result.matchedCount > 0) {
                return { 
                    updated: true, 
                    location: "main_document",
                    collectionName: collection.collectionName
                };
            }
        }

        // Check if it's in units array
        if (parentDoc.units && Array.isArray(parentDoc.units)) {
            console.log(`   🔧 Updating in units array...`);
            const result = await collection.updateOne(
                { 
                    "_id": parentDoc._id,
                    "units._id": objectId
                },
                {
                    $set: {
                        "units.$.aiVideoUrl": videoUrl,
                        "units.$.updatedAt": new Date(),
                        "units.$.videoStorage": "aws_s3",
                        "units.$.s3Path": videoUrl.includes('amazonaws.com') ? videoUrl.split('.com/')[1] : null
                    }
                }
            );
            
            if (result.matchedCount > 0) {
                return { 
                    updated: true, 
                    location: "nested_units_array",
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

// ✅ AWS S3 Upload Function
async function uploadToS3(videoBuffer, filename) {
    try {
        console.log("\n☁️ [S3 UPLOAD] Starting S3 upload...");
        console.log(`   📁 Bucket: ${S3_BUCKET_NAME}`);
        console.log(`   📁 Folder: ${S3_FOLDER_PATH}`);
        console.log(`   📄 Filename: ${filename}`);

        const key = `${S3_FOLDER_PATH}${filename}`;
        console.log(`   🔑 S3 Key: ${key}`);
        
        const command = new PutObjectCommand({
            Bucket: S3_BUCKET_NAME,
            Key: key,
            Body: videoBuffer,
            ContentType: 'video/mp4',
            ACL: 'public-read'
        });

        await s3Client.send(command);
        console.log(`   ✅ Upload to S3 successful`);

        const region = process.env.AWS_REGION || 'ap-south-1';
        const s3Url = `https://${S3_BUCKET_NAME}.s3.${region}.amazonaws.com/${key}`;
        console.log(`   🔗 S3 Public URL: ${s3Url}`);

        return s3Url;
    } catch (error) {
        console.error(`   ❌ S3 upload failed: ${error.message}`);
        throw error;
    }
}

// ✅ Download video from URL
async function downloadVideo(videoUrl) {
    try {
        console.log(`   📥 Downloading video from: ${videoUrl}`);
        
        const response = await axios({
            method: 'GET',
            url: videoUrl,
            responseType: 'arraybuffer',
            timeout: 120000,
            headers: {
                'Accept': 'video/*',
                'User-Agent': 'Mozilla/5.0'
            }
        });

        console.log(`   ✅ Video downloaded, size: ${response.data.length} bytes`);
        return response.data;
    } catch (error) {
        console.error(`   ❌ Video download failed: ${error.message}`);
        throw error;
    }
}

// ✅ HeyGen API: Generate Video (SIMPLIFIED VERSION)
async function generateHygenVideo(script, subtopic, avatar = "anna") {
    try {
        if (!HYGEN_API_KEY) {
            throw new Error("HeyGen API key is not configured");
        }

        console.log("\n🎬 [HEYGEN API] Generating video...");
        console.log(`   📝 Script length: ${script.length} characters`);
        
        // Check available avatars - you might need to adjust this
        const validAvatars = ["anna", "lisa", "chris", "alice", "brian"];
        const selectedAvatar = validAvatars.includes(avatar) ? avatar : "anna";
        
        // HeyGen API v2 format
        const requestData = {
            video_inputs: [{
                character: {
                    type: "avatar",
                    avatar_id: selectedAvatar,
                    avatar_style: "normal"
                },
                voice: {
                    type: "text",
                    input_text: script,
                    voice_id: "1bd001e7e50f421d891986aad5158bc8" // Default English voice
                },
                background: {
                    type: "color",
                    value: "#FFFFFF"
                }
            }],
            aspect_ratio: "16:9",
            test: false,
            caption: false
        };

        console.log("⏳ Calling HeyGen API...");
        const response = await axios.post(
            `${HYGEN_API_URL}/v2/video/generate`,
            requestData,
            {
                headers: {
                    'X-Api-Key': HYGEN_API_KEY,
                    'Content-Type': 'application/json'
                },
                timeout: 300000 // 5 minutes
            }
        );

        console.log("✅ HeyGen video generation request successful");
        
        if (!response.data.data || !response.data.data.video_id) {
            throw new Error("Invalid response from HeyGen API");
        }
        
        const videoId = response.data.data.video_id;
        console.log(`📹 Video ID: ${videoId}`);
        
        return videoId;

    } catch (error) {
        console.error("❌ HeyGen API call failed:", error.response?.data || error.message);
        throw error;
    }
}

// ✅ Poll HeyGen video status
async function pollHygenVideoStatus(videoId, jobId) {
    const MAX_POLLS = 120; // 120 polls * 5 seconds = 10 minutes max
    let pollCount = 0;
    
    console.log(`⏳ Polling HeyGen video status for video_id: ${videoId}`);
    
    while (pollCount < MAX_POLLS) {
        await new Promise(r => setTimeout(r, 5000)); // Poll every 5 seconds
        pollCount++;
        
        // Update job status
        jobStatus.set(jobId, {
            ...jobStatus.get(jobId),
            progress: `Polling HeyGen API (${pollCount}/${MAX_POLLS})`,
            polls: pollCount
        });
        
        try {
            const statusResponse = await axios.get(
                `${HYGEN_API_URL}/v1/video_status/get?video_id=${videoId}`,
                {
                    headers: {
                        'X-Api-Key': HYGEN_API_KEY
                    },
                    timeout: 30000
                }
            );
            
            if (statusResponse.data.data) {
                const status = statusResponse.data.data.status;
                console.log(`📊 Poll ${pollCount}/${MAX_POLLS}: Status = ${status}`);
                
                if (status === "completed") {
                    const videoUrl = statusResponse.data.data.video_url;
                    console.log(`✅ HeyGen video ready: ${videoUrl}`);
                    return videoUrl;
                } else if (status === "failed") {
                    throw new Error("HeyGen video generation failed");
                }
            }
            
        } catch (error) {
            console.warn(`⚠️ Poll ${pollCount} failed:`, error.message);
            
            // Try alternative endpoint after some polls
            if (pollCount >= 20 && pollCount % 10 === 0) {
                try {
                    const altResponse = await axios.get(
                        `${HYGEN_API_URL}/v1/video/${videoId}`,
                        {
                            headers: {
                                'X-Api-Key': HYGEN_API_KEY
                            },
                            timeout: 30000
                        }
                    );
                    
                    if (altResponse.data.data && altResponse.data.data.video_url) {
                        console.log(`✅ Got video URL from alternative endpoint`);
                        return altResponse.data.data.video_url;
                    }
                } catch (altError) {
                    console.warn(`⚠️ Alternative endpoint also failed:`, altError.message);
                }
            }
        }
    }
    
    throw new Error(`HeyGen video generation timeout after ${pollCount} polls`);
}

// ✅ Background Job Processing
async function processHygenVideoJob(jobId, params) {
    const { subtopic, description, questions, subtopicId, dbname, subjectName, avatar } = params;
    
    try {
        console.log(`\n🔄 [JOB ${jobId}] Processing HeyGen video for: ${subtopic}`);
        
        // Update job status
        jobStatus.set(jobId, {
            ...jobStatus.get(jobId),
            status: 'processing',
            progress: 'Preparing script...'
        });

        // Prepare script
        let cleanScript = description.replace(/<[^>]*>/g, '');
        
        if (questions.length > 0) {
            cleanScript += "\n\nNow, let me ask you some questions to test your understanding.";
            questions.forEach((q, index) => {
                cleanScript += ` Question ${index + 1}: ${q.question}. The correct answer is: ${q.answer}.`;
            });
        }

        // Step 1: Generate video with HeyGen
        jobStatus.set(jobId, {
            ...jobStatus.get(jobId),
            progress: 'Calling HeyGen API...'
        });

        const videoId = await generateHygenVideo(cleanScript, subtopic, avatar);
        
        jobStatus.set(jobId, {
            ...jobStatus.get(jobId),
            videoId: videoId,
            progress: 'Waiting for video to render...'
        });

        // Step 2: Poll for video completion
        const hygenVideoUrl = await pollHygenVideoStatus(videoId, jobId);
        
        // Step 3: Download and upload to S3
        jobStatus.set(jobId, {
            ...jobStatus.get(jobId),
            progress: 'Downloading video from HeyGen...'
        });

        console.log("\n☁️ Starting S3 upload process...");
        
        // Generate unique filename
        const timestamp = Date.now();
        const safeSubtopicName = subtopic.replace(/[^a-zA-Z0-9]/g, '_').substring(0, 50);
        const filename = `hygen_video_${safeSubtopicName}_${timestamp}.mp4`;

        jobStatus.set(jobId, {
            ...jobStatus.get(jobId),
            progress: 'Uploading to AWS S3...'
        });

        // Download video from HeyGen
        const videoBuffer = await downloadVideo(hygenVideoUrl);
        
        // Upload to S3
        const s3Url = await uploadToS3(videoBuffer, filename);
        console.log(`✅ S3 Upload successful: ${s3Url}`);

        // Step 4: Save to database
        jobStatus.set(jobId, {
            ...jobStatus.get(jobId),
            progress: 'Saving to database...'
        });

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
                console.log(`🔍 Searching in ALL collections: ${targetCollections.join(', ')}`);
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
                    updatedCollection = updateResult.collectionName || collectionName;
                    console.log(`✅ SUCCESS in ${updatedCollection} at ${updateLocation}`);
                    break;
                }
            }

            if (updated) {
                console.log(`🎉 S3 URL saved to database in ${updatedCollection} at ${updateLocation}`);
                
                jobStatus.set(jobId, {
                    status: 'completed',
                    subtopic: subtopic,
                    videoUrl: s3Url,
                    s3Url: s3Url,
                    completedAt: new Date(),
                    questions: questions.length,
                    avatar: avatar,
                    storedIn: 'aws_s3',
                    databaseUpdated: true,
                    updateLocation: updateLocation,
                    collection: updatedCollection,
                    message: 'HeyGen video uploaded to S3 and saved to database successfully'
                });
                
                console.log("✅ PROCESS COMPLETE: HeyGen video saved to S3 and database!");
            } else {
                console.log("\n⚠️ COULD NOT SAVE TO DATABASE!");
                console.log(`   Subtopic ID: ${subtopicId}`);
                console.log(`   Database: ${dbname}`);
                
                jobStatus.set(jobId, {
                    status: 'completed',
                    subtopic: subtopic,
                    videoUrl: s3Url,
                    s3Url: s3Url,
                    completedAt: new Date(),
                    questions: questions.length,
                    avatar: avatar,
                    storedIn: 'aws_s3',
                    databaseUpdated: false,
                    note: 'Subtopic not found in database',
                    s3UrlForManualSave: s3Url,
                    subtopicIdForManualSave: subtopicId
                });
            }
        } else {
            throw new Error("Missing S3 URL or subtopic ID");
        }

    } catch (error) {
        console.error("❌ HeyGen video generation failed:", error);
        jobStatus.set(jobId, {
            ...jobStatus.get(jobId),
            status: 'failed',
            error: error.message,
            failedAt: new Date(),
            progress: `Failed: ${error.message}`
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
                success: false,
                error: "Job not found",
                jobId: jobId
            });
        }

        res.json({
            success: true,
            ...status,
            jobId: jobId,
            elapsed: status.startedAt ? (new Date() - new Date(status.startedAt)) / 1000 : 0
        });
    } catch (error) {
        console.error("❌ Job status check failed:", error);
        res.status(500).json({ 
            success: false,
            error: "Failed to check job status" 
        });
    }
});

// ✅ Manual Save Endpoint
app.post("/api/save-to-db", async (req, res) => {
    try {
        const {
            videoUrl,
            subtopic,
            subtopicId,
            dbname = "professional",
            subjectName
        } = req.body;

        console.log("\n📤 [MANUAL SAVE] Manual save request");

        if (!videoUrl || !subtopicId) {
            return res.status(400).json({
                success: false,
                error: "Missing videoUrl or subtopicId"
            });
        }

        const dbConn = getDB(dbname);
        let targetCollections;
        
        if (subjectName) {
            targetCollections = [subjectName];
        } else {
            const collections = await dbConn.listCollections().toArray();
            targetCollections = collections.map(c => c.name);
        }

        let updated = false;
        let updateLocation = "not_found";
        let updatedCollection = "unknown";

        for (const collectionName of targetCollections) {
            const collection = dbConn.collection(collectionName);
            const updateResult = await updateNestedSubtopicInUnits(collection, subtopicId, videoUrl);
            if (updateResult.updated) {
                updated = true;
                updateLocation = updateResult.location;
                updatedCollection = collectionName;
                break;
            }
        }

        if (updated) {
            res.json({
                success: true,
                s3_url: videoUrl,
                stored_in: "database",
                database_updated: true,
                location: updateLocation,
                collection: updatedCollection,
                message: `S3 URL saved to database successfully in ${updatedCollection}`
            });
        } else {
            res.json({
                success: false,
                s3_url: videoUrl,
                stored_in: "s3_only",
                database_updated: false,
                message: "S3 URL NOT saved to database - subtopic not found"
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

// ✅ DEBUG endpoints
app.get("/api/debug-collections", async (req, res) => {
    try {
        const { dbname = "professional" } = req.query;
        const dbConn = getDB(dbname);
        const collections = await dbConn.listCollections().toArray();
        
        res.json({
            success: true,
            database: dbname,
            collections: collections.map(c => c.name),
            count: collections.length
        });
    } catch (error) {
        res.status(500).json({ 
            success: false,
            error: error.message 
        });
    }
});

app.get("/api/debug-find-doc", async (req, res) => {
    try {
        const { 
            subtopicId, 
            dbname = "professional",
            collectionName 
        } = req.query;

        const dbConn = getDB(dbname);
        
        if (collectionName) {
            const collection = dbConn.collection(collectionName);
            const doc = await collection.findOne({
                $or: [
                    { "_id": new ObjectId(subtopicId) },
                    { "_id": subtopicId },
                    { "units._id": new ObjectId(subtopicId) },
                    { "units._id": subtopicId },
                    { "units.id": subtopicId }
                ]
            });
            
            res.json({
                success: true,
                found: !!doc,
                collection: collectionName,
                document: doc
            });
        } else {
            const collections = await dbConn.listCollections().toArray();
            let foundDoc = null;
            let foundCollection = "";
            
            for (const coll of collections) {
                const collection = dbConn.collection(coll.name);
                const doc = await collection.findOne({
                    $or: [
                        { "_id": new ObjectId(subtopicId) },
                        { "_id": subtopicId },
                        { "units._id": new ObjectId(subtopicId) },
                        { "units._id": subtopicId },
                        { "units.id": subtopicId }
                    ]
                });
                
                if (doc) {
                    foundDoc = doc;
                    foundCollection = coll.name;
                    break;
                }
            }
            
            res.json({
                success: true,
                found: !!foundDoc,
                collection: foundCollection,
                document: foundDoc
            });
        }

    } catch (err) {
        res.status(500).json({ 
            success: false,
            error: err.message 
        });
    }
});

// ✅ Clear old jobs (cleanup function)
function cleanupOldJobs() {
    const twentyFourHoursAgo = Date.now() - (24 * 60 * 60 * 1000);
    for (const [jobId, job] of jobStatus.entries()) {
        if (job.startedAt && new Date(job.startedAt).getTime() < twentyFourHoursAgo) {
            jobStatus.delete(jobId);
        }
    }
}

// ✅ Health check
app.get("/health", (req, res) => {
    cleanupOldJobs();
    
    res.json({
        status: "OK",
        timestamp: new Date().toISOString(),
        service: "HeyGen AI Video Generator with S3 Storage",
        active_jobs: jobStatus.size,
        endpoints: [
            "POST /generate-hygen-video",
            "POST /api/save-to-db",
            "GET /api/job-status/:jobId",
            "GET /api/debug-collections",
            "GET /api/debug-find-doc",
            "GET /health"
        ],
        s3: {
            bucket: S3_BUCKET_NAME,
            folder: S3_FOLDER_PATH,
            region: process.env.AWS_REGION || 'ap-south-1'
        },
        hygen: {
            configured: !!HYGEN_API_KEY
        }
    });
});

// ✅ Start server
app.listen(PORT, "0.0.0.0", () => {
    console.log(`\n✅ Server running on http://0.0.0.0:${PORT}`);
    console.log(`☁️ AWS S3 Configuration:`);
    console.log(`   Bucket: ${S3_BUCKET_NAME}`);
    console.log(`   Folder: ${S3_FOLDER_PATH}`);
    console.log(`   Region: ${process.env.AWS_REGION || 'ap-south-1'}`);
    console.log(`🤖 HeyGen API: ${HYGEN_API_KEY ? 'Configured' : 'Not configured'}`);
    console.log(`\n✅ Available Endpoints:`);
    console.log(`   POST /generate-hygen-video (Returns immediately, processes in background)`);
    console.log(`   POST /api/save-to-db`);
    console.log(`   GET /api/job-status/:jobId`);
    console.log(`   GET /api/debug-collections`);
    console.log(`   GET /api/debug-find-doc`);
    console.log(`   GET /health`);
});
